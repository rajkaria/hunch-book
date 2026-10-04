import { describe, expect, it } from "vitest";
import {
  aggregatorRoundOf,
  findBracketingRound,
  MAX_STALENESS_SECONDS,
  phaseOf,
  type Round,
} from "../src/settlers/chainlink.js";
import { arrayReader, fixtureRounds, type Pair } from "./fixtures.js";

/** The rule PriceAtTimeResolver enforces, by brute force over the whole list. */
function bruteForce(rounds: Round[], target: bigint): Round | undefined {
  for (let i = 0; i + 1 < rounds.length; i++) {
    const r = rounds[i] as Round;
    const next = rounds[i + 1] as Round;
    if (r.updatedAt <= target && target < next.updatedAt) return r;
  }
  return undefined;
}

const PAIRS: Pair[] = ["btc-usd", "eth-usd", "mon-usd"];

describe("findBracketingRound on rounds recorded from Monad mainnet", () => {
  for (const pair of PAIRS) {
    const rounds = fixtureRounds(pair);
    const first = rounds[0] as Round;
    const last = rounds.at(-1) as Round;

    it(`${pair}: the fixture is one phase of consecutive rounds`, () => {
      expect(rounds.length).toBeGreaterThan(200);
      expect(new Set(rounds.map((r) => phaseOf(r.roundId))).size).toBe(1);
      rounds.forEach((r, i) => {
        expect(aggregatorRoundOf(r.roundId)).toBe(aggregatorRoundOf(first.roundId) + BigInt(i));
        if (i > 0) expect(r.updatedAt).toBeGreaterThanOrEqual((rounds[i - 1] as Round).updatedAt);
      });
    });

    it(`${pair}: finds the same round as brute force for every T in the fixture`, async () => {
      // Every update time, one second either side of it, and the midpoints between updates.
      const targets = new Set<bigint>();
      for (let i = 1; i < rounds.length; i++) {
        const r = rounds[i] as Round;
        const prev = rounds[i - 1] as Round;
        targets.add(r.updatedAt);
        targets.add(r.updatedAt - 1n);
        targets.add(r.updatedAt + 1n);
        targets.add((r.updatedAt + prev.updatedAt) / 2n);
      }
      let checked = 0;
      for (const t of targets) {
        const expected = bruteForce(rounds, t);
        if (!expected || t >= last.updatedAt) continue;
        if (t - expected.updatedAt > MAX_STALENESS_SECONDS) continue;
        const reader = arrayReader(rounds, { olderRounds: true });
        const result = await findBracketingRound(reader, t);
        expect(result.status, `T=${t}`).toBe("found");
        if (result.status !== "found") continue;
        expect(result.round.roundId).toBe(expected.roundId);
        expect(result.next.roundId).toBe(expected.roundId + 1n);
        expect(result.round.updatedAt <= t && t < result.next.updatedAt).toBe(true);
        // Doubling back, then halving: logarithmic in the distance, never a walk over every round.
        expect(reader.reads).toBeLessThanOrEqual(2 * Math.ceil(Math.log2(rounds.length)) + 3);
        checked++;
      }
      expect(checked).toBeGreaterThan(500);
    });

    it(`${pair}: T exactly at a round's update time picks that round`, async () => {
      const r = rounds[150] as Round;
      const result = await findBracketingRound(arrayReader(rounds, { olderRounds: true }), r.updatedAt);
      expect(result.status).toBe("found");
      // The last round updated at or before T (two rounds can share a second).
      if (result.status === "found")
        expect(result.round.roundId).toBe(bruteForce(rounds, r.updatedAt)?.roundId);
    });

    it(`${pair}: waits while no round after T exists`, async () => {
      for (const t of [last.updatedAt, last.updatedAt + 3_600n]) {
        const result = await findBracketingRound(arrayReader(rounds), t);
        expect(result.status).toBe("wait");
        if (result.status === "wait") expect(result.reason).toMatch(/no Chainlink round after T yet/);
      }
    });

    it(`${pair}: reports a round it cannot read instead of guessing`, async () => {
      // Before the first recorded round, the reader (like a feed with lost history) has nothing.
      const result = await findBracketingRound(arrayReader(rounds), first.updatedAt - 10n);
      expect(result.status).toBe("unsettleable");
      if (result.status === "unsettleable") expect(result.reason).toMatch(/cannot be read/);
    });
  }
});

describe("findBracketingRound edge cases", () => {
  const PHASE = 7n << 64n;
  const round = (n: bigint, updatedAt: bigint, answer = 100n): Round => ({
    roundId: PHASE | n,
    answer,
    updatedAt,
  });

  it("refuses a round updated more than an hour before T (the resolver's staleness rule)", async () => {
    const rounds = [round(1n, 1_000n), round(2n, 2_000n), round(3n, 10_000n)];
    const ok = await findBracketingRound(arrayReader(rounds), 2_000n + 3_600n);
    expect(ok.status).toBe("found");
    const stale = await findBracketingRound(arrayReader(rounds), 2_000n + 3_601n);
    expect(stale.status).toBe("unsettleable");
    if (stale.status === "unsettleable") {
      expect(stale.reason).toMatch(/more than the resolver's 3600 s limit/);
      expect(stale.round?.roundId).toBe(PHASE | 2n);
    }
  });

  it("refuses a T before the first round of the current phase", async () => {
    const rounds = [round(1n, 5_000n), round(2n, 6_000n)];
    const result = await findBracketingRound(arrayReader(rounds), 4_000n);
    expect(result.status).toBe("unsettleable");
    if (result.status === "unsettleable")
      expect(result.reason).toMatch(/before the first round of the feed's current phase/);
  });

  it("refuses a non-positive price", async () => {
    const rounds = [round(1n, 1_000n, 0n), round(2n, 2_000n)];
    const result = await findBracketingRound(arrayReader(rounds), 1_500n);
    expect(result.status).toBe("unsettleable");
  });

  it("finds round 1 when T falls between rounds 1 and 2", async () => {
    const rounds = [round(1n, 1_000n), round(2n, 2_000n), round(3n, 3_000n), round(4n, 4_000n)];
    const result = await findBracketingRound(arrayReader(rounds), 1_999n);
    expect(result.status).toBe("found");
    if (result.status === "found") expect(result.round.roundId).toBe(PHASE | 1n);
  });

  it("skips over equal update times to the last round at or before T", async () => {
    const rounds = [round(1n, 1_000n), round(2n, 1_500n), round(3n, 1_500n), round(4n, 2_000n)];
    const result = await findBracketingRound(arrayReader(rounds), 1_500n);
    expect(result.status).toBe("found");
    if (result.status === "found") expect(result.round.roundId).toBe(PHASE | 3n);
  });
});

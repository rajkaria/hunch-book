import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ChainlinkRound,
  chainlinkAggregatorRound,
  chainlinkEvidence,
  chainlinkEvidenceHash,
  chainlinkOutcome,
  chainlinkPhase,
  chainlinkRoundId,
  decodeChainlinkEvidence,
  findBracketingRound,
  Outcome,
  perplEvidenceHash,
  perplOutcome,
  priceToE8,
  type RoundReader,
} from "@hunch-book/shared";
import { type Address, concat, type Hex, keccak256, numberToHex, pad } from "viem";
import { describe, expect, it, vi } from "vitest";

// The Chainlink round finder against real rounds the maker recorded from Monad mainnet
// (services/maker/test/fixtures), and the evidence hashes rebuilt word by word, independently of
// viem's ABI encoder, as the resolvers' abi.encode lays them out.

const here = dirname(fileURLToPath(import.meta.url));
type Fixture = { rounds: { roundId: string; answer: string; updatedAt: number }[]; decimals: number };
const fixture = (pair: string): Fixture =>
  JSON.parse(
    readFileSync(join(here, `../../../services/maker/test/fixtures/chainlink-${pair}.json`), "utf8"),
  );

/** A reader over fixture rounds. Rounds older than the fixture are filled in a minute apart, all older. */
function fixtureReader(rounds: ChainlinkRound[]): { read: RoundReader; calls: () => number; ids: bigint[] } {
  const byId = new Map(rounds.map((r) => [r.roundId, r]));
  const first = rounds[0] as ChainlinkRound;
  const ids: bigint[] = [];
  let calls = 0;
  const read: RoundReader = async (wanted) => {
    calls += 1;
    ids.push(...wanted);
    return wanted.map((id) => {
      const known = byId.get(id);
      if (known) return known;
      if (chainlinkPhase(id) !== chainlinkPhase(first.roundId)) return null;
      const behind = chainlinkAggregatorRound(first.roundId) - chainlinkAggregatorRound(id);
      if (behind <= 0n) return null;
      return { roundId: id, answer: first.answer, updatedAt: first.updatedAt - 60n * behind };
    });
  };
  return { read, calls: () => calls, ids };
}

const rounds = (f: Fixture): ChainlinkRound[] =>
  f.rounds.map((r) => ({
    roundId: BigInt(r.roundId),
    answer: BigInt(r.answer),
    updatedAt: BigInt(r.updatedAt),
  }));

describe("findBracketingRound on recorded Chainlink rounds", () => {
  for (const pair of ["btc-usd", "eth-usd", "mon-usd"]) {
    const all = rounds(fixture(pair));
    const latest = all[all.length - 1] as ChainlinkRound;

    it(`${pair}: finds the round with updatedAt(r) <= T < updatedAt(r + 1) for every T in the fixture`, async () => {
      for (let i = 0; i < all.length - 1; i += 7) {
        const r = all[i] as ChainlinkRound;
        const next = all[i + 1] as ChainlinkRound;
        if (next.updatedAt === r.updatedAt) continue;
        for (const target of [r.updatedAt, next.updatedAt - 1n]) {
          const { read } = fixtureReader(all);
          const result = await findBracketingRound({ latest, target, read });
          expect(result.status === "found" || result.status === "stale", `T ${target}`).toBe(true);
          if (result.status !== "found" && result.status !== "stale") continue;
          expect(result.round.roundId, `T ${target}`).toBe(r.roundId);
          expect(result.next.roundId).toBe(next.roundId);
          expect(result.round.updatedAt <= target && target < result.next.updatedAt).toBe(true);
        }
      }
    });
  }

  const btc = rounds(fixture("btc-usd"));
  const latest = btc[btc.length - 1] as ChainlinkRound;

  it("waits while no round after T exists", async () => {
    const { read, calls } = fixtureReader(btc);
    const result = await findBracketingRound({ latest, target: latest.updatedAt, read });
    expect(result).toEqual({ status: "waiting", latest });
    expect(calls()).toBe(0);
  });

  it("reports a stale bracket (more than an hour before T) so the market voids instead", async () => {
    // Push every round after the 11th two hours later, so round 11 is the last one before T.
    const shifted = btc.map((r, i) => (i > 10 ? { ...r, updatedAt: r.updatedAt + 7_200n } : r));
    const before = shifted[10] as ChainlinkRound;
    const { read } = fixtureReader(shifted);
    const result = await findBracketingRound({
      latest: shifted[shifted.length - 1] as ChainlinkRound,
      target: before.updatedAt + 3_601n,
      read,
    });
    expect(result.status).toBe("stale");
    if (result.status === "stale") {
      expect(result.round.roundId).toBe(before.roundId);
      expect(result.staleSeconds).toBe(3_601n);
    }
    const fresh = await findBracketingRound({
      latest: shifted[shifted.length - 1] as ChainlinkRound,
      target: before.updatedAt + 3_600n,
      read: fixtureReader(shifted).read,
    });
    expect(fresh.status).toBe("found");
  });

  it("reports a phase that starts after T", async () => {
    const first: ChainlinkRound = { roundId: chainlinkRoundId(2n, 1n), answer: 5n, updatedAt: 2_000n };
    const second: ChainlinkRound = { roundId: chainlinkRoundId(2n, 2n), answer: 6n, updatedAt: 2_100n };
    const read: RoundReader = async (ids) => ids.map((id) => (id === first.roundId ? first : null));
    expect(await findBracketingRound({ latest: second, target: 1_000n, read })).toEqual({
      status: "phase-start",
      first,
    });
    expect(await findBracketingRound({ latest: first, target: 1_000n, read })).toEqual({
      status: "phase-start",
      first,
    });
  });

  it("stays in the latest round's phase and batches its reads", async () => {
    const { read, calls, ids } = fixtureReader(btc);
    const target = (btc[150] as ChainlinkRound).updatedAt;
    const result = await findBracketingRound({ latest, target, read });
    expect(result.status).toBe("found");
    expect(ids.every((id) => chainlinkPhase(id) === chainlinkPhase(latest.roundId))).toBe(true);
    expect(calls()).toBeLessThanOrEqual(6);
  });

  it("finds a round far back in a long phase in a handful of batches", async () => {
    const top = 5_000_000n;
    const phase = 3n;
    const at = (i: bigint): ChainlinkRound => ({
      roundId: chainlinkRoundId(phase, i),
      answer: i,
      updatedAt: 1_000n + i * 30n,
    });
    const read = vi.fn<RoundReader>(async (ids) => ids.map((id) => at(chainlinkAggregatorRound(id))));
    const target = 1_000n + 123_456n * 30n + 7n;
    const result = await findBracketingRound({ latest: at(top), target, read });
    expect(result.status).toBe("found");
    if (result.status === "found") expect(chainlinkAggregatorRound(result.round.roundId)).toBe(123_456n);
    expect(read.mock.calls.length).toBeLessThanOrEqual(12);
  });

  it("refuses to guess when a round in the middle cannot be read", async () => {
    const read: RoundReader = async (ids) => ids.map(() => null);
    await expect(
      findBracketingRound({ latest, target: (btc[5] as ChainlinkRound).updatedAt, read }),
    ).rejects.toThrow(/could not be read/);
  });
});

const word = (v: bigint | number): Hex => pad(numberToHex(BigInt.asUintN(256, BigInt(v))), { size: 32 });
const addrWord = (a: Address): Hex => pad(a, { size: 32 });

describe("evidence and evidence hashes", () => {
  const feed = "0xc1d4C3331635184fA4C3c22fb92211B2Ac9E0546" as Address;

  it("encodes Chainlink evidence as abi.encode(uint80 roundId) and decodes it back", () => {
    const id = 18_446_744_073_710_222_086n;
    expect(chainlinkEvidence(id)).toBe(word(id));
    expect(decodeChainlinkEvidence(chainlinkEvidence(id))).toBe(id);
  });

  it("rebuilds PriceAtTimeResolver's Chainlink hash word by word", () => {
    const a = {
      feed,
      roundId: 18_446_744_073_710_222_086n,
      answer: 8_421_961_928_206n,
      updatedAt: 1_790_973_832n,
      nextUpdatedAt: 1_790_973_962n,
      target: 1_790_973_900n,
    };
    const expected = keccak256(
      concat([
        word(0),
        addrWord(feed),
        word(a.roundId),
        word(a.answer),
        word(a.updatedAt),
        word(a.nextUpdatedAt),
        word(a.target),
      ]),
    );
    expect(chainlinkEvidenceHash(a)).toBe(expected);
  });

  it("rebuilds PerplFundingResolver's hash, with negative int48 sums sign-extended", () => {
    const exchange = "0x1964C32f0bE608E7D29302AFF5E61268E72080cc" as Address;
    const a = {
      exchange,
      perpId: 16n,
      startBlock: 68_058_301n,
      endBlock: 68_264_005n,
      sumStart: -1_234_567n,
      sumEnd: 9_876n,
      eventStart: 68_052_000n,
      eventEnd: 68_258_000n,
    };
    const expected = keccak256(
      concat([
        addrWord(exchange),
        word(a.perpId),
        word(a.startBlock),
        word(a.endBlock),
        word(a.sumStart),
        word(a.sumEnd),
        word(a.eventStart),
        word(a.eventEnd),
      ]),
    );
    expect(perplEvidenceHash(a)).toBe(expected);
  });
});

describe("rules", () => {
  it("scales like PriceScale.toE8, truncating toward zero", () => {
    expect(priceToE8(12_345n, -2)).toBe(12_345_000_000n);
    expect(priceToE8(123_456_789_012_345_678_901n, -18)).toBe(12_345_678_901n);
    expect(priceToE8(-15n, -9)).toBe(-1n);
    expect(priceToE8(7n, -100)).toBe(0n);
  });

  it("Chainlink: YES at or above the strike, NO below", () => {
    expect(chainlinkOutcome(12_000_000_000_000n, 8, 12_000_000_000_000n)).toBe(Outcome.Yes);
    expect(chainlinkOutcome(11_999_999_999_999n, 8, 12_000_000_000_000n)).toBe(Outcome.No);
    // 18-decimal answer: truncation never flips "at or above".
    expect(chainlinkOutcome(120_000_000_000_000_000_000_000n, 18, 12_000_000_000_000n)).toBe(Outcome.Yes);
    expect(chainlinkOutcome(119_999_999_999_999_999_999_999n, 18, 12_000_000_000_000n)).toBe(Outcome.No);
  });

  it("Perpl: YES only when ΔF is above the threshold; equal is NO", () => {
    expect(perplOutcome(100n, 151n, 50n)).toBe(Outcome.Yes);
    expect(perplOutcome(100n, 150n, 50n)).toBe(Outcome.No);
    expect(perplOutcome(-10n, -5n, 0n)).toBe(Outcome.Yes);
    expect(perplOutcome(-10n, -15n, 0n)).toBe(Outcome.No);
  });
});

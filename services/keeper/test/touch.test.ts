import {
  deployments,
  encodeChainlinkTouchParams,
  encodeRoundEvidence,
  TemplateId,
  TouchDirection,
  touchesStrike,
  type Window,
} from "@hunch-book/shared";
import type { Address, PublicClient } from "viem";
import { describe, expect, it } from "vitest";
import { chainlinkTouchSettler } from "../src/settlers/chainlinkTouch.js";
import type { SettleDeps, SettleMarket } from "../src/settlers/index.js";
import { type FullRound, huntTouch, type TouchHunt, type TouchReader } from "../src/settlers/touchRounds.js";
import { arrayReader, chainlinkFixture, fixtureRounds, type Pair } from "./fixtures.js";

// The touch hunter against Chainlink rounds recorded from Monad mainnet (the maker's fixtures: 301
// consecutive rounds of one phase per feed). The recordings hold roundId, answer and updatedAt; on
// these OCR feeds every round answers in itself, so answeredInRound is the round's own id. Every result
// is checked against a brute-force pass over the same rounds.

const MARKET = "0x00000000000000000000000000000000000000a3" as Address;
const RESOLVER = "0x34Ac3F430c8F49735987Efe88634Ef8d9c295727" as Address;

function full(pair: Pair): FullRound[] {
  return fixtureRounds(pair).map((r) => ({ ...r, answeredInRound: r.roundId }));
}

/**
 * A reader over `rounds` whose latest round is `visible()` (default: the last), counting reads. As in
 * fixtures.ts, rounds of the same phase before the first recorded one exist too, one minute apart and
 * older than it, the way a real feed keeps its whole phase readable.
 */
function reader(rounds: FullRound[], decimals: number, visible: () => number = () => rounds.length - 1) {
  const older = arrayReader(rounds, { olderRounds: true });
  const r = {
    reads: 0,
    async latest() {
      r.reads++;
      return rounds[visible()] as FullRound;
    },
    async rounds(ids: bigint[]) {
      r.reads += ids.length;
      const last = rounds[visible()] as FullRound;
      return Promise.all(
        ids.map(async (id) => {
          if (id > last.roundId) return undefined;
          const known = rounds.find((x) => x.roundId === id);
          if (known) return known;
          const synthetic = await older.round(id);
          return synthetic && { ...synthetic, answeredInRound: synthetic.roundId };
        }),
      );
    },
    async decimals() {
      return decimals;
    },
  } satisfies TouchReader & { reads: number };
  return r;
}

/** The first round of [T1, T2] that touches, by brute force. */
function bruteForce(rounds: FullRound[], decimals: number, q: Parameters<typeof huntTouch>[1]) {
  return rounds.find(
    (r) =>
      r.updatedAt >= q.startTime &&
      r.updatedAt <= q.endTime &&
      touchesStrike(r.answer, decimals, q.strikeE8, q.direction),
  );
}

const pairs: Pair[] = ["btc-usd", "eth-usd", "mon-usd"];

describe("huntTouch on recorded rounds", () => {
  for (const pair of pairs) {
    const rounds = full(pair);
    const decimals = chainlinkFixture(pair).decimals;
    const after = (rounds.at(-1) as FullRound).updatedAt + 1n;

    it(`${pair}: proves the highest round of a window at its own price, and nothing one unit above`, async () => {
      const window = rounds.slice(40, 160);
      const top = window.reduce((a, b) => (b.answer > a.answer ? b : a));
      const strikeE8 = touchPriceE8Floor(top.answer, decimals);
      const q = {
        strikeE8,
        direction: TouchDirection.AtOrAbove,
        startTime: (window[0] as FullRound).updatedAt,
        endTime: (window.at(-1) as FullRound).updatedAt,
      };
      const hit = await huntTouch(reader(rounds, decimals), q, undefined, after);
      expect(hit.status).toBe("found");
      expect(hit.status === "found" && hit.round.roundId).toBe(bruteForce(rounds, decimals, q)?.roundId);

      const miss = await huntTouch(
        reader(rounds, decimals),
        { ...q, strikeE8: strikeE8 + 1n },
        undefined,
        after,
      );
      expect(miss.status).toBe("none");
      expect(miss.hunt?.complete).toBe(true);
      expect(miss.hunt?.checked).toBe(
        rounds.filter((r) => r.updatedAt >= q.startTime && r.updatedAt <= q.endTime).length,
      );
      expect(miss.hunt?.closest).toBe(strikeE8);
    });

    it(`${pair}: proves the lowest round of a window when the direction is at or below`, async () => {
      const window = rounds.slice(100, 250);
      const bottom = window.reduce((a, b) => (b.answer < a.answer ? b : a));
      const strikeE8 = touchPriceE8Ceil(bottom.answer, decimals);
      const q = {
        strikeE8,
        direction: TouchDirection.AtOrBelow,
        startTime: (window[0] as FullRound).updatedAt,
        endTime: (window.at(-1) as FullRound).updatedAt,
      };
      const hit = await huntTouch(reader(rounds, decimals), q, undefined, after);
      expect(hit.status === "found" && hit.round.roundId).toBe(bruteForce(rounds, decimals, q)?.roundId);
      const miss = await huntTouch(
        reader(rounds, decimals),
        { ...q, strikeE8: strikeE8 - 1n },
        undefined,
        after,
      );
      expect(miss).toMatchObject({ status: "none", hunt: { complete: true } });
    });
  }

  it("agrees with brute force on many windows and strikes", async () => {
    for (const pair of pairs) {
      const rounds = full(pair);
      const decimals = chainlinkFixture(pair).decimals;
      const after = (rounds.at(-1) as FullRound).updatedAt + 1n;
      for (let i = 0; i < 40; i++) {
        const a = (i * 37) % 250;
        const b = a + 1 + ((i * 53) % 50);
        const pivot = rounds[a + ((i * 7) % (b - a))] as FullRound;
        const q = {
          strikeE8: touchPriceE8Floor(pivot.answer, decimals) + BigInt((i % 3) - 1),
          direction: i % 2 === 0 ? TouchDirection.AtOrAbove : TouchDirection.AtOrBelow,
          startTime: (rounds[a] as FullRound).updatedAt,
          endTime: (rounds[b] as FullRound).updatedAt,
        } as const;
        const result = await huntTouch(reader(rounds, decimals), q, undefined, after);
        const expected = bruteForce(rounds, decimals, q);
        expect(result.status === "found" ? result.round.roundId : undefined).toBe(expected?.roundId);
        if (!expected) expect(result.hunt?.complete).toBe(true);
      }
    }
  });

  it("reads only the rounds written since the last cycle, and finds the touch the cycle it appears", async () => {
    const rounds = full("btc-usd");
    const decimals = 8;
    const window = rounds.slice(50, 280);
    const top = window.reduce((a, b) => (b.answer > a.answer ? b : a));
    const topIndex = rounds.indexOf(top);
    const q = {
      strikeE8: touchPriceE8Floor(top.answer, decimals),
      direction: TouchDirection.AtOrAbove,
      startTime: (window[0] as FullRound).updatedAt,
      endTime: (window.at(-1) as FullRound).updatedAt,
    } as const;
    let latest = 60;
    const r = reader(rounds, decimals, () => latest);
    let hunt: TouchHunt | undefined;
    let found: bigint | undefined;
    const reads: number[] = [];
    while (latest < rounds.length - 1 && found === undefined) {
      const before = r.reads;
      const scan = await huntTouch(r, q, hunt, (rounds[latest] as FullRound).updatedAt);
      reads.push(r.reads - before);
      hunt = scan.hunt;
      if (scan.status === "found") found = scan.round.roundId;
      else latest += 1;
    }
    expect(found).toBe(top.roundId);
    expect(latest).toBe(topIndex);
    // After the first call (which searches for T1), each cycle reads the latest round, one new round
    // and its decimals at most.
    expect(Math.max(...reads.slice(1))).toBeLessThanOrEqual(3);
  });

  it("is not complete before T2, while the feed may still write a round of the window", async () => {
    const rounds = full("eth-usd");
    const q = {
      strikeE8: 10n ** 20n,
      direction: TouchDirection.AtOrAbove,
      startTime: (rounds[10] as FullRound).updatedAt,
      endTime: (rounds.at(-1) as FullRound).updatedAt + 3_600n,
    } as const;
    const early = await huntTouch(reader(rounds, 8), q, undefined, q.endTime - 1n);
    expect(early).toMatchObject({ status: "none", hunt: { complete: false } });
    // The same rounds, read once the chain is past T2: nothing new can count.
    const late = await huntTouch(reader(rounds, 8), q, early.hunt, q.endTime + 1n);
    expect(late).toMatchObject({ status: "none", hunt: { complete: true } });
  });

  it("waits while the window has not started in the feed's rounds", async () => {
    const rounds = full("mon-usd");
    const q = {
      strikeE8: 1n,
      direction: TouchDirection.AtOrAbove,
      startTime: (rounds.at(-1) as FullRound).updatedAt + 60n,
      endTime: (rounds.at(-1) as FullRound).updatedAt + 600n,
    } as const;
    const scan = await huntTouch(reader(rounds, 8), q, undefined, q.startTime);
    expect(scan).toMatchObject({ status: "none", hunt: undefined });
  });

  it("skips a round answered in an older round, as the resolver does", async () => {
    const rounds = full("btc-usd").map((r, i) => (i === 120 ? { ...r, answeredInRound: r.roundId - 1n } : r));
    const target = rounds[120] as FullRound;
    const q = {
      strikeE8: touchPriceE8Floor(target.answer, 8),
      direction: TouchDirection.AtOrAbove,
      startTime: target.updatedAt,
      endTime: target.updatedAt,
    } as const;
    const scan = await huntTouch(reader(rounds, 8), q, undefined, target.updatedAt + 10_000n);
    expect(scan.status === "found" ? scan.round.roundId : undefined).not.toBe(target.roundId);
  });

  it("reads earlier phases when the current phase started inside the window", async () => {
    // The recorded rounds, re-labelled as two phases: the first 150 rounds as phase 1 (rounds 1 to 150)
    // and the rest as phase 2 (rounds 1 to 151). Answers and times are the recorded ones.
    const recorded = full("btc-usd");
    const relabel = (phase: bigint, r: FullRound, i: number) => {
      const roundId = (phase << 64n) | BigInt(i + 1);
      return { ...r, roundId, answeredInRound: roundId };
    };
    const phase1 = recorded.slice(0, 150).map((r, i) => relabel(1n, r, i));
    const phase2 = recorded.slice(150).map((r, i) => relabel(2n, r, i));
    const all = [...phase1, ...phase2];
    const r = {
      async latest() {
        return phase2.at(-1) as FullRound;
      },
      async rounds(ids: bigint[]) {
        return ids.map((id) => all.find((x) => x.roundId === id));
      },
      async decimals() {
        return 8;
      },
    };
    const inPhase1 = phase1.slice(100);
    const top = inPhase1.reduce((a, b) => (b.answer > a.answer ? b : a));
    const q = {
      strikeE8: touchPriceE8Floor(top.answer, 8),
      direction: TouchDirection.AtOrAbove,
      startTime: (phase1[100] as FullRound).updatedAt,
      endTime: (phase2[20] as FullRound).updatedAt,
    } as const;
    const scan = await huntTouch(r, q, undefined, (phase2.at(-1) as FullRound).updatedAt);
    const expected = bruteForce(all, 8, q);
    expect(scan.status === "found" ? scan.round.roundId : undefined).toBe(expected?.roundId);
    expect(expected && expected.roundId >> 64n).toBe(1n);
  });
});

// Mirrors of the resolver's rounding, so strikes sit exactly on a recorded price.
const touchPriceE8Floor = (answer: bigint, decimals: number) =>
  decimals >= 8 ? answer / 10n ** BigInt(decimals - 8) : answer * 10n ** BigInt(8 - decimals);
const touchPriceE8Ceil = (answer: bigint, decimals: number) => {
  if (decimals <= 8) return answer * 10n ** BigInt(8 - decimals);
  const div = 10n ** BigInt(decimals - 8);
  return answer % div === 0n ? answer / div : answer / div + 1n;
};

describe("the touch settler", () => {
  const rounds = full("btc-usd");
  const window = rounds.slice(20, 200);
  const top = window.reduce((a, b) => (b.answer > a.answer ? b : a));
  const T1 = (window[0] as FullRound).updatedAt;
  const T2 = (window.at(-1) as FullRound).updatedAt;
  const feed = deployments["monad-mainnet"].external.chainlink["BTC/USD"] as Address;
  const marketFor = (strikeE8: bigint): SettleMarket => ({
    address: MARKET,
    templateId: TemplateId.ChainlinkTouch,
    params: encodeChainlinkTouchParams({
      feed,
      strikeE8,
      direction: TouchDirection.AtOrAbove,
      lockTime: T1 - 60n,
      startTime: T1,
      endTime: T2,
    }),
    window: { blockClock: false, lock: T1 - 60n, close: T2, settleDeadline: T2 + 8n * 86_400n } as Window,
    resolver: RESOLVER,
  });
  const client = {
    async readContract() {
      const last = rounds.at(-1) as FullRound;
      return [last.roundId, last.answer, last.updatedAt, last.updatedAt, last.roundId] as const;
    },
  } as unknown as PublicClient;
  const deps = {
    client,
    deployment: deployments["monad-mainnet"],
    pythApiKey: undefined,
    hermesUrl: "",
  } as SettleDeps;
  const settler = () => chainlinkTouchSettler({ reader: () => reader(rounds, 8) });
  const now = (timestamp: bigint) => ({ block: 1n, timestamp });

  it("waits for the window, then sends the touching round as the proof", async () => {
    const s = settler();
    const m = marketFor(touchPriceE8Floor(top.answer, 8));
    expect(s.prover?.waitReason(m, now(T1 - 1n))).toMatch(/^waiting for the window to open at/);
    expect(s.prover?.waitReason(m, now(T1))).toBeNull();
    const proof = await s.prover?.findProof(m, now(T2 + 10n), deps);
    expect(proof).toMatchObject({ status: "found", proof: encodeRoundEvidence(top.roundId) });
    // Before the challenge period ends, the settle job waits; a proof found after close settles YES.
    expect(s.waitReason(m, now(T2 + 86_399n))).toMatch(/challenge period/);
    expect(s.waitReason(m, now(T2 + 86_400n))).toBeNull();
    const yes = await s.evidence(m, now(T2 + 86_400n), deps);
    expect(yes).toMatchObject({ status: "ready", evidence: encodeRoundEvidence(top.roundId) });
  });

  it("settles NO with empty evidence only after reading every round of the window", async () => {
    const s = settler();
    const m = marketFor(touchPriceE8Floor(top.answer, 8) + 1n);
    const no = await s.evidence(m, now(T2 + 86_400n), deps);
    expect(no).toMatchObject({ status: "ready", evidence: "0x", detail: { answer: "no" } });
    expect(s.prover?.waitReason(m, now(T2 + 86_400n))).toMatch(/^no round in the window touched/);
  });

  it("keeps NO waiting while the hunt has rounds left to read", async () => {
    const s = chainlinkTouchSettler({ reader: () => reader(rounds, 8), maxReads: 30 });
    const m = marketFor(touchPriceE8Floor(top.answer, 8) + 1n);
    const first = await s.evidence(m, now(T2 + 86_400n), deps);
    expect(first).toMatchObject({ status: "wait" });
    expect(first.status === "wait" && first.reason).toMatch(
      /^NO waits until every round of the window is read/,
    );
  });
});

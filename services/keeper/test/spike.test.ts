import { readFileSync } from "node:fs";
import {
  deployments,
  encodeFundingEventEvidence,
  encodePerplFundingSpikeParams,
  TemplateId,
  type Window,
} from "@hunch-book/shared";
import type { Address, PublicClient } from "viem";
import { describe, expect, it } from "vitest";
import {
  type FundingRead,
  type FundingReader,
  huntSpike,
  type SpikeHunt,
  walkFundingEvents,
} from "../src/settlers/fundingEvents.js";
import { fundingSpikeSettler } from "../src/settlers/fundingSpike.js";
import type { SettleDeps, SettleMarket } from "../src/settlers/index.js";

// The spike hunter against Perpl funding sums recorded from Monad mainnet (the maker's fixtures: 601
// consecutive funding events per perp, read with getFundingSumAtBlock at each grid block). The fake
// reader answers getFundingSumAtBlock(b) the way Perpl does: the last recorded event at or before b.

interface FundingFixture {
  perpId: number;
  interval: number;
  samples: { block: number; sum: number; eventBlock: number }[];
}

const fixture = (asset: "btc" | "mon"): FundingFixture =>
  JSON.parse(
    readFileSync(new URL(`../../maker/test/fixtures/perpl-funding-${asset}.json`, import.meta.url), "utf8"),
  );

interface Ev {
  block: bigint;
  sum: bigint;
}

const eventsOf = (f: FundingFixture): Ev[] =>
  f.samples.map((s) => ({ block: BigInt(s.eventBlock), sum: BigInt(s.sum) }));

/** getFundingSumAtBlock over a list of events, counting reads. */
function reader(events: Ev[]) {
  const r = {
    reads: 0,
    async sums(blocks: bigint[]): Promise<FundingRead[]> {
      r.reads += blocks.length;
      return blocks.map((b) => {
        let found: Ev | undefined;
        for (const e of events) {
          if (e.block > b) break;
          found = e;
        }
        return found ? { sum: found.sum, eventBlock: found.block } : { sum: 0n, eventBlock: 0n };
      });
    },
  } satisfies FundingReader & { reads: number };
  return r;
}

/** Single-interval increments of the events in (after, upTo], by brute force. */
function bruteForce(events: Ev[], interval: bigint, after: bigint, upTo: bigint) {
  const out: { block: bigint; increment: bigint; single: boolean }[] = [];
  for (let i = 1; i < events.length; i++) {
    const e = events[i] as Ev;
    const prev = events[i - 1] as Ev;
    if (e.block > after && e.block <= upTo) {
      out.push({ block: e.block, increment: e.sum - prev.sum, single: e.block - prev.block === interval });
    }
  }
  return out;
}

for (const asset of ["btc", "mon"] as const) {
  const f = fixture(asset);
  const events = eventsOf(f);
  const interval = BigInt(f.interval);

  describe(`walkFundingEvents on recorded ${asset.toUpperCase()} funding`, () => {
    it("finds every event of a window with its single-interval increment, in a few batched reads", async () => {
      const after = (events[100] as Ev).block + 5n;
      const upTo = (events[400] as Ev).block + 7n;
      const r = reader(events);
      const walk = await walkFundingEvents(r, { after, upTo, interval });
      const expected = bruteForce(events, interval, after, upTo);
      expect([...walk.events].reverse().map((e) => [e.block, e.increment, e.singleInterval])).toEqual(
        expected.map((e) => [e.block, e.increment, e.single]),
      );
      // One read for the top, then one per event: batched 64 at a time on the grid.
      expect(r.reads).toBe(1 + expected.length);
    });

    it("re-predicts the grid after a gap, and marks the event after a gap as not one interval", async () => {
      // Drop three events, as a pause would.
      const gapped = events.filter((_, i) => i < 200 || i > 202);
      const after = (gapped[150] as Ev).block;
      const upTo = (gapped[260] as Ev).block;
      const walk = await walkFundingEvents(reader(gapped), { after, upTo, interval });
      const expected = bruteForce(gapped, interval, after, upTo);
      expect([...walk.events].reverse().map((e) => [e.block, e.singleInterval])).toEqual(
        expected.map((e) => [e.block, e.single]),
      );
      expect(expected.filter((e) => !e.single)).toHaveLength(1);
    });
  });

  describe(`huntSpike on recorded ${asset.toUpperCase()} funding`, () => {
    const startBlock = (events[200] as Ev).block + 1n;
    const endBlock = (events[500] as Ev).block + 100n;
    const inWindow = bruteForce(events, interval, startBlock, endBlock).filter((e) => e.single);
    const largest = inWindow.reduce(
      (m, e) => (e.increment > m ? e.increment : m),
      inWindow[0]?.increment ?? 0n,
    );
    const head = (events.at(-1) as Ev).block + 10n;

    it("proves the first event above the threshold, and nothing at the largest increment itself", async () => {
      const q = { startBlock, endBlock, threshold: largest - 1n };
      const hit = await huntSpike(reader(events), q, interval, undefined, head);
      const first = inWindow.find((e) => e.increment > q.threshold);
      expect(hit.status === "found" ? hit.event.block : undefined).toBe(first?.block);

      const miss = await huntSpike(reader(events), { ...q, threshold: largest }, interval, undefined, head);
      expect(miss).toMatchObject({ status: "none", hunt: { complete: true, largest } });
      expect(miss.hunt.checked).toBe(bruteForce(events, interval, startBlock, endBlock).length);
    });

    it("checks each event once as it becomes final, and is complete only after the window", async () => {
      const q = { startBlock, endBlock, threshold: largest };
      const r = reader(events);
      let hunt: SpikeHunt | undefined;
      let reads = 0;
      for (let i = 190; i < 520; i++) {
        const now = (events[i] as Ev).block + 3n;
        const scan = await huntSpike(r, q, interval, hunt, now);
        hunt = scan.hunt;
        expect(hunt.complete).toBe(now - 1n >= endBlock);
        reads = r.reads;
      }
      expect(hunt?.complete).toBe(true);
      // Each new event costs the top read and its e - 1 read.
      expect(reads).toBeLessThanOrEqual(2 * (520 - 190));
    });
  });
}

describe("the funding spike settler", () => {
  const f = fixture("btc");
  const events = eventsOf(f);
  const interval = BigInt(f.interval);
  const startBlock = (events[300] as Ev).block;
  const endBlock = (events[450] as Ev).block;
  const challengeBlocks = 288_000n;
  const exchange = deployments["monad-mainnet"].external.perpl.exchange;
  const RESOLVER = "0x3459d8026DD8E7B0f3BE2B1aF21050013b9bCA64" as Address;
  const marketFor = (threshold: bigint): SettleMarket => ({
    address: "0x00000000000000000000000000000000000000b4",
    templateId: TemplateId.PerplFundingSpike,
    params: encodePerplFundingSpikeParams({
      perpId: BigInt(f.perpId),
      startBlock,
      endBlock,
      threshold,
      expectedScalingExp: 0,
    }),
    window: { blockClock: true, lock: startBlock, close: endBlock, settleDeadline: 0n } as Window,
    resolver: RESOLVER,
  });
  const calls: string[] = [];
  const client = {
    async multicall() {
      calls.push("resolver");
      return [exchange, challengeBlocks];
    },
    async readContract(req: { functionName: string }) {
      calls.push(req.functionName);
      if (req.functionName === "getFundingInterval") return interval;
      throw new Error(`unexpected ${req.functionName}`);
    },
  } as unknown as PublicClient;
  const deps = {
    client,
    deployment: deployments["monad-mainnet"],
    pythApiKey: undefined,
    hermesUrl: "",
  } as SettleDeps;
  const single = bruteForce(events, interval, startBlock, endBlock).filter((e) => e.single);
  const largest = single.reduce((m, e) => (e.increment > m ? e.increment : m), 0n);

  it("waits for the first event after the lock, then sends the spike as the proof", async () => {
    const s = fundingSpikeSettler({ reader: () => reader(events) });
    const m = marketFor(largest - 1n);
    expect(s.prover?.waitReason(m, { block: startBlock + 1n, timestamp: 0n })).toMatch(
      /^waiting for the first/,
    );
    const found = await s.prover?.findProof(m, { block: endBlock + 1n, timestamp: 0n }, deps);
    const first = single.find((e) => e.increment > largest - 1n);
    expect(found).toMatchObject({ status: "found", proof: encodeFundingEventEvidence(first?.block ?? 0n) });
  });

  it("waits for the end of the challenge period, then settles NO once every event is checked", async () => {
    calls.length = 0;
    const s = fundingSpikeSettler({ reader: () => reader(events) });
    const m = marketFor(largest);
    expect(s.waitReason(m, { block: endBlock + 1n, timestamp: 0n })).toBeNull();
    const early = await s.evidence(m, { block: endBlock + challengeBlocks, timestamp: 0n }, deps);
    expect(early).toMatchObject({ status: "wait" });
    // The resolver's challenge period is now known, so the plan waits for it without reading.
    expect(s.waitReason(m, { block: endBlock + challengeBlocks, timestamp: 0n })).toMatch(/challenge period/);
    const no = await s.evidence(m, { block: endBlock + challengeBlocks + 1n, timestamp: 0n }, deps);
    expect(no).toMatchObject({
      status: "ready",
      evidence: "0x",
      detail: { answer: "no", largestIncrement: largest },
    });
    expect(s.prover?.waitReason(m, { block: endBlock + challengeBlocks + 1n, timestamp: 0n })).toMatch(
      /^no funding event in the window/,
    );
    // The resolver and the interval were each read once.
    expect(calls.filter((c) => c === "resolver")).toHaveLength(1);
  });
});

import { isFundingSpike, perplExchangeAbi } from "@hunch-book/shared";
import type { Address, PublicClient } from "viem";

// Hunts for the funding event that proves a template 4 spike (docs/TEMPLATES.md, template 4).
//
// PerplFundingSpikeResolver accepts event block e only if startBlock < e <= endBlock, e is final
// (e < block.number), Perpl reports e itself as the last event at or before e, and the last event
// strictly before e (Perpl's answer for e − 1) sits exactly one funding interval earlier. Then
// F(e) − F(e − 1) is that single event's increment, and it must be strictly above the threshold.
//
// The hunt makes exactly those reads. It walks back from the latest final event through Perpl's own
// "last event at or before" answers: the answer for e − 1 is the event before e. Perpl's events sit on
// a fixed grid, so the reads for a whole batch of earlier events are predicted and sent in one
// multicall; where an event is off the grid (a pause, a restart), the walk re-predicts from there.
// Every event in the window is checked once; the hunt remembers the newest one it has checked.

export interface FundingRead {
  /** Cumulative funding at the last event at or before the block asked for. */
  sum: bigint;
  /** That event's block (0 before the perp's funding started). */
  eventBlock: bigint;
}

export interface FundingReader {
  /** getFundingSumAtBlock(perpId, block) for each block, in order. */
  sums(blocks: bigint[]): Promise<FundingRead[]>;
}

export interface FundingEvent {
  block: bigint;
  sum: bigint;
  /** Perpl's last event before this one (its answer for block − 1). */
  previousBlock: bigint;
  previousSum: bigint;
  /** F(block) − F(previous): the single event's increment when `singleInterval`. */
  increment: bigint;
  /** The previous event is exactly one interval earlier, so the increment belongs to one event. */
  singleInterval: boolean;
}

/** Events of (`after`, the latest event at or before `upTo`], newest first. */
export async function walkFundingEvents(
  reader: FundingReader,
  opts: { after: bigint; upTo: bigint; interval: bigint; batch?: number },
): Promise<{ events: FundingEvent[]; latest: bigint; reads: number }> {
  const batch = opts.batch ?? 64;
  let reads = 1;
  const [top] = await reader.sums([opts.upTo]);
  if (!top || top.eventBlock <= opts.after || top.eventBlock === 0n) {
    return { events: [], latest: top?.eventBlock ?? 0n, reads };
  }
  const events: FundingEvent[] = [];
  let current = { block: top.eventBlock, sum: top.sum };
  while (current.block > opts.after && current.block > 0n) {
    // Predict the next `batch` events back on the grid and read each one's "e − 1".
    const predicted: bigint[] = [];
    for (let k = 0n; k < BigInt(batch); k++) {
      const e = current.block - k * opts.interval;
      if (e <= opts.after || e <= 0n) break;
      predicted.push(e);
    }
    reads += predicted.length;
    const answers = await reader.sums(predicted.map((e) => e - 1n));
    let i = 0;
    for (; i < predicted.length; i++) {
      // The prediction holds only while the walk is still on the grid.
      if (predicted[i] !== current.block) break;
      const prev = answers[i] as FundingRead;
      if (prev.eventBlock >= current.block) {
        throw new Error(
          `Perpl reported event block ${prev.eventBlock} for block ${current.block - 1n}: the walk cannot go on`,
        );
      }
      events.push({
        block: current.block,
        sum: current.sum,
        previousBlock: prev.eventBlock,
        previousSum: prev.sum,
        increment: current.sum - prev.sum,
        singleInterval: prev.eventBlock !== 0n && prev.eventBlock === current.block - opts.interval,
      });
      current = { block: prev.eventBlock, sum: prev.sum };
      if (current.block <= opts.after || current.block === 0n) break;
    }
  }
  return { events, latest: top.eventBlock, reads };
}

export interface SpikeQuestion {
  startBlock: bigint;
  endBlock: bigint;
  threshold: bigint;
}

export interface SpikeHunt {
  /** Every event at or before this block has been checked. */
  checkedUpTo: bigint;
  /** Events of the window checked so far. */
  checked: number;
  /** Every event of the window has been checked. */
  complete: boolean;
  found?: FundingEvent;
  /** The largest single-interval increment seen so far. */
  largest?: bigint;
}

export type SpikeScan =
  | { status: "found"; event: FundingEvent; hunt: SpikeHunt; reads: number }
  | { status: "none"; reason: string; hunt: SpikeHunt; reads: number };

/**
 * Checks the events that became final since the last call and returns the first spike.
 * `head` is the current block: only events before it are final.
 */
export async function huntSpike(
  reader: FundingReader,
  q: SpikeQuestion,
  interval: bigint,
  previous: SpikeHunt | undefined,
  head: bigint,
): Promise<SpikeScan> {
  const hunt: SpikeHunt = previous
    ? { ...previous }
    : { checkedUpTo: q.startBlock, checked: 0, complete: false };
  if (hunt.found) return { status: "found", event: hunt.found, hunt, reads: 0 };
  if (hunt.complete) return { status: "none", reason: noSpikeReason(hunt, q), hunt, reads: 0 };
  // Read only blocks that are final: an event at e needs e < block.number when it is proved.
  const upTo = head - 1n < q.endBlock ? head - 1n : q.endBlock;
  if (upTo <= hunt.checkedUpTo) {
    return { status: "none", reason: `no funding event after block ${hunt.checkedUpTo} yet`, hunt, reads: 0 };
  }
  const walk = await walkFundingEvents(reader, { after: hunt.checkedUpTo, upTo, interval });
  // Oldest first: the first spike of the window is the proof.
  for (const event of [...walk.events].reverse()) {
    hunt.checked++;
    if (!event.singleInterval) continue;
    if (hunt.largest === undefined || event.increment > hunt.largest) hunt.largest = event.increment;
    if (isFundingSpike(event.increment, q.threshold)) {
      hunt.found = event;
      hunt.checkedUpTo = event.block;
      return { status: "found", event, hunt, reads: walk.reads };
    }
  }
  hunt.checkedUpTo = upTo;
  hunt.complete = upTo >= q.endBlock;
  if (hunt.complete) return { status: "none", reason: noSpikeReason(hunt, q), hunt, reads: walk.reads };
  return {
    status: "none",
    reason: `no spike in the ${hunt.checked} funding events of the window so far (largest ${hunt.largest ?? "none"}, threshold ${q.threshold})`,
    hunt,
    reads: walk.reads,
  };
}

function noSpikeReason(hunt: SpikeHunt, q: SpikeQuestion): string {
  return `no funding event in the window was above the threshold (${hunt.checked} events checked, largest ${hunt.largest ?? "none"}, threshold ${q.threshold})`;
}

/** A FundingReader over Perpl's Exchange: getFundingSumAtBlock through Multicall3. */
export function perplFundingReader(client: PublicClient, exchange: Address, perpId: bigint): FundingReader {
  return {
    async sums(blocks) {
      if (blocks.length === 0) return [];
      const results = await client.multicall({
        allowFailure: false,
        batchSize: 16_384,
        contracts: blocks.map((block) => ({
          address: exchange,
          abi: perplExchangeAbi,
          functionName: "getFundingSumAtBlock" as const,
          args: [perpId, block] as const,
        })),
      });
      return results.map(([sum, eventBlock]) => ({ sum: BigInt(sum), eventBlock }));
    },
  };
}

import { type PerplFundingSpikeParams, perplExchangeAbi } from "@hunch-book/shared";
import { type Address, parseAbi } from "viem";
import type { HunchContext } from "../context.js";
import { multicall, ok } from "../multicall.js";

// Perpl reads for settlement: the cumulative funding sum at a block (templates 1 and 4), the funding
// interval, and a scan of the funding events inside a spike market's window for single events that
// charged longs more than the threshold (template 4, PerplFundingSpikeResolver).

/** Views on the Perpl resolvers that IResolver leaves out. */
export const perplResolverAbi = parseAbi([
  "function exchange() view returns (address)",
  "function versionUnchanged() view returns (bool)",
  "function challengeBlocks() view returns (uint256)",
]);

export interface FundingPoint {
  /** Perpl's cumulative funding sum, raw units. */
  sum: bigint;
  /** The last funding event at or before the block asked for. */
  eventBlock: bigint;
}

/** getFundingSumAtBlock at each block, batched. A failed read is null. */
export async function fundingAt(
  ctx: HunchContext,
  exchange: Address,
  perpId: bigint,
  blocks: readonly bigint[],
): Promise<(FundingPoint | null)[]> {
  const results = await multicall(
    ctx,
    blocks.map((b) => ({
      address: exchange,
      abi: perplExchangeAbi,
      functionName: "getFundingSumAtBlock",
      args: [perpId, b],
    })),
  );
  return results.map((r) => {
    const v = ok<readonly [number | bigint, bigint]>(r);
    return v ? { sum: BigInt(v[0]), eventBlock: BigInt(v[1]) } : null;
  });
}

/** The Perpl Exchange a resolver reads: its own `exchange()`, else the deployments file's. */
export async function resolverExchange(ctx: HunchContext, resolver: Address): Promise<Address> {
  try {
    return await ctx.publicClient.readContract({
      address: resolver,
      abi: perplResolverAbi,
      functionName: "exchange",
    });
  } catch {
    return ctx.deployment.external.perpl.exchange;
  }
}

export async function fundingInterval(ctx: HunchContext, exchange: Address): Promise<bigint> {
  return ctx.publicClient.readContract({
    address: exchange,
    abi: perplExchangeAbi,
    functionName: "getFundingInterval",
  });
}

export interface Spike {
  eventBlock: bigint;
  sum: bigint;
  previousEventBlock: bigint;
  previousSum: bigint;
  /** F(e) − F(e − interval): what that one event charged longs, raw units. */
  increment: bigint;
}

export interface SpikeScan {
  /** Events in (startBlock, min(endBlock, head − 1)] that charged more than the threshold, newest first. */
  spikes: Spike[];
  /** Funding events checked. */
  events: number;
  /** "grid": every event sat one interval apart and was read in batches; "walk": read one by one. */
  method: "grid" | "walk" | "none";
  complete: boolean;
  note: string | null;
}

/**
 * Finds single funding events in the window that charged longs more than the threshold. Assumes
 * Perpl's fixed grid first (one batched read); if any event is off the grid, walks back one event at a
 * time instead, so no event is missed.
 */
export async function scanSpikes(
  ctx: HunchContext,
  exchange: Address,
  p: PerplFundingSpikeParams,
  options: { head: bigint; all?: boolean; maxEvents?: number },
): Promise<SpikeScan> {
  const none: SpikeScan = { spikes: [], events: 0, method: "none", complete: true, note: null };
  // An event counts only once its block has passed (the resolver needs e < block.number).
  const top = p.endBlock < options.head - 1n ? p.endBlock : options.head - 1n;
  if (top <= p.startBlock) return none;
  const interval = await fundingInterval(ctx, exchange);
  if (interval === 0n) return { ...none, complete: false, note: "Perpl reports a funding interval of zero." };
  const [end] = await fundingAt(ctx, exchange, p.perpId, [top]);
  if (!end) return { ...none, complete: false, note: "Perpl's funding history could not be read." };
  if (end.eventBlock <= p.startBlock || end.eventBlock === 0n) return none;
  const maxEvents = options.maxEvents ?? 10_000;
  const isSpike = (sum: bigint, prevSum: bigint): boolean => sum - prevSum > p.threshold;

  // Grid pass: candidates e_k = e_top − k · interval, each read at e_k and e_k − 1.
  const candidates: bigint[] = [];
  for (let e = end.eventBlock; e > p.startBlock && candidates.length < maxEvents; e -= interval)
    candidates.push(e);
  const reads = await fundingAt(
    ctx,
    exchange,
    p.perpId,
    candidates.flatMap((e) => [e, e - 1n]),
  );
  let onGrid = true;
  const spikes: Spike[] = [];
  for (let k = 0; k < candidates.length; k++) {
    const e = candidates[k] as bigint;
    const at = reads[2 * k];
    const before = reads[2 * k + 1];
    if (!at || !before || at.eventBlock !== e) {
      onGrid = false;
      break;
    }
    const prevOnGrid = before.eventBlock === e - interval;
    if (!prevOnGrid && e - interval > p.startBlock) {
      onGrid = false;
      break;
    }
    if (prevOnGrid && isSpike(at.sum, before.sum)) {
      spikes.push({
        eventBlock: e,
        sum: at.sum,
        previousEventBlock: before.eventBlock,
        previousSum: before.sum,
        increment: at.sum - before.sum,
      });
    }
  }
  if (onGrid) {
    const complete = candidates.length < maxEvents;
    return {
      spikes: options.all ? spikes : spikes.slice(-1),
      events: candidates.length,
      method: "grid",
      complete,
      note: complete ? null : `Stopped after ${maxEvents} events.`,
    };
  }

  // Walk pass: one event at a time, from the newest back to the window's start.
  const walked: Spike[] = [];
  let e = end.eventBlock;
  let sum = end.sum;
  let events = 0;
  while (e > p.startBlock && events < maxEvents) {
    const [before] = await fundingAt(ctx, exchange, p.perpId, [e - 1n]);
    if (!before)
      return {
        spikes: walked,
        events,
        method: "walk",
        complete: false,
        note: `Read failed at block ${e - 1n}.`,
      };
    events++;
    if (before.eventBlock === e - interval && isSpike(sum, before.sum)) {
      walked.push({
        eventBlock: e,
        sum,
        previousEventBlock: before.eventBlock,
        previousSum: before.sum,
        increment: sum - before.sum,
      });
    }
    if (before.eventBlock === 0n || before.eventBlock >= e) break;
    e = before.eventBlock;
    sum = before.sum;
  }
  const complete = events < maxEvents;
  return {
    spikes: options.all ? walked : walked.slice(-1),
    events,
    method: "walk",
    complete,
    note: complete ? null : `Stopped after ${maxEvents} events.`,
  };
}

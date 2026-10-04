import { type HunchContext, type MarketInfo, readBook } from "@hunch-book/sdk";
import { decodeL2Book, kuruOrderBookAbi, type L2Level } from "@hunch-book/shared";
import { type Abi, type Address, getAddress, type Hex } from "viem";
import { type BookEvent, OrderBookState, sameLevels, sortEvents } from "./orders.js";
import type { Sample } from "./score.js";
import { blockTimes, bookEvents, graduationBlock, mapLimit } from "./sources.js";

// Samples of a market's book every N blocks: each maker's resting orders (rebuilt from Kuru's events
// from the book's first order on) and, with `check`, whether the rebuilt book equals what getL2Book
// returned at that block, so a sample is never scored from a book that drifted from the chain's.

export interface SampleOptions {
  /** First block to sample. */
  from: bigint;
  /** Last block to sample (inclusive). */
  to: bigint;
  /** Blocks between samples. */
  every: bigint;
  /** Where to start replaying Kuru's events; default: the block the market graduated. */
  replayFrom?: bigint;
  /** Compare every sample with getL2Book at its block (needs an RPC that keeps past state). */
  check?: boolean;
}

export interface MarketSamples {
  market: Address;
  book: Address;
  replayFrom: bigint;
  events: number;
  samples: (Sample & { l2Match?: boolean | null })[];
}

async function l2At(
  ctx: HunchContext,
  book: Address,
  block: bigint,
): Promise<{ bids: L2Level[]; asks: L2Level[] } | null> {
  try {
    const data = await ctx.publicClient.readContract({
      address: book,
      abi: kuruOrderBookAbi as Abi,
      functionName: "getL2Book",
      args: [],
      blockNumber: block,
    });
    const l2 = decodeL2Book(data as Hex);
    return { bids: l2.bids, asks: l2.asks };
  } catch {
    return null;
  }
}

/** Replays a market's book and samples it every `every` blocks in [from, to]. */
export async function sampleMarket(
  ctx: HunchContext,
  m: MarketInfo,
  options: SampleOptions,
): Promise<MarketSamples> {
  if (!m.book) throw new Error(`Market #${m.id} has no book.`);
  const book = m.book;
  const params = (await readBook(ctx, book, m.address)).params;
  const replayFrom =
    options.replayFrom ??
    (await graduationBlock(ctx, m.address, BigInt(ctx.deployment.hunchBook.deployBlock ?? 0), options.to)) ??
    options.from;
  const events = sortEvents(
    await bookEvents(ctx, book, replayFrom, options.to, { pricePrecision: params.pricePrecision }),
  );
  const state = new OrderBookState();
  const sampleBlocks: bigint[] = [];
  for (let b = options.from; b <= options.to; b += options.every) sampleBlocks.push(b);
  const times = await blockTimes(ctx, sampleBlocks);
  const samples: MarketSamples["samples"] = [];
  let i = 0;
  for (const b of sampleBlocks) {
    while (i < events.length && (events[i] as BookEvent).block <= b) state.apply(events[i++] as BookEvent);
    samples.push({
      market: getAddress(m.address),
      block: b,
      time: Number(times.get(b) ?? 0n),
      orders: state.resting(),
    });
  }
  if (options.check) {
    const l2s = await mapLimit(sampleBlocks, 5, (b) => l2At(ctx, book, b));
    samples.forEach((s, k) => {
      const l2 = l2s[k];
      const rebuilt = new OrderBookState();
      rebuilt.applyAll(s.orders.map((o, n) => ({ kind: "created", block: s.block, logIndex: n, ...o })));
      s.l2Match = l2 ? sameLevels(rebuilt.levels(), l2) : null;
    });
  }
  return { market: getAddress(m.address), book, replayFrom, events: events.length, samples };
}

// ---------------------------------------------------------------- the samples file (JSON lines)

export function sampleToLine(s: Sample & { l2Match?: boolean | null }): string {
  return JSON.stringify({
    market: s.market,
    block: s.block.toString(),
    time: s.time ?? null,
    l2Match: s.l2Match ?? null,
    orders: s.orders.map((o) => ({
      orderId: o.orderId.toString(),
      owner: o.owner,
      price: o.price.toString(),
      size: o.size.toString(),
      isBuy: o.isBuy,
    })),
  });
}

export function sampleFromLine(line: string): Sample & { l2Match?: boolean | null } {
  const j = JSON.parse(line) as {
    market: Address;
    block: string;
    time: number | null;
    l2Match: boolean | null;
    orders: { orderId: string; owner: Address; price: string; size: string; isBuy: boolean }[];
  };
  return {
    market: getAddress(j.market),
    block: BigInt(j.block),
    ...(j.time === null ? {} : { time: j.time }),
    l2Match: j.l2Match,
    orders: j.orders.map((o) => ({
      orderId: BigInt(o.orderId),
      owner: getAddress(o.owner),
      price: BigInt(o.price),
      size: BigInt(o.size),
      isBuy: o.isBuy,
    })),
  };
}

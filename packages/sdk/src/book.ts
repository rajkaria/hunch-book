import {
  bookDepth,
  decodeL2Book,
  HUNCH_BOOK_PARAMS,
  type KuruMatchParams,
  kuruOrderBookAbi,
  type L2Level,
  midPrice,
  ONE_USDC,
} from "@hunch-book/shared";
import type { Abi, Address, Hex } from "viem";
import type { HunchContext } from "./context.js";
import { type MarketInfo, requireMarket } from "./markets.js";
import { multicall, ok } from "./multicall.js";

// A market's Kuru YES/USDC book, read onchain: every resting level from `getL2Book()` and the
// matching parameters from `getMarketParams()` (docs/PROTOCOL.md §8.1: the onchain book is the source
// of truth). Quotes walk these levels with Kuru's own integer arithmetic.

export interface BookLevelE6 {
  /** USDC base units per whole YES token. */
  priceE6: bigint;
  /** YES base units resting at this price. */
  size: bigint;
}

export interface OrderBook {
  market: Address;
  book: Address;
  /** The block the levels were read at. */
  block: bigint;
  /** Best (highest) bid first, in the book's own units. */
  bids: L2Level[];
  /** Best (lowest) ask first, in the book's own units. */
  asks: L2Level[];
  params: KuruMatchParams;
  /** Mid of the best bid and ask, E6, when both sides have orders. */
  midE6: bigint | null;
  /** Best ask minus best bid, E6, when both sides have orders. */
  spreadE6: bigint | null;
  depth: { bidSize: bigint; bidValue: bigint; askSize: bigint; askCost: bigint };
}

type RawParams = readonly [
  number,
  bigint,
  Address,
  bigint,
  Address,
  bigint,
  number,
  bigint,
  bigint,
  bigint,
  bigint,
];

/** Kuru's `getMarketParams()` as matching parameters. */
export function matchParams(raw: RawParams): KuruMatchParams {
  return {
    pricePrecision: BigInt(raw[0]),
    sizePrecision: raw[1],
    baseDecimals: Number(raw[3]),
    quoteDecimals: Number(raw[5]),
    takerFeeBps: raw[9],
  };
}

/** A price in the book's units as USDC base units per whole YES token. */
export function toE6(price: bigint, params: KuruMatchParams): bigint {
  return (price * ONE_USDC) / params.pricePrecision;
}

/** Reads a book by its address. */
export async function readBook(
  ctx: HunchContext,
  book: Address,
  market: Address,
  options: { blockNumber?: bigint } = {},
): Promise<OrderBook> {
  const results = await multicall(
    ctx,
    [
      { address: book, abi: kuruOrderBookAbi as Abi, functionName: "getL2Book", args: [] },
      { address: book, abi: kuruOrderBookAbi as Abi, functionName: "getMarketParams" },
    ],
    options,
  );
  const data = ok<Hex>(results[0]);
  if (data === undefined) throw new Error(`Could not read the Kuru book ${book}.`);
  const raw = ok<RawParams>(results[1]);
  const params = raw ? matchParams(raw) : HUNCH_BOOK_PARAMS;
  const l2 = decodeL2Book(data);
  const mid = midPrice(l2);
  const bid = l2.bids[0]?.price;
  const ask = l2.asks[0]?.price;
  return {
    market,
    book,
    block: l2.block,
    bids: l2.bids,
    asks: l2.asks,
    params,
    midE6: mid === null ? null : toE6(mid, params),
    spreadE6: bid === undefined || ask === undefined ? null : toE6(ask - bid, params),
    depth: bookDepth(l2, params),
  };
}

/** A market's book, or a plain error when it has none yet. */
export async function getOrderBook(ctx: HunchContext, market: Address | MarketInfo): Promise<OrderBook> {
  const m = await requireMarket(ctx, market);
  if (!m.book) throw new Error(`Market #${m.id} has no Kuru book yet: it trades only after graduation.`);
  return readBook(ctx, m.book, m.address);
}

/** Levels in E6 prices, for display and JSON. */
export function levelsE6(levels: readonly L2Level[], params: KuruMatchParams): BookLevelE6[] {
  return levels.map((l) => ({ priceE6: toE6(l.price, params), size: l.size }));
}

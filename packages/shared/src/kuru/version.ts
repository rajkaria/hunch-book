import { KURU_BEST_PRICE_SCALE, KURU_EMPTY_ASK, KURU_EMPTY_BID } from "./abis.js";
import type { L2Book, L2Level } from "./l2book.js";
import { KURU_V2_EMPTY_HIGH, KURU_V2_EMPTY_LOW } from "./v2abis.js";

/**
 * Which Kuru exchange a stack's books live on (docs/PROTOCOL.md §8.1). v1: Router + MarginAccount,
 * `bestBidAsk()` at 1e18, `getL2Book()` as packed bytes, fees in bps. v2: SpotRouter + AccountCore,
 * `bestBidAsk()` as two uint32 in pricePrecision units, `getL2Book(levels)` as four arrays, fees in pps.
 */
export type KuruVersion = 1 | 2;

/** Best YES prices in pricePrecision units (E6 on Hunch books); null for an empty side. */
export interface BestPrices {
  bid: bigint | null;
  ask: bigint | null;
}

const isV2Empty = (v: bigint): boolean => v === KURU_V2_EMPTY_LOW || v >= KURU_V2_EMPTY_HIGH;

/**
 * A v2 `bestBidAsk()` result. Either sentinel (0 or 2^32 - 1) means empty on either side, and so does
 * anything that does not fit a uint32 (the same rule as BookPrice.yesQuoteV2 onchain).
 */
export function bestPricesV2(bid: bigint, ask: bigint): BestPrices {
  return { bid: isV2Empty(bid) ? null : bid, ask: isV2Empty(ask) ? null : ask };
}

/**
 * A v1 `bestBidAsk()` result (1e18 scale) in pricePrecision units: bids round down, asks up, so a price
 * read here is never better than the book (BookPrice.yesQuote onchain).
 */
export function bestPricesV1(bid: bigint, ask: bigint, pricePrecision: bigint): BestPrices {
  const scale = KURU_BEST_PRICE_SCALE / pricePrecision;
  return {
    bid: bid === KURU_EMPTY_BID || bid === 0n ? null : bid / scale,
    ask: ask === KURU_EMPTY_ASK || ask === KURU_EMPTY_BID ? null : (ask + scale - 1n) / scale,
  };
}

/** `bestBidAsk()` of either version in pricePrecision units. */
export function bestPrices(
  version: KuruVersion,
  bid: bigint,
  ask: bigint,
  pricePrecision: bigint,
): BestPrices {
  return version === 2 ? bestPricesV2(bid, ask) : bestPricesV1(bid, ask, pricePrecision);
}

/**
 * A v2 `bestBidAsk()` in v1's shape (1e18 scale, empty bid = 2^256 - 1, empty ask = 0), for code written
 * against v1 values. Exact: a v2 price p becomes p * 1e18 / pricePrecision.
 */
export function bestBidAskV2AsV1(
  bid: bigint,
  ask: bigint,
  pricePrecision: bigint,
): readonly [bigint, bigint] {
  const p = bestPricesV2(bid, ask);
  const scale = KURU_BEST_PRICE_SCALE / pricePrecision;
  return [
    p.bid === null ? KURU_EMPTY_BID : p.bid * scale,
    p.ask === null ? KURU_EMPTY_ASK : p.ask * scale,
  ] as const;
}

/** The arrays a v2 `getL2Book(levels)` returns. */
export type KuruV2L2Result = readonly [
  readonly (number | bigint)[],
  readonly (number | bigint)[],
  readonly (number | bigint)[],
  readonly (number | bigint)[],
];

/** A v2 `getL2Book(levels)` result as an L2Book (`block` is the block the read was made at). */
export function l2BookFromV2(result: KuruV2L2Result, block: bigint): L2Book {
  const zip = (prices: readonly (number | bigint)[], sizes: readonly (number | bigint)[]): L2Level[] => {
    if (prices.length !== sizes.length) throw new Error("malformed v2 L2 book: price and size counts differ");
    const out: L2Level[] = [];
    for (let i = 0; i < prices.length; i++) {
      const size = BigInt(sizes[i] as number | bigint);
      if (size === 0n) continue;
      out.push({ price: BigInt(prices[i] as number | bigint), size });
    }
    return out;
  };
  return { block, bids: zip(result[0], result[1]), asks: zip(result[2], result[3]) };
}

/** A stack's Kuru version from its `kuruVersion` field (absent = 1). */
export function kuruVersionOf(stack: { kuruVersion?: number }): KuruVersion {
  return stack.kuruVersion === 2 ? 2 : 1;
}

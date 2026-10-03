import { type Hex, size as hexSize, hexToBigInt, slice } from "viem";
import { KURU_BEST_PRICE_SCALE, KURU_EMPTY_ASK, KURU_EMPTY_BID } from "./abis.js";

/** One price level. `price` is in the book's pricePrecision units, `size` in its sizePrecision units. */
export interface L2Level {
  price: bigint;
  size: bigint;
}

export interface L2Book {
  /** The block the view was read at. */
  block: bigint;
  /** Best (highest) bid first. */
  bids: L2Level[];
  /** Best (lowest) ask first. */
  asks: L2Level[];
}

/**
 * Decodes the bytes returned by Kuru's `getL2Book()`: 32-byte words laid out as
 * `[block][bid price, bid size]... [0][ask price, ask size]...`. Prices are never zero, so the
 * single zero word separates bids from asks.
 */
export function decodeL2Book(data: Hex): L2Book {
  const length = hexSize(data);
  if (length % 32 !== 0 || length < 64) throw new Error(`malformed L2 book: ${length} bytes`);
  const words: bigint[] = [];
  for (let offset = 0; offset < length; offset += 32) {
    words.push(hexToBigInt(slice(data, offset, offset + 32)));
  }
  const block = words[0] as bigint;
  const bids: L2Level[] = [];
  const asks: L2Level[] = [];
  let i = 1;
  while (i < words.length && words[i] !== 0n) {
    bids.push(level(words, i));
    i += 2;
  }
  if (words[i] !== 0n) throw new Error("malformed L2 book: no separator between bids and asks");
  i += 1;
  while (i < words.length) {
    asks.push(level(words, i));
    i += 2;
  }
  return { block, bids, asks };
}

function level(words: bigint[], i: number): L2Level {
  const price = words[i];
  const size = words[i + 1];
  if (price === undefined || size === undefined) throw new Error("malformed L2 book: odd price/size pair");
  return { price, size };
}

/** `bestBidAsk()` with Kuru's empty-side sentinels replaced by `null`, still at 1e18 scale. */
export function decodeBestBidAsk(bid: bigint, ask: bigint): { bid: bigint | null; ask: bigint | null } {
  return { bid: bid === KURU_EMPTY_BID ? null : bid, ask: ask === KURU_EMPTY_ASK ? null : ask };
}

/** Converts a 1e18-scale `bestBidAsk()` price to the book's pricePrecision units. */
export function bestPriceToPrecision(price: bigint, pricePrecision: bigint): bigint {
  return (price * pricePrecision) / KURU_BEST_PRICE_SCALE;
}

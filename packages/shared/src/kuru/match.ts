import { BPS } from "../math.js";
import type { L2Level } from "./l2book.js";

// Kuru's integer arithmetic for wallet-path market orders, walked over the resting levels that
// `getL2Book()` returns. It reproduces what Kuru's OrderBook does (and what contracts/test/mocks/
// MockKuruOrderBook.sol models, checked against the real book in the fork suites), so a quote here
// equals what the chain will do against the same book. Resting orders only: Hunch books leave Kuru's
// AMM vault empty (docs/PROTOCOL.md §8.1).

/** The parts of a Kuru market's params that matching depends on (from `getMarketParams()`). */
export interface KuruMatchParams {
  /** Prices are quote per one base, scaled by this. */
  pricePrecision: bigint;
  /** Sizes are base, scaled by this. */
  sizePrecision: bigint;
  baseDecimals: number;
  quoteDecimals: number;
  takerFeeBps: bigint;
}

/** Every Hunch book: 6-decimal YES and USDC with both precisions at 1e6, so book units are token units. */
export const HUNCH_BOOK_PARAMS: KuruMatchParams = {
  pricePrecision: 1_000_000n,
  sizePrecision: 1_000_000n,
  baseDecimals: 6,
  quoteDecimals: 6,
  takerFeeBps: 0n,
};

const ceilDiv = (a: bigint, b: bigint): bigint => (a === 0n ? 0n : (a - 1n) / b + 1n);
const pow10 = (n: number): bigint => 10n ** BigInt(n);

export interface MarketBuyFill {
  /** Base credited to the taker after the fee, in base token units. */
  baseOut: bigint;
  /** Gross base matched, in sizePrecision units. */
  filled: bigint;
  /** Kuru's taker fee, in base token units. */
  fee: bigint;
  /** Quote returned because the asks ran out, in quote token units. */
  refund: bigint;
  /** Ask levels the order touched. */
  levels: number;
  /** True when the asks ran out before the quote was spent. */
  exhausted: boolean;
}

/**
 * A market buy of `quoteIn` (pricePrecision units). At each ask level (price p, size s) Kuru computes
 * F = floor(q · sP / p); if F <= s it fills F and stops (the truncated remainder of q stays with Kuru);
 * otherwise it fills s and continues with q = floor(p · (F − s) / sP). Quote left when the asks run out
 * is refunded.
 */
export function simulateMarketBuy(
  asks: readonly L2Level[],
  quoteIn: bigint,
  p: KuruMatchParams,
): MarketBuyFill {
  let q = quoteIn;
  let filled = 0n;
  let levels = 0;
  for (const level of asks) {
    if (q <= 0n) break;
    if (level.price <= 0n) break;
    levels += 1;
    const fillable = (q * p.sizePrecision) / level.price;
    if (fillable <= level.size) {
      filled += fillable;
      q = 0n;
    } else {
      filled += level.size;
      q = (level.price * (fillable - level.size)) / p.sizePrecision;
    }
  }
  let baseOut = 0n;
  let fee = 0n;
  if (filled !== 0n) {
    const gross = (filled * pow10(p.baseDecimals)) / p.sizePrecision;
    fee = ceilDiv(gross * p.takerFeeBps, BPS);
    baseOut = gross - fee;
  }
  const refund = q > 0n ? (q * pow10(p.quoteDecimals)) / p.pricePrecision : 0n;
  return { baseOut, filled, fee, refund, levels, exhausted: q > 0n };
}

export interface MarketSellFill {
  /** Quote credited to the taker after the fee, in quote token units. */
  quoteOut: bigint;
  /** Base matched, in sizePrecision units. */
  filled: bigint;
  /** Kuru's taker fee, in quote token units. */
  fee: bigint;
  /** Base returned because the bids ran out, in base token units. */
  refund: bigint;
  levels: number;
  exhausted: boolean;
}

/**
 * A market sell of `sizeIn` (sizePrecision units). Each bid level pays floor(filled · p / sP); the sum,
 * converted to quote token units, is credited minus the taker fee. Size left when the bids run out is
 * refunded. If the quote credited rounds to zero, Kuru credits nothing.
 */
export function simulateMarketSell(
  bids: readonly L2Level[],
  sizeIn: bigint,
  p: KuruMatchParams,
): MarketSellFill {
  let s = sizeIn;
  let quote = 0n;
  let levels = 0;
  for (const level of bids) {
    if (s <= 0n) break;
    levels += 1;
    const f = s < level.size ? s : level.size;
    quote += (f * level.price) / p.sizePrecision;
    s -= f;
  }
  let quoteOut = 0n;
  let fee = 0n;
  if (quote !== 0n) {
    const gross = (quote * pow10(p.quoteDecimals)) / p.pricePrecision;
    fee = ceilDiv(gross * p.takerFeeBps, BPS);
    quoteOut = gross - fee;
  }
  const refund = s > 0n ? (s * pow10(p.baseDecimals)) / p.sizePrecision : 0n;
  return { quoteOut, filled: sizeIn - s, fee, refund, levels, exhausted: s > 0n };
}

/**
 * The smallest quote (pricePrecision units) whose market buy credits at least `baseOut` (sizePrecision
 * units) after the taker fee, or null if the asks cannot supply it. The same backward recurrence as
 * HunchRouter._quoteForExactBase, which `sellNo` borrows and spends:
 *   G = ceil(baseOut · 1e4 / (1e4 − f)); k = first level where the cumulative size reaches G;
 *   Q_k = ceil(need · p_k / sP); Q_i = ceil((s_i + ceil(Q_{i+1} · sP / p_i)) · p_i / sP).
 */
export function quoteForExactBase(
  asks: readonly L2Level[],
  baseOut: bigint,
  p: KuruMatchParams,
): bigint | null {
  if (baseOut <= 0n) return null;
  if (p.takerFeeBps >= BPS) return null;
  const gross = ceilDiv(baseOut * BPS, BPS - p.takerFeeBps);
  let cumulative = 0n;
  let k = -1;
  for (let j = 0; j < asks.length; j++) {
    cumulative += (asks[j] as L2Level).size;
    if (cumulative >= gross) {
      k = j;
      break;
    }
  }
  if (k < 0) return null;
  const last = asks[k] as L2Level;
  if (last.price <= 0n) return null;
  const need = gross - (cumulative - last.size);
  let quote = ceilDiv(need * last.price, p.sizePrecision);
  for (let i = k - 1; i >= 0; i--) {
    const level = asks[i] as L2Level;
    if (level.price <= 0n) return null;
    const fill = level.size + ceilDiv(quote * p.sizePrecision, level.price);
    quote = ceilDiv(fill * level.price, p.sizePrecision);
  }
  return quote;
}

export interface BookDepth {
  /** Total resting ask size, sizePrecision units. */
  askSize: bigint;
  /** Quote that buys every resting ask: Σ ceil(p · s / sP), pricePrecision units. */
  askCost: bigint;
  /** Total resting bid size, sizePrecision units. */
  bidSize: bigint;
  /** Quote every resting bid pays: Σ floor(p · s / sP), pricePrecision units. */
  bidValue: bigint;
}

export function bookDepth(
  book: { bids: readonly L2Level[]; asks: readonly L2Level[] },
  p: KuruMatchParams,
): BookDepth {
  let askSize = 0n;
  let askCost = 0n;
  for (const l of book.asks) {
    askSize += l.size;
    askCost += ceilDiv(l.price * l.size, p.sizePrecision);
  }
  let bidSize = 0n;
  let bidValue = 0n;
  for (const l of book.bids) {
    bidSize += l.size;
    bidValue += (l.price * l.size) / p.sizePrecision;
  }
  return { askSize, askCost, bidSize, bidValue };
}

/** One ladder row: a level with the running total from the touch outward. */
export interface DepthRow extends L2Level {
  cumulative: bigint;
}

/** Adds the cumulative size from the best price outward. */
export function withCumulative(levels: readonly L2Level[]): DepthRow[] {
  let running = 0n;
  return levels.map((l) => {
    running += l.size;
    return { price: l.price, size: l.size, cumulative: running };
  });
}

import type { L2Level } from "./kuru/l2book.js";
import {
  bookDepth,
  type KuruMatchParams,
  quoteForExactBase,
  simulateMarketBuy,
  simulateMarketSell,
} from "./kuru/match.js";
import { BPS } from "./math.js";
import { ONE_USDC } from "./types.js";

// Quotes for HunchRouter's four paths (docs/PROTOCOL.md §5.4), from a Kuru L2 book read. Each one
// follows the router's own arithmetic (contracts/src/core/HunchRouter.sol), so the numbers a trader is
// shown are what the router would do against that book. Amounts are 6-decimal base units: Hunch books
// quote USDC base units per YES base unit (pricePrecision = sizePrecision = 1e6).

export type TradeKind = "buyYes" | "sellYes" | "buyNo" | "sellNo";

export const TRADE_KINDS: readonly TradeKind[] = ["buyYes", "sellYes", "buyNo", "sellNo"];

export interface TradeBook {
  /** Best (highest) bid first. */
  bids: readonly L2Level[];
  /** Best (lowest) ask first. */
  asks: readonly L2Level[];
}

/** Why a quote cannot be sent as it is. */
export type Shortfall =
  /** The side of the book this trade needs has no orders. */
  | "empty"
  /** The book cannot fill the whole amount. */
  | "liquidity"
  /** The amount is too small to fill anything. */
  | "dust"
  /** Selling NO would cost more YES than the merge returns (asks above 1 USDC). */
  | "price";

export interface TradeQuote {
  kind: TradeKind;
  /** The router call's amount argument: usdcIn, yesIn, noOut or noIn. */
  amount: bigint;
  /** USDC the trader pays (buys) or receives (sells). */
  usdc: bigint;
  /** Tokens the trader receives (buys) or gives up (sells), of the side traded. */
  tokens: bigint;
  /** What the router sends back besides the main output: unspent USDC, unsold YES, extra YES. */
  returned: { usdc: bigint; yes: bigint };
  /** USDC per token of the traded side, scaled by 1e6. Null when nothing fills. */
  avgPriceE6: bigint | null;
  /** Book levels the trade touches. */
  levels: number;
  shortfall: Shortfall | null;
}

const ceilDiv = (a: bigint, b: bigint): bigint => (a === 0n ? 0n : (a - 1n) / b + 1n);

function avgPrice(usdc: bigint, tokens: bigint): bigint | null {
  return tokens > 0n ? (usdc * ONE_USDC) / tokens : null;
}

/** buyYes(market, usdcIn, minYesOut, deadline): market-buy YES with USDC; unspent USDC comes back. */
export function quoteBuyYes(book: TradeBook, usdcIn: bigint, p: KuruMatchParams): TradeQuote {
  const fill = simulateMarketBuy(book.asks, usdcIn, p);
  const spent = usdcIn - fill.refund;
  let shortfall: Shortfall | null = null;
  if (book.asks.length === 0) shortfall = "empty";
  else if (fill.baseOut === 0n) shortfall = "dust";
  else if (fill.exhausted) shortfall = "liquidity";
  return {
    kind: "buyYes",
    amount: usdcIn,
    usdc: spent,
    tokens: fill.baseOut,
    returned: { usdc: fill.refund, yes: 0n },
    avgPriceE6: avgPrice(spent, fill.baseOut),
    levels: fill.levels,
    shortfall,
  };
}

/** sellYes(market, yesIn, minUsdcOut, deadline): market-sell YES; YES the bids cannot take comes back. */
export function quoteSellYes(book: TradeBook, yesIn: bigint, p: KuruMatchParams): TradeQuote {
  const fill = simulateMarketSell(book.bids, yesIn, p);
  const sold = yesIn - fill.refund;
  let shortfall: Shortfall | null = null;
  if (book.bids.length === 0) shortfall = "empty";
  else if (fill.quoteOut === 0n) shortfall = "dust";
  else if (fill.exhausted) shortfall = "liquidity";
  return {
    kind: "sellYes",
    amount: yesIn,
    usdc: fill.quoteOut,
    tokens: sold,
    returned: { usdc: 0n, yes: fill.refund },
    avgPriceE6: avgPrice(fill.quoteOut, sold),
    levels: fill.levels,
    shortfall,
  };
}

/**
 * buyNo(market, noOut, maxUsdcIn, deadline): mint `k` sets for k USDC, sell the k YES fill-or-kill,
 * deliver k NO. The trader pays k − proceeds (nothing, plus the excess back, if proceeds exceed k).
 */
export function quoteBuyNo(book: TradeBook, k: bigint, p: KuruMatchParams): TradeQuote {
  const fill = simulateMarketSell(book.bids, k, p);
  const proceeds = fill.quoteOut;
  const cost = proceeds >= k ? 0n : k - proceeds;
  const excess = proceeds > k ? proceeds - k : 0n;
  let shortfall: Shortfall | null = null;
  if (book.bids.length === 0) shortfall = "empty";
  else if (fill.exhausted) shortfall = "liquidity";
  return {
    kind: "buyNo",
    amount: k,
    usdc: cost,
    tokens: k,
    returned: { usdc: excess, yes: 0n },
    avgPriceE6: avgPrice(cost, k),
    levels: fill.levels,
    shortfall,
  };
}

/**
 * sellNo(market, noIn, minUsdcOut, deadline): borrow Q (the least quote that buys k YES after the fee),
 * buy YES, merge k sets into k USDC, repay Q. The trader receives k − Q plus any quote Kuru refunds, and
 * any YES credited above k.
 */
export function quoteSellNo(book: TradeBook, k: bigint, p: KuruMatchParams): TradeQuote {
  const empty: TradeQuote = {
    kind: "sellNo",
    amount: k,
    usdc: 0n,
    tokens: k,
    returned: { usdc: 0n, yes: 0n },
    avgPriceE6: null,
    levels: 0,
    shortfall: book.asks.length === 0 ? "empty" : "liquidity",
  };
  if (book.asks.length === 0 || k <= 0n) return { ...empty, shortfall: k <= 0n ? "dust" : "empty" };
  const borrow = quoteForExactBase(book.asks, k, p);
  if (borrow === null) return empty;
  const fill = simulateMarketBuy(book.asks, borrow, p);
  const received = k + fill.refund;
  if (received < borrow) return { ...empty, levels: fill.levels, shortfall: "price" };
  const usdc = received - borrow;
  return {
    kind: "sellNo",
    amount: k,
    usdc,
    tokens: k,
    returned: { usdc: 0n, yes: fill.baseOut > k ? fill.baseOut - k : 0n },
    avgPriceE6: avgPrice(usdc, k),
    levels: fill.levels,
    shortfall: null,
  };
}

export function quoteTrade(kind: TradeKind, book: TradeBook, amount: bigint, p: KuruMatchParams): TradeQuote {
  switch (kind) {
    case "buyYes":
      return quoteBuyYes(book, amount, p);
    case "sellYes":
      return quoteSellYes(book, amount, p);
    case "buyNo":
      return quoteBuyNo(book, amount, p);
    case "sellNo":
      return quoteSellNo(book, amount, p);
  }
}

/** True for the paths where the trader pays USDC. */
export const isBuy = (kind: TradeKind): boolean => kind === "buyYes" || kind === "buyNo";

/** The side of the token traded. */
export const tradeSide = (kind: TradeKind): "yes" | "no" =>
  kind === "buyYes" || kind === "sellYes" ? "yes" : "no";

/**
 * The router's limit argument after a slippage allowance in basis points: minYesOut (buyYes),
 * minUsdcOut (sellYes, sellNo) rounded down, or maxUsdcIn (buyNo) rounded up.
 */
export function tradeLimit(quote: TradeQuote, slippageBps: bigint): bigint {
  const bps = slippageBps < 0n ? 0n : slippageBps > BPS ? BPS : slippageBps;
  switch (quote.kind) {
    case "buyYes":
      return (quote.tokens * (BPS - bps)) / BPS;
    case "buyNo":
      return ceilDiv(quote.usdc * (BPS + bps), BPS);
    default:
      return (quote.usdc * (BPS - bps)) / BPS;
  }
}

/** The token the router pulls from the trader and how much it must be approved for. */
export function tradeApproval(
  kind: TradeKind,
  amount: bigint,
  limit: bigint,
): { token: "usdc" | "yes" | "no"; amount: bigint } {
  switch (kind) {
    case "buyYes":
      return { token: "usdc", amount };
    case "buyNo":
      return { token: "usdc", amount: limit };
    case "sellYes":
      return { token: "yes", amount };
    case "sellNo":
      return { token: "no", amount };
  }
}

/** The YES mid in pricePrecision units, only when both sides have orders. */
export function midPrice(book: TradeBook): bigint | null {
  const bid = book.bids[0]?.price;
  const ask = book.asks[0]?.price;
  if (bid === undefined || ask === undefined) return null;
  return (bid + ask) / 2n;
}

/**
 * How much worse the average price is than the mid, in basis points of the mid (0 or more is worse for
 * the trader). For NO the mid is 1 − YES mid. Null without a two-sided book or a fill.
 */
export function priceImpactBps(quote: TradeQuote, book: TradeBook, p: KuruMatchParams): bigint | null {
  const yesMid = midPrice(book);
  if (yesMid === null || quote.avgPriceE6 === null) return null;
  const midE6 = (yesMid * ONE_USDC) / p.pricePrecision;
  const mid = tradeSide(quote.kind) === "yes" ? midE6 : ONE_USDC - midE6;
  if (mid <= 0n) return null;
  const diff = isBuy(quote.kind) ? quote.avgPriceE6 - mid : mid - quote.avgPriceE6;
  return (diff * BPS) / mid;
}

/** The best price for this trade on the touch, USDC per token scaled by 1e6, or null if that side is empty. */
export function touchPrice(kind: TradeKind, book: TradeBook, p: KuruMatchParams): bigint | null {
  const toE6 = (price: bigint): bigint => (price * ONE_USDC) / p.pricePrecision;
  const bid = book.bids[0]?.price;
  const ask = book.asks[0]?.price;
  switch (kind) {
    case "buyYes":
      return ask === undefined ? null : toE6(ask);
    case "sellYes":
      return bid === undefined ? null : toE6(bid);
    case "buyNo":
      return bid === undefined ? null : ONE_USDC - toE6(bid);
    case "sellNo":
      return ask === undefined ? null : ONE_USDC - toE6(ask);
  }
}

/** The largest `k` in [0, hi] for which `fits(k)` holds, given `fits` is true up to some point and false after. */
function largestFitting(hi: bigint, fits: (k: bigint) => boolean): bigint {
  let lo = 0n;
  let top = hi;
  while (lo < top) {
    const mid = (lo + top + 1n) / 2n;
    if (fits(mid)) lo = mid;
    else top = mid - 1n;
  }
  return lo;
}

/**
 * The largest amount this trade can take: limited by the trader's balance (USDC for buys, the token for
 * sells) and by what the book can fill in full.
 */
export function maxTradeAmount(
  kind: TradeKind,
  book: TradeBook,
  p: KuruMatchParams,
  balances: { usdc: bigint; yes: bigint; no: bigint },
): bigint {
  const depth = bookDepth(book, p);
  const min = (a: bigint, b: bigint): bigint => (a < b ? a : b);
  switch (kind) {
    case "buyYes":
      // Per-level rounding means the exact quote that clears the asks can differ from Σ p · s by a few
      // base units, so search for the largest quote Kuru spends in full.
      return largestFitting(
        min(balances.usdc, depth.askCost),
        (q) => !simulateMarketBuy(book.asks, q, p).exhausted,
      );
    case "sellYes":
      return min(balances.yes, depth.bidSize);
    case "buyNo":
      return largestFitting(depth.bidSize, (k) => {
        const q = quoteBuyNo(book, k, p);
        return q.shortfall === null && q.usdc <= balances.usdc;
      });
    case "sellNo":
      return largestFitting(
        min(balances.no, depth.askSize),
        (k) => quoteSellNo(book, k, p).shortfall === null,
      );
  }
}

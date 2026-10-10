import {
  maxTradeAmount,
  ONE_USDC,
  priceImpactBps,
  quoteTrade,
  type TradeKind,
  type TradeQuote,
  touchPrice,
  tradeApproval,
  tradeLimit,
} from "@hunch-book/shared";
import type { Address } from "viem";
import { getOrderBook, type OrderBook } from "./book.js";
import type { HunchContext } from "./context.js";
import type { MarketInfo } from "./markets.js";

// Quotes for the router's four paths (docs/PROTOCOL.md §5.4) against the live order book. The math is
// the shared package's, which follows HunchRouter's and Kuru's integer arithmetic, so a quote equals
// what the router would do against the same book.

export type { TradeKind, TradeQuote };

export const DEFAULT_SLIPPAGE_BPS = 100n;

export interface Quote extends TradeQuote {
  market: Address;
  book: Address;
  /** The block the book was read at. */
  block: bigint;
  /** The slippage allowance the limit uses, in basis points. */
  slippageBps: bigint;
  /** The router's limit argument: minYesOut, minUsdcOut, or maxUsdcIn for buyNo. */
  limit: bigint;
  /** What the trader must approve the router for, and in which token. */
  approval: { token: "usdc" | "yes" | "no"; amount: bigint };
  /** How much worse the average price is than the mid, in basis points. Null without a two-sided book. */
  impactBps: bigint | null;
  /** Best price on the touch for this trade, E6. Null if that side of the book is empty. */
  touchPriceE6: bigint | null;
  /** Mid of the YES book, E6, for NO trades too. */
  midE6: bigint | null;
}

/** The router's limit after a slippage allowance (basis points). */
export function applySlippage(quote: TradeQuote, slippageBps: bigint = DEFAULT_SLIPPAGE_BPS): bigint {
  return tradeLimit(quote, slippageBps);
}

/** A quote against a book already read. Pure. */
export function quoteOnBook(
  book: OrderBook,
  kind: TradeKind,
  amount: bigint,
  slippageBps: bigint = DEFAULT_SLIPPAGE_BPS,
): Quote {
  const q = quoteTrade(kind, book, amount, book.params);
  const limit = tradeLimit(q, slippageBps);
  return {
    ...q,
    market: book.market,
    book: book.book,
    block: book.block,
    slippageBps,
    limit,
    approval: tradeApproval(kind, amount, limit),
    impactBps: priceImpactBps(q, book, book.params),
    touchPriceE6: touchPrice(kind, book, book.params),
    midE6: book.midE6,
  };
}

/** Reads the market's book and quotes `amount` (usdcIn, yesIn, noOut or noIn) for `kind`. */
export async function quote(
  ctx: HunchContext,
  market: Address | MarketInfo,
  kind: TradeKind,
  amount: bigint,
  options: { slippageBps?: bigint } = {},
): Promise<Quote> {
  const book = await getOrderBook(ctx, market);
  return quoteOnBook(book, kind, amount, options.slippageBps);
}

/** The largest amount this trade can take, given the trader's balances and what the book can fill. */
export function maxAmount(
  book: OrderBook,
  kind: TradeKind,
  balances: { usdc: bigint; yes: bigint; no: bigint },
): bigint {
  return maxTradeAmount(kind, book, book.params, balances);
}

/** "0.4160" for 416000 E6. */
export function formatPriceE6(priceE6: bigint | null): string | null {
  if (priceE6 === null) return null;
  const whole = priceE6 / ONE_USDC;
  const frac = (priceE6 % ONE_USDC).toString().padStart(6, "0").slice(0, 4);
  return `${whole}.${frac}`;
}

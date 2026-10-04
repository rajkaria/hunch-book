import {
  BPS,
  bookDepth,
  isBuy,
  maxTradeAmount,
  ONE_USDC,
  Phase,
  priceImpactBps,
  quoteTrade,
  Side,
  type TradeKind,
  type TradeQuote,
  touchPrice,
  tradeApproval,
  tradeLimit,
  tradeSide,
} from "@hunch-book/shared";
import type { Address } from "viem";
import { type BookSnapshot, BookState } from "../chain/kuru";
import type { WalletBalances } from "../chain/reads";
import { formatFixed, formatUsdc } from "../format";

// The trade ticket as pure logic: which router path, the quote, the limit after slippage, the approval it
// needs, and the one reason (if any) the trade cannot be sent. The component only renders this.

export type TradeTab = "buy" | "sell";

export function tradeKindOf(tab: TradeTab, side: Side): TradeKind {
  if (tab === "buy") return side === Side.Yes ? "buyYes" : "buyNo";
  return side === Side.Yes ? "sellYes" : "sellNo";
}

/** What the amount box is denominated in, matching the router call's argument. */
export function amountUnit(kind: TradeKind): "USDC" | "YES" | "NO" {
  if (kind === "buyYes") return "USDC";
  return kind === "sellYes" ? "YES" : "NO";
}

export const TRADE_LABEL: Record<TradeKind, string> = {
  buyYes: "Buy YES",
  sellYes: "Sell YES",
  buyNo: "Buy NO",
  sellNo: "Sell NO",
};

// ---------------------------------------------------------------- slippage and deadline

/** Slippage presets in basis points: 0.5%, 1%, 2%. */
export const SLIPPAGE_PRESETS: readonly bigint[] = [50n, 100n, 200n];
export const DEFAULT_SLIPPAGE_BPS = 100n;
/** Custom slippage is accepted from 0.01% to 50%. */
export const MAX_SLIPPAGE_BPS = 5_000n;

/** "0.5" (percent) to 50 bps. Null for anything outside 0.01% to 50% or more than two decimals. */
export function parseSlippagePercent(input: string): bigint | null {
  const s = input.trim().replace(/%$/, "").trim();
  if (!/^\d*\.?\d{0,2}$/.test(s) || s === "" || s === ".") return null;
  const [whole = "0", frac = ""] = s.split(".");
  const bps = BigInt(whole || "0") * 100n + BigInt(frac.padEnd(2, "0") || "0");
  return bps >= 1n && bps <= MAX_SLIPPAGE_BPS ? bps : null;
}

/** Basis points to "0.5%", "1%", "12.25%". */
export function formatBps(bps: bigint): string {
  const negative = bps < 0n;
  const body = formatFixed(negative ? -bps : bps, 2);
  return `${negative ? "-" : ""}${body}%`;
}

/** The router's deadline: five minutes from now, in unix seconds. */
export const DEADLINE_SECONDS = 300;

export function tradeDeadline(nowSeconds: number): bigint {
  return BigInt(Math.floor(nowSeconds) + DEADLINE_SECONDS);
}

// ---------------------------------------------------------------- prices

/** A 1e6-scaled USDC price per token to "0.416". */
export function formatPriceE6(e6: bigint, decimals = 3): string {
  return formatFixed(e6, 6, { minDecimals: decimals, maxDecimals: decimals });
}

/** A book price (pricePrecision units) as a 1e6-scaled USDC price. */
export function bookPriceE6(price: bigint, pricePrecision: bigint): bigint {
  return (price * ONE_USDC) / pricePrecision;
}

// ---------------------------------------------------------------- evaluation

export interface TicketContext {
  kind: TradeKind;
  /** Parsed amount, or null when the box is empty or invalid. */
  amount: bigint | null;
  slippageBps: bigint;
  phase: Phase;
  router: Address | undefined;
  book: BookSnapshot | null;
  wallet: { connected: boolean; onAppChain: boolean };
  balances: WalletBalances | null;
}

export interface TicketState {
  quote: TradeQuote | null;
  /** minYesOut, minUsdcOut or maxUsdcIn for the router call. */
  limit: bigint | null;
  impactBps: bigint | null;
  /** The approval the router needs, and whether the current allowance already covers it. */
  approval: { token: "usdc" | "yes" | "no"; amount: bigint; needed: boolean } | null;
  /** The largest amount the book and the wallet allow, or null without a book. */
  max: bigint | null;
  /** Why the trade cannot be sent right now, in one sentence. Null when it can. */
  blocker: string | null;
  /** Something to know before sending (a large price impact), or null. */
  warning: string | null;
}

/** An average price this many basis points worse than the best price on the book earns a warning. */
export const HIGH_IMPACT_BPS = 500n;

/** How much worse the average price is than the touch (the best price this trade can get), in bps. */
export function slippageFromTouchBps(quote: TradeQuote, book: BookSnapshot): bigint | null {
  const touch = touchPrice(quote.kind, book, book.params);
  if (touch === null || touch <= 0n || quote.avgPriceE6 === null) return null;
  const diff = isBuy(quote.kind) ? quote.avgPriceE6 - touch : touch - quote.avgPriceE6;
  return (diff * BPS) / touch;
}

const unitAmount = (amount: bigint, unit: string): string => `${formatUsdc(amount, { exact: true })} ${unit}`;

function marketBlocker(ctx: TicketContext): string | null {
  if (!ctx.router) return "The Hunch router is not deployed on this network, so trades cannot be sent.";
  if (ctx.phase === Phase.Pool || ctx.phase === Phase.PoolLocked) {
    return "This market trades on the book only after its pool graduates.";
  }
  if (ctx.phase !== Phase.Graduated) {
    return "Trading through the router stopped at close. Winning tokens redeem after settlement.";
  }
  if (!ctx.book) return "Reading the book...";
  if (ctx.book.state !== BookState.Active) return "Kuru has paused this book, so it cannot trade right now.";
  return null;
}

function bookSideBlocker(kind: TradeKind, book: BookSnapshot): string | null {
  const needsAsks = kind === "buyYes" || kind === "sellNo";
  if (needsAsks && book.asks.length === 0) {
    return kind === "buyYes"
      ? "Nobody is selling YES on the book right now, so there is nothing to buy."
      : "Selling NO buys YES from the asks, and there are none on the book right now.";
  }
  if (!needsAsks && book.bids.length === 0) {
    return kind === "sellYes"
      ? "Nobody is bidding for YES on the book right now, so there is nobody to sell to."
      : "Buying NO sells YES into the bids, and there are none on the book right now.";
  }
  return null;
}

/** Everything the ticket shows, from the inputs. Pure: the same inputs always give the same state. */
export function evaluateTicket(ctx: TicketContext): TicketState {
  const empty: TicketState = {
    quote: null,
    limit: null,
    impactBps: null,
    approval: null,
    max: null,
    blocker: null,
    warning: null,
  };
  const market = marketBlocker(ctx);
  if (market) return { ...empty, blocker: market };
  const book = ctx.book as BookSnapshot;
  const p = book.params;
  const side = bookSideBlocker(ctx.kind, book);
  if (side) return { ...empty, blocker: side };

  const balances = ctx.balances ?? null;
  const max = maxTradeAmount(
    ctx.kind,
    book,
    p,
    balances
      ? { usdc: balances.usdc, yes: balances.yes, no: balances.no }
      : { usdc: 2n ** 96n, yes: 2n ** 96n, no: 2n ** 96n },
  );
  const base: TicketState = { ...empty, max };

  // The quote shows before a wallet connects; sending needs one.
  const walletBlocker = !ctx.wallet.connected
    ? "Connect a browser wallet to trade."
    : !ctx.wallet.onAppChain
      ? "Switch your wallet to this app's network to trade."
      : null;
  if (ctx.amount === null || ctx.amount <= 0n)
    return { ...base, blocker: walletBlocker ?? "Enter an amount." };

  const quote = quoteTrade(ctx.kind, book, ctx.amount, p);
  const limit = tradeLimit(quote, ctx.slippageBps);
  const impactBps = priceImpactBps(quote, book, p);
  const withQuote: TicketState = { ...base, quote, limit, impactBps };

  if (quote.shortfall === "dust") return { ...withQuote, blocker: "That amount is too small to fill." };
  if (quote.shortfall === "price") {
    return { ...withQuote, blocker: "The asks are above 1 USDC, so selling NO now would pay nothing." };
  }
  if (quote.shortfall === "liquidity" || quote.shortfall === "empty") {
    const depth = bookDepth(book, p);
    const capacity =
      ctx.kind === "buyYes"
        ? `The asks hold ${unitAmount(depth.askSize, "YES")}.`
        : ctx.kind === "sellNo"
          ? `The asks hold ${unitAmount(depth.askSize, "YES")} to buy back.`
          : `The bids take ${unitAmount(depth.bidSize, "YES")}.`;
    return {
      ...withQuote,
      blocker: `The book cannot fill that amount. ${capacity} Lower the amount or use Max.`,
    };
  }
  if (ctx.kind === "buyYes" && limit === 0n)
    return { ...withQuote, blocker: "That amount is too small to fill." };
  if (walletBlocker) return { ...withQuote, blocker: walletBlocker };

  const approvalSpec = tradeApproval(ctx.kind, ctx.amount, limit);
  if (balances) {
    const held =
      approvalSpec.token === "usdc"
        ? balances.usdc
        : approvalSpec.token === "yes"
          ? balances.yes
          : balances.no;
    if (approvalSpec.amount > held) {
      const unit = approvalSpec.token === "usdc" ? "USDC" : approvalSpec.token.toUpperCase();
      const what =
        ctx.kind === "buyNo"
          ? `Buying NO can cost up to ${unitAmount(approvalSpec.amount, "USDC")} with your slippage limit.`
          : `That needs ${unitAmount(approvalSpec.amount, unit)}.`;
      return { ...withQuote, blocker: `${what} Your wallet holds ${unitAmount(held, unit)}.` };
    }
  }
  const allowance = balances
    ? approvalSpec.token === "usdc"
      ? balances.allowance.usdcToRouter
      : approvalSpec.token === "yes"
        ? balances.allowance.yesToRouter
        : balances.allowance.noToRouter
    : 0n;
  const approval = { ...approvalSpec, needed: allowance < approvalSpec.amount };
  const fromTouch = slippageFromTouchBps(quote, book);
  const warning =
    fromTouch !== null && fromTouch >= HIGH_IMPACT_BPS
      ? `The average price is ${formatBps(fromTouch)} worse than the best price on the book, because this trade fills several levels. Check it before you send.`
      : null;
  return { ...withQuote, approval, blocker: balances ? null : "Reading your balances...", warning };
}

/** Lines for the quote box: what you pay, what you get, the average price and the limit. */
export interface QuoteLine {
  label: string;
  value: string;
}

export function quoteLines(state: TicketState, slippageBps: bigint): QuoteLine[] {
  const q = state.quote;
  if (!q || state.limit === null) return [];
  const side = tradeSide(q.kind).toUpperCase();
  const lines: QuoteLine[] = [];
  if (isBuy(q.kind)) {
    lines.push({ label: "You pay", value: unitAmount(q.usdc, "USDC") });
    lines.push({ label: "You get", value: unitAmount(q.tokens, side) });
  } else {
    lines.push({ label: "You sell", value: unitAmount(q.tokens, side) });
    lines.push({ label: "You get", value: unitAmount(q.usdc, "USDC") });
  }
  if (q.avgPriceE6 !== null) {
    lines.push({ label: `Average price per ${side}`, value: `${formatPriceE6(q.avgPriceE6, 4)} USDC` });
  }
  if (state.impactBps !== null)
    lines.push({ label: "Price impact vs mid", value: formatBps(state.impactBps) });
  const pct = formatBps(slippageBps);
  if (q.kind === "buyYes")
    lines.push({ label: `Minimum received (${pct})`, value: unitAmount(state.limit, "YES") });
  if (q.kind === "buyNo")
    lines.push({ label: `Maximum paid (${pct})`, value: unitAmount(state.limit, "USDC") });
  if (q.kind === "sellYes" || q.kind === "sellNo") {
    lines.push({ label: `Minimum received (${pct})`, value: unitAmount(state.limit, "USDC") });
  }
  if (q.returned.usdc > 0n) {
    lines.push({
      label: q.kind === "buyNo" ? "Also returned (bids above 1 USDC)" : "Returned unspent",
      value: unitAmount(q.returned.usdc, "USDC"),
    });
  }
  if (q.returned.yes > 0n) {
    lines.push({
      label: q.kind === "sellNo" ? "Extra YES from rounding" : "Returned unsold",
      value: unitAmount(q.returned.yes, "YES"),
    });
  }
  return lines;
}

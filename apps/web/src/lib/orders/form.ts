import { BPS, ONE_USDC, Phase, Side, type TradeKind, tradeApproval } from "@hunch-book/shared";
import type { Address } from "viem";
import { formatUsdc, formatUtc } from "../format";
import { amountUnit, formatBps, formatPriceE6 } from "../trade/ticket";

// Take-profit, stop-loss and limit-buy orders (ConditionalOrders, docs/PERIPHERY.md) as pure logic: the
// order type and side become the contract's kind and condition, the form becomes an OrderRequest, and
// every reason it cannot be placed is one plain sentence. The component only renders this.

/** IHunchRouter.Kind, which ConditionalOrders uses for its order kinds. */
export const OrderKind = { BuyYes: 0, SellYes: 1, BuyNo: 2, SellNo: 3 } as const;
export type OrderKind = (typeof OrderKind)[keyof typeof OrderKind];

/** IConditionalOrders.Condition. */
export const Condition = { AtOrAbove: 0, AtOrBelow: 1 } as const;
export type Condition = (typeof Condition)[keyof typeof Condition];

/** IConditionalOrders.Status. */
export const OrderStatus = { None: 0, Open: 1, Executed: 2, Cancelled: 3 } as const;
export type OrderStatus = (typeof OrderStatus)[keyof typeof OrderStatus];

/** ConditionalOrders.MAX_TIP_BPS: an executor tip is 0 to 0.5% of the output. */
export const MAX_TIP_BPS = 50n;
export const TIP_PRESETS: readonly bigint[] = [0n, 10n, 25n, 50n];
export const DEFAULT_TIP_BPS = 10n;

/** Slippage below the trigger price that the order still accepts. */
export const ORDER_SLIPPAGE_PRESETS: readonly bigint[] = [100n, 200n, 500n];
export const DEFAULT_ORDER_SLIPPAGE_BPS = 200n;

export type OrderType = "takeProfit" | "stopLoss" | "limitBuy";
export const ORDER_TYPES: readonly OrderType[] = ["takeProfit", "stopLoss", "limitBuy"];

export const ORDER_TYPE_LABEL: Record<OrderType, string> = {
  takeProfit: "Take-profit",
  stopLoss: "Stop-loss",
  limitBuy: "Limit buy",
};

export const ORDER_TYPE_HELP: Record<OrderType, string> = {
  takeProfit: "Sells your tokens once the price rises to your trigger or above.",
  stopLoss: "Sells your tokens once the price falls to your trigger or below.",
  limitBuy: "Buys once the price falls to your trigger or below.",
};

export type ExpiryChoice = "1h" | "1d" | "7d" | "close";
export const EXPIRY_CHOICES: readonly ExpiryChoice[] = ["1h", "1d", "7d", "close"];
export const EXPIRY_LABEL: Record<ExpiryChoice, string> = {
  "1h": "1 hour",
  "1d": "1 day",
  "7d": "7 days",
  close: "Until close",
};
const EXPIRY_SECONDS: Record<Exclude<ExpiryChoice, "close">, number> = {
  "1h": 3_600,
  "1d": 86_400,
  "7d": 604_800,
};

const TRADE_KIND: Record<OrderKind, TradeKind> = {
  [OrderKind.BuyYes]: "buyYes",
  [OrderKind.SellYes]: "sellYes",
  [OrderKind.BuyNo]: "buyNo",
  [OrderKind.SellNo]: "sellNo",
};

export const tradeKindOfOrder = (kind: OrderKind): TradeKind => TRADE_KIND[kind];

export const isBuyKind = (kind: OrderKind): boolean => kind === OrderKind.BuyYes || kind === OrderKind.BuyNo;

export const sideOfKind = (kind: OrderKind): Side =>
  kind === OrderKind.BuyYes || kind === OrderKind.SellYes ? Side.Yes : Side.No;

/** The contract's kind and condition for an order type on one side. */
export function orderShape(type: OrderType, side: Side): { kind: OrderKind; condition: Condition } {
  const yes = side === Side.Yes;
  switch (type) {
    case "takeProfit":
      return { kind: yes ? OrderKind.SellYes : OrderKind.SellNo, condition: Condition.AtOrAbove };
    case "stopLoss":
      return { kind: yes ? OrderKind.SellYes : OrderKind.SellNo, condition: Condition.AtOrBelow };
    case "limitBuy":
      return { kind: yes ? OrderKind.BuyYes : OrderKind.BuyNo, condition: Condition.AtOrBelow };
  }
}

/** The order type a stored order is, from its kind and condition. A buy at or above is a breakout buy. */
export function orderTypeOf(kind: OrderKind, condition: Condition): OrderType | "breakoutBuy" {
  if (isBuyKind(kind)) return condition === Condition.AtOrBelow ? "limitBuy" : "breakoutBuy";
  return condition === Condition.AtOrAbove ? "takeProfit" : "stopLoss";
}

/** Which book price the trigger watches, in plain words. NO prices come from the YES book. */
export const TRIGGER_PRICE_LABEL: Record<OrderKind, string> = {
  [OrderKind.BuyYes]: "the YES ask",
  [OrderKind.SellYes]: "the YES bid",
  [OrderKind.BuyNo]: "the NO ask (1 minus the YES bid)",
  [OrderKind.SellNo]: "the NO bid (1 minus the YES ask)",
};

/** True when `price` meets `condition` against `trigger`, as ConditionalOrders checks it. */
export function conditionMet(condition: Condition, price: bigint, trigger: bigint): boolean {
  return condition === Condition.AtOrAbove ? price >= trigger : price <= trigger;
}

/**
 * A price typed as USDC per token ("0.65", ".65") to E6 (650000). Null for anything that is not a price
 * strictly between 0 and 1 USDC with at most 6 decimals.
 */
export function parsePriceE6(input: string): bigint | null {
  const s = input.trim();
  if (!/^\d*\.?\d*$/.test(s) || s === "" || s === ".") return null;
  const [whole = "0", frac = ""] = s.split(".");
  if (frac.length > 6) return null;
  const value = BigInt(whole || "0") * ONE_USDC + BigInt(frac.padEnd(6, "0") || "0");
  return value > 0n && value < ONE_USDC ? value : null;
}

const ceilDiv = (a: bigint, b: bigint): bigint => (a === 0n ? 0n : (a - 1n) / b + 1n);

/**
 * The order's `limit` at its trigger price, after the executor tip and a slippage allowance:
 * the minimum the owner receives (BuyYes in YES, sells in USDC), or for BuyNo the most USDC it may cost.
 * ConditionalOrders checks the limit after the tip, so the tip comes off before the slippage.
 */
export function orderLimit(
  kind: OrderKind,
  amountIn: bigint,
  triggerE6: bigint,
  slippageBps: bigint,
  tipBps: bigint,
): bigint {
  if (amountIn <= 0n || triggerE6 <= 0n) return 0n;
  const keep = (x: bigint): bigint => (x * (BPS - tipBps) * (BPS - slippageBps)) / (BPS * BPS);
  switch (kind) {
    case OrderKind.SellYes:
    case OrderKind.SellNo:
      return keep((amountIn * triggerE6) / ONE_USDC);
    case OrderKind.BuyYes:
      return keep((amountIn * ONE_USDC) / triggerE6);
    case OrderKind.BuyNo: {
      // k NO never cost more than k USDC: the router mints k sets and sells the YES for something.
      const most = ceilDiv(amountIn * triggerE6 * (BPS + slippageBps), ONE_USDC * BPS);
      return most > amountIn ? amountIn : most;
    }
    default:
      return 0n;
  }
}

/** The expiry in unix seconds for a choice, never after the market's close. */
export function orderExpiry(choice: ExpiryChoice, now: number, closeTime: number | null): bigint | null {
  if (choice === "close") return closeTime === null ? null : BigInt(Math.floor(closeTime));
  const at = Math.floor(now) + EXPIRY_SECONDS[choice];
  return BigInt(closeTime === null ? at : Math.min(at, Math.floor(closeTime)));
}

/** What ConditionalOrders.place takes. */
export interface OrderRequest {
  market: Address;
  kind: OrderKind;
  condition: Condition;
  triggerPriceE6: number;
  expiry: bigint;
  executorTipBps: number;
  amountIn: bigint;
  limit: bigint;
}

export type OrderToken = "usdc" | "yes" | "no";
export type TokenAmounts = Record<OrderToken, bigint>;

export interface OrderForm {
  type: OrderType;
  side: Side;
  trigger: string;
  /** Parsed amount in base units, or null when the box is empty or invalid. */
  amount: bigint | null;
  slippageBps: bigint;
  tipBps: bigint;
  expiry: ExpiryChoice;
}

export interface OrderContext {
  market: Address;
  /** The ConditionalOrders address, or undefined where it is not deployed. */
  contract: Address | undefined;
  phase: Phase;
  /** Unix seconds now (the later of the browser's and the chain's clock). */
  now: number;
  /** The market's close in unix seconds (estimated for block-clock markets), or null if unknown. */
  closeTime: number | null;
  wallet: { connected: boolean; onAppChain: boolean };
  /** The wallet's USDC, YES and NO, or null while unread. */
  balances: TokenAmounts | null;
  /** What the wallet has approved ConditionalOrders to move, or null while unread. */
  allowances: TokenAmounts | null;
  /** What the wallet's other open orders can still pull at execution (USDC across every market). */
  committed: TokenAmounts;
  /** The price the trigger watches, on the book now (E6), or null when that side is empty or unread. */
  priceNowE6: bigint | null;
}

export interface OrderEvaluation {
  kind: OrderKind;
  condition: Condition;
  unit: "USDC" | "YES" | "NO";
  triggerE6: bigint | null;
  expiry: bigint | null;
  limit: bigint | null;
  request: OrderRequest | null;
  /** The input token, the allowance every open order including this one needs, and whether it is short. */
  approval: { token: OrderToken; amount: bigint; needed: boolean } | null;
  errors: { trigger?: string; amount?: string; expiry?: string };
  /** Why the order cannot be placed right now, in one sentence. Null when it can. */
  blocker: string | null;
  warnings: string[];
  /** The order in one sentence, once it is complete. */
  summary: string | null;
}

const TOKEN_UNIT: Record<OrderToken, string> = { usdc: "USDC", yes: "YES", no: "NO" };

const amountText = (amount: bigint, unit: string): string => `${formatUsdc(amount, { exact: true })} ${unit}`;

function marketBlocker(ctx: OrderContext): string | null {
  if (!ctx.contract) return "Conditional orders are not deployed on this network yet.";
  if (ctx.phase === Phase.Pool || ctx.phase === Phase.PoolLocked) {
    return "Orders trade on the book, so they open once the pool graduates.";
  }
  if (ctx.phase !== Phase.Graduated) return "This market has closed. Open orders can only be cancelled.";
  if (ctx.closeTime !== null && ctx.closeTime <= ctx.now) {
    return "This market is closing, so new orders could not execute.";
  }
  return null;
}

/** The order in one sentence: what it does, when, and the least it accepts. */
export function orderSentence(
  kind: OrderKind,
  condition: Condition,
  amountIn: bigint,
  triggerE6: bigint,
  limit: bigint,
  expiry: bigint,
): string {
  const side = sideOfKind(kind) === Side.Yes ? "YES" : "NO";
  const when = `once ${TRIGGER_PRICE_LABEL[kind]} is at or ${condition === Condition.AtOrAbove ? "above" : "below"} ${formatPriceE6(triggerE6)} USDC`;
  const until = `Expires ${formatUtc(expiry)}.`;
  switch (kind) {
    case OrderKind.BuyYes:
      return `Spend ${amountText(amountIn, "USDC")} on YES ${when}, for at least ${amountText(limit, "YES")}. ${until}`;
    case OrderKind.BuyNo:
      return `Buy ${amountText(amountIn, "NO")} ${when}, paying at most ${amountText(limit, "USDC")}. ${until}`;
    default:
      return `Sell ${amountText(amountIn, side)} ${when}, for at least ${amountText(limit, "USDC")}. ${until}`;
  }
}

/** Everything the order form shows, from its inputs. Pure: the same inputs always give the same result. */
export function evaluateOrder(form: OrderForm, ctx: OrderContext): OrderEvaluation {
  const { kind, condition } = orderShape(form.type, form.side);
  const unit = amountUnit(tradeKindOfOrder(kind));
  const out: OrderEvaluation = {
    kind,
    condition,
    unit,
    triggerE6: null,
    expiry: null,
    limit: null,
    request: null,
    approval: null,
    errors: {},
    blocker: null,
    warnings: [],
    summary: null,
  };

  const market = marketBlocker(ctx);
  if (market) return { ...out, blocker: market };

  const triggerE6 = form.trigger.trim() === "" ? null : parsePriceE6(form.trigger);
  if (form.trigger.trim() !== "" && triggerE6 === null) {
    out.errors.trigger = "Enter a price between 0 and 1 USDC, for example 0.65.";
  }
  out.triggerE6 = triggerE6;

  const expiry = orderExpiry(form.expiry, ctx.now, ctx.closeTime);
  if (expiry === null) out.errors.expiry = "The close time is not known yet. Pick a fixed expiry.";
  else if (expiry <= BigInt(Math.floor(ctx.now))) out.errors.expiry = "That expiry has already passed.";
  else out.expiry = expiry;

  const tipBps = form.tipBps < 0n ? 0n : form.tipBps > MAX_TIP_BPS ? MAX_TIP_BPS : form.tipBps;
  const amount = form.amount;
  if (triggerE6 !== null && amount !== null && amount > 0n) {
    out.limit = orderLimit(kind, amount, triggerE6, form.slippageBps, tipBps);
    if (out.limit === 0n) {
      out.errors.amount = "That amount is too small: what you would receive rounds to zero.";
    }
  }

  // The input ConditionalOrders pulls at execution, checked against the wallet now.
  if (amount !== null && amount > 0n && out.limit !== null && out.limit > 0n) {
    const spec = tradeApproval(tradeKindOfOrder(kind), amount, out.limit);
    const token = spec.token as OrderToken;
    if (ctx.balances) {
      const held = ctx.balances[token];
      if (spec.amount > held) {
        out.errors.amount =
          kind === OrderKind.BuyNo
            ? `Buying that much NO can cost up to ${amountText(spec.amount, "USDC")}. Your wallet holds ${amountText(held, "USDC")}.`
            : `That needs ${amountText(spec.amount, TOKEN_UNIT[token])}. Your wallet holds ${amountText(held, TOKEN_UNIT[token])}.`;
      } else if (ctx.committed[token] + spec.amount > held) {
        out.warnings.push(
          `Your other open orders can also pull ${amountText(ctx.committed[token], TOKEN_UNIT[token])}. If they execute first, this one may not have enough left and will fail.`,
        );
      }
    }
    const total = ctx.committed[token] + spec.amount;
    const allowance = ctx.allowances?.[token] ?? 0n;
    out.approval = { token, amount: total, needed: allowance < total };
  }

  if (triggerE6 !== null && ctx.priceNowE6 !== null && conditionMet(condition, ctx.priceNowE6, triggerE6)) {
    out.warnings.push(
      `${TRIGGER_PRICE_LABEL[kind].replace(/^the/, "The")} is ${formatPriceE6(ctx.priceNowE6)} now, so this order is triggered as soon as it is placed. Any bot can execute it right away.`,
    );
  }
  if (form.type === "stopLoss") {
    out.warnings.push(
      "A stop-loss sells only if the book pays at least your minimum. In a fast fall it may not fill, and it stays open.",
    );
  }

  if (triggerE6 !== null && amount !== null && amount > 0n && out.limit !== null && out.expiry !== null) {
    out.summary = orderSentence(kind, condition, amount, triggerE6, out.limit, out.expiry);
  }

  const missing =
    triggerE6 === null
      ? "Enter a trigger price."
      : amount === null || amount <= 0n
        ? `Enter an amount in ${unit}.`
        : null;
  const fieldError = out.errors.trigger ?? out.errors.amount ?? out.errors.expiry ?? null;
  const walletBlocker = !ctx.wallet.connected
    ? "Connect a browser wallet to place orders."
    : !ctx.wallet.onAppChain
      ? "Switch your wallet to this app's network to place orders."
      : null;
  out.blocker = fieldError ?? missing ?? walletBlocker ?? (ctx.balances ? null : "Reading your balances...");
  if (out.blocker !== null) return out;

  out.request = {
    market: ctx.market,
    kind,
    condition,
    triggerPriceE6: Number(triggerE6),
    expiry: out.expiry as bigint,
    executorTipBps: Number(tipBps),
    amountIn: amount as bigint,
    limit: out.limit as bigint,
  };
  return out;
}

/** "0.1%" for 10 basis points, "No tip" for 0. */
export function tipLabel(bps: bigint): string {
  return bps === 0n ? "No tip" : formatBps(bps);
}

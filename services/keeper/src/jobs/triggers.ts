import { KURU_EMPTY_BID, Phase } from "@hunch-book/shared";

// When a ConditionalOrders order may execute, as pure functions of the order, the market's YES book
// and the time. They mirror the contract (contracts/src/periphery/ConditionalOrders.sol and
// libraries/BookPrice.sol) so the keeper only simulates orders the contract will call triggered:
// - Kuru's bestBidAsk() is scaled to 1e18; an empty bid reads as type(uint256).max and an empty ask
//   as 0. A zero bid or a max ask is also empty. Bids round down to E6 and asks round up, so a price
//   read here is never better than the book.
// - BuyYes triggers on the YES ask, SellYes on the YES bid, BuyNo on the NO ask (1 − YES bid) and
//   SellNo on the NO bid (1 − YES ask), each floored at 0.
// - AtOrAbove: price >= trigger. AtOrBelow: price <= trigger. An empty side never triggers.
// - An order executes while Open and up to its expiry (inclusive), through the router, which refuses
//   once the market is closed.

export const OrderKind = { BuyYes: 0, SellYes: 1, BuyNo: 2, SellNo: 3 } as const;
export type OrderKind = (typeof OrderKind)[keyof typeof OrderKind];

export const Condition = { AtOrAbove: 0, AtOrBelow: 1 } as const;
export type Condition = (typeof Condition)[keyof typeof Condition];

export const OrderStatus = { None: 0, Open: 1, Executed: 2, Cancelled: 3 } as const;
export type OrderStatus = (typeof OrderStatus)[keyof typeof OrderStatus];

export const KIND_LABEL: Record<OrderKind, string> = {
  [OrderKind.BuyYes]: "buy YES",
  [OrderKind.SellYes]: "sell YES",
  [OrderKind.BuyNo]: "buy NO",
  [OrderKind.SellNo]: "sell NO",
};

/** The fields of IConditionalOrders.Order the trigger looks at. */
export interface TriggerOrder {
  status: number;
  kind: number;
  condition: number;
  triggerPriceE6: number;
  /** Unix seconds, inclusive. */
  expiry: bigint;
}

/** The YES side of the book in E6 (USDC base units per YES), as BookPrice.yesQuote reads it. */
export interface YesQuote {
  hasBid: boolean;
  hasAsk: boolean;
  bid: bigint;
  ask: bigint;
}

const ONE = 1_000_000n;
const SCALE_DOWN = 1_000_000_000_000n;
const MAX = KURU_EMPTY_BID;

/** BookPrice.yesQuote from bestBidAsk()'s raw answer. */
export function yesQuote(bestBid: bigint, bestAsk: bigint): YesQuote {
  const q: YesQuote = { hasBid: false, hasAsk: false, bid: 0n, ask: 0n };
  if (bestBid !== MAX && bestBid !== 0n) {
    q.hasBid = true;
    q.bid = bestBid / SCALE_DOWN;
  }
  if (bestAsk !== 0n && bestAsk !== MAX) {
    q.hasAsk = true;
    q.ask = (bestAsk - 1n) / SCALE_DOWN + 1n;
  }
  return q;
}

const complement = (price: bigint) => (price >= ONE ? 0n : ONE - price);

/** The trigger-side price for `kind` (ConditionalOrders._price). */
export function triggerSidePrice(kind: number, q: YesQuote): { available: boolean; priceE6: bigint } {
  if (kind === OrderKind.BuyYes) return { available: q.hasAsk, priceE6: q.ask };
  if (kind === OrderKind.SellYes) return { available: q.hasBid, priceE6: q.bid };
  if (kind === OrderKind.BuyNo) return { available: q.hasBid, priceE6: complement(q.bid) };
  return { available: q.hasAsk, priceE6: complement(q.ask) };
}

export function conditionMet(condition: number, priceE6: bigint, triggerE6: bigint): boolean {
  return condition === Condition.AtOrAbove ? priceE6 >= triggerE6 : priceE6 <= triggerE6;
}

export type TriggerDecision =
  | { execute: true; priceE6: bigint; reason: string }
  | { execute: false; drop: boolean; reason: string; priceE6?: bigint };

/**
 * Whether to execute `order` now. `drop` means the order can never execute again (not open, expired,
 * market past trading), so the keeper stops watching it.
 */
export function evaluateOrder(
  order: TriggerOrder,
  market: { phase: number } | undefined,
  quote: YesQuote | undefined,
  nowSeconds: bigint,
): TriggerDecision {
  if (order.status !== OrderStatus.Open) return { execute: false, drop: true, reason: "not open" };
  if (nowSeconds > order.expiry) return { execute: false, drop: true, reason: `expired at ${order.expiry}` };
  if (!market) return { execute: false, drop: false, reason: "market not known yet" };
  if (market.phase !== Phase.Graduated) {
    const over =
      market.phase === Phase.Closed || market.phase === Phase.Settled || market.phase === Phase.Voided;
    return {
      execute: false,
      drop: over,
      reason: over ? "the market is past trading: the router refuses" : "the market has no book yet",
    };
  }
  if (!quote) return { execute: false, drop: false, reason: "no book read" };
  const side = triggerSidePrice(order.kind, quote);
  if (!side.available) return { execute: false, drop: false, reason: "that side of the book is empty" };
  const trigger = BigInt(order.triggerPriceE6);
  const word = order.condition === Condition.AtOrAbove ? "at or above" : "at or below";
  if (!conditionMet(order.condition, side.priceE6, trigger)) {
    return {
      execute: false,
      drop: false,
      priceE6: side.priceE6,
      reason: `price ${side.priceE6} is not ${word} ${trigger}`,
    };
  }
  return { execute: true, priceE6: side.priceE6, reason: `price ${side.priceE6} is ${word} ${trigger}` };
}

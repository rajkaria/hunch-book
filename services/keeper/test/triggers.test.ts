import { KURU_EMPTY_ASK, KURU_EMPTY_BID, Phase } from "@hunch-book/shared";
import { describe, expect, it } from "vitest";
import {
  Condition,
  conditionMet,
  evaluateOrder,
  OrderKind,
  OrderStatus,
  type TriggerOrder,
  triggerSidePrice,
  yesQuote,
  yesQuoteV2,
} from "../src/jobs/triggers.js";

// The pure trigger rules, against the same cases as contracts/test/periphery/ConditionalOrders.t.sol
// and BookPrice: prices from bestBidAsk() at 1e18, bids rounded down, asks rounded up, NO prices as the
// complement of the YES book.

const E18 = 10n ** 18n;
const at = (usdc: string) => (BigInt(Math.round(Number(usdc) * 1e6)) * E18) / 1_000_000n;

describe("yesQuote (BookPrice.yesQuote)", () => {
  it("reads empty sides from Kuru's sentinels, and treats a zero bid or max ask as empty", () => {
    expect(yesQuote(KURU_EMPTY_BID, KURU_EMPTY_ASK)).toEqual({
      hasBid: false,
      hasAsk: false,
      bid: 0n,
      ask: 0n,
    });
    expect(yesQuote(0n, KURU_EMPTY_BID)).toMatchObject({ hasBid: false, hasAsk: false });
  });

  it("rounds a bid down and an ask up to E6", () => {
    const q = yesQuote(at("0.42") + 1n, at("0.45") + 1n);
    expect(q).toEqual({ hasBid: true, hasAsk: true, bid: 420_000n, ask: 450_001n });
    expect(yesQuote(at("0.42"), at("0.45"))).toMatchObject({ bid: 420_000n, ask: 450_000n });
  });
});

describe("triggerSidePrice", () => {
  const q = yesQuote(at("0.40"), at("0.43"));
  it("buys YES on the ask, sells YES on the bid, and prices NO from the complement", () => {
    expect(triggerSidePrice(OrderKind.BuyYes, q)).toEqual({ available: true, priceE6: 430_000n });
    expect(triggerSidePrice(OrderKind.SellYes, q)).toEqual({ available: true, priceE6: 400_000n });
    expect(triggerSidePrice(OrderKind.BuyNo, q)).toEqual({ available: true, priceE6: 600_000n });
    expect(triggerSidePrice(OrderKind.SellNo, q)).toEqual({ available: true, priceE6: 570_000n });
  });

  it("an empty side has no price, and a price above 1 USDC floors NO at 0", () => {
    const oneSided = yesQuote(KURU_EMPTY_BID, at("1.2"));
    expect(triggerSidePrice(OrderKind.SellYes, oneSided).available).toBe(false);
    expect(triggerSidePrice(OrderKind.BuyNo, oneSided).available).toBe(false);
    expect(triggerSidePrice(OrderKind.SellNo, oneSided)).toEqual({ available: true, priceE6: 0n });
  });
});

describe("evaluateOrder", () => {
  const order = (over: Partial<TriggerOrder> = {}): TriggerOrder => ({
    status: OrderStatus.Open,
    kind: OrderKind.SellYes,
    condition: Condition.AtOrBelow,
    triggerPriceE6: 350_000,
    expiry: 2_000n,
    ...over,
  });
  const trading = { phase: Phase.Graduated };

  it("triggers a stop-loss once the bid is at or below the trigger, equal included", () => {
    expect(evaluateOrder(order(), trading, yesQuote(at("0.36"), at("0.40")), 1_000n)).toMatchObject({
      execute: false,
      drop: false,
      reason: "price 360000 is not at or below 350000",
    });
    expect(evaluateOrder(order(), trading, yesQuote(at("0.35"), at("0.40")), 1_000n)).toMatchObject({
      execute: true,
      priceE6: 350_000n,
    });
  });

  it("triggers a take-profit at or above, and a limit buy of NO on 1 − bid", () => {
    const tp = order({ condition: Condition.AtOrAbove, triggerPriceE6: 700_000 });
    expect(evaluateOrder(tp, trading, yesQuote(at("0.70"), at("0.72")), 1n).execute).toBe(true);
    const buyNo = order({ kind: OrderKind.BuyNo, condition: Condition.AtOrBelow, triggerPriceE6: 300_000 });
    expect(evaluateOrder(buyNo, trading, yesQuote(at("0.70"), at("0.72")), 1n)).toMatchObject({
      execute: true,
      priceE6: 300_000n,
    });
    expect(evaluateOrder(buyNo, trading, yesQuote(at("0.69"), at("0.72")), 1n).execute).toBe(false);
  });

  it("drops orders that can never execute, and waits on the rest", () => {
    const book = yesQuote(at("0.30"), at("0.32"));
    expect(evaluateOrder(order({ status: OrderStatus.Executed }), trading, book, 1n)).toMatchObject({
      drop: true,
    });
    expect(evaluateOrder(order({ status: OrderStatus.Cancelled }), trading, book, 1n)).toMatchObject({
      drop: true,
    });
    // Expiry is inclusive.
    expect(evaluateOrder(order(), trading, book, 2_000n).execute).toBe(true);
    expect(evaluateOrder(order(), trading, book, 2_001n)).toMatchObject({ execute: false, drop: true });
    for (const phase of [Phase.Closed, Phase.Settled, Phase.Voided]) {
      expect(evaluateOrder(order(), { phase }, book, 1n)).toMatchObject({ execute: false, drop: true });
    }
    expect(evaluateOrder(order(), { phase: Phase.Pool }, book, 1n)).toMatchObject({
      execute: false,
      drop: false,
    });
    expect(evaluateOrder(order(), undefined, book, 1n)).toMatchObject({ execute: false, drop: false });
    expect(evaluateOrder(order(), trading, yesQuote(KURU_EMPTY_BID, at("0.32")), 1n)).toMatchObject({
      execute: false,
      reason: "that side of the book is empty",
    });
  });

  it("conditionMet compares as the contract does", () => {
    expect(conditionMet(Condition.AtOrAbove, 5n, 5n)).toBe(true);
    expect(conditionMet(Condition.AtOrAbove, 4n, 5n)).toBe(false);
    expect(conditionMet(Condition.AtOrBelow, 5n, 5n)).toBe(true);
    expect(conditionMet(Condition.AtOrBelow, 6n, 5n)).toBe(false);
  });
});

describe("Kuru v2 books", () => {
  it("reads bestBidAsk as E6 prices, with either sentinel empty on either side", () => {
    expect(yesQuoteV2(420_000n, 440_000n)).toEqual({
      hasBid: true,
      hasAsk: true,
      bid: 420_000n,
      ask: 440_000n,
    });
    const max = 2n ** 32n - 1n;
    expect(yesQuoteV2(0n, max)).toEqual({ hasBid: false, hasAsk: false, bid: 0n, ask: 0n });
    expect(yesQuoteV2(max, 0n)).toEqual({ hasBid: false, hasAsk: false, bid: 0n, ask: 0n });
    // The same prices read the v1 way agree.
    expect(yesQuoteV2(420_000n, 440_000n)).toEqual(yesQuote(420_000n * 10n ** 12n, 440_000n * 10n ** 12n));
  });
});

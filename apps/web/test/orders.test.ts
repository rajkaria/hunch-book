import { Phase, Side } from "@hunch-book/shared";
import type { Address } from "viem";
import { describe, expect, it } from "vitest";
import { closePlan } from "../src/lib/orders/close";
import {
  Condition,
  conditionMet,
  evaluateOrder,
  type OrderContext,
  type OrderForm,
  OrderKind,
  OrderStatus,
  orderExpiry,
  orderLimit,
  orderShape,
  orderTypeOf,
  parsePriceE6,
} from "../src/lib/orders/form";
import {
  committedInputs,
  describeOrder,
  orderInput,
  orderState,
  parseOrder,
  type StoredOrder,
  triggeredNow,
  triggerPriceNow,
} from "../src/lib/orders/read";
import { MARKET, makeBalances, makeBook, USDC, USER } from "./fixtures";

const CONTRACT = "0x00000000000000000000000000000000000000c0" as Address;
const OTHER_MARKET = "0x00000000000000000000000000000000000000a2" as Address;
const NOW = 1_799_000_000;

function ctx(overrides: Partial<OrderContext> = {}): OrderContext {
  return {
    market: MARKET,
    contract: CONTRACT,
    phase: Phase.Graduated,
    now: NOW,
    closeTime: NOW + 86_400 * 3,
    wallet: { connected: true, onAppChain: true },
    balances: { usdc: USDC(1_000), yes: USDC(50), no: USDC(80) },
    allowances: { usdc: 0n, yes: 0n, no: 0n },
    committed: { usdc: 0n, yes: 0n, no: 0n },
    priceNowE6: 350_000n,
    ...overrides,
  };
}

function form(overrides: Partial<OrderForm> = {}): OrderForm {
  return {
    type: "takeProfit",
    side: Side.Yes,
    trigger: "0.65",
    amount: USDC(50),
    slippageBps: 200n,
    tipBps: 10n,
    expiry: "1d",
    ...overrides,
  };
}

function stored(overrides: Partial<StoredOrder> = {}): StoredOrder {
  return {
    id: 1n,
    owner: USER,
    expiry: BigInt(NOW + 3_600),
    triggerPriceE6: 650_000n,
    market: MARKET,
    kind: OrderKind.SellYes,
    condition: Condition.AtOrAbove,
    status: OrderStatus.Open,
    executorTipBps: 10,
    amountIn: USDC(50),
    limit: USDC(31.8),
    ...overrides,
  };
}

describe("order shapes", () => {
  it("maps each order type and side to the contract's kind and condition", () => {
    expect(orderShape("takeProfit", Side.Yes)).toEqual({
      kind: OrderKind.SellYes,
      condition: Condition.AtOrAbove,
    });
    expect(orderShape("stopLoss", Side.No)).toEqual({
      kind: OrderKind.SellNo,
      condition: Condition.AtOrBelow,
    });
    expect(orderShape("limitBuy", Side.Yes)).toEqual({
      kind: OrderKind.BuyYes,
      condition: Condition.AtOrBelow,
    });
    expect(orderShape("limitBuy", Side.No)).toEqual({
      kind: OrderKind.BuyNo,
      condition: Condition.AtOrBelow,
    });
  });

  it("reads a stored kind and condition back as an order type, including the breakout buy", () => {
    expect(orderTypeOf(OrderKind.SellNo, Condition.AtOrAbove)).toBe("takeProfit");
    expect(orderTypeOf(OrderKind.SellYes, Condition.AtOrBelow)).toBe("stopLoss");
    expect(orderTypeOf(OrderKind.BuyNo, Condition.AtOrBelow)).toBe("limitBuy");
    expect(orderTypeOf(OrderKind.BuyYes, Condition.AtOrAbove)).toBe("breakoutBuy");
  });

  it("checks a condition the way ConditionalOrders does, equal counting both ways", () => {
    expect(conditionMet(Condition.AtOrAbove, 650_000n, 650_000n)).toBe(true);
    expect(conditionMet(Condition.AtOrAbove, 649_999n, 650_000n)).toBe(false);
    expect(conditionMet(Condition.AtOrBelow, 650_000n, 650_000n)).toBe(true);
    expect(conditionMet(Condition.AtOrBelow, 650_001n, 650_000n)).toBe(false);
  });
});

describe("parsePriceE6", () => {
  it("parses prices strictly between 0 and 1 USDC with up to 6 decimals", () => {
    expect(parsePriceE6("0.65")).toBe(650_000n);
    expect(parsePriceE6(".5")).toBe(500_000n);
    expect(parsePriceE6(" 0.123456 ")).toBe(123_456n);
  });

  it("refuses 0, 1 and more, too many decimals and anything that is not a number", () => {
    for (const bad of ["", ".", "0", "1", "1.2", "0.1234567", "abc", "-0.5", "0,5"]) {
      expect(parsePriceE6(bad), bad).toBeNull();
    }
  });
});

describe("orderLimit", () => {
  it("sells: the USDC at the trigger, less the tip, less the slippage, rounded down", () => {
    // 50 YES at 0.65 = 32.5 USDC; keep 99.9% after a 0.1% tip and 98% after 2% slippage.
    expect(orderLimit(OrderKind.SellYes, USDC(50), 650_000n, 200n, 10n)).toBe(31_818_150n);
    expect(orderLimit(OrderKind.SellNo, USDC(10), 400_000n, 0n, 0n)).toBe(USDC(4));
  });

  it("buys YES: the tokens the USDC buys at the trigger, less tip and slippage", () => {
    expect(orderLimit(OrderKind.BuyYes, USDC(20), 400_000n, 100n, 0n)).toBe(USDC(49.5));
  });

  it("buys NO: the most USDC it may cost, rounded up and never above the NO bought", () => {
    expect(orderLimit(OrderKind.BuyNo, USDC(100), 600_000n, 200n, 50n)).toBe(USDC(61.2));
    expect(orderLimit(OrderKind.BuyNo, USDC(100), 990_000n, 5_000n, 0n)).toBe(USDC(100));
    expect(orderLimit(OrderKind.BuyNo, 3n, 333_333n, 0n, 0n)).toBe(1n);
  });

  it("is zero for a zero amount or price", () => {
    expect(orderLimit(OrderKind.SellYes, 0n, 650_000n, 0n, 0n)).toBe(0n);
    expect(orderLimit(OrderKind.BuyYes, USDC(1), 0n, 0n, 0n)).toBe(0n);
  });
});

describe("orderExpiry", () => {
  it("adds the chosen time, never past the close", () => {
    expect(orderExpiry("1h", NOW, NOW + 86_400)).toBe(BigInt(NOW + 3_600));
    expect(orderExpiry("7d", NOW, NOW + 86_400)).toBe(BigInt(NOW + 86_400));
    expect(orderExpiry("close", NOW, NOW + 86_400)).toBe(BigInt(NOW + 86_400));
    expect(orderExpiry("1d", NOW, null)).toBe(BigInt(NOW + 86_400));
    expect(orderExpiry("close", NOW, null)).toBeNull();
  });
});

describe("evaluateOrder", () => {
  it("builds the request ConditionalOrders.place takes, and asks for the exact approval", () => {
    const e = evaluateOrder(form(), ctx());
    expect(e.blocker).toBeNull();
    expect(e.request).toEqual({
      market: MARKET,
      kind: OrderKind.SellYes,
      condition: Condition.AtOrAbove,
      triggerPriceE6: 650_000,
      expiry: BigInt(NOW + 86_400),
      executorTipBps: 10,
      amountIn: USDC(50),
      limit: 31_818_150n,
    });
    expect(e.approval).toEqual({ token: "yes", amount: USDC(50), needed: true });
    expect(e.summary).toContain(
      "Sell 50.00 YES once the YES bid is at or above 0.650 USDC, for at least 31.81815 USDC.",
    );
  });

  it("counts other open orders in the approval, and needs none once the allowance covers them", () => {
    const committed = { usdc: USDC(30), yes: 0n, no: 0n };
    const buy = form({ type: "limitBuy", trigger: "0.40", amount: USDC(20) });
    const short = evaluateOrder(buy, ctx({ committed, allowances: { usdc: USDC(40), yes: 0n, no: 0n } }));
    expect(short.approval).toEqual({ token: "usdc", amount: USDC(50), needed: true });
    const enough = evaluateOrder(buy, ctx({ committed, allowances: { usdc: USDC(50), yes: 0n, no: 0n } }));
    expect(enough.approval?.needed).toBe(false);
    expect(enough.request?.kind).toBe(OrderKind.BuyYes);
  });

  it("approves USDC up to the limit for a NO buy, and refuses more than the wallet holds", () => {
    const buyNo = form({ type: "limitBuy", side: Side.No, trigger: "0.60", amount: USDC(100) });
    const ok = evaluateOrder(buyNo, ctx());
    expect(ok.unit).toBe("NO");
    expect(ok.approval).toMatchObject({ token: "usdc", amount: ok.limit });
    const poor = evaluateOrder(buyNo, ctx({ balances: { usdc: USDC(10), yes: 0n, no: 0n } }));
    expect(poor.errors.amount).toBe(
      "Buying that much NO can cost up to 61.20 USDC. Your wallet holds 10.00 USDC.",
    );
    expect(poor.request).toBeNull();
  });

  it("refuses to sell more than the wallet holds", () => {
    const e = evaluateOrder(form({ amount: USDC(60) }), ctx());
    expect(e.errors.amount).toBe("That needs 60.00 YES. Your wallet holds 50.00 YES.");
    expect(e.blocker).toBe(e.errors.amount);
  });

  it("explains a bad trigger, a missing amount and a wallet that is not ready", () => {
    expect(evaluateOrder(form({ trigger: "1.5" }), ctx()).errors.trigger).toMatch(/between 0 and 1 USDC/);
    expect(evaluateOrder(form({ trigger: "" }), ctx()).blocker).toBe("Enter a trigger price.");
    expect(evaluateOrder(form({ amount: null }), ctx()).blocker).toBe("Enter an amount in YES.");
    expect(evaluateOrder(form(), ctx({ wallet: { connected: false, onAppChain: false } })).blocker).toBe(
      "Connect a browser wallet to place orders.",
    );
    expect(evaluateOrder(form(), ctx({ balances: null })).blocker).toBe("Reading your balances...");
  });

  it("warns when the order is triggered at once, and for every stop-loss", () => {
    const now = evaluateOrder(form({ trigger: "0.30" }), ctx({ priceNowE6: 350_000n }));
    expect(now.warnings[0]).toMatch(
      /^The YES bid is 0\.350 now, so this order is triggered as soon as it is placed/,
    );
    const stop = evaluateOrder(form({ type: "stopLoss", trigger: "0.30" }), ctx());
    expect(stop.warnings.some((w) => w.startsWith("A stop-loss sells only if"))).toBe(true);
  });

  it("is blocked before graduation, after close and where the contract is missing", () => {
    expect(evaluateOrder(form(), ctx({ phase: Phase.Pool })).blocker).toMatch(/once the pool graduates/);
    expect(evaluateOrder(form(), ctx({ phase: Phase.Closed })).blocker).toMatch(/can only be cancelled/);
    expect(evaluateOrder(form(), ctx({ closeTime: NOW - 1 })).blocker).toMatch(/closing/);
    expect(evaluateOrder(form(), ctx({ contract: undefined })).blocker).toMatch(/not deployed/);
  });

  it("caps the tip at 0.5%", () => {
    expect(evaluateOrder(form({ tipBps: 500n }), ctx()).request?.executorTipBps).toBe(50);
  });
});

describe("stored orders", () => {
  it("parses getOrder's tuple and tells open, expired, executed and cancelled apart", () => {
    const o = parseOrder(3n, {
      owner: USER,
      expiry: NOW + 10,
      triggerPriceE6: 650_000,
      market: MARKET,
      kind: 1,
      condition: 0,
      status: 1,
      executorTipBps: 10,
      amountIn: USDC(5),
      limit: USDC(3),
    });
    expect(o).toMatchObject({
      id: 3n,
      expiry: BigInt(NOW + 10),
      triggerPriceE6: 650_000n,
      kind: OrderKind.SellYes,
    });
    expect(orderState(o, NOW)).toBe("open");
    expect(orderState(o, NOW + 11)).toBe("expired");
    expect(orderState({ ...o, status: OrderStatus.Executed }, NOW)).toBe("executed");
    expect(orderState({ ...o, status: OrderStatus.Cancelled }, NOW)).toBe("cancelled");
  });

  it("adds up what open orders can still pull: USDC across markets, tokens on this market only", () => {
    const orders = [
      stored({ kind: OrderKind.BuyYes, amountIn: USDC(10), market: OTHER_MARKET }),
      stored({ kind: OrderKind.BuyNo, amountIn: USDC(5), limit: USDC(3) }),
      stored({ kind: OrderKind.SellYes, amountIn: USDC(7) }),
      stored({ kind: OrderKind.SellNo, amountIn: USDC(9), market: OTHER_MARKET }),
      stored({ kind: OrderKind.SellYes, amountIn: USDC(100), status: OrderStatus.Cancelled }),
      stored({ kind: OrderKind.SellYes, amountIn: USDC(100), expiry: BigInt(NOW - 1) }),
    ];
    expect(committedInputs(orders, MARKET, NOW)).toEqual({ usdc: USDC(13), yes: USDC(7), no: 0n });
    expect(orderInput(stored({ kind: OrderKind.BuyNo, limit: USDC(3) }))).toEqual({
      token: "usdc",
      amount: USDC(3),
    });
  });

  it("describes an order in one line", () => {
    expect(describeOrder(stored())).toEqual({
      title: "Take-profit YES at or above 0.650",
      detail: "Sell 50.00 YES, get at least 31.80 USDC, when the YES bid is at or above 0.650, 0.1% tip.",
    });
    expect(
      describeOrder(stored({ kind: OrderKind.BuyNo, condition: Condition.AtOrBelow, executorTipBps: 0 }))
        .title,
    ).toBe("Limit buy NO at or below 0.650");
  });

  it("reads the trigger-side price off the book and says when an open order is triggered", () => {
    const book = makeBook();
    expect(triggerPriceNow(OrderKind.BuyYes, book)).toBe(400_000n);
    expect(triggerPriceNow(OrderKind.SellYes, book)).toBe(350_000n);
    expect(triggerPriceNow(OrderKind.BuyNo, book)).toBe(650_000n);
    expect(triggerPriceNow(OrderKind.SellNo, book)).toBe(600_000n);
    expect(triggeredNow(stored({ triggerPriceE6: 350_000n }), book, NOW)).toBe(true);
    expect(triggeredNow(stored({ triggerPriceE6: 360_000n }), book, NOW)).toBe(false);
    expect(triggeredNow(stored({ triggerPriceE6: 350_000n, expiry: BigInt(NOW - 1) }), book, NOW)).toBe(
      false,
    );
    expect(triggeredNow(stored(), null, NOW)).toBe(false);
  });
});

describe("closePlan", () => {
  const base = {
    slippageBps: 100n,
    phase: Phase.Graduated,
    router: "0x00000000000000000000000000000000000000ee" as Address,
    book: makeBook(),
    wallet: { connected: true, onAppChain: true },
  };

  it("sells the whole balance with a minimum out and an exact router approval", () => {
    const plan = closePlan(Side.Yes, { ...base, balances: makeBalances({ yes: USDC(50) }) });
    expect(plan).not.toBeNull();
    expect(plan?.kind).toBe("sellYes");
    expect(plan?.amount).toBe(USDC(50));
    expect(plan?.partial).toBe(false);
    expect(plan?.state.quote?.usdc).toBe(USDC(17.5));
    expect(plan?.state.limit).toBe(USDC(17.325));
    expect(plan?.state.approval).toEqual({ token: "yes", amount: USDC(50), needed: true });
  });

  it("closes what the book can take when it is thinner than the balance", () => {
    const plan = closePlan(Side.Yes, { ...base, balances: makeBalances({ yes: USDC(1_000) }) });
    expect(plan?.partial).toBe(true);
    expect(plan?.amount).toBe(USDC(400));
    expect(plan?.held).toBe(USDC(1_000));
    expect(plan?.state.blocker).toBeNull();
  });

  it("is null with nothing to close, and blocked once the market closes", () => {
    expect(closePlan(Side.No, { ...base, balances: makeBalances({ no: 0n }) })).toBeNull();
    const closed = closePlan(Side.No, { ...base, phase: Phase.Closed, balances: makeBalances() });
    expect(closed?.state.blocker).toMatch(/stopped at close/);
  });
});

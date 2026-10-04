// ConditionalOrders: an order's life from placement to execution or cancellation. An execution trades
// through the router with the contract as the router's user; the indexer gives that trade, and its
// USDC, to the order's owner.
import { describe, expect, it } from "vitest";
import {
  ADDR,
  ALICE,
  afterPeripheryDeploy,
  BOB,
  CAROL,
  E18,
  Kind,
  Protocol,
  SEED,
  seedTestnetMarket,
  USDC,
} from "./helpers.js";

const Condition = { AtOrAbove: 0n, AtOrBelow: 1n } as const;
const EXPIRY = 1_800_000_000n;

async function withOrders() {
  const p = new Protocol();
  seedTestnetMarket(p);
  p.s.next({ from: ADDR.maker });
  p.orderCreated({
    book: SEED.book,
    orderId: 1n,
    owner: ADDR.maker,
    size: USDC(20),
    priceE6: 385_000n,
    isBuy: true,
  });
  p.orderCreated({
    book: SEED.book,
    orderId: 2n,
    owner: ADDR.maker,
    size: USDC(20),
    priceE6: 416_000n,
    isBuy: false,
  });
  p.s.next({ from: ALICE });
  p.mintSets({ market: SEED.market, payer: ALICE, to: ALICE, amount: USDC(10) });
  afterPeripheryDeploy(p, ALICE);
  // Alice: take profit on 5 YES at 0.38 or better, at least 1.8 USDC back, a 0.5% tip.
  p.placeOrder({
    orderId: 1n,
    owner: ALICE,
    market: SEED.market,
    kind: Kind.SellYes,
    condition: Condition.AtOrAbove,
    triggerPriceE6: 380_000n,
    expiry: EXPIRY,
    executorTipBps: 50n,
    amountIn: USDC(5),
    limit: USDC(1.8),
  });
  p.s.next({ from: BOB });
  // Bob: a limit buy, 2.08 USDC of YES once the ask is 0.42 or lower.
  p.placeOrder({
    orderId: 2n,
    owner: BOB,
    market: SEED.market,
    kind: Kind.BuyYes,
    condition: Condition.AtOrBelow,
    triggerPriceE6: 420_000n,
    expiry: EXPIRY,
    amountIn: USDC(2.08),
    limit: USDC(4.9),
  });
  p.s.next({ from: CAROL });
  p.placeOrder({
    orderId: 3n,
    owner: CAROL,
    market: SEED.market,
    kind: Kind.SellNo,
    condition: Condition.AtOrBelow,
    triggerPriceE6: 300_000n,
    expiry: EXPIRY,
    amountIn: USDC(1),
    limit: 0n,
  });
  await p.run();
  return p;
}

describe("conditional orders", () => {
  it("are recorded when placed, per owner and per market", async () => {
    const p = await withOrders();
    expect(await p.indexer.ConditionalOrder.getOrThrow("1")).toMatchObject({
      orderId: 1n,
      owner_id: ALICE,
      ownerIsOurs: false,
      market_id: SEED.market,
      kind: "SellYes",
      condition: "AtOrAbove",
      triggerPriceE6: 380_000n,
      expiry: EXPIRY,
      executorTipBps: 50,
      amountIn: USDC(5),
      limit: USDC(1.8),
      status: "Open",
      executor: undefined,
      routerTrade_id: undefined,
    });
    expect((await p.indexer.ConditionalOrder.getOrThrow("3")).kind).toBe("SellNo");
    expect(await p.indexer.Market.getOrThrow(SEED.market)).toMatchObject({
      conditionalOrderCount: 3,
      conditionalOrdersOpen: 3,
      conditionalOrdersExecuted: 0,
    });
    expect(await p.indexer.ProtocolStats.getOrThrow("10143")).toMatchObject({
      conditionalOrdersPlaced: 3,
      conditionalOrdersOpen: 3,
    });
  });

  it("give an execution's router trade and USDC to the owner, and label who executed it", async () => {
    const p = await withOrders();
    p.s.next({ from: ADDR.keeper });
    const alice = p.executeYesOrder({
      orderId: 1n,
      owner: ALICE,
      executor: ADDR.keeper,
      market: SEED.market,
      book: SEED.book,
      buy: false,
      kuruOrderId: 1n,
      maker: ADDR.maker,
      price: E18(0.385),
      size: USDC(5),
      remaining: USDC(15),
      tipBps: 50n,
    });
    p.s.next({ from: CAROL });
    const bob = p.executeYesOrder({
      orderId: 2n,
      owner: BOB,
      executor: CAROL,
      market: SEED.market,
      book: SEED.book,
      buy: true,
      kuruOrderId: 2n,
      maker: ADDR.maker,
      price: E18(0.416),
      size: USDC(5),
      remaining: USDC(15),
      tipBps: 0n,
    });
    p.s.next({ from: CAROL });
    p.cancelOrder({ orderId: 3n, owner: CAROL });
    await p.run();

    expect(alice).toEqual({ spent: USDC(5), received: 1_915_375n, tip: 9_625n });
    const order = await p.indexer.ConditionalOrder.getOrThrow("1");
    expect(order).toMatchObject({
      status: "Executed",
      executor: ADDR.keeper,
      executorIsOurs: true,
      executedPriceE6: 385_000n,
      spent: USDC(5),
      received: 1_915_375n,
      tip: 9_625n,
    });
    const trade = await p.indexer.RouterTrade.getOrThrow(order.routerTrade_id as string);
    expect(trade).toMatchObject({
      user_id: ALICE,
      userIsOurs: false,
      conditionalOrder_id: "1",
      kind: "SellYes",
      usdc: 1_925_000n,
      tokens: USDC(5),
    });
    const bobOrder = await p.indexer.ConditionalOrder.getOrThrow("2");
    expect(bobOrder).toMatchObject({ status: "Executed", executor: CAROL, executorIsOurs: false, tip: 0n });
    expect(bob).toEqual({ spent: 2_080_000n, received: USDC(5), tip: 0n });
    expect(await p.indexer.RouterTrade.getOrThrow(bobOrder.routerTrade_id as string)).toMatchObject({
      user_id: BOB,
      conditionalOrder_id: "2",
      kind: "BuyYes",
    });
    expect(await p.indexer.ConditionalOrder.getOrThrow("3")).toMatchObject({
      status: "Cancelled",
      cancelTx: expect.any(String),
    });

    // The owners traded; the contract never counts as a wallet that traded, nor holds a position.
    expect(await p.indexer.Wallet.getOrThrow(ALICE)).toMatchObject({
      participant: true,
      traded: true,
      routerTradeCount: 1,
      routerVolume: 1_925_000n,
    });
    expect(await p.indexer.Wallet.getOrThrow(ADDR.conditionalOrders)).toMatchObject({
      participant: false,
      routerTradeCount: 0,
    });
    expect(await p.indexer.Position.getOrThrow(`${SEED.market}-${ALICE}`)).toMatchObject({
      yesBalance: USDC(5),
      noBalance: USDC(10),
      usdcSpent: USDC(10),
      usdcReceived: 1_915_375n,
    });
    expect(await p.indexer.Position.getOrThrow(`${SEED.market}-${BOB}`)).toMatchObject({
      yesBalance: USDC(5),
      usdcSpent: 2_080_000n,
    });
    expect(await p.indexer.Position.get(`${SEED.market}-${ADDR.conditionalOrders}`)).toBeUndefined();
    // Kuru names the transaction's sender (the executor) as the taker's origin: the fill's trader.
    const fills = await p.indexer.Trade.getAll();
    expect(fills.map((f) => [f.trader, f.traderIsOurs, f.viaRouter])).toEqual([
      [ADDR.keeper, true, true],
      [CAROL, false, true],
    ]);

    expect(await p.indexer.Market.getOrThrow(SEED.market)).toMatchObject({
      conditionalOrderCount: 3,
      conditionalOrdersOpen: 0,
      conditionalOrdersExecuted: 2,
      routerTradeCount: 2,
      routerVolume: 1_925_000n + 2_080_000n,
    });
    expect(await p.indexer.ProtocolStats.getOrThrow("10143")).toMatchObject({
      conditionalOrdersPlaced: 3,
      conditionalOrdersOpen: 0,
      conditionalOrdersExecuted: 2,
      conditionalOrdersCancelled: 1,
      conditionalOrdersExecutedByUs: 1,
      routerTradeCount: 2,
    });
    const days = await p.indexer.DailyStats.getAll();
    const sum = (k: "conditionalOrdersPlaced" | "conditionalOrdersExecuted" | "conditionalOrdersCancelled") =>
      days.reduce((n, d) => n + d[k], 0);
    expect([
      sum("conditionalOrdersPlaced"),
      sum("conditionalOrdersExecuted"),
      sum("conditionalOrdersCancelled"),
    ]).toEqual([3, 2, 1]);
  });

  it("ignore a second close of the same order", async () => {
    const p = await withOrders();
    p.s.next({ from: CAROL });
    p.cancelOrder({ orderId: 3n, owner: CAROL });
    p.s.next({ from: CAROL });
    p.cancelOrder({ orderId: 3n, owner: CAROL }); // cannot happen onchain; a replayed log must not count twice
    p.cancelOrder({ orderId: 99n, owner: CAROL }); // an order the indexer never saw
    await p.run();
    expect(await p.indexer.ProtocolStats.getOrThrow("10143")).toMatchObject({
      conditionalOrdersOpen: 2,
      conditionalOrdersCancelled: 1,
    });
  });
});

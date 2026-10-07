// Two stacks on one chain (docs/PROTOCOL.md section 8.1): the primary one on Kuru v1 and `kuruV2`, whose
// graduator registers Kuru v2 books. Both are indexed into the same tables: each factory numbers its own
// markets and templates, v2 books are read for SpotSwap, and a v2 swap's maker is unknown, so it never
// counts as our maker's fill or as a fill between others.
import { describe, expect, it } from "vitest";
import {
  ADDR,
  ALICE,
  BOB,
  CAROL,
  E18,
  KURU_V2,
  Outcome,
  PRIMARY,
  Protocol,
  Side,
  type StackAddr,
  USDC,
} from "./helpers.js";

const V2_MARKET = "0x7200000000000000000000000000000000000001";
const V2_YES = "0x7200000000000000000000000000000000000002";
const V2_NO = "0x7200000000000000000000000000000000000003";
const V2_BOOK = "0x72000000000000000000000000000000000000b0";
const V1_MARKET = "0x7100000000000000000000000000000000000001";
const V1_YES = "0x7100000000000000000000000000000000000002";
const V1_NO = "0x7100000000000000000000000000000000000003";
const V1_BOOK = "0x71000000000000000000000000000000000000b0";

/** A market on `stack` that meets the graduation rule with outside stakers only. */
function outsideMarket(p: Protocol, market: string, yes: string, no: string): void {
  p.s.next({ from: ALICE });
  p.createMarket({ market, yes, no, creator: ALICE, amount: USDC(300) });
  p.s.next({ from: BOB });
  p.stake({ market, user: BOB, side: Side.No, amount: USDC(200) });
}

/** One market on each stack: v1 graduated by its graduator creating the book, v2 by registering Kuru's. */
function twoStacks(v2: StackAddr): { p: Protocol; q: Protocol } {
  const p = new Protocol();
  const q = p.on(v2);
  p.s.next({ from: ADDR.guardian });
  p.addTemplates();
  q.addTemplates();
  outsideMarket(p, V1_MARKET, V1_YES, V1_NO);
  outsideMarket(q, V2_MARKET, V2_YES, V2_NO);
  p.s.next({ from: ADDR.keeper });
  p.graduate({ market: V1_MARKET, book: V1_BOOK });
  q.s.next({ from: ADDR.keeper });
  q.registerBook({ market: V2_MARKET, book: V2_BOOK, registrar: ADDR.keeper });
  q.graduate({ market: V2_MARKET, book: V2_BOOK, registered: true });
  return { p, q };
}

describe.skipIf(!KURU_V2)("two stacks", () => {
  const v2 = KURU_V2 as StackAddr;

  it("numbers each factory's markets and templates on their own, and tags each with its stack", async () => {
    const { p } = twoStacks(v2);
    await p.run();

    expect(await p.indexer.Market.getOrThrow(V1_MARKET)).toMatchObject({
      number: 1,
      stack: "primary",
      kuruVersion: 1,
      template_id: "1",
    });
    expect(await p.indexer.Market.getOrThrow(V2_MARKET)).toMatchObject({
      number: 1,
      stack: v2.name,
      kuruVersion: 2,
      template_id: `${v2.name}-1`,
    });
    expect(await p.indexer.Template.getOrThrow("1")).toMatchObject({ stack: "primary", marketCount: 1 });
    expect(await p.indexer.Template.getOrThrow(`${v2.name}-1`)).toMatchObject({
      stack: v2.name,
      templateId: 1n,
      marketCount: 1,
    });
    expect(await p.indexer.Stack.getOrThrow(`10143-primary`)).toMatchObject({
      primary: true,
      kuruVersion: 1,
      factory: PRIMARY.factory,
      marketsCreated: 1,
    });
    expect(await p.indexer.Stack.getOrThrow(`10143-${v2.name}`)).toMatchObject({
      primary: false,
      kuruVersion: 2,
      factory: v2.factory,
      marketsCreated: 1,
    });
    // The protocol totals add up every stack, the vaults' USDC included.
    expect(await p.indexer.ProtocolStats.getOrThrow("10143")).toMatchObject({
      marketsCreated: 2,
      marketsGraduated: 2,
      vaultUsdcIn: USDC(1_000),
      vaultPool: 0n,
      vaultSets: USDC(1_000),
      solvencyMargin: 0n,
    });
    // Each book is read with its own Kuru version.
    expect(await p.indexer.Book.getOrThrow(V1_BOOK)).toMatchObject({ kuruVersion: 1, source: "Created" });
    expect(await p.indexer.Book.getOrThrow(V2_BOOK)).toMatchObject({
      kuruVersion: 2,
      source: "Registered",
      registrar: ADDR.keeper,
    });
  });

  it("records a v2 swap through the router at its average price, with the maker unknown", async () => {
    const { p, q } = twoStacks(v2);
    // Alice buys 10 YES (after Kuru's fee) for 4.3 USDC through the v2 router.
    q.s.next({ from: ALICE });
    q.routerSwapV2({
      market: V2_MARKET,
      book: V2_BOOK,
      user: ALICE,
      buy: true,
      usdc: USDC(4.3),
      tokens: USDC(10),
    });
    // Carol sells 5 YES straight into the book for 2 USDC.
    q.s.next({ from: CAROL });
    q.swap({ book: V2_BOOK, executor: CAROL, isBuy: false, amountIn: USDC(5), amountOut: USDC(2) });
    await p.run();

    const trades = (await p.indexer.Trade.getAll()).sort((a, b) => Number(a.block - b.block));
    expect(trades).toHaveLength(2);
    expect(trades[0]).toMatchObject({
      market_id: V2_MARKET,
      book_id: V2_BOOK,
      kuruVersion: 2,
      orderId: undefined,
      priceE18: undefined,
      makerRemaining: undefined,
      maker: ADDR.zero,
      makerKnown: false,
      taker: v2.router,
      txOrigin: ALICE,
      trader: ALICE,
      viaRouter: true,
      takerBuysYes: true,
      size: USDC(10),
      notional: USDC(4.3),
      priceE6: 430_000n,
      isOurMaker: false,
      makerIsOurs: false,
      betweenOthers: false,
    });
    expect(trades[1]).toMatchObject({
      trader: CAROL,
      viaRouter: false,
      takerBuysYes: false,
      size: USDC(5),
      notional: USDC(2),
      priceE6: 400_000n,
    });

    // The router's own Trade keeps Alice's side, once.
    const [routerTrade] = await p.indexer.RouterTrade.getAll();
    expect(routerTrade).toMatchObject({ user_id: ALICE, usdc: USDC(4.3), tokens: USDC(10), book: V2_BOOK });
    const alice = await p.indexer.Position.getOrThrow(`${V2_MARKET}-${ALICE}`);
    expect(alice.usdcSpent).toBe(USDC(300) + USDC(4.3));
    expect(alice.yesBalance).toBe(USDC(10));
    // Carol traded the book directly: her USDC comes from the swap.
    expect((await p.indexer.Position.getOrThrow(`${V2_MARKET}-${CAROL}`)).usdcReceived).toBe(USDC(2));
    // No position for the router or for Kuru's AccountCore holding tokens mid-transaction... the router is plumbing.
    expect(await p.indexer.Position.get(`${V2_MARKET}-${v2.router}`)).toBeUndefined();

    expect(await p.indexer.Book.getOrThrow(V2_BOOK)).toMatchObject({
      fillCount: 2,
      fillCountOurMaker: 0,
      fillCountMakerUnknown: 2,
      volume: USDC(6.3),
      lastPriceE6: 400_000n,
    });
    expect(await p.indexer.Market.getOrThrow(V2_MARKET)).toMatchObject({
      fillCount: 2,
      fillCountMakerUnknown: 2,
      volume: USDC(6.3),
      routerTradeCount: 1,
    });
    expect(await p.indexer.ProtocolStats.getOrThrow("10143")).toMatchObject({
      fillCount: 2,
      fillCountMakerUnknown: 2,
      volumeMakerUnknown: USDC(6.3),
      fillCountBetweenOthers: 0,
      volumeBetweenOthers: 0n,
      fillCountOurMaker: 0,
      ourMakerShareBps: 0,
    });
  });

  it("counts our maker's share among fills whose maker is known", async () => {
    const { p, q } = twoStacks(v2);
    // A v1 fill where our maker bot is the maker, and a v2 swap whose maker nobody can name.
    p.s.next({ from: ALICE });
    p.fill({
      book: V1_BOOK,
      orderId: 1n,
      maker: ADDR.maker,
      taker: ALICE,
      takerBuysYes: true,
      price: E18(0.6),
      size: USDC(5),
      remaining: 0n,
    });
    q.s.next({ from: BOB });
    q.swap({ book: V2_BOOK, executor: BOB, isBuy: true, amountIn: USDC(4), amountOut: USDC(10) });
    await p.run();

    expect(await p.indexer.ProtocolStats.getOrThrow("10143")).toMatchObject({
      fillCount: 2,
      fillCountOurMaker: 1,
      fillCountMakerUnknown: 1,
      volume: USDC(7),
      volumeOurMaker: USDC(3),
      volumeMakerUnknown: USDC(4),
      // 1 of the 1 fills with a known maker, and all of their volume.
      ourMakerShareBps: 10_000,
      ourMakerVolumeShareBps: 10_000,
    });
  });

  it("settles and redeems on the v2 stack's vault like any other", async () => {
    const { p, q } = twoStacks(v2);
    q.s.next({ from: ADDR.keeper });
    q.settleGraduated({ market: V2_MARKET, outcome: Outcome.No });
    q.s.next({ from: BOB });
    q.redeem({
      market: V2_MARKET,
      holder: BOB,
      side: Side.No,
      amount: USDC(10),
      paid: USDC(9.9),
      fee: USDC(0.1),
      creator: ALICE,
    });
    await p.run();

    expect(await p.indexer.Market.getOrThrow(V2_MARKET)).toMatchObject({
      stage: "Settled",
      outcome: "No",
      redemptionCount: 1,
    });
    const stats = await p.indexer.ProtocolStats.getOrThrow("10143");
    expect(stats.vaultUsdcOut).toBe(USDC(9.9));
    expect(stats.marketsSettled).toBe(1);
    expect(stats.solvencyMargin).toBe(0n);
  });

  it("credits a referral only from fees on its own registry's stack", async () => {
    const { p, q } = twoStacks(v2);
    p.s.next({ from: BOB });
    p.bind({ user: BOB, referrer: CAROL }); // on the primary stack's ReferralRegistry
    p.s.next({ from: ADDR.keeper });
    p.settleGraduated({ market: V1_MARKET, outcome: Outcome.No });
    q.settleGraduated({ market: V2_MARKET, outcome: Outcome.No });
    for (const [r, market] of [
      [p, V1_MARKET],
      [q, V2_MARKET],
    ] as const) {
      r.s.next({ from: BOB });
      r.redeem({
        market,
        holder: BOB,
        side: Side.No,
        amount: USDC(10),
        paid: USDC(9.9),
        fee: USDC(0.1),
        creator: ALICE,
      });
    }
    await p.run();

    const [binding] = await p.indexer.Referral.getAll();
    expect(binding).toMatchObject({ stack: "primary", user_id: BOB, referrer_id: CAROL });
    expect(await p.indexer.ReferralLink.getOrThrow(`primary-${BOB}`)).toMatchObject({
      stack: "primary",
      user: BOB,
      referral_id: binding?.id,
    });
    // The primary market's fee is credited to Carol; the v2 market's is not.
    const fees = await p.indexer.ReferralFee.getAll();
    expect(fees.map((f) => f.market_id)).toEqual([V1_MARKET]);
    expect(await p.indexer.Referrer.getOrThrow(CAROL)).toMatchObject({ feeCount: 1, fees: USDC(0.1) });
  });
});

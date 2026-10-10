// A stack on Hunch Book's own order book (contracts/src/venue/): its graduator creates books on the
// HunchOrderBookFactory, and those books emit Kuru v1's events with the same layouts. The indexer reads
// them as Kuru v1 books, registered from the graduator's events like any other, and tags the stack, its
// markets, books and fills with venue Hunch. Nothing of Kuru's is attributed to that stack.
import { describe, expect, it } from "vitest";
import { booksOf, networkOf, stackOfContract, venueOf } from "../src/lib/network.js";
import {
  ADDR,
  ALICE,
  BOB,
  CAROL,
  CHAIN,
  E18,
  HUNCH,
  KURU_V2,
  Outcome,
  PRIMARY,
  Protocol,
  Side,
  type StackAddr,
  USDC,
} from "./helpers.js";

const H_MARKET = "0x4800000000000000000000000000000000000001";
const H_YES = "0x4800000000000000000000000000000000000002";
const H_NO = "0x4800000000000000000000000000000000000003";
const H_BOOK = "0x48000000000000000000000000000000000000b0";
const K_MARKET = "0x4b00000000000000000000000000000000000001";
const K_YES = "0x4b00000000000000000000000000000000000002";
const K_NO = "0x4b00000000000000000000000000000000000003";
const K_BOOK = "0x4b000000000000000000000000000000000000b0";

/** A market on the protocol's stack that meets the graduation rule with outside stakers only. */
function outsideMarket(p: Protocol, market: string, yes: string, no: string): void {
  p.s.next({ from: ALICE });
  p.createMarket({ market, yes, no, creator: ALICE, amount: USDC(300) });
  p.s.next({ from: BOB });
  p.stake({ market, user: BOB, side: Side.No, amount: USDC(200) });
}

/** One graduated market on the primary (Kuru v1) stack and one on the Hunch venue stack. */
function bothVenues(hunch: StackAddr): { p: Protocol; h: Protocol } {
  const p = new Protocol();
  const h = p.on(hunch);
  p.s.next({ from: ADDR.guardian });
  p.addTemplates();
  h.addTemplates();
  outsideMarket(p, K_MARKET, K_YES, K_NO);
  outsideMarket(h, H_MARKET, H_YES, H_NO);
  p.s.next({ from: ADDR.keeper });
  p.graduate({ market: K_MARKET, book: K_BOOK });
  h.s.next({ from: ADDR.keeper });
  h.graduate({ market: H_MARKET, book: H_BOOK });
  return { p, h };
}

describe.skipIf(!HUNCH)("a stack on Hunch Book's own order book", () => {
  const hunch = HUNCH as StackAddr;
  const stack = () => {
    const s = networkOf(CHAIN).stacks.find((k) => k.name === hunch.name);
    if (!s) throw new Error("no hunch stack");
    return s;
  };

  it("finds the stack's contracts, its venue's included, and nothing of Kuru's", () => {
    const s = stack();
    expect(s).toMatchObject({ venue: "hunch", kuruVersion: 1 });
    for (const a of [s.factory, s.vault, s.router, s.graduator, s.kuru.router, s.kuru.marginAccount]) {
      expect(stackOfContract(CHAIN, a ?? "")?.name).toBe(hunch.name);
    }
    // Kuru's own Router and MarginAccount belong to no stack: every Kuru stack shares them.
    const kuru = networkOf(CHAIN).kuru;
    expect(stackOfContract(CHAIN, kuru.router)).toBeUndefined();
    expect(stackOfContract(CHAIN, kuru.marginAccount)).toBeUndefined();
    expect(s.kuru.router).not.toBe(kuru.router);
    expect(s.kuru.marginAccount).not.toBe(kuru.marginAccount);
    expect(hunch.custody).toBe(s.kuru.marginAccount);
  });

  it("reads each graduator's books with its stack's version and venue", () => {
    expect(booksOf(CHAIN, hunch.graduator)).toEqual({ kuruVersion: 1, venue: "Hunch" });
    expect(booksOf(CHAIN, PRIMARY.graduator)).toEqual({ kuruVersion: 1, venue: "Kuru" });
    if (KURU_V2) expect(booksOf(CHAIN, KURU_V2.graduator)).toEqual({ kuruVersion: 2, venue: "Kuru" });
    // An address that is no graduator of ours: a Kuru v1 book, as before.
    expect(booksOf(CHAIN, ALICE)).toEqual({ kuruVersion: 1, venue: "Kuru" });
    expect(venueOf({ venue: "hunch" })).toBe("Hunch");
    expect(venueOf({ venue: "kuru" })).toBe("Kuru");
  });

  it("tags the stack, its markets and its books with venue Hunch, and the Kuru stack's with Kuru", async () => {
    const { p } = bothVenues(hunch);
    await p.run();

    expect(await p.indexer.Stack.getOrThrow(`${CHAIN}-${hunch.name}`)).toMatchObject({
      primary: false,
      kuruVersion: 1,
      venue: "Hunch",
      factory: hunch.factory,
      marketsCreated: 1,
    });
    expect(await p.indexer.Stack.getOrThrow(`${CHAIN}-primary`)).toMatchObject({
      kuruVersion: 1,
      venue: "Kuru",
    });
    expect(await p.indexer.Market.getOrThrow(H_MARKET)).toMatchObject({
      number: 1,
      stack: hunch.name,
      kuruVersion: 1,
      venue: "Hunch",
      template_id: `${hunch.name}-1`,
      stage: "Graduated",
      book_id: H_BOOK,
    });
    expect(await p.indexer.Market.getOrThrow(K_MARKET)).toMatchObject({
      stack: "primary",
      kuruVersion: 1,
      venue: "Kuru",
    });
    expect(await p.indexer.Book.getOrThrow(H_BOOK)).toMatchObject({
      market_id: H_MARKET,
      source: "Created",
      kuruVersion: 1,
      venue: "Hunch",
    });
    expect(await p.indexer.Book.getOrThrow(K_BOOK)).toMatchObject({ kuruVersion: 1, venue: "Kuru" });
  });

  it("reads a Hunch book's orders, fills and cancels like a Kuru v1 book's, each fill with its venue", async () => {
    const { p, h } = bothVenues(hunch);
    // Our maker rests two asks on the Hunch book; Alice buys 4 YES at 0.55 through the hunch router.
    h.s.next({ from: ADDR.maker });
    h.orderCreated({
      book: H_BOOK,
      orderId: 1n,
      owner: ADDR.maker,
      size: USDC(4),
      priceE6: 550_000n,
      isBuy: false,
    });
    h.orderCreated({
      book: H_BOOK,
      orderId: 2n,
      owner: ADDR.maker,
      size: USDC(4),
      priceE6: 560_000n,
      isBuy: false,
    });
    h.s.next({ from: ALICE });
    h.routerYes({
      market: H_MARKET,
      book: H_BOOK,
      user: ALICE,
      buy: true,
      orderId: 1n,
      maker: ADDR.maker,
      price: E18(0.55),
      size: USDC(4),
      remaining: 0n,
    });
    // Carol sells 2 YES straight into a bid on the Kuru book.
    p.s.next({ from: CAROL });
    p.fill({
      book: K_BOOK,
      orderId: 9n,
      maker: BOB,
      taker: CAROL,
      takerBuysYes: false,
      price: E18(0.5),
      size: USDC(2),
      remaining: 0n,
    });
    // Our maker pulls its other ask (Hunch's book emits OrdersCanceled).
    h.s.next({ from: ADDR.maker });
    h.s.emit("KuruOrderBook", "OrdersCanceled", { orderId: [2n], owner: ADDR.maker }, H_BOOK);
    await p.run();

    const trades = (await p.indexer.Trade.getAll()).sort((a, b) => Number(a.block - b.block));
    expect(trades).toHaveLength(2);
    expect(trades[0]).toMatchObject({
      market_id: H_MARKET,
      book_id: H_BOOK,
      kuruVersion: 1,
      venue: "Hunch",
      orderId: 1n,
      maker: ADDR.maker,
      makerKnown: true,
      taker: hunch.router,
      trader: ALICE,
      viaRouter: true,
      takerBuysYes: true,
      size: USDC(4),
      notional: USDC(2.2),
      priceE6: 550_000n,
      isOurMaker: true,
    });
    expect(trades[1]).toMatchObject({ book_id: K_BOOK, kuruVersion: 1, venue: "Kuru", trader: CAROL });

    const order = (id: bigint) => p.indexer.BookOrder.getOrThrow(`${H_BOOK}-${id}`);
    expect(await order(1n)).toMatchObject({ status: "Filled", remaining: 0n, isOurMaker: true });
    expect(await order(2n)).toMatchObject({ status: "Cancelled" });
    expect(await p.indexer.Book.getOrThrow(H_BOOK)).toMatchObject({
      fillCount: 1,
      fillCountOurMaker: 1,
      volume: USDC(2.2),
      orderCount: 2,
      orderCountOurMaker: 2,
      lastPriceE6: 550_000n,
    });
    // The router's own Trade keeps Alice's side; neither the hunch router nor its margin account is a holder.
    const [routerTrade] = await p.indexer.RouterTrade.getAll();
    expect(routerTrade).toMatchObject({ user_id: ALICE, book: H_BOOK, tokens: USDC(4) });
    expect((await p.indexer.Position.getOrThrow(`${H_MARKET}-${ALICE}`)).yesBalance).toBe(USDC(4));
    expect(await p.indexer.Position.get(`${H_MARKET}-${hunch.router}`)).toBeUndefined();
    // Our maker's fill on the Hunch book counts as ours in the protocol totals, as on Kuru.
    expect(await p.indexer.ProtocolStats.getOrThrow(`${CHAIN}`)).toMatchObject({
      fillCount: 2,
      fillCountOurMaker: 1,
      volumeOurMaker: USDC(2.2),
      fillCountBetweenOthers: 1,
    });
  });

  it("keeps the venue when the book is only known from the market's Graduated", async () => {
    const p = new Protocol();
    const h = p.on(hunch);
    p.s.next({ from: ADDR.guardian });
    h.addTemplates();
    outsideMarket(h, H_MARKET, H_YES, H_NO);
    // No BookCreated or BookRegistered from the graduator: the market's own event names the book.
    h.s.next({ from: ADDR.keeper });
    h.graduate({ market: H_MARKET, book: H_BOOK, registered: true });
    await p.run();
    expect(await p.indexer.Book.getOrThrow(H_BOOK)).toMatchObject({
      market_id: H_MARKET,
      kuruVersion: 1,
      venue: "Hunch",
    });
  });

  it("settles and redeems on the Hunch stack's vault like any other", async () => {
    const { p, h } = bothVenues(hunch);
    h.s.next({ from: ADDR.keeper });
    h.settleGraduated({ market: H_MARKET, outcome: Outcome.Yes });
    h.s.next({ from: ALICE });
    h.redeem({
      market: H_MARKET,
      holder: ALICE,
      side: Side.Yes,
      amount: USDC(10),
      paid: USDC(9.9),
      fee: USDC(0.1),
      creator: ALICE,
    });
    await p.run();
    expect(await p.indexer.Market.getOrThrow(H_MARKET)).toMatchObject({
      stage: "Settled",
      outcome: "Yes",
      venue: "Hunch",
      redemptionCount: 1,
    });
    const stats = await p.indexer.ProtocolStats.getOrThrow(`${CHAIN}`);
    expect(stats.marketsSettled).toBe(1);
    expect(stats.solvencyMargin).toBe(0n);
  });
});

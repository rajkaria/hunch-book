// Kuru books: registration paths, fills, orders and cancels.
import { describe, expect, it } from "vitest";
import { ADDR, ALICE, BOB, E18, Protocol, SEED, Side, USDC } from "./helpers.js";

const MAINNET_STYLE_BOOK = "0xb00c000000000000000000000000000000000001";

/** A market that meets the graduation rule with outside stakers only. */
function outsideMarket(p: Protocol): void {
  p.s.next({ from: ALICE });
  p.createMarket({ market: SEED.market, yes: SEED.yes, no: SEED.no, creator: ALICE, amount: USDC(300) });
  p.s.next({ from: BOB });
  p.stake({ market: SEED.market, user: BOB, side: Side.No, amount: USDC(200) });
}

describe("books", () => {
  it("registers a book Kuru created before graduation, and graduation keeps it", async () => {
    const p = new Protocol();
    outsideMarket(p);
    p.s.next({ from: BOB });
    p.registerBook({ market: SEED.market, book: MAINNET_STYLE_BOOK, registrar: BOB });
    await p.run();
    expect(await p.indexer.Market.getOrThrow(SEED.market)).toMatchObject({
      book_id: MAINNET_STYLE_BOOK,
      graduated: false,
      stage: "Pool",
    });

    p.s.next({ from: ADDR.keeper });
    p.graduate({ market: SEED.market, book: MAINNET_STYLE_BOOK, registered: true });
    p.s.next({ from: ALICE });
    p.orderCreated({
      book: MAINNET_STYLE_BOOK,
      orderId: 7n,
      owner: ALICE,
      size: USDC(3),
      priceE6: 600_000n,
      isBuy: false,
    });
    p.s.next({ from: BOB });
    p.fill({
      book: MAINNET_STYLE_BOOK,
      orderId: 7n,
      maker: ALICE,
      taker: BOB,
      takerBuysYes: true,
      price: E18(0.6),
      size: USDC(3),
      remaining: 0n,
    });
    await p.run();

    expect(await p.indexer.Book.getOrThrow(MAINNET_STYLE_BOOK)).toMatchObject({
      source: "Registered",
      registrar: BOB,
      fillCount: 1,
    });
    expect(await p.indexer.Graduation.getOrThrow(SEED.market)).toMatchObject({
      book: MAINNET_STYLE_BOOK,
      caller: ADDR.keeper,
      callerIsOurs: true,
    });
    const [fill] = await p.indexer.Trade.getAll();
    expect(fill).toMatchObject({
      betweenOthers: true,
      isOurMaker: false,
      viaRouter: false,
      trader: BOB,
      notional: USDC(1.8),
    });
    const stats = await p.indexer.ProtocolStats.getOrThrow("10143");
    expect(stats).toMatchObject({
      fillCountBetweenOthers: 1,
      ourMakerShareBps: 0,
      wallets: 2,
      ourWallets: 0,
    });
    expect(await p.indexer.BookOrder.getOrThrow(`${MAINNET_STYLE_BOOK}-7`)).toMatchObject({
      status: "Filled",
      remaining: 0n,
    });
  });

  it("counts a self-trade once for the wallet and nets its USDC", async () => {
    const p = new Protocol();
    outsideMarket(p);
    p.s.next({ from: ADDR.keeper });
    p.graduate({ market: SEED.market, book: SEED.book });
    p.s.next({ from: ALICE });
    p.orderCreated({
      book: SEED.book,
      orderId: 1n,
      owner: ALICE,
      size: USDC(2),
      priceE6: 500_000n,
      isBuy: true,
    });
    p.fill({
      book: SEED.book,
      orderId: 1n,
      maker: ALICE,
      taker: ALICE,
      takerBuysYes: false,
      price: E18(0.5),
      size: USDC(2),
      remaining: 0n,
    });
    await p.run();
    expect(await p.indexer.Wallet.getOrThrow(ALICE)).toMatchObject({
      fillCount: 1,
      fillVolume: USDC(1),
      traded: true,
    });
    expect(await p.indexer.Position.getOrThrow(`${SEED.market}-${ALICE}`)).toMatchObject({
      usdcSpent: USDC(300) + USDC(1),
      usdcReceived: USDC(1),
    });
    expect(await p.indexer.ProtocolStats.getOrThrow("10143")).toMatchObject({
      fillCount: 1,
      traderWallets: 1,
      wallets: 2,
    });
  });

  it("cancels orders one at a time and in batches, and leaves filled ones alone", async () => {
    const p = new Protocol();
    outsideMarket(p);
    p.s.next();
    p.graduate({ market: SEED.market, book: SEED.book });
    p.s.next({ from: ADDR.maker });
    for (const [orderId, priceE6] of [
      [1n, 400_000n],
      [2n, 410_000n],
      [3n, 420_000n],
      [4n, 430_000n],
    ] as const) {
      p.orderCreated({ book: SEED.book, orderId, owner: ADDR.maker, size: USDC(1), priceE6, isBuy: true });
    }
    p.s.next({ from: BOB });
    p.fill({
      book: SEED.book,
      orderId: 4n,
      maker: ADDR.maker,
      taker: BOB,
      takerBuysYes: false,
      price: E18(0.43),
      size: USDC(1),
      remaining: 0n,
    });
    p.s.next({ from: ADDR.maker });
    p.s.emit(
      "KuruOrderBook",
      "OrderCanceled",
      { orderId: 1n, owner: ADDR.maker, price: 400_000n, size: USDC(1), isBuy: true },
      SEED.book,
    );
    p.s.next({ from: ADDR.maker });
    p.s.emit("KuruOrderBook", "OrdersCanceled", { orderId: [2n, 4n], owner: ADDR.maker }, SEED.book);
    await p.run();
    const status = async (id: bigint) => (await p.indexer.BookOrder.getOrThrow(`${SEED.book}-${id}`)).status;
    expect([await status(1n), await status(2n), await status(3n), await status(4n)]).toEqual([
      "Cancelled",
      "Cancelled",
      "Open",
      "Filled",
    ]);
    const stats = await p.indexer.ProtocolStats.getOrThrow("10143");
    expect(stats).toMatchObject({
      orderCount: 4,
      orderCountOurMaker: 4,
      fillCountOurMaker: 1,
      ourMakerShareBps: 10_000,
    });
  });

  it("never routes logs from a book the Graduator did not register", async () => {
    const p = new Protocol();
    outsideMarket(p);
    await p.run();
    p.s.next({ from: ALICE });
    p.orderCreated({
      book: MAINNET_STYLE_BOOK,
      orderId: 1n,
      owner: ALICE,
      size: USDC(1),
      priceE6: 1n,
      isBuy: true,
    });
    p.fill({
      book: MAINNET_STYLE_BOOK,
      orderId: 1n,
      maker: ALICE,
      taker: BOB,
      takerBuysYes: false,
      price: E18(0.5),
      size: USDC(1),
      remaining: 0n,
    });
    // Kuru's events have no indexed fields: the indexer reads them only from registered book addresses.
    await expect(p.run()).rejects.toThrow(/never reached a handler/);
    expect(await p.indexer.Trade.getAll()).toHaveLength(0);
    expect(await p.indexer.BookOrder.getAll()).toHaveLength(0);
  });
});

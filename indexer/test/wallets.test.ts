// Distinct wallets, our-wallet labels, daily rollups and token positions.
import { describe, expect, it } from "vitest";
import { ADDR, ALICE, BOB, CAROL, Protocol, SEED, Side, USDC } from "./helpers.js";

const DAY = 86_400;

describe("wallet counts", () => {
  it("counts each wallet once overall and once per day, and rolls days up", async () => {
    const p = new Protocol(); // starts 2026-10-03
    p.s.next({ from: ALICE });
    p.createMarket({ market: SEED.market, yes: SEED.yes, no: SEED.no, creator: ALICE, amount: USDC(10) });
    p.s.next({ from: ALICE });
    p.stake({ market: SEED.market, user: ALICE, side: Side.No, amount: USDC(5) });
    p.s.next({ from: BOB });
    p.stake({ market: SEED.market, user: BOB, side: Side.Yes, amount: USDC(7) });
    // Next day: Alice again, and Carol for the first time.
    p.s.next({ seconds: DAY, from: ALICE });
    p.stake({ market: SEED.market, user: ALICE, side: Side.Yes, amount: USDC(1) });
    p.s.next({ from: CAROL });
    p.stake({ market: SEED.market, user: CAROL, side: Side.No, amount: USDC(2) });
    await p.run();

    const stats = await p.indexer.ProtocolStats.getOrThrow("10143");
    expect(stats).toMatchObject({
      wallets: 3,
      stakerWallets: 3,
      traderWallets: 0,
      externalWallets: 3,
      stakeCount: 5,
      stakedUsdc: USDC(25),
    });
    const days = (await p.indexer.DailyStats.getAll()).sort((a, b) => a.date.localeCompare(b.date));
    expect(
      days.map((d) => [d.date, d.activeWallets, d.newWallets, d.stakeCount, d.stakedUsdc, d.marketsCreated]),
    ).toEqual([
      ["2026-10-03", 2, 2, 3, USDC(22), 1],
      ["2026-10-04", 2, 1, 2, USDC(3), 0],
    ]);
    expect(days[0]?.dayStart).toBe(1_790_985_600n);
    expect(await p.indexer.WalletDay.getAll()).toHaveLength(4);
    const market = await p.indexer.Market.getOrThrow(SEED.market);
    expect(market).toMatchObject({ stakerCount: 3, yesStakerCount: 2, noStakerCount: 2, stakeCount: 5 });
    expect(await p.indexer.Staker.getOrThrow(`${SEED.market}-${ALICE}`)).toMatchObject({
      yesStake: USDC(11),
      noStake: USDC(5),
      stakeCount: 3,
    });
  });

  it("moves a wallet to our count when one of our wallets pays its stake", async () => {
    const p = new Protocol();
    p.s.next({ from: ALICE });
    p.createMarket({ market: SEED.market, yes: SEED.yes, no: SEED.no, creator: ALICE });
    p.s.next({ from: BOB });
    p.stake({ market: SEED.market, user: BOB, side: Side.No, amount: USDC(5) });
    await p.run();
    expect(await p.indexer.ProtocolStats.getOrThrow("10143")).toMatchObject({ wallets: 2, ourWallets: 0 });

    // Later the keeper pays for a stake in Bob's name: Bob's activity is labelled ours from then on.
    p.s.next({ from: ADDR.keeper });
    p.stake({ market: SEED.market, user: BOB, side: Side.No, amount: USDC(5), payer: ADDR.keeper });
    await p.run();
    expect(await p.indexer.Wallet.getOrThrow(BOB)).toMatchObject({ ourRole: "Seeded", isOurs: true });
    const stats = await p.indexer.ProtocolStats.getOrThrow("10143");
    expect(stats).toMatchObject({
      wallets: 2,
      ourWallets: 1,
      externalWallets: 1,
      stakeCountOurs: 1,
      stakedUsdcOurs: USDC(5),
    });
    const [day] = await p.indexer.DailyStats.getAll();
    expect(day).toMatchObject({ activeWallets: 2, activeOurWallets: 1 });
    // The keeper paid, so it is not a participant itself.
    expect(await p.indexer.Wallet.getOrThrow(ADDR.keeper)).toMatchObject({
      ourRole: "Keeper",
      participant: false,
    });
  });

  it("labels our maker, keeper, guardian and fee recipient from the deployments file", async () => {
    const p = new Protocol();
    p.s.next({ from: ADDR.keeper });
    p.createMarket({ market: SEED.market, yes: SEED.yes, no: SEED.no, creator: ADDR.keeper });
    p.s.next({ from: ADDR.maker });
    p.stake({ market: SEED.market, user: ADDR.maker, side: Side.No, amount: USDC(5) });
    await p.run();
    expect(await p.indexer.Wallet.getOrThrow(ADDR.keeper)).toMatchObject({ ourRole: "Keeper", isOurs: true });
    expect(await p.indexer.Wallet.getOrThrow(ADDR.maker)).toMatchObject({ ourRole: "Maker", isOurs: true });
    expect(await p.indexer.Market.getOrThrow(SEED.market)).toMatchObject({ creatorIsOurs: true });
    expect(await p.indexer.Creator.getOrThrow(ADDR.keeper)).toMatchObject({ isOurs: true });
    expect(await p.indexer.ProtocolStats.getOrThrow("10143")).toMatchObject({
      wallets: 2,
      ourWallets: 2,
      stakeCountOurs: 2,
    });
  });
});

describe("positions from token transfers", () => {
  it("tracks balances between wallets and skips the contracts tokens pass through", async () => {
    const p = new Protocol();
    p.s.next({ from: ALICE });
    p.createMarket({ market: SEED.market, yes: SEED.yes, no: SEED.no, creator: ALICE, amount: USDC(300) });
    p.s.next({ from: BOB });
    p.stake({ market: SEED.market, user: BOB, side: Side.No, amount: USDC(200) });
    p.s.next();
    p.graduate({ market: SEED.market, book: SEED.book });
    p.s.next();
    p.claimTokens({ market: SEED.market, users: [ALICE, BOB] });
    p.s.next({ from: ALICE });
    p.s.emit("OutcomeToken", "Transfer", { from: ALICE, to: CAROL, value: USDC(100) }, SEED.yes);
    p.s.emit("OutcomeToken", "Transfer", { from: ALICE, to: ALICE, value: USDC(1) }, SEED.yes);
    await p.run();

    expect(await p.indexer.Position.getOrThrow(`${SEED.market}-${ALICE}`)).toMatchObject({
      yesBalance: USDC(400),
      yesClaimed: USDC(500),
    });
    expect(await p.indexer.Position.getOrThrow(`${SEED.market}-${CAROL}`)).toMatchObject({
      yesBalance: USDC(100),
      noBalance: 0n,
    });
    expect(await p.indexer.Position.getOrThrow(`${SEED.market}-${BOB}`)).toMatchObject({
      noBalance: USDC(500),
    });
    expect(await p.indexer.Position.get(`${SEED.market}-${SEED.market}`)).toBeUndefined();
    expect(await p.indexer.Position.get(`${SEED.market}-${ADDR.zero}`)).toBeUndefined();
    // Carol only received tokens: she has a position but did not stake or trade.
    expect(await p.indexer.Wallet.getOrThrow(CAROL)).toMatchObject({ participant: false });
    expect(await p.indexer.ProtocolStats.getOrThrow("10143")).toMatchObject({ wallets: 2 });
    const transfers = await p.indexer.TokenTransfer.getAll();
    expect(transfers.filter((t) => t.side === "Yes")).toHaveLength(4); // mint, claim, two transfers

    // A token the vault never registered does not reach the handlers at all.
    p.s.next({ from: ALICE });
    p.s.emit(
      "OutcomeToken",
      "Transfer",
      { from: ALICE, to: CAROL, value: 1n },
      "0x7070000000000000000000000000000000000007",
    );
    await expect(p.run()).rejects.toThrow(/never reached a handler/);
  });

  it("prices a router BuyNo and SellNo by the NO token", async () => {
    const p = new Protocol();
    p.s.next({ from: ALICE });
    p.createMarket({ market: SEED.market, yes: SEED.yes, no: SEED.no, creator: ALICE, amount: USDC(300) });
    p.s.next({ from: BOB });
    p.s.emit(
      "HunchRouter",
      "Trade",
      { market: SEED.market, user: BOB, kind: 2n, amountIn: 3_075_000n, amountOut: USDC(5), book: SEED.book },
      ADDR.router,
    );
    p.s.next({ from: BOB });
    p.s.emit(
      "HunchRouter",
      "Trade",
      { market: SEED.market, user: BOB, kind: 3n, amountIn: USDC(5), amountOut: 2_920_000n, book: SEED.book },
      ADDR.router,
    );
    await p.run();
    const trades = await p.indexer.RouterTrade.getAll();
    expect(trades.map((t) => [t.kind, t.usdc, t.tokens, t.priceE6])).toEqual([
      ["BuyNo", 3_075_000n, USDC(5), 615_000n],
      ["SellNo", 2_920_000n, USDC(5), 584_000n],
    ]);
    expect(await p.indexer.Position.getOrThrow(`${SEED.market}-${BOB}`)).toMatchObject({
      usdcSpent: 3_075_000n,
      usdcReceived: 2_920_000n,
    });
    expect(await p.indexer.ProtocolStats.getOrThrow("10143")).toMatchObject({
      routerTradeCount: 2,
      routerVolume: 5_995_000n,
      traderWallets: 1,
    });
  });
});

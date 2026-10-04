// The testnet golden path, replayed log for log: the seeded market (SeedTestnetMarket.s.sol) and the
// router trades against our maker's quotes (TradeTestnet.s.sol), then outside traders on the same book.
import { describe, expect, it } from "vitest";
import { ADDR, ALICE, BOB, E18, Protocol, SEED, Side, seedTestnetMarket, USDC } from "./helpers.js";

const pair = (wallet: string) => `${SEED.market}-${wallet}`;

describe("seeded testnet market", () => {
  it("creates, stakes, graduates and claims like the contracts did", async () => {
    const p = new Protocol();
    seedTestnetMarket(p);
    const result = await p.run();

    // Dynamic registration: the market and both tokens from the vault, the book from the Graduator.
    const registered = result.changes.flatMap((c) => c.addresses?.sets ?? []);
    expect(registered).toEqual(
      expect.arrayContaining([
        { address: SEED.market, contract: "Market" },
        { address: SEED.yes, contract: "OutcomeToken" },
        { address: SEED.no, contract: "OutcomeToken" },
        { address: SEED.book, contract: "KuruOrderBook" },
      ]),
    );

    const market = await p.indexer.Market.getOrThrow(SEED.market);
    expect(market).toMatchObject({
      number: 1,
      template_id: "1",
      templateId: 1n,
      key: SEED.key,
      params: SEED.params,
      question:
        "Will MON longs pay more than 1,500 raw funding units on Perpl (perp 64) between block 68058301 and block 68264005?",
      asset: "MON",
      perpId: 64n,
      threshold: 1500n,
      blockClock: true,
      lockAt: 68_058_301n,
      closeAt: 68_264_005n,
      settleDeadline: undefined,
      creator_id: ADDR.guardian,
      creatorIsOurs: true,
      yesToken: SEED.yes,
      noToken: SEED.no,
      stage: "Graduated",
      yesTotal: USDC(410),
      noTotal: USDC(280),
      poolTotal: USDC(690),
      impliedChanceBps: 5942,
      stakeCount: 11,
      stakerCount: 11,
      yesStakerCount: 7,
      noStakerCount: 4,
      book_id: SEED.book,
      graduated: true,
      openingPriceE6: 594_202n,
      redeemFeeYesE6: 8_115n,
      redeemFeeNoE6: 11_884n,
      vaultPool: 0n,
      vaultSets: USDC(690),
      collateralIn: USDC(690),
      collateralOut: 0n,
      solvencyMargin: 0n,
    });

    const template = await p.indexer.Template.getOrThrow("1");
    expect(template).toMatchObject({ marketCount: 1, minPool: USDC(500), minStakers: 10n });

    const graduation = await p.indexer.Graduation.getOrThrow(SEED.market);
    expect(graduation).toMatchObject({
      total: USDC(690),
      openingPriceE6: 594_202n,
      book: SEED.book,
      stakerCount: 11,
      caller: ADDR.guardian,
      callerIsOurs: true,
    });
    expect(await p.indexer.Book.getOrThrow(SEED.book)).toMatchObject({
      market_id: SEED.market,
      source: "Created",
    });

    // Stakes paid by the deployer for addresses derived from its key are ours (Seeded).
    const seeded = await p.indexer.Wallet.getOrThrow(SEED.stakers[0] as string);
    expect(seeded).toMatchObject({ ourRole: "Seeded", isOurs: true, participant: true, staked: true });
    const deployer = await p.indexer.Wallet.getOrThrow(ADDR.guardian);
    expect(deployer).toMatchObject({ ourRole: "Guardian", isOurs: true, marketsCreated: 1, stakeCount: 1 });
    const stakes = await p.indexer.Stake.getAll();
    expect(stakes).toHaveLength(11);
    expect(stakes.every((s) => s.paidByUs && s.payer === ADDR.guardian && !s.relayed)).toBe(true);

    // Claims: ⌊T · s / sideTotal⌋, pushed by the deployer; 5 base units of YES dust to the fee recipient.
    const claims = await p.indexer.TokenClaim.getAll();
    expect(claims).toHaveLength(11);
    expect(claims.filter((c) => c.wallet_id !== ADDR.guardian).every((c) => c.pushedByUs)).toBe(true);
    expect(await p.indexer.Position.getOrThrow(pair(SEED.stakers[0] as string))).toMatchObject({
      yesStaked: USDC(60),
      yesClaimed: 100_975_609n,
      yesBalance: 100_975_609n,
      noBalance: 0n,
    });
    expect(await p.indexer.Position.getOrThrow(pair(SEED.stakers[9] as string))).toMatchObject({
      noStaked: USDC(70),
      noBalance: 172_500_000n,
    });
    expect(await p.indexer.Position.getOrThrow(pair(ADDR.guardian))).toMatchObject({
      yesClaimed: 84_146_341n,
      yesBalance: 84_146_346n, // its claim plus the swept dust
      usdcSpent: USDC(50), // its own first stake; the stakes it paid for others are not its position
    });
    const dust = await p.indexer.DustSweep.getAll();
    expect(dust).toEqual([expect.objectContaining({ side: "Yes", amount: 5n, to: ADDR.guardian })]);
    // The market contract passes tokens through: it never gets a Position.
    expect(await p.indexer.Position.get(`${SEED.market}-${SEED.market}`)).toBeUndefined();

    const stats = await p.indexer.ProtocolStats.getOrThrow("10143");
    expect(stats).toMatchObject({
      marketsCreated: 1,
      marketsPool: 0,
      marketsGraduated: 1,
      marketsGraduatedTotal: 1,
      wallets: 11,
      ourWallets: 11,
      externalWallets: 0,
      stakerWallets: 11,
      traderWallets: 0,
      stakeCount: 11,
      stakedUsdc: USDC(690),
      stakeCountOurs: 11,
      stakedUsdcOurs: USDC(690),
      vaultPool: 0n,
      vaultSets: USDC(690),
      vaultObligations: USDC(690),
      vaultUsdcIn: USDC(690),
      vaultUsdcBalance: USDC(690),
      solvencyMargin: 0n,
    });
  });

  it("counts router trades against our maker as ours on both sides, and outside fills separately", async () => {
    const p = new Protocol();
    seedTestnetMarket(p);
    // The maker bot quotes 20 YES each side: a bid at 0.385 (order 1) and an ask at 0.416 (order 2).
    p.s.next({ blocks: 100, seconds: 40, from: ADDR.maker });
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
    // TradeTestnet.s.sol: the deployer buys YES for 5 USDC, then sells the 12.019230 YES back.
    p.s.next({ blocks: 5000, seconds: 2000 });
    p.routerYes({
      market: SEED.market,
      book: SEED.book,
      user: ADDR.guardian,
      buy: true,
      orderId: 2n,
      maker: ADDR.maker,
      price: E18(0.416),
      size: 12_019_230n,
      remaining: 7_980_770n,
      usdc: USDC(5),
    });
    p.s.next({ blocks: 3, seconds: 1 });
    p.routerYes({
      market: SEED.market,
      book: SEED.book,
      user: ADDR.guardian,
      buy: false,
      orderId: 1n,
      maker: ADDR.maker,
      price: E18(0.385),
      size: 12_019_230n,
      remaining: 7_980_770n,
    });
    await p.run();

    let stats = await p.indexer.ProtocolStats.getOrThrow("10143");
    expect(stats).toMatchObject({
      fillCount: 2,
      fillCountOurMaker: 2,
      fillCountOurTrader: 2,
      fillCountBetweenOthers: 0,
      volume: 4_999_999n + 4_627_403n,
      volumeOurMaker: 4_999_999n + 4_627_403n,
      ourMakerShareBps: 10_000,
      ourMakerVolumeShareBps: 10_000,
      routerTradeCount: 2,
      routerVolume: USDC(5) + 4_627_403n,
      orderCount: 2,
      orderCountOurMaker: 2,
      wallets: 12, // the maker joins the 11 seeded wallets
      ourWallets: 12,
      externalWallets: 0,
      traderWallets: 2,
    });
    const fills = await p.indexer.Trade.getAll();
    expect(fills.map((f) => [f.takerBuysYes, f.priceE6, f.size, f.notional])).toEqual([
      [true, 416_000n, 12_019_230n, 4_999_999n],
      [false, 385_000n, 12_019_230n, 4_627_403n],
    ]);
    expect(
      fills.every((f) => f.viaRouter && f.trader === ADDR.guardian && f.isOurMaker && !f.betweenOthers),
    ).toBe(true);
    const buy = (await p.indexer.RouterTrade.getAll()).find((t) => t.kind === "BuyYes");
    expect(buy).toMatchObject({ usdc: USDC(5), tokens: 12_019_230n, priceE6: 416_000n, userIsOurs: true });
    expect(await p.indexer.Position.getOrThrow(pair(ADDR.guardian))).toMatchObject({
      usdcSpent: USDC(50) + USDC(5),
      usdcReceived: 4_627_403n,
      yesBalance: 84_146_346n, // bought 12.019230 and sold them back
    });
    // The maker's USDC flows come from its fills; its tokens sit in Kuru's margin account.
    expect(await p.indexer.Position.getOrThrow(pair(ADDR.maker))).toMatchObject({
      usdcReceived: 4_999_999n,
      usdcSpent: 4_627_403n,
    });
    expect(await p.indexer.BookOrder.getOrThrow(`${SEED.book}-2`)).toMatchObject({
      status: "Open",
      remaining: 7_980_770n,
      isOurMaker: true,
      priceE6: 416_000n,
    });

    // Alice lifts the rest of our ask directly on Kuru; then Bob quotes and Alice trades with Bob.
    p.s.next({ blocks: 10, seconds: 4, from: ALICE });
    p.fill({
      book: SEED.book,
      orderId: 2n,
      maker: ADDR.maker,
      taker: ALICE,
      takerBuysYes: true,
      price: E18(0.416),
      size: 7_980_770n,
      remaining: 0n,
    });
    p.s.next({ blocks: 10, seconds: 4, from: BOB });
    p.orderCreated({
      book: SEED.book,
      orderId: 3n,
      owner: BOB,
      size: USDC(10),
      priceE6: 450_000n,
      isBuy: false,
    });
    p.s.next({ blocks: 10, seconds: 4, from: ALICE });
    p.fill({
      book: SEED.book,
      orderId: 3n,
      maker: BOB,
      taker: ALICE,
      takerBuysYes: true,
      price: E18(0.45),
      size: USDC(4),
      remaining: USDC(6),
    });
    await p.run();

    stats = await p.indexer.ProtocolStats.getOrThrow("10143");
    expect(stats).toMatchObject({
      fillCount: 4,
      fillCountOurMaker: 3,
      fillCountBetweenOthers: 1,
      volumeBetweenOthers: USDC(1.8),
      ourMakerShareBps: 7_500,
      wallets: 14,
      ourWallets: 12,
      externalWallets: 2,
      orderCount: 3,
      orderCountOurMaker: 2,
    });
    expect(await p.indexer.BookOrder.getOrThrow(`${SEED.book}-2`)).toMatchObject({
      status: "Filled",
      remaining: 0n,
    });
    expect(await p.indexer.BookOrder.getOrThrow(`${SEED.book}-3`)).toMatchObject({
      status: "Open",
      remaining: USDC(6),
      isOurMaker: false,
    });
    expect(await p.indexer.Position.getOrThrow(pair(ALICE))).toMatchObject({
      usdcSpent: 3_320_000n + USDC(1.8),
    });
    expect(await p.indexer.Position.getOrThrow(pair(BOB))).toMatchObject({ usdcReceived: USDC(1.8) });
    expect(await p.indexer.Wallet.getOrThrow(ALICE)).toMatchObject({
      isOurs: false,
      traded: true,
      staked: false,
      fillCount: 2,
    });
    const market = await p.indexer.Market.getOrThrow(SEED.market);
    expect(market).toMatchObject({ fillCount: 4, fillCountOurMaker: 3, lastPriceE6: 450_000n });
    const book = await p.indexer.Book.getOrThrow(SEED.book);
    expect(book).toMatchObject({ fillCount: 4, fillCountOurMaker: 3, orderCount: 3, lastPriceE6: 450_000n });
  });

  it("labels a relayed stake as the staker's own money", async () => {
    const p = new Protocol();
    p.s.next();
    p.createMarket({ market: SEED.market, yes: SEED.yes, no: SEED.no, creator: ALICE });
    p.s.next({ from: ADDR.keeper });
    p.stake({ market: SEED.market, user: BOB, side: Side.No, amount: USDC(25), relayed: true });
    await p.run();
    const stake = (await p.indexer.Stake.getAll()).find((s) => s.wallet_id === BOB);
    expect(stake).toMatchObject({ payer: BOB, relayed: true, paidByUs: false, amount: USDC(25) });
    expect(await p.indexer.Wallet.getOrThrow(BOB)).toMatchObject({ isOurs: false, ourRole: "None" });
    expect(await p.indexer.Position.getOrThrow(pair(BOB))).toMatchObject({
      usdcSpent: USDC(25),
      noStaked: USDC(25),
    });
    const stats = await p.indexer.ProtocolStats.getOrThrow("10143");
    expect(stats).toMatchObject({
      wallets: 2,
      ourWallets: 0,
      stakeCountOurs: 0,
      vaultUsdcIn: USDC(75),
      vaultPool: USDC(75),
    });
    expect(await p.indexer.Creator.getOrThrow(ALICE)).toMatchObject({ isOurs: false, marketCount: 1 });
  });
});

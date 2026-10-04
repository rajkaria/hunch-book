// Settlement, void, pool payouts, redemptions and fees: the ledger replay and the latency stats.
import { describe, expect, it } from "vitest";
import {
  ADDR,
  ALICE,
  BOB,
  CAROL,
  Outcome,
  Protocol,
  priceParams,
  SEED,
  Side,
  seedTestnetMarket,
  USDC,
} from "./helpers.js";

const BTC_FEED = "0x12c0f44368a02081ce58a936d1c1f606bb301715"; // testnet Chainlink BTC/USD, in deployments
const POOL_MARKET = "0x9000000000000000000000000000000000000001";
const POOL_YES = "0x9000000000000000000000000000000000000002";
const POOL_NO = "0x9000000000000000000000000000000000000003";
const CLOSE = 1_791_244_800n; // 2026-10-06 00:00:00 UTC

describe("graduated market settlement", () => {
  it("settles YES, measures latency in blocks, and replays redemptions and fees", async () => {
    const p = new Protocol();
    seedTestnetMarket(p);
    await p.run();

    // Close is block 68264005 (the market's endBlock); the keeper settles 95 blocks later.
    p.s.next({ blocks: 68_264_100 - p.s.block, seconds: 82_000, from: ADDR.keeper });
    p.settleGraduated({ market: SEED.market, outcome: Outcome.Yes });
    // The deployer redeems its 84.146346 YES an hour later; a seeded staker redeems a day later.
    p.s.next({ blocks: 9000, seconds: 3600, from: ADDR.guardian });
    p.redeem({
      market: SEED.market,
      holder: ADDR.guardian,
      side: Side.Yes,
      amount: 84_146_346n,
      paid: 83_463_419n,
      fee: 682_927n,
      creator: ADDR.guardian,
    });
    p.s.next({ blocks: 200_000, seconds: 86_400, from: SEED.stakers[0] });
    p.redeem({
      market: SEED.market,
      holder: SEED.stakers[0] as string,
      side: Side.Yes,
      amount: 100_975_609n,
      paid: 100_156_096n,
      fee: 819_513n,
      creator: ADDR.guardian,
    });
    await p.run();

    const settlement = await p.indexer.Settlement.getOrThrow(SEED.market);
    expect(settlement).toMatchObject({
      voided: false,
      outcome: "Yes",
      settler: ADDR.keeper,
      settlerIsOurs: true,
      caller: ADDR.keeper,
      graduated: true,
      early: false,
      latencyBlocks: 95n,
      latencySeconds: undefined,
      redemptionFeeNumerator: 200n * USDC(280),
      redemptionFeeDenominator: 10_000n * USDC(690),
    });
    const market = await p.indexer.Market.getOrThrow(SEED.market);
    expect(market).toMatchObject({
      stage: "Settled",
      outcome: "Yes",
      settler: ADDR.keeper,
      redemptionCount: 2,
      redeemedTokens: 84_146_346n + 100_975_609n,
      redeemedUsdc: 83_463_419n + 100_156_096n,
      redemptionFees: 682_927n + 819_513n,
      vaultSets: USDC(690) - 84_146_346n - 100_975_609n,
      feesAccrued: 682_927n + 819_513n,
      solvencyMargin: 0n,
    });
    const redemptions = await p.indexer.Redemption.getAll();
    expect(redemptions.map((r) => r.secondsAfterSettlement)).toEqual([3_600n, 3_600n + 86_400n]);
    expect(await p.indexer.Position.getOrThrow(`${SEED.market}-${ADDR.guardian}`)).toMatchObject({
      yesBalance: 0n,
      redeemedYes: 84_146_346n,
      redeemedUsdc: 83_463_419n,
      redemptionFees: 682_927n,
    });
    expect(await p.indexer.Creator.getOrThrow(ADDR.guardian)).toMatchObject({
      feesAccrued: 170_731n + 204_878n,
      feesOwed: 170_731n + 204_878n,
    });

    let stats = await p.indexer.ProtocolStats.getOrThrow("10143");
    expect(stats).toMatchObject({
      marketsGraduated: 0,
      marketsSettled: 1,
      settlementsBlockClock: 1,
      settlementLatencyBlocksTotal: 95n,
      avgSettlementLatencyBlocks: 95n,
      settlementsTimed: 0,
      avgSettlementLatencySeconds: undefined,
      redemptionCount: 2,
      redeemedUsdc: 83_463_419n + 100_156_096n,
      redemptionFees: 682_927n + 819_513n,
      marketsRedeemed: 1,
      avgSecondsToFirstRedemption: 3_600n,
      protocolFeesAccrued: 512_196n + (819_513n - 204_878n),
      creatorFeesAccrued: 170_731n + 204_878n,
      vaultFeesOwed: 682_927n + 819_513n,
      vaultUsdcOut: 83_463_419n + 100_156_096n,
      solvencyMargin: 0n,
    });
    expect(stats.vaultObligations).toBe(stats.vaultUsdcBalance);

    // Fee withdrawals move USDC out and lower what is owed by the same amount.
    p.s.next({ from: ADDR.guardian });
    p.s.emit(
      "CollateralVault",
      "CreatorFeesWithdrawn",
      { creator: ADDR.guardian, to: ADDR.guardian, amount: 375_609n },
      ADDR.vault,
    );
    p.s.emit("Usdc", "Transfer", { from: ADDR.vault, to: ADDR.guardian, value: 375_609n }, ADDR.usdc);
    p.s.next({ from: ADDR.guardian });
    p.s.emit(
      "CollateralVault",
      "ProtocolFeesWithdrawn",
      { to: ADDR.guardian, amount: 1_126_831n },
      ADDR.vault,
    );
    p.s.emit("Usdc", "Transfer", { from: ADDR.vault, to: ADDR.guardian, value: 1_126_831n }, ADDR.usdc);
    await p.run();
    stats = await p.indexer.ProtocolStats.getOrThrow("10143");
    expect(stats).toMatchObject({
      creatorFeesWithdrawn: 375_609n,
      protocolFeesWithdrawn: 1_126_831n,
      vaultFeesOwed: 0n,
      solvencyMargin: 0n,
    });
    expect(await p.indexer.Creator.getOrThrow(ADDR.guardian)).toMatchObject({
      feesWithdrawn: 375_609n,
      feesOwed: 0n,
    });
    const kinds = (await p.indexer.VaultEvent.getAll()).map((e) => e.kind);
    expect(kinds).toEqual(
      expect.arrayContaining([
        "Finalize",
        "Redeem",
        "FeeAccrual",
        "CreatorFeeWithdrawal",
        "ProtocolFeeWithdrawal",
        "UsdcIn",
        "UsdcOut",
      ]),
    );
  });

  it("voids a graduated market and redeems both sides at 0.50", async () => {
    const p = new Protocol();
    seedTestnetMarket(p);
    p.s.next({ blocks: 2_000_000, seconds: 900_000, from: ADDR.keeper });
    p.voidMarket({ market: SEED.market });
    p.s.next({ seconds: 60, from: SEED.stakers[9] });
    p.redeem({
      market: SEED.market,
      holder: SEED.stakers[9] as string,
      side: Side.No,
      amount: 172_500_000n,
      paid: 86_250_000n,
      fee: 0n,
      creator: ADDR.guardian,
    });
    await p.run();

    const market = await p.indexer.Market.getOrThrow(SEED.market);
    expect(market).toMatchObject({
      stage: "Voided",
      outcome: "Unresolved",
      redeemedUsdc: 86_250_000n,
      vaultSets: USDC(690) - 86_250_000n, // a void redemption lowers the ledger by what it pays
      solvencyMargin: 0n,
    });
    expect(market.voidedAt).toBeDefined();
    expect(await p.indexer.Settlement.getOrThrow(SEED.market)).toMatchObject({
      voided: true,
      outcome: "Unresolved",
      graduated: true,
    });
    const [redemption] = await p.indexer.Redemption.getAll();
    expect(redemption).toMatchObject({
      voided: true,
      side: "No",
      paid: 86_250_000n,
      fee: 0n,
      secondsAfterSettlement: 60n,
    });
    const stats = await p.indexer.ProtocolStats.getOrThrow("10143");
    expect(stats).toMatchObject({
      marketsVoided: 1,
      marketsGraduated: 0,
      solvencyMargin: 0n,
      settlementsBlockClock: 0,
    });
  });
});

describe("pool-only market settlement", () => {
  function poolMarket(p: Protocol): void {
    p.addTemplates();
    p.s.next({ from: ALICE });
    p.createMarket({
      market: POOL_MARKET,
      yes: POOL_YES,
      no: POOL_NO,
      creator: ALICE,
      templateId: 2n,
      params: priceParams({
        feed: BTC_FEED,
        strikeE8: 8_469_650_000_000n,
        lockTime: CLOSE - 86_400n,
        closeTime: CLOSE,
      }),
    });
    p.s.next({ from: CAROL });
    p.stake({ market: POOL_MARKET, user: CAROL, side: Side.Yes, amount: USDC(20) });
    p.s.next({ from: BOB });
    p.stake({ market: POOL_MARKET, user: BOB, side: Side.No, amount: USDC(30) });
  }

  it("describes a price market and pays winners, fees and dust", async () => {
    const p = new Protocol();
    poolMarket(p);
    // Settled at T + 120 seconds.
    p.s.next({ seconds: Number(CLOSE) + 120 - p.s.timestamp, from: ADDR.keeper });
    p.settlePool({ market: POOL_MARKET, outcome: Outcome.Yes });
    p.s.next({ from: ALICE });
    p.claimPool({ market: POOL_MARKET, user: ALICE, paid: 70_999_999n, fee: 428_572n, creator: ALICE });
    p.s.next({ from: CAROL });
    p.claimPool({ market: POOL_MARKET, user: CAROL, paid: 28_399_999n, fee: 171_429n, creator: ALICE });
    p.poolDust({ market: POOL_MARKET, dust: 1n, creator: ALICE });
    await p.run();

    const market = await p.indexer.Market.getOrThrow(POOL_MARKET);
    expect(market).toMatchObject({
      templateId: 2n,
      question:
        "Will BTC/USD be at or above $84,696.5 at 2026-10-06 00:00:00 UTC (unix time 1791244800), per Chainlink's BTC/USD feed?",
      asset: "BTC/USD",
      priceSource: "Chainlink",
      feed: BTC_FEED,
      strikeE8: 8_469_650_000_000n,
      blockClock: false,
      lockAt: CLOSE - 86_400n,
      closeAt: CLOSE,
      settleDeadline: CLOSE + 604_800n,
      stage: "Settled",
      outcome: "Yes",
      graduated: false,
      poolPaidOut: 70_999_999n + 28_399_999n,
      poolFees: 428_572n + 171_429n + 1n,
      vaultPool: 0n,
      collateralIn: USDC(100),
      collateralOut: 70_999_999n + 28_399_999n,
      feesAccrued: 600_002n,
      solvencyMargin: 0n,
    });
    const payouts = await p.indexer.PoolPayout.getAll();
    expect(payouts.map((x) => [x.kind, x.wallet_id, x.paid, x.fee])).toEqual([
      ["Winnings", ALICE, 70_999_999n, 428_572n],
      ["Winnings", CAROL, 28_399_999n, 171_429n],
      ["Dust", undefined, 0n, 1n],
    ]);
    expect(await p.indexer.Staker.getOrThrow(`${POOL_MARKET}-${ALICE}`)).toMatchObject({
      poolClaimed: true,
      poolPaid: 70_999_999n,
    });
    expect(await p.indexer.Position.getOrThrow(`${POOL_MARKET}-${CAROL}`)).toMatchObject({
      usdcSpent: USDC(20),
      usdcReceived: 28_399_999n,
      poolFee: 171_429n,
    });
    expect(await p.indexer.Creator.getOrThrow(ALICE)).toMatchObject({ feesAccrued: 107_143n + 42_857n });
    expect(await p.indexer.Settlement.getOrThrow(POOL_MARKET)).toMatchObject({
      latencySeconds: 120n,
      latencyBlocks: undefined,
      graduated: false,
      redemptionFeeNumerator: 0n,
      redemptionFeeDenominator: 1n,
    });
    const stats = await p.indexer.ProtocolStats.getOrThrow("10143");
    expect(stats).toMatchObject({
      marketsSettled: 1,
      marketsPool: 0,
      settlementsTimed: 1,
      avgSettlementLatencySeconds: 120n,
      poolPayoutCount: 2,
      poolPaidOut: 70_999_999n + 28_399_999n,
      poolFees: 600_002n,
      vaultPool: 0n,
      vaultFeesOwed: 600_002n,
      vaultUsdcBalance: 600_002n,
      solvencyMargin: 0n,
      wallets: 3,
      ourWallets: 0,
    });
  });

  it("refunds every stake in full when the market voids", async () => {
    const p = new Protocol();
    poolMarket(p);
    p.s.next({ seconds: Number(CLOSE) + 604_801 - p.s.timestamp, from: BOB });
    p.voidMarket({ market: POOL_MARKET });
    for (const [user, amount] of [
      [ALICE, USDC(50)],
      [CAROL, USDC(20)],
      [BOB, USDC(30)],
    ] as const) {
      p.s.next({ from: user });
      p.claimPool({ market: POOL_MARKET, user, paid: amount, fee: 0n, creator: ALICE });
    }
    await p.run();
    const payouts = await p.indexer.PoolPayout.getAll();
    expect(payouts.every((x) => x.kind === "Refund" && x.fee === 0n)).toBe(true);
    expect(await p.indexer.Market.getOrThrow(POOL_MARKET)).toMatchObject({
      stage: "Voided",
      vaultPool: 0n,
      solvencyMargin: 0n,
    });
    const stats = await p.indexer.ProtocolStats.getOrThrow("10143");
    expect(stats).toMatchObject({
      marketsVoided: 1,
      poolPaidOut: USDC(100),
      vaultUsdcBalance: 0n,
      solvencyMargin: 0n,
    });
  });

  it("refunds a one-sided pool and leaves an early settlement out of the latency average", async () => {
    const p = new Protocol();
    p.addTemplates();
    p.s.next({ from: ALICE });
    p.createMarket({
      market: POOL_MARKET,
      yes: POOL_YES,
      no: POOL_NO,
      creator: ALICE,
      templateId: 2n,
      params: priceParams({ feed: BTC_FEED, strikeE8: 1n, lockTime: CLOSE - 60n, closeTime: CLOSE }),
    });
    // A touch-style proof settles YES an hour before close.
    p.s.next({ seconds: Number(CLOSE) - 3_600 - p.s.timestamp, from: ADDR.keeper });
    p.settlePool({ market: POOL_MARKET, outcome: Outcome.Yes });
    p.s.next({ from: ALICE });
    p.claimPool({ market: POOL_MARKET, user: ALICE, paid: USDC(50), fee: 0n, creator: ALICE });
    await p.run();
    expect(await p.indexer.Settlement.getOrThrow(POOL_MARKET)).toMatchObject({
      early: true,
      latencySeconds: undefined,
    });
    const [payout] = await p.indexer.PoolPayout.getAll();
    expect(payout).toMatchObject({ kind: "Refund", paid: USDC(50) });
    const stats = await p.indexer.ProtocolStats.getOrThrow("10143");
    expect(stats).toMatchObject({
      earlySettlements: 1,
      settlementsTimed: 0,
      avgSettlementLatencySeconds: undefined,
    });
  });
});

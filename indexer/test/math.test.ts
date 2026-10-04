// The stats arithmetic, checked against the contracts' formulas and packages/shared's payout math.
import { describe, expect, it } from "vitest";
import * as shared from "../../packages/shared/src/math.js";
import {
  average,
  averagePriceE6,
  impliedChanceBps,
  kuruNotional,
  kuruPriceE6,
  marketSolvencyMargin,
  redeemFeePerTokenE6,
  shareBps,
  utcDay,
} from "../src/lib/math.js";
import { emptyStats, refreshStats } from "../src/lib/store.js";

describe("math", () => {
  it("implied chance matches the shared helper", () => {
    for (const [y, n] of [
      [410_000_000n, 280_000_000n],
      [1n, 0n],
      [0n, 0n],
      [3n, 97n],
    ] as const) {
      expect(impliedChanceBps(y, n)).toBe(Number(shared.impliedChanceBps(y, n)));
    }
    expect(impliedChanceBps(410_000_000n, 280_000_000n)).toBe(5942);
  });

  it("redemption fee per token is Market.feePerToken, and matches the shared fee for one whole token", () => {
    // f_YES = φ · N / T for the seeded market: 0.008115 USDC per YES.
    expect(redeemFeePerTokenE6(280_000_000n, 690_000_000n)).toBe(8_115n);
    expect(redeemFeePerTokenE6(0n, 0n)).toBe(0n);
    // The shared helper rounds the fee up; the per-token view rounds down: they differ by at most one unit.
    const up = shared.redemptionFee(1_000_000n, 280_000_000n, 690_000_000n);
    expect(up - redeemFeePerTokenE6(280_000_000n, 690_000_000n)).toBeLessThanOrEqual(1n);
  });

  it("reads Kuru fills as testnet showed them", () => {
    // TradeTestnet.s.sol: 12.019230 YES at 0.416, then at 0.385.
    expect(kuruPriceE6(416_000_000_000_000_000n)).toBe(416_000n);
    expect(kuruNotional(12_019_230n, 416_000_000_000_000_000n)).toBe(4_999_999n);
    expect(kuruNotional(12_019_230n, 385_000_000_000_000_000n)).toBe(4_627_403n);
    expect(averagePriceE6(5_000_000n, 12_019_230n)).toBe(416_000n);
    expect(averagePriceE6(1n, 0n)).toBe(0n);
  });

  it("shares, averages and days", () => {
    expect(shareBps(3n, 4n)).toBe(7_500);
    expect(shareBps(1n, 3n)).toBe(3_333);
    expect(shareBps(5n, 0n)).toBe(0);
    expect(average(95n, 1)).toBe(95n);
    expect(average(10n, 3)).toBe(3n);
    expect(average(10n, 0)).toBeUndefined();
    expect(utcDay(1_791_039_317n)).toEqual({ date: "2026-10-03", dayStart: 1_790_985_600n });
    expect(utcDay(1_790_985_600n)).toEqual({ date: "2026-10-03", dayStart: 1_790_985_600n });
    expect(utcDay(1_790_985_599n).date).toBe("2026-10-02");
  });

  it("market solvency margin is zero when in and out balance what is owed", () => {
    const m = { collateralIn: 100n, collateralOut: 60n, vaultPool: 0n, vaultSets: 30n, feesAccrued: 10n };
    expect(marketSolvencyMargin(m)).toBe(0n);
    expect(marketSolvencyMargin({ ...m, collateralOut: 61n })).toBe(-1n);
  });

  it("protocol stats derive shares, averages and the solvency margin from raw counters", () => {
    const s = { ...emptyStats({ chainId: 10143, timestamp: 1n, block: 1n }) };
    Object.assign(s, {
      wallets: 14,
      ourWallets: 12,
      fillCount: 4,
      fillCountOurMaker: 3,
      volume: 400n,
      volumeOurMaker: 100n,
      settlementsTimed: 2,
      settlementLatencySecondsTotal: 241n,
      settlementsBlockClock: 1,
      settlementLatencyBlocksTotal: 95n,
      marketsRedeemed: 1,
      firstRedemptionLatencySecondsTotal: 3_600n,
      protocolFeesAccrued: 75n,
      creatorFeesAccrued: 25n,
      protocolFeesWithdrawn: 70n,
      vaultPool: 10n,
      vaultSets: 20n,
      vaultUsdcIn: 100n,
      vaultUsdcOut: 65n,
    });
    refreshStats(s, { timestamp: 9n, block: 8n });
    expect(s).toMatchObject({
      externalWallets: 2,
      ourMakerShareBps: 7_500,
      ourMakerVolumeShareBps: 2_500,
      avgSettlementLatencySeconds: 120n,
      avgSettlementLatencyBlocks: 95n,
      avgSecondsToFirstRedemption: 3_600n,
      vaultFeesOwed: 30n,
      vaultObligations: 60n,
      vaultUsdcBalance: 35n,
      solvencyMargin: -25n,
      updatedAt: 9n,
      updatedAtBlock: 8n,
    });
  });
});

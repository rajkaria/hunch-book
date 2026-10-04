// Every handler is guarded by the id of the record it writes. If the store already holds the result of
// a log (a log delivered again), handling it again changes nothing.
import { createTestIndexer, type TestIndexer } from "envio";
import { describe, expect, it } from "vitest";
import {
  ADDR,
  ALICE,
  afterPeripheryDeploy,
  BOB,
  deliver,
  E18,
  json,
  Outcome,
  Protocol,
  SEED,
  Side,
  seedTestnetMarket,
  snapshotParams,
  USDC,
} from "./helpers.js";

const ENTITIES = [
  "Template",
  "Market",
  "OutcomeToken",
  "Wallet",
  "Stake",
  "Staker",
  "Graduation",
  "TokenClaim",
  "DustSweep",
  "Book",
  "Trade",
  "RouterTrade",
  "BookOrder",
  "Position",
  "Settlement",
  "Redemption",
  "PoolPayout",
  "SetFlow",
  "VaultEvent",
  "TokenTransfer",
  "Creator",
  "ProtocolStats",
  "DailyStats",
  "WalletDay",
  "Snapshot",
  "AutoRedeemOptIn",
  "AutoRedeemMarketOptOut",
  "AutoRedeemSettingChange",
  "AutoRedemption",
  "AutoRedeemFailure",
  "ConditionalOrder",
  "Referral",
  "Referrer",
  "ReferredUser",
  "ReferralFee",
  "ReferralCredit",
  "RewardEpoch",
  "RewardClaim",
  "RewardToken",
  "RewardDistributor",
  "OracleFeed",
  "OracleCheckpoint",
  "PriceAdapter",
  "TimelockOperation",
  "TimelockAction",
] as const;

type Store = Record<(typeof ENTITIES)[number], { getAll(): Promise<unknown[]>; set(row: unknown): void }>;

async function everything(indexer: TestIndexer): Promise<Record<string, unknown[]>> {
  const store = indexer as unknown as Store;
  const out: Record<string, unknown[]> = {};
  for (const name of ENTITIES) out[name] = await store[name].getAll();
  return out;
}

/** Indexes `build`'s logs once, then hands the same logs to a second indexer that already holds the result. */
async function deliveredTwice(build: (p: Protocol) => void) {
  const first = new Protocol();
  build(first);
  const logs = first.s.pending();
  await first.run();
  const after = await everything(first.indexer);

  const second = createTestIndexer();
  const store = second as unknown as Store;
  for (const name of ENTITIES) for (const row of after[name] ?? []) store[name].set(row);
  await deliver(second, logs);
  return { once: json(after), twice: json(await everything(second)) };
}

describe("idempotent handlers", () => {
  it("market creation, stakes and deposits", async () => {
    const { once, twice } = await deliveredTwice((p) => {
      p.addTemplates();
      p.s.next({ from: ALICE });
      p.createMarket({ market: SEED.market, yes: SEED.yes, no: SEED.no, creator: ALICE });
      p.s.next({ from: BOB });
      p.stake({ market: SEED.market, user: BOB, side: Side.No, amount: USDC(10) });
      p.s.next({ from: ADDR.keeper });
      p.stake({ market: SEED.market, user: ALICE, side: Side.Yes, amount: USDC(5), relayed: true });
    });
    expect(twice).toEqual(once);
  });

  it("graduation, claims, orders, fills, router trades, sets, settlement and redemption", async () => {
    const { once, twice } = await deliveredTwice((p) => {
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
      p.fill({
        book: SEED.book,
        orderId: 1n,
        maker: ADDR.maker,
        taker: ALICE,
        takerBuysYes: false,
        price: E18(0.385),
        size: USDC(5),
        remaining: USDC(15),
      });
      p.s.next({ from: BOB });
      p.routerYes({
        market: SEED.market,
        book: SEED.book,
        user: BOB,
        buy: true,
        orderId: 2n,
        maker: ADDR.maker,
        price: E18(0.416),
        size: USDC(5),
        remaining: USDC(15),
      });
      p.s.next({ from: BOB });
      p.mintSets({ market: SEED.market, payer: BOB, to: BOB, amount: USDC(3) });
      p.s.next({ from: BOB });
      p.mergeSets({ market: SEED.market, holder: BOB, to: BOB, amount: USDC(1) });
      p.s.next({ from: ADDR.maker });
      p.s.emit("KuruOrderBook", "OrdersCanceled", { orderId: [1n, 2n], owner: ADDR.maker }, SEED.book);
      p.s.next({ from: BOB });
      p.flashLoan({ receiver: ADDR.router, amount: USDC(2) });
      p.s.next({ blocks: 500_000, seconds: 200_000, from: ADDR.keeper });
      p.settleGraduated({ market: SEED.market, outcome: Outcome.No });
      p.s.next({ from: SEED.stakers[9] });
      p.redeem({
        market: SEED.market,
        holder: SEED.stakers[9] as string,
        side: Side.No,
        amount: 172_500_000n,
        paid: 171_092_754n,
        fee: 1_407_246n,
        creator: ADDR.guardian,
      });
    });
    expect(twice).toEqual(once);
    // And the first pass did count things, so the comparison is not between two empty stores.
    const stats = (once as Record<string, { fillCount: number; routerTradeCount: number }[]>)
      .ProtocolStats?.[0];
    expect(stats).toMatchObject({ fillCount: 2, routerTradeCount: 1 });
  });

  it("template 7 snapshots and every periphery contract", async () => {
    const close = 1_791_046_200n;
    const { once, twice } = await deliveredTwice((p) => {
      seedTestnetMarket(p);
      p.addSnapshotTemplate();
      p.s.next({ from: ALICE });
      p.createMarket({
        market: SNAPSHOT_MARKET,
        yes: SNAPSHOT_YES,
        no: SNAPSHOT_NO,
        creator: ALICE,
        templateId: 7n,
        params: snapshotParams({
          sourceId: 0,
          threshold: 1_000n,
          comparator: 1,
          lockTime: close - 3_600n,
          closeTime: close,
          snapshotWindow: 600,
        }),
      });
      p.s.next({ from: ALICE });
      p.mintSets({ market: SEED.market, payer: ALICE, to: ALICE, amount: USDC(10) });
      p.s.next({ from: ADDR.maker });
      p.orderCreated({
        book: SEED.book,
        orderId: 1n,
        owner: ADDR.maker,
        size: USDC(20),
        priceE6: 385_000n,
        isBuy: true,
      });

      afterPeripheryDeploy(p, ALICE);
      p.optIn(ALICE);
      p.marketOptOut(ALICE, SNAPSHOT_MARKET);
      p.bind({ user: ALICE, referrer: BOB });
      p.placeOrder({
        orderId: 1n,
        owner: ALICE,
        market: SEED.market,
        kind: 1n,
        condition: 0n,
        triggerPriceE6: 380_000n,
        expiry: 1_800_000_000n,
        executorTipBps: 50n,
        amountIn: USDC(2),
        limit: 0n,
      });
      p.placeOrder({
        orderId: 2n,
        owner: ALICE,
        market: SEED.market,
        kind: 0n,
        condition: 1n,
        triggerPriceE6: 100_000n,
        expiry: 1_800_000_000n,
        amountIn: USDC(1),
        limit: 0n,
      });
      p.s.next({ from: ADDR.keeper });
      p.executeYesOrder({
        orderId: 1n,
        owner: ALICE,
        executor: ADDR.keeper,
        market: SEED.market,
        book: SEED.book,
        buy: false,
        kuruOrderId: 1n,
        maker: ADDR.maker,
        price: E18(0.385),
        size: USDC(2),
        remaining: USDC(18),
        tipBps: 50n,
      });
      p.poke({ market: SEED.market, chanceE6: 400_000n, spreadE6: 31_000n });
      p.adapterCreated({ market: SEED.market, side: Side.Yes, adapter: ADAPTER });
      p.s.next({ from: ALICE });
      p.cancelOrder({ orderId: 2n, owner: ALICE });
      p.s.next({ from: ADDR.guardian });
      p.s.emit(
        "MerkleDistributor",
        "FunderTransferred",
        { previous: ADDR.zero, current: ADDR.guardian },
        ADDR.merkleDistributor,
      );
      p.createEpoch({ epoch: 1n, token: ADDR.usdc, total: USDC(10), claimDeadline: 1_800_000_000n });
      const id = p.queueOperation({ data: "0xdeadbeef", nonce: 0n, readyAt: 1_791_300_000n });
      p.queueOperation({ data: "0xfeedface", nonce: 1n, readyAt: 1_791_300_000n });
      p.s.emit("TemplateTimelock", "GraduationPauseSet", { paused: true }, ADDR.timelock);
      p.s.next({ seconds: Number(close) + 5 - p.s.timestamp, from: ADDR.keeper });
      p.snapshotTaken({ sourceId: 0, closeTime: close, window: 600, value: 1_234n, caller: SNAPSHOT_MARKET });
      p.settlePool({ market: SNAPSHOT_MARKET, outcome: Outcome.Yes });
      p.settleGraduated({ market: SEED.market, outcome: Outcome.No });
      p.executeOperation({ id, nonce: 0n, executor: ADDR.keeper });
      p.s.next({ from: ADDR.keeper });
      p.autoRedeem({
        market: SEED.market,
        holder: ALICE,
        side: Side.No,
        amount: USDC(10),
        paid: USDC(10) - 118_841n,
        fee: 118_841n,
        creator: ADDR.guardian,
        caller: ADDR.keeper,
      });
      p.redeemFailed({ market: SEED.market, holder: BOB, reason: "0x" });
      p.s.next({ from: BOB });
      p.claimReward({ epoch: 1n, account: BOB, amount: USDC(4), caller: BOB });
      p.s.next({ from: ADDR.guardian });
      p.sweepEpoch({ epoch: 1n, to: ADDR.guardian, amount: USDC(6) });
      p.s.emit(
        "MerkleDistributor",
        "FunderTransferStarted",
        { current: ADDR.guardian, pending: BOB },
        ADDR.merkleDistributor,
      );
    });
    expect(twice).toEqual(once);
    const counted = once as Record<string, Record<string, unknown>[]>;
    expect(counted.ProtocolStats?.[0]).toMatchObject({
      snapshotsTaken: 1,
      autoRedemptionCount: 1,
      autoRedeemFailures: 1,
      conditionalOrdersExecuted: 1,
      conditionalOrdersCancelled: 1,
      referralBindings: 1,
      referredFeeCount: 1,
      rewardEpochs: 1,
      rewardClaimCount: 1,
      oraclePokes: 1,
      priceAdapters: 1,
      timelockExecuted: 1,
      timelockPending: 1,
    });
  });
});

const SNAPSHOT_MARKET = "0x7700000000000000000000000000000000000001";
const SNAPSHOT_YES = "0x7700000000000000000000000000000000000002";
const SNAPSHOT_NO = "0x7700000000000000000000000000000000000003";
const ADAPTER = "0x00000000000000000000000000000000000000a1";

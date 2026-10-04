// AutoRedeemer: opt-ins and opt-outs per holder, redemptions the keeper makes for them, and failures.
// The vault's Redeemed names the AutoRedeemer as holder; the indexer counts it for the holder it paid.
import { describe, expect, it } from "vitest";
import {
  ADDR,
  ALICE,
  afterPeripheryDeploy,
  BOB,
  CAROL,
  Outcome,
  Protocol,
  SEED,
  Side,
  seedTestnetMarket,
  USDC,
} from "./helpers.js";

const OTHER_MARKET = "0x9000000000000000000000000000000000000009";
// Settled NO: the fee on 10 NO is ceil(10 * 200 * 410 / (10000 * 690)) USDC, in base units.
const FEE = 118_841n;
const PAID = USDC(10) - FEE;

async function seededWithAliceSets() {
  const p = new Protocol();
  seedTestnetMarket(p);
  p.s.next({ from: ALICE });
  p.mintSets({ market: SEED.market, payer: ALICE, to: ALICE, amount: USDC(10) });
  await p.run();
  return p;
}

describe("auto-redeem", () => {
  it("keeps each holder's setting and the per-market exclusions", async () => {
    const p = await seededWithAliceSets();
    afterPeripheryDeploy(p, ALICE);
    p.optIn(ALICE);
    p.s.next({ from: BOB });
    p.optIn(BOB);
    p.s.next({ from: BOB });
    p.marketOptOut(BOB, SEED.market);
    p.marketOptOut(BOB, OTHER_MARKET);
    p.s.next({ from: BOB });
    p.marketOptOut(BOB, OTHER_MARKET, false);
    p.optIn(BOB, false);
    p.s.next({ from: CAROL });
    p.optIn(CAROL);
    p.s.next({ from: CAROL });
    p.optIn(CAROL); // already on: optInWithPermit on a second token
    await p.run();

    expect(await p.indexer.AutoRedeemOptIn.getOrThrow(ALICE)).toMatchObject({
      holder_id: ALICE,
      holderIsOurs: false,
      optedIn: true,
      optInCount: 1,
      marketsOptedOut: 0,
    });
    expect(await p.indexer.AutoRedeemOptIn.getOrThrow(BOB)).toMatchObject({
      optedIn: false,
      optInCount: 1,
      marketsOptedOut: 1,
    });
    expect(await p.indexer.AutoRedeemOptIn.getOrThrow(CAROL)).toMatchObject({ optedIn: true, optInCount: 1 });
    expect(await p.indexer.AutoRedeemMarketOptOut.getOrThrow(`${SEED.market}-${BOB}`)).toMatchObject({
      optIn_id: BOB,
      holder: BOB,
      market_id: SEED.market,
      optedOut: true,
    });
    expect((await p.indexer.AutoRedeemMarketOptOut.getOrThrow(`${OTHER_MARKET}-${BOB}`)).optedOut).toBe(
      false,
    );
    const changes = await p.indexer.AutoRedeemSettingChange.getAll();
    expect(changes.map((c) => [c.holder, c.kind])).toEqual([
      [ALICE, "OptIn"],
      [BOB, "OptIn"],
      [BOB, "MarketOptOut"],
      [BOB, "MarketOptOut"],
      [BOB, "MarketOptIn"],
      [BOB, "OptOut"],
      [CAROL, "OptIn"],
      [CAROL, "OptIn"],
    ]);
    expect((await p.indexer.ProtocolStats.getOrThrow("10143")).autoRedeemHolders).toBe(2);
  });

  it("counts a keeper redemption for the holder it paid, and links it to the vault's record", async () => {
    const p = await seededWithAliceSets();
    afterPeripheryDeploy(p, ALICE);
    p.optIn(ALICE);
    p.s.next({ from: ADDR.keeper });
    p.settleGraduated({ market: SEED.market, outcome: Outcome.No });
    p.s.next({ from: ADDR.keeper });
    p.autoRedeem({
      market: SEED.market,
      holder: ALICE,
      side: Side.No,
      amount: USDC(10),
      paid: PAID,
      fee: FEE,
      creator: ADDR.guardian,
      caller: ADDR.keeper,
    });
    p.redeemFailed({ market: SEED.market, holder: CAROL, reason: "0x5e2b2e7a" });
    await p.run();

    const [redemption] = await p.indexer.Redemption.getAll();
    expect(redemption).toMatchObject({
      wallet_id: ALICE,
      to: ALICE,
      viaAutoRedeemer: true,
      side: "No",
      amount: USDC(10),
      paid: PAID,
      fee: FEE,
    });
    const [auto] = await p.indexer.AutoRedemption.getAll();
    expect(auto).toMatchObject({
      market_id: SEED.market,
      holder_id: ALICE,
      holderIsOurs: false,
      side: "No",
      amount: USDC(10),
      paid: PAID,
      caller: ADDR.keeper,
      callerIsOurs: true,
      redemption_id: redemption?.id,
    });

    // The holder's position, not the AutoRedeemer's: the AutoRedeemer only passes tokens through.
    expect(await p.indexer.Position.getOrThrow(`${SEED.market}-${ALICE}`)).toMatchObject({
      yesBalance: USDC(10),
      noBalance: 0n,
      redeemedNo: USDC(10),
      redeemedUsdc: PAID,
      redemptionFees: FEE,
      usdcSpent: USDC(10),
      usdcReceived: PAID,
    });
    expect(await p.indexer.Position.get(`${SEED.market}-${ADDR.autoRedeemer}`)).toBeUndefined();
    expect(await p.indexer.Wallet.getOrThrow(ALICE)).toMatchObject({
      redemptionCount: 1,
      redeemedUsdc: PAID,
    });

    expect(await p.indexer.AutoRedeemOptIn.getOrThrow(ALICE)).toMatchObject({
      redemptionCount: 1,
      redeemedUsdc: PAID,
    });
    expect(await p.indexer.AutoRedeemFailure.getAll()).toEqual([
      expect.objectContaining({
        market_id: SEED.market,
        holder: CAROL,
        reason: "0x5e2b2e7a",
        caller: ADDR.keeper,
        callerIsOurs: true,
      }),
    ]);
    expect(await p.indexer.AutoRedeemOptIn.getOrThrow(CAROL)).toMatchObject({
      optedIn: false,
      failureCount: 1,
    });
    expect(await p.indexer.Market.getOrThrow(SEED.market)).toMatchObject({
      autoRedemptionCount: 1,
      autoRedeemedUsdc: PAID,
      redemptionCount: 1,
      solvencyMargin: 0n,
    });
    const stats = await p.indexer.ProtocolStats.getOrThrow("10143");
    expect(stats).toMatchObject({
      autoRedeemHolders: 1,
      autoRedemptionCount: 1,
      autoRedeemedUsdc: PAID,
      autoRedemptionCountOurCaller: 1,
      autoRedeemFailures: 1,
      redemptionCount: 1,
      solvencyMargin: 0n,
    });
    const days = await p.indexer.DailyStats.getAll();
    expect(days.reduce((sum, d) => sum + d.autoRedeemedUsdc, 0n)).toBe(PAID);
  });

  it("matches each side of a voided market's redemption to its own vault record", async () => {
    const p = await seededWithAliceSets();
    afterPeripheryDeploy(p, ALICE);
    p.optIn(ALICE);
    p.s.next({ blocks: 3_000_000, seconds: 30 * 86_400, from: BOB });
    p.voidMarket({ market: SEED.market });
    p.s.next({ from: BOB });
    for (const side of [Side.Yes, Side.No]) {
      p.autoRedeem({
        market: SEED.market,
        holder: ALICE,
        side,
        amount: USDC(10),
        paid: USDC(5),
        fee: 0n,
        creator: ADDR.guardian,
        caller: BOB,
      });
    }
    await p.run();
    const redemptions = await p.indexer.Redemption.getAll();
    const autos = await p.indexer.AutoRedemption.getAll();
    expect(autos.map((a) => [a.side, a.callerIsOurs])).toEqual([
      ["Yes", false],
      ["No", false],
    ]);
    for (const a of autos) {
      const r = redemptions.find((x) => x.id === a.redemption_id);
      expect(r).toMatchObject({ side: a.side, voided: true, wallet_id: ALICE, viaAutoRedeemer: true });
    }
    expect(await p.indexer.Position.getOrThrow(`${SEED.market}-${ALICE}`)).toMatchObject({
      yesBalance: 0n,
      noBalance: 0n,
      redeemedUsdc: USDC(10),
    });
    expect((await p.indexer.ProtocolStats.getOrThrow("10143")).autoRedemptionCountOurCaller).toBe(0);
  });
});

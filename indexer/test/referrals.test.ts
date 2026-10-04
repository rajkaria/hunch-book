// ReferralRegistry: bindings, per-referrer aggregates, and the credit a referrer earns from its users'
// fees while their bindings are active (docs/PERIPHERY.md, the referral formula).
import { describe, expect, it } from "vitest";
import { utcDay } from "../src/lib/math.js";
import { protocolShareOf, referralCredit } from "../src/lib/referrals.js";
import {
  ADDR,
  ALICE,
  afterPeripheryDeploy,
  BOB,
  CAROL,
  Outcome,
  Protocol,
  REFERRAL_DURATION,
  SEED,
  Side,
  seedTestnetMarket,
  USDC,
} from "./helpers.js";

const POOL = "0x9100000000000000000000000000000000000001";
const POOL_YES = "0x9100000000000000000000000000000000000002";
const POOL_NO = "0x9100000000000000000000000000000000000003";
// Settled NO: redeeming 10 NO pays a fee of ceil(10 * 200 * 410 / (10000 * 690)) USDC, in base units.
const FEE = 118_841n;
const SHARE = 89_131n; // FEE - floor(FEE * 2500 / 10000)
const POOL_FEE = USDC(0.2);
const POOL_SHARE = USDC(0.15);
const DAY = 86_400;

function redeemTen(p: Protocol, holder: string) {
  p.redeem({
    market: SEED.market,
    holder,
    side: Side.No,
    amount: USDC(10),
    paid: USDC(10) - FEE,
    fee: FEE,
    creator: ADDR.guardian,
  });
}

async function scenario() {
  const p = new Protocol();
  seedTestnetMarket(p);
  p.s.next({ from: ALICE });
  p.mintSets({ market: SEED.market, payer: ALICE, to: ALICE, amount: USDC(30) });
  // A pool market Bob will win from the pool.
  p.s.next({ from: ALICE });
  p.createMarket({
    market: POOL,
    yes: POOL_YES,
    no: POOL_NO,
    creator: ALICE,
    side: Side.Yes,
    amount: USDC(10),
  });
  p.s.next({ from: BOB });
  p.stake({ market: POOL, user: BOB, side: Side.No, amount: USDC(10) });

  afterPeripheryDeploy(p, ALICE);
  const aliceBoundAt = BigInt(p.s.timestamp);
  p.bind({ user: ALICE, referrer: CAROL });
  p.s.next({ from: ADDR.keeper });
  p.bind({ user: BOB, referrer: CAROL, relayer: ADDR.keeper }); // bindFor, relayed by our keeper

  p.s.next({ seconds: DAY, from: ADDR.keeper });
  p.settleGraduated({ market: SEED.market, outcome: Outcome.No });
  p.settlePool({ market: POOL, outcome: Outcome.No });
  p.s.next({ from: ALICE });
  redeemTen(p, ALICE); // credited to Carol
  p.s.next({ from: BOB });
  p.claimPool({ market: POOL, user: BOB, paid: USDC(19.8), fee: POOL_FEE, creator: ALICE }); // to Carol
  p.s.next({ from: SEED.stakers[9] });
  p.redeem({
    market: SEED.market,
    holder: SEED.stakers[9] as string,
    side: Side.No,
    amount: 172_500_000n,
    paid: 171_092_754n,
    fee: 1_407_246n,
    creator: ADDR.guardian,
  }); // nobody referred this staker
  // Alice's binding ends 180 days after it began; a fee at that second is no longer credited.
  p.s.next({ seconds: Number(aliceBoundAt + REFERRAL_DURATION) - p.s.timestamp, from: ALICE });
  redeemTen(p, ALICE);
  // She binds again, to Bob, and redeems the rest.
  p.s.next({ seconds: 60, from: ALICE });
  p.bind({ user: ALICE, referrer: BOB });
  p.s.next({ seconds: 60, from: ALICE });
  redeemTen(p, ALICE);
  await p.run();
  return { p, aliceBoundAt };
}

describe("referrals", () => {
  it("split each fee the way the vault does and credit the referrer's share with a floor", () => {
    expect(protocolShareOf(FEE)).toBe(SHARE);
    expect(protocolShareOf(POOL_FEE)).toBe(POOL_SHARE);
    expect(protocolShareOf(3n)).toBe(3n); // floor(3 * 0.25) = 0 goes to the creator
    expect(referralCredit(SHARE, 2_000n)).toBe(17_826n);
  });

  it("record bindings, and credit fees only while a binding is active", async () => {
    const { p, aliceBoundAt } = await scenario();
    const referrals = await p.indexer.Referral.getAll();
    expect(referrals.map((r) => [r.user_id, r.referrer_id, r.relayed, r.relayerIsOurs, r.feeCount])).toEqual([
      [ALICE, CAROL, false, false, 1],
      [BOB, CAROL, true, true, 1],
      [ALICE, BOB, false, false, 1],
    ]);
    const [first] = referrals;
    expect(first).toMatchObject({
      boundAt: aliceBoundAt,
      expiresAt: aliceBoundAt + REFERRAL_DURATION,
      relayer: ALICE,
      fees: FEE,
      protocolShare: SHARE,
      userIsOurs: false,
    });
    expect(referrals[1]).toMatchObject({ relayer: ADDR.keeper, fees: POOL_FEE, protocolShare: POOL_SHARE });
    // The wallet points at its latest binding.
    expect((await p.indexer.Wallet.getOrThrow(ALICE)).referral_id).toBe(referrals[2]?.id);

    expect(await p.indexer.Referrer.getOrThrow(CAROL)).toMatchObject({
      isOurs: false,
      bindingCount: 2,
      userCount: 2,
      activeUntil: referrals[1]?.expiresAt,
      feeCount: 2,
      fees: FEE + POOL_FEE,
      protocolShare: SHARE + POOL_SHARE,
    });
    expect(await p.indexer.Referrer.getOrThrow(BOB)).toMatchObject({
      bindingCount: 1,
      userCount: 1,
      feeCount: 1,
      protocolShare: SHARE,
    });
    expect(await p.indexer.ReferredUser.getOrThrow(`${CAROL}-${ALICE}`)).toMatchObject({
      bindingCount: 1,
      feeCount: 1,
      fees: FEE,
      protocolShare: SHARE,
    });

    // Three fees were credited: Alice's first redemption, Bob's pool claim, Alice's last redemption.
    const fees = await p.indexer.ReferralFee.getAll();
    expect(fees.map((f) => [f.referrer_id, f.user, f.kind, f.fee, f.protocolShare])).toEqual([
      [CAROL, ALICE, "Redemption", FEE, SHARE],
      [CAROL, BOB, "PoolClaim", POOL_FEE, POOL_SHARE],
      [BOB, ALICE, "Redemption", FEE, SHARE],
    ]);
    expect(fees[1]).toMatchObject({ market_id: POOL, referral_id: referrals[1]?.id });

    // Per referrer per day: what the rewards scorer reads.
    const credits = await p.indexer.ReferralCredit.getAll();
    for (const c of credits) expect(c.id).toBe(`${c.referrer_id}-${c.date}`);
    const total = (referrer: string) =>
      credits.filter((c) => c.referrer_id === referrer).reduce((sum, c) => sum + c.protocolShare, 0n);
    expect(total(CAROL)).toBe(SHARE + POOL_SHARE);
    expect(total(BOB)).toBe(SHARE);
    const carolDay = credits.find((c) => c.referrer_id === CAROL);
    expect(carolDay).toMatchObject({ date: utcDay(BigInt(fees[0]?.timestamp ?? 0n)).date, feeCount: 2 });

    const stats = await p.indexer.ProtocolStats.getOrThrow("10143");
    expect(stats).toMatchObject({
      referralBindings: 3,
      referralBindingsRelayedByUs: 1,
      referrers: 2,
      referredFeeCount: 3,
      referredFees: FEE * 2n + POOL_FEE,
      referredProtocolShare: SHARE * 2n + POOL_SHARE,
      redemptionCount: 4,
    });
    const days = await p.indexer.DailyStats.getAll();
    expect(days.reduce((n, d) => n + d.referralBindings, 0)).toBe(3);
    expect(days.reduce((n, d) => n + d.referredProtocolShare, 0n)).toBe(SHARE * 2n + POOL_SHARE);
  });
});

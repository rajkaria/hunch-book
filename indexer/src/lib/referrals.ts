// Referral credit (docs/PERIPHERY.md, the referral formula): the ReferralRegistry decides who referred a
// user, the fee events decide how much. A fee counts for the user's referrer when the user's binding
// was active at the fee's block time: boundAt <= t < expiresAt.
import type { Enum } from "envio";
import { BPS } from "./math.js";
import { addr } from "./network.js";
import type { Unit } from "./store.js";

/** CollateralVault's CREATOR_SHARE_BPS: the creator's 25% of every fee, never shared with referrers. */
export const CREATOR_SHARE_BPS = 2_500n;

/** fee - floor(fee * 2500 / 10000): the protocol's 75% of a fee, as the vault splits it. */
export function protocolShareOf(fee: bigint): bigint {
  return fee - (fee * CREATOR_SHARE_BPS) / BPS;
}

/** A referrer's credit for one fee at the epoch's published share: floor(protocolShare * bps / 10000). */
export function referralCredit(protocolShare: bigint, referralShareBps: bigint): bigint {
  return (protocolShare * referralShareBps) / BPS;
}

/**
 * Credits one fee-paying event to the user's referrer, if the user's latest binding was active at this
 * event's block time. Called from the handlers of the vault's Redeemed (user = `to`) and a market's
 * PoolClaimed (user = the claimer), which are themselves guarded against running twice.
 */
export async function creditReferral(
  u: Unit,
  e: { user: string; market: string; kind: Enum<"ReferralFeeKind">; fee: bigint },
): Promise<void> {
  if (e.fee === 0n) return;
  const user = addr(e.user);
  const wallet = await u.find("Wallet", user);
  if (!wallet?.referral_id) return;
  const referral = await u.find("Referral", wallet.referral_id);
  if (!referral) return;
  const t = u.m.timestamp;
  if (t < referral.boundAt || t >= referral.expiresAt) return;

  const share = protocolShareOf(e.fee);
  const referrerId = referral.referrer_id;
  for (const row of [
    referral,
    await u.find("Referrer", referrerId),
    await u.find("ReferredUser", `${referrerId}-${user}`),
    await u.load("ReferralCredit", `${referrerId}-${u.m.date}`, () => ({
      id: `${referrerId}-${u.m.date}`,
      referrer_id: referrerId,
      date: u.m.date,
      dayStart: u.m.dayStart,
      feeCount: 0,
      fees: 0n,
      protocolShare: 0n,
    })),
  ]) {
    if (!row) continue;
    row.feeCount += 1;
    row.fees += e.fee;
    row.protocolShare += share;
  }
  u.create("ReferralFee", {
    id: u.m.id,
    referral_id: referral.id,
    referrer_id: referrerId,
    user,
    market_id: addr(e.market),
    kind: e.kind,
    fee: e.fee,
    protocolShare: share,
    date: u.m.date,
    block: u.m.block,
    timestamp: u.m.timestamp,
    tx: u.m.tx,
  });
  const s = await u.stats();
  s.referredFeeCount += 1;
  s.referredFees += e.fee;
  s.referredProtocolShare += share;
  const d = await u.daily();
  d.referredFeeCount += 1;
  d.referredProtocolShare += share;
}

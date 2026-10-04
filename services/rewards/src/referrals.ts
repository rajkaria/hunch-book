import { BPS, splitFee } from "@hunch-book/shared";
import { type Address, getAddress, type Hex, isAddressEqual, zeroAddress } from "viem";

// Referral shares (roadmap C-8), by the formula in docs/PERIPHERY.md: the registry decides who, the
// fee events decide how much. For each fee a user paid at time t while bound to referrer r
// (boundAt <= t < expiresAt):
//
//   protocolShare(fee) = fee − floor(fee · 2500 / 10000)      the creator's 25% is never shared
//   credit(r)         += floor(protocolShare(fee) · referralShareBps / 10000)
//
// Fee events: the vault's Redeemed (the user is `to`, who received the USDC) and each market's
// PoolClaimed (the user is `user`). Rounding dust moved to the fee balances has no user and earns nothing.

/** The policy value planned for each epoch: 20% of the protocol's share. */
export const DEFAULT_REFERRAL_SHARE_BPS = 2_000n;

export interface FeeEvent {
  kind: "redeem" | "pool";
  market: Address;
  user: Address;
  /** USDC base units. */
  fee: bigint;
  block: bigint;
  /** Unix seconds of the block. */
  time: bigint;
  tx: Hex;
}

export interface Binding {
  referrer: Address;
  boundAt: bigint;
  expiresAt: bigint;
}

/** The protocol's 75% of a fee, as the vault splits it. */
export function protocolShare(fee: bigint): bigint {
  return splitFee(fee).protocol;
}

export function referralCredit(fee: bigint, shareBps: bigint = DEFAULT_REFERRAL_SHARE_BPS): bigint {
  return (protocolShare(fee) * shareBps) / BPS;
}

/** True when the binding covers time t: boundAt <= t < expiresAt, with a real referrer. */
export function bindingActiveAt(b: Binding | null, t: bigint): b is Binding {
  return b !== null && !isAddressEqual(b.referrer, zeroAddress) && b.boundAt <= t && t < b.expiresAt;
}

export interface CreditRow {
  event: FeeEvent;
  referrer: Address;
  credit: bigint;
}

export interface ReferralResult {
  /** Per referrer, USDC base units. */
  credits: Map<Address, bigint>;
  rows: CreditRow[];
  /** Fee events with no active binding at their time. */
  unbound: number;
}

/** Credits every referrer for the fees their referred users paid while bound. */
export async function creditReferrers(
  events: readonly FeeEvent[],
  bindingAt: (user: Address, event: FeeEvent) => Promise<Binding | null>,
  shareBps: bigint = DEFAULT_REFERRAL_SHARE_BPS,
): Promise<ReferralResult> {
  const credits = new Map<Address, bigint>();
  const rows: CreditRow[] = [];
  let unbound = 0;
  for (const event of events) {
    if (event.fee <= 0n) continue;
    const binding = await bindingAt(event.user, event);
    if (!bindingActiveAt(binding, event.time)) {
      unbound++;
      continue;
    }
    const credit = referralCredit(event.fee, shareBps);
    if (credit === 0n) continue;
    const referrer = getAddress(binding.referrer);
    credits.set(referrer, (credits.get(referrer) ?? 0n) + credit);
    rows.push({ event, referrer, credit });
  }
  return { credits, rows, unbound };
}

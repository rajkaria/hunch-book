// Payout math, identical to the contracts (docs/PROTOCOL.md §5). All amounts in 6-decimal base units.
// Rounding always favours the vault: payouts round down, fees round up.

/** Hunch's fee on winnings: 2% (φ), in basis points. */
export const FEE_BPS = 200n;
/** The creator's share of every fee, in basis points. */
export const CREATOR_SHARE_BPS = 2_500n;
export const BPS = 10_000n;

const ceilDiv = (a: bigint, b: bigint): bigint => (a === 0n ? 0n : (a - 1n) / b + 1n);

/** Pool phase implied chance of YES in basis points: Y / T. */
export function impliedChanceBps(yesTotal: bigint, noTotal: bigint): bigint {
  const total = yesTotal + noTotal;
  return total === 0n ? 0n : (yesTotal * BPS) / total;
}

/** What a winning staker gets from a pool that settles without graduating (§5.2). */
export function poolPayout(
  stake: bigint,
  winningTotal: bigint,
  losingTotal: bigint,
): { paid: bigint; fee: bigint } {
  if (stake === 0n || winningTotal === 0n) return { paid: 0n, fee: 0n };
  const gross = (stake * losingTotal) / winningTotal;
  const fee = ceilDiv(gross * FEE_BPS, BPS);
  return { paid: stake + gross - fee, fee };
}

/** Tokens a staker claims at graduation: ⌊T · s / sideTotal⌋ (§5.3). */
export function tokenClaim(stake: bigint, sideTotal: bigint, total: bigint): bigint {
  return sideTotal === 0n ? 0n : (stake * total) / sideTotal;
}

/** Redemption fee on `amount` winning tokens: ⌈amount · φ · losingTotal / T⌉ (§5.3). */
export function redemptionFee(amount: bigint, losingTotal: bigint, total: bigint): bigint {
  if (total === 0n) return 0n;
  return ceilDiv(amount * FEE_BPS * losingTotal, BPS * total);
}

/** USDC paid for `amount` winning tokens after settlement. */
export function redemptionPayout(amount: bigint, losingTotal: bigint, total: bigint): bigint {
  return amount - redemptionFee(amount, losingTotal, total);
}

/** Splits a fee into the protocol's and the creator's shares, as the vault does. */
export function splitFee(fee: bigint): { protocol: bigint; creator: bigint } {
  const creator = (fee * CREATOR_SHARE_BPS) / BPS;
  return { protocol: fee - creator, creator };
}

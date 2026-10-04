// Pure arithmetic shared by the handlers. Amounts are 6-decimal base units (USDC and outcome tokens).

export const BPS = 10_000n;
/** φ: Hunch Book's fee on winnings, 2% (PROTOCOL.md section 5.2). */
export const FEE_BPS = 200n;
export const ONE_TOKEN = 1_000_000n;
/** Kuru's Trade event prices carry 18 decimals. */
export const KURU_PRICE_SCALE = 10n ** 18n;
const E18_TO_E6 = 10n ** 12n;
export const SECONDS_PER_DAY = 86_400n;

/** Pool-phase implied chance of YES in basis points: yes / (yes + no). */
export function impliedChanceBps(yesTotal: bigint, noTotal: bigint): number {
  const total = yesTotal + noTotal;
  return total === 0n ? 0 : Number((yesTotal * BPS) / total);
}

/** part / whole in basis points, rounded down; 0 when there is no whole. */
export function shareBps(part: bigint, whole: bigint): number {
  return whole === 0n ? 0 : Number((part * BPS) / whole);
}

/** total / count rounded down, or undefined when nothing was counted. */
export function average(total: bigint, count: number): bigint | undefined {
  return count === 0 ? undefined : total / BigInt(count);
}

/**
 * Redemption fee per whole winning token, as Market.feePerToken computes it: φ · losing / total
 * (PROTOCOL.md section 5.3), in USDC base units.
 */
export function redeemFeePerTokenE6(losingTotal: bigint, total: bigint): bigint {
  return total === 0n ? 0n : (FEE_BPS * losingTotal * ONE_TOKEN) / (BPS * total);
}

/** A Kuru fill price (18 decimals) as USDC base units per whole token. */
export function kuruPriceE6(priceE18: bigint): bigint {
  return priceE18 / E18_TO_E6;
}

/**
 * USDC base units for a Kuru fill: size (token base units) times the 18-decimal price, rounded down.
 * Hunch Book books use size precision 10^6, so Kuru's filled size is already in token base units.
 */
export function kuruNotional(size: bigint, priceE18: bigint): bigint {
  return (size * priceE18) / KURU_PRICE_SCALE;
}

/** Average USDC base units per whole token. */
export function averagePriceE6(usdc: bigint, tokens: bigint): bigint {
  return tokens === 0n ? 0n : (usdc * ONE_TOKEN) / tokens;
}

/** The UTC day of a unix timestamp: "2026-10-04" and the day's first second. */
export function utcDay(timestamp: bigint): { date: string; dayStart: bigint } {
  const dayStart = timestamp - (timestamp % SECONDS_PER_DAY);
  const date = new Date(Number(dayStart) * 1000).toISOString().slice(0, 10);
  return { date, dayStart };
}

/** Per-market solvency: USDC in minus out, minus what is still owed (pool, sets, fees). Never negative. */
export function marketSolvencyMargin(m: {
  collateralIn: bigint;
  collateralOut: bigint;
  vaultPool: bigint;
  vaultSets: bigint;
  feesAccrued: bigint;
}): bigint {
  return m.collateralIn - m.collateralOut - m.vaultPool - m.vaultSets - m.feesAccrued;
}

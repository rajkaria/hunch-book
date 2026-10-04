import { priceToE8 } from "./settlement.js";
import { TouchDirection } from "./templates.js";

// The per-observation rules of the two proof-by-pointer templates (docs/TEMPLATES.md), so the keeper
// that hunts for proofs and the maker that prices these markets read a round or a funding event the
// way the resolvers do:
// - template 3 (ChainlinkTouchResolver): a round touches the strike when its price, scaled to 8
//   decimals, is at or above it (direction 0) or at or below it (direction 1). Equal counts in both
//   directions. Scaling truncates for "at or above" and rounds up for "at or below", so rounding can
//   never flip the rule (PriceScale.toE8 and toE8Ceil).
// - template 4 (PerplFundingSpikeResolver): one funding event spikes when its single-interval
//   increment is strictly above the threshold. Equal is not a spike.

/** PriceScale.toE8Ceil: like `priceToE8`, but scaling a positive price down rounds up. */
export function priceToE8Ceil(value: bigint, exponent: number): bigint {
  const floor = priceToE8(value, exponent);
  const shift = exponent + 8;
  if (value <= 0n || shift >= 0) return floor;
  if (shift < -76) return 1n;
  return value % 10n ** BigInt(-shift) === 0n ? floor : floor + 1n;
}

/** A Chainlink answer with `decimals` in USD × 1e8, rounded the way template 3 rounds for `direction`. */
export function touchPriceE8(answer: bigint, decimals: number, direction: TouchDirection): bigint {
  return direction === TouchDirection.AtOrAbove
    ? priceToE8(answer, -decimals)
    : priceToE8Ceil(answer, -decimals);
}

/**
 * Template 3's rule for one round: a positive answer that reaches the strike in `direction`.
 * Equal to the strike counts in both directions.
 */
export function touchesStrike(
  answer: bigint,
  decimals: number,
  strikeE8: bigint,
  direction: TouchDirection,
): boolean {
  if (answer <= 0n) return false;
  const priceE8 = touchPriceE8(answer, decimals, direction);
  return direction === TouchDirection.AtOrAbove ? priceE8 >= strikeE8 : priceE8 <= strikeE8;
}

/** Template 4's rule for one funding event: its single-interval increment is above the threshold. */
export function isFundingSpike(increment: bigint, threshold: bigint): boolean {
  return increment > threshold;
}

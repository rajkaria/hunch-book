import { normalCdf } from "./normal.js";

// Fair value for template S-2 (docs/PROTOCOL.md §6.2, §9.2): "Will ASSET/USD be at or above K at T?"
// Model: the price is lognormal with no drift. Volatility is the realised volatility of the Chainlink
// feed's own recent rounds, read onchain with getRoundData, so no API key is involved.

/** One Chainlink round: its id (rounds are sequential), the answer (any fixed decimals), when it was written. */
export interface PriceRound {
  roundId: bigint;
  answer: number;
  updatedAt: number;
}

const SECONDS_PER_YEAR = 365 * 24 * 60 * 60;

/** Annualised volatility below which the model will not go, so a quiet feed never makes it overconfident. */
export const MIN_ANNUAL_VOL = 0.05;

/**
 * Realised variance of log returns per second: Σ ln(Pᵢ/Pᵢ₋₁)² / (t_last − t_first), over consecutive
 * rounds in round-id order. Two rounds can share a timestamp (two updates in one second); both moves
 * count. Duplicate round ids and non-positive answers are skipped.
 */
export function realisedVariancePerSecond(rounds: PriceRound[]): {
  variance: number;
  returns: number;
  seconds: number;
} {
  const byId = new Map<bigint, PriceRound>();
  for (const round of rounds) if (round.answer > 0) byId.set(round.roundId, round);
  const sorted = [...byId.values()].sort((a, b) => (a.roundId < b.roundId ? -1 : 1));
  let sumSquares = 0;
  for (let i = 1; i < sorted.length; i++) {
    const r = Math.log((sorted[i] as PriceRound).answer / (sorted[i - 1] as PriceRound).answer);
    sumSquares += r * r;
  }
  const returns = sorted.length - 1;
  const seconds =
    returns > 0 ? (sorted.at(-1) as PriceRound).updatedAt - (sorted[0] as PriceRound).updatedAt : 0;
  if (returns <= 0 || seconds <= 0) throw new Error("not enough rounds to measure volatility");
  return { variance: sumSquares / seconds, returns, seconds };
}

export function annualisedVol(variancePerSecond: number): number {
  return Math.sqrt(variancePerSecond * SECONDS_PER_YEAR);
}

export interface PriceFairInput {
  /** Latest price, same units as `strike`. */
  spot: number;
  strike: number;
  variancePerSecond: number;
  /** closeTime − now, in seconds. */
  secondsToClose: number;
}

export interface PriceFair {
  p: number;
  /** Annualised volatility used (after the floor). */
  vol: number;
  /** True once the observation time has passed. */
  decided: boolean;
}

/** P(S_T ≥ K) for a driftless lognormal price: Φ((ln(S/K) − σ²τ/2) / (σ√τ)). */
export function priceAtTimeFairValue(input: PriceFairInput): PriceFair {
  const { spot, strike, secondsToClose } = input;
  if (!(spot > 0) || !(strike > 0)) throw new Error("spot and strike must be positive");
  const floor = (MIN_ANNUAL_VOL * MIN_ANNUAL_VOL) / SECONDS_PER_YEAR;
  const variance = Math.max(input.variancePerSecond, floor);
  const vol = annualisedVol(variance);
  if (secondsToClose <= 0) return { p: spot >= strike ? 1 : 0, vol, decided: true };
  const total = variance * secondsToClose;
  const d2 = (Math.log(spot / strike) - total / 2) / Math.sqrt(total);
  return { p: normalCdf(d2), vol, decided: false };
}

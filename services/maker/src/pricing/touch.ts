import { normalCdf } from "./normal.js";
import { annualisedVol, MIN_ANNUAL_VOL } from "./priceAtTime.js";

// Fair value for template 3, touch (docs/TEMPLATES.md): "Will Chainlink's ASSET/USD feed report a price
// at or above K (or at or below K) in any round updated between T1 and T2?"
//
// Model: the price is lognormal with no drift (a martingale), so the log price drifts at −σ²/2. The
// chance that it reaches a barrier within τ seconds has a closed form (the reflection principle for a
// Brownian motion with drift). Volatility is the realised volatility of the feed's own recent rounds,
// as for template 2.
//
// Two refinements, both stated in the detail the bot logs:
// - Chainlink writes rounds, not a continuous path: a brief move that never makes it into a round is
//   not a touch. The barrier is moved away from spot by exp(0.5826 · σ · √Δt), Δt the feed's average
//   time between rounds (Broadie, Glasserman and Kou's correction for discrete monitoring).
// - Before the window opens, only rounds from T1 count, so the chance is averaged over where the price
//   may be at T1 (numerical integration over the lognormal price at T1).
// A touch already seen in a round of the window makes the answer YES; past T2 with none, NO.

const SECONDS_PER_YEAR = 365 * 24 * 60 * 60;
/** Broadie, Glasserman and Kou's constant: −ζ(1/2)/√(2π). */
export const DISCRETE_MONITORING_BETA = 0.5826;

export interface TouchFairInput {
  spot: number;
  strike: number;
  /** "up": YES at or above the strike; "down": at or below. */
  direction: "up" | "down";
  variancePerSecond: number;
  /** T1 − now (zero or below once the window is open). */
  secondsToStart: number;
  /** T2 − now. */
  secondsToEnd: number;
  /** A round of the window has already touched the strike. */
  touched: boolean;
  /** Average seconds between the feed's rounds, for the discrete-monitoring correction (0: none). */
  roundSeconds: number;
}

export interface TouchFair {
  p: number;
  /** Annualised volatility used (after the floor). */
  vol: number;
  decided: boolean;
  /** The barrier after the discrete-monitoring correction. */
  barrier: number;
}

/**
 * P(a driftless lognormal price starting at `spot` reaches `barrier` within `seconds`).
 * Already at or beyond the barrier: 1.
 */
export function hitProbability(
  spot: number,
  barrier: number,
  up: boolean,
  variancePerSecond: number,
  seconds: number,
): number {
  if (up ? spot >= barrier : spot <= barrier) return 1;
  if (seconds <= 0) return 0;
  const d = Math.abs(Math.log(barrier / spot));
  const s = Math.sqrt(variancePerSecond * seconds);
  const m = (-variancePerSecond * seconds) / 2; // drift of the log price over the period
  const p = up
    ? normalCdf((-d + m) / s) + Math.exp(-d) * normalCdf((-d - m) / s)
    : normalCdf((-d - m) / s) + Math.exp(d) * normalCdf((-d + m) / s);
  return Math.min(1, Math.max(0, p));
}

const Z_STEPS = 400;
const Z_MAX = 8;

export function touchFairValue(input: TouchFairInput): TouchFair {
  const { spot, strike, direction, secondsToStart, secondsToEnd } = input;
  if (!(spot > 0) || !(strike > 0)) throw new Error("spot and strike must be positive");
  const floor = (MIN_ANNUAL_VOL * MIN_ANNUAL_VOL) / SECONDS_PER_YEAR;
  const variance = Math.max(input.variancePerSecond, floor);
  const vol = annualisedVol(variance);
  const up = direction === "up";
  const shift = Math.exp(DISCRETE_MONITORING_BETA * Math.sqrt(variance * Math.max(0, input.roundSeconds)));
  const barrier = up ? strike * shift : strike / shift;
  if (input.touched) return { p: 1, vol, decided: true, barrier };
  if (secondsToEnd <= 0) return { p: 0, vol, decided: true, barrier };
  if (secondsToStart <= 0) {
    return { p: hitProbability(spot, barrier, up, variance, secondsToEnd), vol, decided: false, barrier };
  }
  // Before the window: average the in-window chance over the price at T1.
  const t1 = secondsToStart;
  const window = secondsToEnd - secondsToStart;
  const sd = Math.sqrt(variance * t1);
  const mean = Math.log(spot) - (variance * t1) / 2;
  const dz = (2 * Z_MAX) / Z_STEPS;
  let p = 0;
  let mass = 0;
  for (let i = 0; i < Z_STEPS; i++) {
    const z = -Z_MAX + (i + 0.5) * dz;
    const w = Math.exp(-0.5 * z * z);
    const atStart = Math.exp(mean + sd * z);
    p += w * hitProbability(atStart, barrier, up, variance, window);
    mass += w;
  }
  return { p: Math.min(1, Math.max(0, p / mass)), vol, decided: false, barrier };
}

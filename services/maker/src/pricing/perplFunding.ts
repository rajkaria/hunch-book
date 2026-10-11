// Fair value for template S-1 (docs/PROTOCOL.md §6.1, §9.2): "Will longs pay more than X in funding on
// Perpl perp P between block A and block B?" YES iff F(B) − F(A) > X, in Perpl's raw funding-sum units.
//
// Model: the funding paid in each remaining interval equals the recent average rate: the mean of the
// last L intervals' funding, with L as many intervals as are left in the window, at least 24 and at most
// 96 (rateWindowFor). Perpl's funding moves in cycles and steps, so one interval is a noisy guess: on
// Monad testnet history, averaging cut the forecast's mean absolute error by a factor of 1.3 to 5
// against the latest interval alone, at every horizon from 24 to 233 intervals, on all four perps.
// The uncertainty around that forecast is not assumed; it is measured. For every start point in the
// perp's own history we compare what the same forecast would have predicted with what was actually
// paid over the same horizon. Those forecast errors are built from the historical per-interval funding
// changes, so they carry their real size, skew and persistence.
// p = P(accrued + forecast + error > X), counted over the historical errors.

/** One read of getFundingSumAtBlock at a grid block. */
export interface FundingSample {
  /** The block queried. */
  block: number;
  /** Cumulative funding at the last funding event at or before `block`, raw units. */
  sum: number;
  /** The block of that event (0 before the perp's funding started). */
  eventBlock: number;
}

export interface FundingFairInput {
  /** Funding already paid inside the window: F(now) − F(startBlock) once the window has started, else 0. */
  accrued: number;
  /** The forecast per-interval funding: the mean of the last `rateWindow` intervals (forecastRate). */
  currentRate: number;
  /** How many recent intervals `currentRate` averages; the historical errors use the same forecast. Default 1. */
  rateWindow?: number;
  /** Funding events from now until the window starts, i.e. in (lastEvent, startBlock]. */
  stepsToStart: number;
  /** Funding events from now until the window ends, i.e. in (lastEvent, endBlock]. */
  stepsToEnd: number;
  /** YES iff ΔF > threshold (equal is NO). Raw units. */
  threshold: number;
  /** Historical per-interval funding, oldest first. */
  increments: number[];
}

export interface FundingFair {
  /** Probability of YES. */
  p: number;
  /** Expected ΔF over the whole window under the forecast. */
  expected: number;
  /** Number of historical forecast errors behind `p`. */
  samples: number;
  /** True when no funding event is left in the window, so the answer is already fixed. */
  decided: boolean;
}

/** The fewest historical forecast errors the model accepts before it quotes. */
export const MIN_FUNDING_SAMPLES = 30;

/** Bounds on the forecast's averaging window, in funding intervals. */
export const MIN_RATE_WINDOW = 24;
export const MAX_RATE_WINDOW = 96;

/** The averaging window for a window ending `stepsToEnd` intervals from now: that many, within the bounds. */
export function rateWindowFor(stepsToEnd: number): number {
  return Math.min(MAX_RATE_WINDOW, Math.max(MIN_RATE_WINDOW, stepsToEnd));
}

/** The mean of the last `window` increments (fewer if the history is shorter); 0 with no history. */
export function forecastRate(increments: number[], window: number): number {
  const recent = increments.slice(-Math.max(1, window));
  return recent.length === 0 ? 0 : recent.reduce((a, b) => a + b, 0) / recent.length;
}

/** Per-interval funding from consecutive grid samples (oldest first). Stops at the perp's funding start. */
export function fundingIncrements(samples: FundingSample[]): number[] {
  const sorted = [...samples].sort((a, b) => a.block - b.block);
  const firstLive = sorted.findIndex((s) => s.eventBlock !== 0);
  if (firstLive === -1) return [];
  const live = sorted.slice(firstLive);
  const increments: number[] = [];
  for (let i = 1; i < live.length; i++) {
    increments.push((live[i] as FundingSample).sum - (live[i - 1] as FundingSample).sum);
  }
  return increments;
}

/** Funding events in (lastEvent, startBlock] and (lastEvent, endBlock] on Perpl's fixed grid. */
export function windowSteps(
  lastEvent: number,
  interval: number,
  startBlock: number,
  endBlock: number,
): { stepsToStart: number; stepsToEnd: number } {
  const steps = (to: number) => Math.max(0, Math.floor((to - lastEvent) / interval));
  return { stepsToStart: steps(startBlock), stepsToEnd: steps(endBlock) };
}

/**
 * Historical errors of the "recent average rate persists" forecast over the steps `from + 1 … to` ahead:
 * for each start t, Σ inc[t + j] − (to − from) · mean(inc[t − window + 1 … t]). Window 1 is the latest
 * interval alone.
 */
export function forecastErrors(increments: number[], from: number, to: number, window = 1): number[] {
  const horizon = to - from;
  const w = Math.max(1, Math.floor(window));
  const prefix = [0];
  for (const inc of increments) prefix.push((prefix[prefix.length - 1] as number) + inc);
  const errors: number[] = [];
  for (let t = w - 1; t + to < increments.length; t++) {
    const rate = ((prefix[t + 1] as number) - (prefix[t + 1 - w] as number)) / w;
    const actual = (prefix[t + to + 1] as number) - (prefix[t + from + 1] as number);
    errors.push(actual - horizon * rate);
  }
  return errors;
}

export function fundingFairValue(input: FundingFairInput): FundingFair {
  const { accrued, currentRate, stepsToStart, stepsToEnd, threshold, increments, rateWindow = 1 } = input;
  if (stepsToEnd < stepsToStart) throw new Error("window ends before it starts");
  if (stepsToEnd === 0) {
    return { p: accrued > threshold ? 1 : 0, expected: accrued, samples: 0, decided: true };
  }
  const expected = accrued + (stepsToEnd - stepsToStart) * currentRate;
  const errors = forecastErrors(increments, stepsToStart, stepsToEnd, rateWindow);
  if (errors.length < MIN_FUNDING_SAMPLES) {
    throw new Error(
      `not enough funding history: ${errors.length} samples for a ${stepsToEnd}-interval horizon (need ${MIN_FUNDING_SAMPLES})`,
    );
  }
  const cut = threshold - expected;
  const above = errors.filter((e) => e > cut).length;
  // Half a count of smoothing keeps p off exactly 0 and 1 when the history has never crossed the cut.
  return { p: (above + 0.5) / (errors.length + 1), expected, samples: errors.length, decided: false };
}

/**
 * How many increments the model needs for a window ending `stepsToEnd` intervals from now. The averaging
 * window costs up to 95 of the 300 spare starts, which still leaves several times MIN_FUNDING_SAMPLES.
 */
export function historyNeeded(stepsToEnd: number): number {
  return stepsToEnd + MIN_FUNDING_SAMPLES * 10;
}

/** Historical forecast starts the bot reads for its errors: about 30 days of Perpl funding intervals. */
export const FUNDING_ERROR_STARTS = 1_000;

/**
 * How many increments the bot reads: the window, the averaging window and FUNDING_ERROR_STARTS starts.
 * A few hundred starts cover under two weeks, one quiet or one wild stretch, and the price swings with
 * it (SOL net funding on testnet read 0.998 from 205 starts and 0.85 from 1,000). A perp with less
 * history gives what it has, which must still meet historyNeeded.
 */
export function historyWanted(stepsToEnd: number): number {
  return stepsToEnd + rateWindowFor(stepsToEnd) + FUNDING_ERROR_STARTS;
}

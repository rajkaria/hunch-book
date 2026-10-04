import { formatFixed } from "../format";

// Perpl funding: units, the funding grid, and recent history so a creator can pick a threshold
// that is genuinely uncertain (docs/PROTOCOL.md §6.1, §8.2).

/** Perpl's funding interval on Monad. The live value is read from the Exchange; this is the fallback. */
export const PERPL_INTERVAL = 8_571n;

/** The parts of Perpl's `getPerpetualInfoV2` the create flow uses. */
export interface PerpInfo {
  perpId: bigint;
  name: string;
  symbol: string;
  priceDecimals: number;
  scalingExp: number;
  /** Perpl's PerpStatusEnum; 0 is paused. */
  status: number;
  fundingStartBlock: bigint;
  /** Mark price in Perpl's price units (priceDecimals). */
  markPrice: bigint;
}

/** One funding event: the cumulative funding sum as of `block`. */
export interface FundingSample {
  block: bigint;
  sum: bigint;
}

/** Recent funding events for one perp, oldest first, on the funding grid. */
export interface FundingHistory {
  interval: bigint;
  /** The newest funding event at or before the head. */
  lastEvent: bigint;
  samples: FundingSample[];
}

export const PERP_STATUS_PAUSED = 0;

/** Decimals of Perpl's funding sum in USD per unit: priceDecimals + fundingSumScalingExp. */
export function fundingDecimals(info: Pick<PerpInfo, "priceDecimals" | "scalingExp">): number {
  return info.priceDecimals + info.scalingExp;
}

/** "$0.0000014", "-$1.6" or "$0": raw funding units as USD per unit of the asset, exact. */
export function formatFundingUsd(raw: bigint, decimals: number): string {
  const negative = raw < 0n;
  const body = formatFixed(negative ? -raw : raw, decimals);
  return negative ? `-$${body}` : `$${body}`;
}

/** The threshold as a percentage of the mark price, for a sense of scale. Null without a price. */
export function percentOfPrice(
  raw: bigint,
  decimals: number,
  info: Pick<PerpInfo, "markPrice" | "priceDecimals">,
): number | null {
  if (info.markPrice <= 0n) return null;
  const usd = Number(raw) / 10 ** decimals;
  const price = Number(info.markPrice) / 10 ** info.priceDecimals;
  return (usd / price) * 100;
}

/** "0.0040%", "0.50%", "12.00%": two significant digits below 1%, two decimals above. */
export function formatPercent(value: number): string {
  if (value === 0 || !Number.isFinite(value)) return "0%";
  const abs = Math.abs(value);
  const places = abs >= 1 ? 2 : Math.min(10, Math.max(2, -Math.floor(Math.log10(abs)) + 1));
  return `${value.toFixed(places)}%`;
}

// ---------- the funding grid ----------

/** Funding events sit on blocks where (block mod interval) equals this offset. */
export function gridAnchor(eventBlock: bigint, interval: bigint): bigint {
  return ((eventBlock % interval) + interval) % interval;
}

/** The first funding-event block at or after `block`. */
export function gridAtOrAfter(block: bigint, interval: bigint, anchor: bigint): bigint {
  const offset = (((block - anchor) % interval) + interval) % interval;
  return offset === 0n ? block : block + (interval - offset);
}

/**
 * Snaps a window to the funding grid: the start moves to the next funding event (so the window never
 * starts earlier than asked), and the end to the grid point nearest the asked end, at least one
 * interval after the start. The window then contains exactly `intervals` funding events.
 */
export function snapWindow(args: {
  startBlock: bigint;
  endBlock: bigint;
  interval: bigint;
  anchor: bigint;
}): { startBlock: bigint; endBlock: bigint; intervals: bigint } {
  const { interval, anchor } = args;
  const startBlock = gridAtOrAfter(args.startBlock, interval, anchor);
  const span = args.endBlock > startBlock ? args.endBlock - startBlock : 0n;
  let intervals = (span + interval / 2n) / interval;
  if (intervals < 1n) intervals = 1n;
  return { startBlock, endBlock: startBlock + intervals * interval, intervals };
}

/** Funding events that count in a window: grid blocks e with start < e <= end. */
export function eventsInWindow(
  startBlock: bigint,
  endBlock: bigint,
  interval: bigint,
  anchor: bigint,
): bigint {
  if (endBlock <= startBlock) return 0n;
  const first = gridAtOrAfter(startBlock + 1n, interval, anchor);
  if (first > endBlock) return 0n;
  return (endBlock - first) / interval + 1n;
}

// ---------- history ----------

/** The change in the funding sum at each event: positive means longs paid shorts. */
export function fundingDeltas(samples: readonly FundingSample[]): bigint[] {
  const out: bigint[] = [];
  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1];
    const cur = samples[i];
    if (prev && cur) out.push(cur.sum - prev.sum);
  }
  return out;
}

/** Sums of every run of `n` consecutive deltas: what past windows of n events paid. */
export function rollingSums(deltas: readonly bigint[], n: number): bigint[] {
  if (n <= 0 || deltas.length < n) return [];
  const out: bigint[] = [];
  let sum = 0n;
  for (let i = 0; i < deltas.length; i++) {
    sum += deltas[i] ?? 0n;
    if (i >= n) sum -= deltas[i - n] ?? 0n;
    if (i >= n - 1) out.push(sum);
  }
  return out;
}

export function median(values: readonly bigint[]): bigint | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? null;
  const lo = sorted[mid - 1];
  const hi = sorted[mid];
  return lo === undefined || hi === undefined ? null : (lo + hi) / 2n;
}

export function meanDelta(deltas: readonly bigint[]): bigint | null {
  if (deltas.length === 0) return null;
  return deltas.reduce((a, b) => a + b, 0n) / BigInt(deltas.length);
}

/** The largest single event in every run of `n` consecutive deltas: past windows' biggest spike. */
export function rollingMax(deltas: readonly bigint[], n: number): bigint[] {
  if (n <= 0 || deltas.length < n) return [];
  const out: bigint[] = [];
  for (let i = n - 1; i < deltas.length; i++) {
    let max = deltas[i - n + 1] ?? 0n;
    for (let j = i - n + 2; j <= i; j++) {
      const d = deltas[j] ?? 0n;
      if (d > max) max = d;
    }
    out.push(max);
  }
  return out;
}

/**
 * The threshold X that splits past windows closest to half and half under a strict "more than X"
 * rule: the candidates are the values themselves. Null for no history.
 */
export function balancedThreshold(values: readonly bigint[]): bigint | null {
  if (values.length === 0) return null;
  const unique = [...new Set(values)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const half = values.length / 2;
  let best: bigint | null = null;
  let bestGap = Number.POSITIVE_INFINITY;
  for (const candidate of unique) {
    const hits = values.filter((v) => v > candidate).length;
    const gap = Math.abs(hits - half);
    if (gap < bestGap) {
      best = candidate;
      bestGap = gap;
    }
  }
  return best;
}

/** What a template 1 window or a template 4 spike measures, per past window of `intervals` events. */
export type FundingRule = "window" | "spike";

/** Each past window's value under the rule: its total funding, or its largest single event. */
export function windowStats(deltas: readonly bigint[], intervals: number, rule: FundingRule): bigint[] {
  return rule === "spike" ? rollingMax(deltas, intervals) : rollingSums(deltas, intervals);
}

/**
 * A threshold that past windows of the same length beat about half the time, so the market starts
 * close to a coin flip. Null when history is too short to judge.
 */
export function suggestThreshold(
  deltas: readonly bigint[],
  intervals: number,
  rule: FundingRule = "window",
): bigint | null {
  return balancedThreshold(windowStats(deltas, intervals, rule));
}

/** How many past windows of `intervals` events would have settled YES at `threshold`. */
export function historicalHits(
  deltas: readonly bigint[],
  intervals: number,
  threshold: bigint,
  rule: FundingRule = "window",
): { hits: number; total: number } | null {
  const stats = windowStats(deltas, intervals, rule);
  if (stats.length === 0) return null;
  return { hits: stats.filter((s) => s > threshold).length, total: stats.length };
}

/** True when past windows say the answer is close to certain (under 10% or over 90% YES). */
export function isLopsided(hits: { hits: number; total: number } | null): boolean {
  if (!hits || hits.total === 0) return false;
  const rate = hits.hits / hits.total;
  return rate < 0.1 || rate > 0.9;
}

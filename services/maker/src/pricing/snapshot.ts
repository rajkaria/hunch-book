import { priceAtTimeFairValue } from "./priceAtTime.js";

// Fair value for template 7, snapshot (docs/TEMPLATES.md, template 7): "Will SOURCE be above /
// at or above / below / at or below K in the first snapshot taken from T?"
// Model: the source's value is lognormal with no drift, the same model as template 2, run from the
// value the resolver reads now. A snapshot source keeps no onchain history the maker could measure a
// volatility from (it is current state only), so each source has an annualised volatility prior:
// a default by what the source is (an asset's mark price, open interest), which MAKER_SNAPSHOT_VOLS
// can override per source id. Once the snapshot is taken the answer is fixed.

const SECONDS_PER_YEAR = 365 * 24 * 60 * 60;

/** Comparators as in SnapshotResolver: 0 above, 1 at or above, 2 below, 3 at or below. */
export type Comparator = 0 | 1 | 2 | 3;

/** Annualised volatility priors for mark prices, by asset symbol as it appears in the source label. */
export const MARK_PRICE_VOL: Readonly<Record<string, number>> = { BTC: 0.5, ETH: 0.65, SOL: 0.8, MON: 1.2 };
/** Open interest moves in steps as traders open and close: a wide prior on every asset. */
export const OPEN_INTEREST_VOL = 1;
/** Any other source: the same wide prior. */
export const DEFAULT_SNAPSHOT_VOL = 1;

/**
 * The volatility prior for a source, from its label ("Perpl's BTC mark price (perp 16)"). An entry in
 * `overrides` (by source id) wins. Mark prices use the asset's prior; open interest and anything the
 * label does not name use the wide default.
 */
export function snapshotVolFor(
  sourceId: number,
  label: string,
  overrides: Readonly<Record<number, number>> = {},
): number {
  const override = overrides[sourceId];
  if (override !== undefined) return override;
  const lower = label.toLowerCase();
  if (lower.includes("open interest")) return OPEN_INTEREST_VOL;
  if (lower.includes("price")) {
    for (const [asset, vol] of Object.entries(MARK_PRICE_VOL)) {
      if (new RegExp(`\\b${asset}\\b`).test(label)) return vol;
    }
  }
  return DEFAULT_SNAPSHOT_VOL;
}

/** Same as SnapshotResolver._holds. */
export function snapshotHolds(value: bigint, threshold: bigint, comparator: Comparator): boolean {
  switch (comparator) {
    case 0:
      return value > threshold;
    case 1:
      return value >= threshold;
    case 2:
      return value < threshold;
    case 3:
      return value <= threshold;
  }
}

export interface SnapshotFairInput {
  /** The source's value now, raw units. */
  value: bigint;
  threshold: bigint;
  comparator: Comparator;
  annualVol: number;
  /** closeTime − now, in seconds. */
  secondsToClose: number;
  /** The stored snapshot's value, once one is taken. */
  snapshot?: bigint;
}

export interface SnapshotFair {
  p: number;
  /** True once the snapshot is stored: the answer is fixed. */
  decided: boolean;
}

/**
 * P(YES). Taken snapshot: 1 or 0. Otherwise P(S_T ≥ K) under a driftless lognormal from the current
 * value (equality has no weight, so above and at or above price the same), and one minus that for the
 * below comparators. At or after T with no snapshot yet, the next snapshot reads about the current
 * value, so the answer is the current value's, but it is not fixed until the snapshot is stored.
 */
export function snapshotFairValue(input: SnapshotFairInput): SnapshotFair {
  const { value, threshold, comparator, annualVol, secondsToClose, snapshot } = input;
  if (snapshot !== undefined)
    return { p: snapshotHolds(snapshot, threshold, comparator) ? 1 : 0, decided: true };
  if (secondsToClose <= 0) return { p: snapshotHolds(value, threshold, comparator) ? 1 : 0, decided: false };
  if (value <= 0n || threshold <= 0n) {
    throw new Error("a snapshot market on a value that can be zero or negative has no lognormal model");
  }
  if (!(annualVol > 0)) throw new Error("the volatility prior must be above zero");
  const above = priceAtTimeFairValue({
    spot: Number(value),
    strike: Number(threshold),
    variancePerSecond: (annualVol * annualVol) / SECONDS_PER_YEAR,
    secondsToClose,
  }).p;
  return { p: comparator <= 1 ? above : 1 - above, decided: false };
}

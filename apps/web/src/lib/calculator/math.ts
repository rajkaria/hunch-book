import type { Deployment } from "@hunch-book/shared";
import {
  averageStep,
  type FundingProjection,
  type FundingStep,
  formatUsdNumber,
  intervalsIn,
  type PerpMeta,
  type PositionSide,
  priceUsd,
  projectFunding,
  ratePercent,
} from "../hedge/math";

// The funding-cost calculator (/calculator). The funding math is the hedge assistant's
// (lib/hedge/math.ts, docs/HEDGE.md): these helpers only turn the form's inputs into its arguments and
// its answer into plain words.

export type SizeMode = "units" | "usd";
export type HorizonChoice = "day" | "week" | "custom";
export type CustomUnit = "hours" | "days";
/** "current": the last funding interval. "average": the mean over the last 24 hours. */
export type RateBasis = "current" | "average";

export const HOUR_SECONDS = 3_600;
export const DAY_SECONDS = 86_400;
/** The longest custom horizon: a year. Funding projected further than that says nothing useful. */
export const MAX_HORIZON_DAYS = 365;

/** The perps the active deployment lists, in its order: [{ symbol: "BTC", id: 16n }, ...]. */
export function perpsOf(deployment: Pick<Deployment, "external">): { symbol: string; id: bigint }[] {
  return Object.entries(deployment.external.perpl.perps).map(([symbol, id]) => ({ symbol, id: BigInt(id) }));
}

/** A positive number from typed text ("1,250.5" and ".5" work), else null. */
export function parseAmount(text: string): number | null {
  const clean = text.trim().replace(/,/g, "");
  if (!/^(\d+\.?\d*|\.\d+)$/.test(clean)) return null;
  const n = Number(clean);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** The size in units of the base asset: typed in units, or as USD notional at the mark price. */
export function unitsFromSize(amount: number, mode: SizeMode, markUsd: number): number | null {
  if (!(amount > 0) || !Number.isFinite(amount)) return null;
  if (mode === "units") return amount;
  return markUsd > 0 ? amount / markUsd : null;
}

/** Seconds in the chosen horizon, or null when a custom one is empty, not a number, or over a year. */
export function horizonSeconds(choice: HorizonChoice, custom: string, unit: CustomUnit): number | null {
  if (choice === "day") return DAY_SECONDS;
  if (choice === "week") return 7 * DAY_SECONDS;
  const n = parseAmount(custom);
  if (n === null) return null;
  const seconds = n * (unit === "days" ? DAY_SECONDS : HOUR_SECONDS);
  return seconds <= MAX_HORIZON_DAYS * DAY_SECONDS ? seconds : null;
}

const plain = (n: number, digits = 2) => n.toLocaleString("en-US", { maximumFractionDigits: digits });

/** "the next 24 hours", "the next 7 days", "the next hour", "the next 36 hours", "the next 2.5 days". */
export function horizonWords(seconds: number): string {
  const hours = seconds / HOUR_SECONDS;
  if (hours === 1) return "the next hour";
  if (hours < 48) return `the next ${plain(hours)} hours`;
  const days = seconds / DAY_SECONDS;
  return `the next ${plain(days)} days`;
}

/**
 * The raw funding per interval the projection assumes: the last interval's, or the mean over the last
 * 24 hours of intervals. `count` is how many intervals that rate stands for (0 with no history).
 */
export function chosenRate(
  steps: readonly FundingStep[],
  basis: RateBasis,
  intervalsPerDay: number,
): { raw: number | null; count: number } {
  if (basis === "current") {
    const last = steps.at(-1);
    return last ? { raw: Number(last.raw), count: 1 } : { raw: null, count: 0 };
  }
  const n = Math.max(1, Math.round(intervalsPerDay));
  const raw = averageStep(steps, n);
  return { raw, count: raw === null ? 0 : Math.min(steps.length, n) };
}

export interface FundingCost {
  /** Funding events in the horizon at the measured block time (fractional: the rate is per event). */
  intervals: number;
  /** Minutes between funding events at the measured block time. */
  intervalMinutes: number;
  /** Intervals the rate stands for: 1 for "the last interval", up to a day's worth for the average. */
  rateIntervals: number;
  units: number;
  markUsd: number;
  notionalUsd: number;
  projection: FundingProjection;
  /** USD the position pays over the horizon if the rate holds. Negative: it receives funding. */
  costUsd: number;
  /** |costUsd| as a percent of the notional, or null without a mark price. */
  costPercent: number | null;
  /** Funding per interval as a percent of the mark price (positive: longs pay). */
  ratePercentPerInterval: number | null;
}

/**
 * What a position pays in funding over `seconds` if the chosen rate holds: Perpl's funding events in the
 * horizon (seconds ÷ (block time × interval blocks)) × the rate per event × the size, signed for the
 * side. Null when the perp has no funding history to project from.
 */
export function estimateFundingCost(args: {
  meta: PerpMeta;
  steps: readonly FundingStep[];
  basis: RateBasis;
  side: PositionSide;
  units: number;
  seconds: number;
  msPerBlock: number;
  intervalBlocks: number;
}): FundingCost | null {
  const { meta, msPerBlock, intervalBlocks } = args;
  const perDay = intervalsIn(DAY_SECONDS, msPerBlock, intervalBlocks);
  const rate = chosenRate(args.steps, args.basis, perDay);
  if (rate.raw === null) return null;
  const intervals = intervalsIn(args.seconds, msPerBlock, intervalBlocks);
  const projection = projectFunding({
    rawPerInterval: rate.raw,
    intervals,
    units: args.units,
    side: args.side,
    meta,
  });
  const markUsd = priceUsd(meta.markPNS, meta);
  const notionalUsd = args.units * markUsd;
  return {
    intervals,
    intervalMinutes: (msPerBlock * intervalBlocks) / 60_000,
    rateIntervals: rate.count,
    units: args.units,
    markUsd,
    notionalUsd,
    projection,
    costUsd: projection.positionUsd,
    costPercent: notionalUsd > 0 ? (Math.abs(projection.positionUsd) / notionalUsd) * 100 : null,
    ratePercentPerInterval: ratePercent(rate.raw, meta),
  };
}

/**
 * USD with enough digits for per-unit funding, which is tiny on low-priced perps: "$3.40", "$0.0042",
 * "-$0.000000338". Never rounds a funding rate to "$0.00".
 */
export function formatRateUsd(value: number): string {
  if (!Number.isFinite(value)) return "n/a";
  const abs = Math.abs(value);
  if (abs === 0 || abs >= 0.0001) return formatUsdNumber(value);
  const body = abs.toLocaleString("en-US", { maximumSignificantDigits: 3, maximumFractionDigits: 20 });
  return value < 0 ? `-$${body}` : `$${body}`;
}

/** "0.05978": a size written to the perp's lot decimals, with no exponent and no trailing zeros. */
export function sizeText(units: number, lotDecimals: number): string {
  const fixed = units.toFixed(Math.min(Math.max(Math.trunc(lotDecimals), 0), 20));
  return fixed.includes(".") ? fixed.replace(/0+$/, "").replace(/\.$/, "") : fixed;
}

/**
 * The assumption behind the number, in one sentence: which rate, over what, and that it is an estimate.
 * `rateText` is the rate already written, such as "$0.105 per BTC".
 */
export function assumptionText(args: {
  basis: RateBasis;
  rateIntervals: number;
  rateText: string;
  horizon: string;
}): string {
  const which =
    args.basis === "current"
      ? `the funding rate of the last interval (${args.rateText} per event)`
      : `the average funding rate of the last ${args.rateIntervals} ${
          args.rateIntervals === 1 ? "interval" : "intervals"
        }, about 24 hours (${args.rateText} per event)`;
  return `This assumes ${which} holds for every funding event in ${args.horizon}. Perpl sets a new rate every interval, so this is an estimate, not a forecast.`;
}

import {
  type Deployment,
  decodeChainlinkTouchParams,
  decodePerplFundingParams,
  decodePerplFundingSpikeParams,
  decodePriceAtTimeParams,
  decodePriceRangeParams,
  encodeChainlinkTouchParams,
  encodePerplFundingParams,
  encodePerplFundingSpikeParams,
  encodePriceAtTimeParams,
  encodePriceRangeParams,
  Phase,
  PriceSource,
  TemplateId,
  TouchDirection,
} from "@hunch-book/shared";
import type { Address, Hex } from "viem";
import { formatE8Usd, formatFixed, formatInt, formatUtc } from "../format";
import { type ChanceSource, marketChance, windowMoment } from "../market/logic";
import { chainlinkFeedName, perpName, pythFeedName } from "../market/params";
import type { ChainClock, MarketView } from "../market/types";

// Ladders (roadmap S-5): markets that ask the same question about the same asset over the same window,
// and differ only in the strike or threshold. Read together, their chances draw the market's implied
// probability curve: the chance of YES at each strike. Grouping decodes each market's own params with the
// shared decoders, so two markets join a ladder only if every other field is identical.

/** "usd": strikes in USD with 8 decimals. "perpl": funding thresholds in Perpl's raw units. */
export type LadderAxis = "usd" | "perpl";
/** "strike": one strike per market. "range": a [lower, upper) bucket per market (template 5). */
export type LadderShape = "strike" | "range";
/** What YES means relative to the strike: at or above it, at or below it, inside the bucket, or more than it. */
export type LadderSense = "above" | "below" | "range" | "more";

export interface LadderSpec {
  templateId: number;
  /** Every param except the strike, so equal keys mean "same question, other strike". */
  key: string;
  shape: LadderShape;
  axis: LadderAxis;
  sense: LadderSense;
  x: bigint;
  upper: bigint | null;
  asset: string;
  /** The question without its window: the page names the window, as clock times where it can. */
  title: string;
  /** Perpl ladders: the perp and the funding scale, to show thresholds in USD once the perp is read. */
  perpl: { perpId: bigint; scalingExp: number } | null;
  /** The same params with another strike (or bucket): the market a "missing strike" would create. */
  withStrike: (x: bigint, upper?: bigint | null) => Hex;
}

/** How a Perpl threshold reads in USD: 10^decimals raw units per dollar, per one unit of `symbol`. */
export interface PerplUnit {
  decimals: number;
  symbol: string;
}

const lower = (a: string): string => a.toLowerCase();

function priceAsset(deployment: Deployment, source: number, feed: Address, pythId: Hex): string {
  const name =
    source === PriceSource.Chainlink ? chainlinkFeedName(deployment, feed) : pythFeedName(deployment, pythId);
  return (
    name ?? (source === PriceSource.Chainlink ? `feed ${feed.slice(0, 8)}` : `Pyth ${pythId.slice(0, 8)}`)
  );
}

/** A market's ladder coordinates, or null for templates that do not ladder (parlays) or bad params. */
export function ladderSpec(
  m: Pick<MarketView, "templateId" | "params">,
  deployment: Deployment,
): LadderSpec | null {
  try {
    switch (m.templateId) {
      case TemplateId.PerplFunding: {
        const p = decodePerplFundingParams(m.params);
        const asset = perpName(deployment, p.perpId) ?? `perp ${p.perpId.toString()}`;
        return {
          templateId: m.templateId,
          key: `1:${p.perpId}:${p.startBlock}:${p.endBlock}:${p.expectedScalingExp}`,
          shape: "strike",
          axis: "perpl",
          sense: "more",
          x: p.threshold,
          upper: null,
          asset,
          title: `${asset} longs pay more than a threshold in funding`,
          perpl: { perpId: p.perpId, scalingExp: p.expectedScalingExp },
          withStrike: (x) => encodePerplFundingParams({ ...p, threshold: x }),
        };
      }
      case TemplateId.PerplFundingSpike: {
        const p = decodePerplFundingSpikeParams(m.params);
        const asset = perpName(deployment, p.perpId) ?? `perp ${p.perpId.toString()}`;
        return {
          templateId: m.templateId,
          key: `4:${p.perpId}:${p.startBlock}:${p.endBlock}:${p.expectedScalingExp}`,
          shape: "strike",
          axis: "perpl",
          sense: "more",
          x: p.threshold,
          upper: null,
          asset,
          title: `One ${asset} funding event charges longs more than a threshold`,
          perpl: { perpId: p.perpId, scalingExp: p.expectedScalingExp },
          withStrike: (x) => encodePerplFundingSpikeParams({ ...p, threshold: x }),
        };
      }
      case TemplateId.PriceAtTime: {
        const p = decodePriceAtTimeParams(m.params);
        const asset = priceAsset(deployment, p.source, p.feed, p.pythId);
        return {
          templateId: m.templateId,
          key: `2:${p.source}:${lower(p.feed)}:${lower(p.pythId)}:${p.lockTime}:${p.closeTime}`,
          shape: "strike",
          axis: "usd",
          sense: "above",
          x: p.strikeE8,
          upper: null,
          asset,
          title: `${asset} at or above a strike at ${formatUtc(p.closeTime)}`,
          perpl: null,
          withStrike: (x) => encodePriceAtTimeParams({ ...p, strikeE8: x }),
        };
      }
      case TemplateId.ChainlinkTouch: {
        const p = decodeChainlinkTouchParams(m.params);
        const asset = priceAsset(deployment, PriceSource.Chainlink, p.feed, `0x${"00".repeat(32)}`);
        const up = p.direction === TouchDirection.AtOrAbove;
        return {
          templateId: m.templateId,
          key: `3:${lower(p.feed)}:${p.direction}:${p.lockTime}:${p.startTime}:${p.endTime}`,
          shape: "strike",
          axis: "usd",
          sense: up ? "above" : "below",
          x: p.strikeE8,
          upper: null,
          asset,
          title: `${asset} ${up ? "reaches" : "falls to"} a level between ${formatUtc(p.startTime)} and ${formatUtc(p.endTime)}`,
          perpl: null,
          withStrike: (x) => encodeChainlinkTouchParams({ ...p, strikeE8: x }),
        };
      }
      case TemplateId.PriceRange: {
        const p = decodePriceRangeParams(m.params);
        const asset = priceAsset(deployment, p.source, p.feed, p.pythId);
        return {
          templateId: m.templateId,
          key: `5:${p.source}:${lower(p.feed)}:${lower(p.pythId)}:${p.lockTime}:${p.closeTime}`,
          shape: "range",
          axis: "usd",
          sense: "range",
          x: p.lowerE8,
          upper: p.upperE8,
          asset,
          title: `${asset} in a price range at ${formatUtc(p.closeTime)}`,
          perpl: null,
          withStrike: (x, upper) => encodePriceRangeParams({ ...p, lowerE8: x, upperE8: upper ?? p.upperE8 }),
        };
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}

export interface LadderPoint {
  market: MarketView;
  x: bigint;
  upper: bigint | null;
  /** The market's implied chance of YES in basis points, or null (voided, or no quote yet). */
  chanceBps: bigint | null;
  chanceSource: ChanceSource;
}

export interface Ladder {
  key: string;
  templateId: number;
  shape: LadderShape;
  axis: LadderAxis;
  sense: LadderSense;
  asset: string;
  title: string;
  perpl: LadderSpec["perpl"];
  /** Sorted by strike (or lower bound), lowest first. */
  points: LadderPoint[];
  /** The params of one rung, to re-encode with a missing strike. */
  sample: LadderSpec;
  /** Every rung shares the window, so the first one's stands for all. */
  window: MarketView["window"];
}

/** Groups markets into ladders with at least `minPoints` rungs, the largest and soonest first. */
export function groupLadders(
  markets: readonly MarketView[],
  deployment: Deployment,
  { minPoints = 2 }: { minPoints?: number } = {},
): Ladder[] {
  const groups = new Map<string, { spec: LadderSpec; points: LadderPoint[] }>();
  for (const m of markets) {
    const spec = ladderSpec(m, deployment);
    if (!spec) continue;
    const chance = marketChance(m);
    const point: LadderPoint = {
      market: m,
      x: spec.x,
      upper: spec.upper,
      chanceBps: chance.bps,
      chanceSource: chance.source,
    };
    const group = groups.get(spec.key);
    if (group) group.points.push(point);
    else groups.set(spec.key, { spec, points: [point] });
  }
  const ladders: Ladder[] = [];
  for (const { spec, points } of groups.values()) {
    if (points.length < minPoints) continue;
    points.sort((a, b) => (a.x === b.x ? 0 : a.x < b.x ? -1 : 1));
    const first = points[0] as LadderPoint;
    ladders.push({
      key: spec.key,
      templateId: spec.templateId,
      shape: spec.shape,
      axis: spec.axis,
      sense: spec.sense,
      asset: spec.asset,
      title: spec.title,
      perpl: spec.perpl,
      points,
      sample: spec,
      window: first.market.window,
    });
  }
  return ladders.sort((a, b) => {
    if (a.points.length !== b.points.length) return b.points.length - a.points.length;
    return a.window.close === b.window.close ? 0 : a.window.close < b.window.close ? -1 : 1;
  });
}

// ---------------------------------------------------------------- missing strikes

/** The nearest 1, 2 or 5 times a power of ten at or below `target` (at least 1). */
export function niceStep(target: bigint): bigint {
  if (target <= 1n) return 1n;
  const digits = target.toString().length;
  const power = 10n ** BigInt(digits - 1);
  const lead = target / power;
  return (lead >= 5n ? 5n : lead >= 2n ? 2n : 1n) * power;
}

/** The step a ladder's rungs are spaced at: the most common gap, or a round share of the strike. */
export function ladderStep(xs: readonly bigint[], axis: LadderAxis): bigint {
  const sorted = [...new Set(xs)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const counts = new Map<bigint, number>();
  for (let i = 1; i < sorted.length; i++) {
    const gap = (sorted[i] as bigint) - (sorted[i - 1] as bigint);
    if (gap > 0n) counts.set(gap, (counts.get(gap) ?? 0) + 1);
  }
  let best: bigint | null = null;
  let bestCount = 0;
  for (const [gap, count] of counts) {
    if (count > bestCount || (count === bestCount && best !== null && gap < best)) {
      best = gap;
      bestCount = count;
    }
  }
  if (best !== null) return best;
  const x = sorted[0] ?? 0n;
  const abs = x < 0n ? -x : x;
  // A single rung: 5% of a price, a quarter of a funding threshold, as a round number.
  return niceStep(axis === "usd" ? abs / 20n : abs / 4n);
}

export interface StrikeSuggestion {
  x: bigint;
  upper: bigint | null;
  /** "gap": between two rungs; "below" or "above": extends the ladder. */
  where: "gap" | "below" | "above";
}

/**
 * Strikes the ladder is missing: gaps between rungs at the ladder's own spacing first, then one step past
 * each end. Range ladders suggest the neighbouring buckets of the same width. Never a strike at or below 0
 * for prices.
 */
export function missingStrikes(
  ladder: Pick<Ladder, "points" | "shape" | "axis">,
  max = 4,
): StrikeSuggestion[] {
  const out: StrikeSuggestion[] = [];
  if (ladder.points.length === 0) return out;
  if (ladder.shape === "range") {
    const buckets = ladder.points
      .filter((p) => p.upper !== null)
      .map((p) => ({ lo: p.x, hi: p.upper as bigint }))
      .sort((a, b) => (a.lo < b.lo ? -1 : a.lo > b.lo ? 1 : 0));
    // The most common bucket width.
    const counts = new Map<bigint, number>();
    for (const b of buckets) counts.set(b.hi - b.lo, (counts.get(b.hi - b.lo) ?? 0) + 1);
    let w = buckets[0] ? buckets[0].hi - buckets[0].lo : 0n;
    let seen = 0;
    for (const [width, n] of counts) {
      if (n > seen) {
        w = width;
        seen = n;
      }
    }
    if (w <= 0n) return out;
    for (let i = 1; i < buckets.length && out.length < max; i++) {
      const prev = buckets[i - 1] as { lo: bigint; hi: bigint };
      const next = buckets[i] as { lo: bigint; hi: bigint };
      if (next.lo > prev.hi) out.push({ x: prev.hi, upper: next.lo, where: "gap" });
    }
    const first = buckets[0];
    const last = buckets[buckets.length - 1];
    if (last && out.length < max) out.push({ x: last.hi, upper: last.hi + w, where: "above" });
    if (first && first.lo - w > 0n && out.length < max) {
      out.push({ x: first.lo - w, upper: first.lo, where: "below" });
    }
    return out;
  }
  const xs = [...new Set(ladder.points.map((p) => p.x))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const step = ladderStep(xs, ladder.axis);
  const have = new Set(xs);
  for (let i = 1; i < xs.length && out.length < max; i++) {
    const lo = xs[i - 1] as bigint;
    const hi = xs[i] as bigint;
    for (let x = lo + step; x < hi && out.length < max; x += step) {
      if (!have.has(x)) out.push({ x, upper: null, where: "gap" });
    }
  }
  const min = xs[0] as bigint;
  const maxX = xs[xs.length - 1] as bigint;
  if (out.length < max) out.push({ x: maxX + step, upper: null, where: "above" });
  const below = min - step;
  if (out.length < max && (ladder.axis === "perpl" ? below >= 0n : below > 0n)) {
    out.push({ x: below, upper: null, where: "below" });
  }
  return out;
}

// ---------------------------------------------------------------- labels and timing

/** A strike as text: "$120,000" for prices, "33 raw units" for Perpl thresholds. */
export function strikeLabel(x: bigint, axis: LadderAxis, unit?: PerplUnit): string {
  if (axis === "usd") return formatE8Usd(x).replace(/\.00$/, "");
  if (!unit) return `${formatInt(x)} raw units`;
  return `${perplUsd(x, unit.decimals)} per ${unit.symbol}`;
}

/** A Perpl funding amount in raw units as USD: "$0.000015", "-$2.5". */
export function perplUsd(x: bigint, decimals: number): string {
  const body = formatFixed(x < 0n ? -x : x, decimals);
  return x < 0n ? `-$${body}` : `$${body}`;
}

/** "$80,000 to $85,000" for a bucket, or the strike alone. */
export function rungLabel(p: Pick<LadderPoint, "x" | "upper">, axis: LadderAxis, unit?: PerplUnit): string {
  return p.upper === null
    ? strikeLabel(p.x, axis, unit)
    : `${strikeLabel(p.x, axis, unit)} to ${strikeLabel(p.upper, axis, unit)}`;
}

/** What YES means at one rung, in a few words. */
export function senseLabel(sense: LadderSense): string {
  switch (sense) {
    case "above":
      return "chance it is at or above the strike";
    case "below":
      return "chance it falls to the strike";
    case "range":
      return "chance it ends inside the range";
    default:
      return "chance funding is more than the threshold";
  }
}

/**
 * True while new rungs can still be created: the shared lock is in the future (for block-clock ladders,
 * by the chain head's estimate). A market must lock in the future when it is created.
 */
export function ladderOpen(ladder: Pick<Ladder, "window">, clock: ChainClock | null, now: number): boolean {
  const lock = windowMoment(ladder.window, ladder.window.lock, clock);
  return lock !== null && lock.time > now + 60;
}

/**
 * Neighbouring rungs whose chances run the wrong way. YES at a higher strike can only happen if YES at a
 * lower one does ("at or above", "more than"), so its chance should never be higher; for "falls to" the
 * other way round. A break means one of the two markets is mispriced against the other. Ranges have no order.
 */
export function monotoneBreaks(ladder: Pick<Ladder, "points" | "sense">): [LadderPoint, LadderPoint][] {
  if (ladder.sense === "range") return [];
  const priced = ladder.points.filter(
    (p) => p.chanceBps !== null && p.market.phase !== Phase.Settled && p.market.phase !== Phase.Voided,
  );
  const breaks: [LadderPoint, LadderPoint][] = [];
  for (let i = 1; i < priced.length; i++) {
    const lo = priced[i - 1] as LadderPoint;
    const hi = priced[i] as LadderPoint;
    if (lo.x === hi.x) continue;
    const a = lo.chanceBps as bigint;
    const b = hi.chanceBps as bigint;
    if (ladder.sense === "below" ? b < a : b > a) breaks.push([lo, hi]);
  }
  return breaks;
}

/** Live rungs: not settled or voided. */
export const liveRungs = (ladder: Pick<Ladder, "points">): number =>
  ladder.points.filter((p) => p.market.phase !== Phase.Settled && p.market.phase !== Phase.Voided).length;

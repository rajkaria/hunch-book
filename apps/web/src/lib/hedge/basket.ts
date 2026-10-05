import { Outcome, Phase } from "@hunch-book/shared";
import type { Address } from "viem";
import { formatChance } from "../format";
import { marketChance } from "../market/logic";
import type { MarketView } from "../market/types";
import {
  eventsBetween,
  fundingMarketOf,
  type LegPricing,
  type PerpMeta,
  PHI,
  type PositionSide,
  type Proposal,
  poolNetGain,
  projectFunding,
  roundUsdc,
  type Sizing,
  sizeLeg,
} from "./math";
import type { TrackedBasket, TrackedLeg } from "./tracking";

// Baskets (docs/HEDGE.md, "Baskets"): one hedge made of one or more markets on the same perp's funding.
// The rule is an even split. The basket covers `cover` times the funding the position is projected to
// pay over every funding event that falls inside at least one leg's window, and each of the n legs is
// sized so that its win adds 1/n of that. Legs at higher thresholds win only when funding runs higher,
// so a basket of strikes pays more as funding rises. A one-leg basket at 100% is the single-market hedge.

export const COVER_DEFAULT = 1;
/** The share of the projected funding a basket may cover: 10% to 200%. */
export const COVER_MIN = 0.1;
export const COVER_MAX = 2;
/** The cover ratios the page offers. */
export const COVER_CHOICES: readonly number[] = [0.5, 0.75, 1, 1.5];

/** A cover ratio inside its bounds; anything not a number is the default, 100%. */
export function clampCover(cover: number | undefined): number {
  if (cover === undefined || !Number.isFinite(cover)) return COVER_DEFAULT;
  return Math.min(COVER_MAX, Math.max(COVER_MIN, cover));
}

/** One market that can go into a basket, with what the sizing and the scenarios need to know. */
export interface BasketCandidate {
  market: Address;
  /** Template 1 (net funding over a window) or template 4 (one event above the threshold). */
  kind: "net" | "spike";
  buy: "yes" | "no";
  pricing: LegPricing;
  /** The part of the window still ahead: from max(now, its start) to its end. */
  from: bigint;
  to: bigint;
  /** Funding events left in the window. */
  eventsLeft: number;
  /** The market's threshold, in the perp's raw funding units. */
  thresholdRaw: number;
  /** Raw funding the window has already counted: 0 before it starts, null while it is being read. */
  accruedRaw: number | null;
}

/** Whether a window has already counted funding events, so its outcome depends on what was paid so far. */
export function windowStarted(startBlock: bigint, lastEvent: bigint): boolean {
  return startBlock < lastEvent;
}

/**
 * A proposal as a basket candidate. A template 1 window that has started needs the funding sum at its
 * start (`sumAtStart`): what it has counted so far is the latest sum minus that. Thresholds are moved
 * onto the perp's own scale, so they compare with its funding directly.
 */
export function candidateOf(
  p: Proposal,
  args: { head: bigint; lastEvent: bigint; lastSum: bigint; scalingExp: number; sumAtStart?: bigint },
): BasketCandidate {
  const { fm } = p;
  let accruedRaw: number | null = 0;
  if (fm.kind === "net" && windowStarted(fm.startBlock, args.lastEvent)) {
    accruedRaw = args.sumAtStart === undefined ? null : Number(args.lastSum - args.sumAtStart);
  }
  return {
    market: fm.market.address,
    kind: fm.kind,
    buy: p.buy,
    pricing: p.pricing,
    from: fm.startBlock > args.head ? fm.startBlock : args.head,
    to: fm.endBlock,
    eventsLeft: p.intervals,
    thresholdRaw: Number(fm.threshold) * 10 ** (args.scalingExp - fm.scalingExp),
    accruedRaw,
  };
}

/**
 * Funding events that fall inside at least one window, counted on Perpl's grid. Overlapping windows
 * count their shared events once; a gap between two windows counts nothing.
 */
export function eventsInAnyWindow(
  windows: readonly { from: bigint; to: bigint }[],
  lastEvent: bigint,
  interval: bigint,
): number {
  const sorted = windows
    .filter((w) => w.to > w.from)
    .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
  let total = 0;
  let run: { from: bigint; to: bigint } | null = null;
  for (const w of sorted) {
    if (run && w.from <= run.to) {
      if (w.to > run.to) run.to = w.to;
      continue;
    }
    if (run) total += eventsBetween(lastEvent, interval, run.from, run.to);
    run = { from: w.from, to: w.to };
  }
  if (run) total += eventsBetween(lastEvent, interval, run.from, run.to);
  return total;
}

// ---------------------------------------------------------------- scenarios

export interface FundingScenario {
  key: "flip" | "half" | "hold" | "double";
  label: string;
  /** The rate in this scenario, as a multiple of the rate the projection uses. */
  multiplier: number;
}

export const SCENARIOS: readonly FundingScenario[] = [
  { key: "flip", label: "Funding flips sign", multiplier: -1 },
  { key: "half", label: "Half the rate", multiplier: 0.5 },
  { key: "hold", label: "The rate holds", multiplier: 1 },
  { key: "double", label: "Twice the rate", multiplier: 2 },
];

/**
 * Whether a leg's side wins if funding runs at `rawPerInterval` for every event left in its window.
 * Template 1 pays YES when the window's net funding (what it has counted so far plus what is ahead) is
 * more than the threshold. Template 4 pays YES when one event charges longs more than the threshold;
 * at a steady rate every event is the same, so that is the rate itself, if an event is left.
 */
export function legWins(c: BasketCandidate, rawPerInterval: number): boolean {
  const yes =
    c.kind === "spike"
      ? c.eventsLeft >= 1 && rawPerInterval > c.thresholdRaw
      : (c.accruedRaw ?? 0) + rawPerInterval * c.eventsLeft > c.thresholdRaw;
  return c.buy === "yes" ? yes : !yes;
}

export interface ScenarioRow {
  scenario: FundingScenario;
  /** Raw funding per interval in this scenario. */
  rawPerInterval: number;
  /** USD the position pays over the basket's events. Negative: it receives funding. */
  fundingPaid: number;
  /** For each leg, in the basket's order: does its side win? */
  wins: boolean[];
  /** USDC the winning legs pay out. */
  payout: number;
  /** USDC the basket cost. */
  cost: number;
  /** payout − cost − funding paid. */
  net: number;
  /** −funding paid: the same scenario with no basket. */
  unhedged: number;
}

type SizedLeg = Extract<Sizing, { ok: true }>;

/** What the position pays and the basket pays out if funding runs at each scenario's rate. */
export function scenarioTable(args: {
  legs: readonly { candidate: BasketCandidate; sizing: SizedLeg }[];
  /** The projected funding cost at the rate as it is (scenario "the rate holds"). */
  cost: number;
  rawPerInterval: number;
  scenarios?: readonly FundingScenario[];
}): ScenarioRow[] {
  const cost = roundUsdc(args.legs.reduce((sum, l) => sum + l.sizing.cost, 0));
  return (args.scenarios ?? SCENARIOS).map((scenario) => {
    const raw = args.rawPerInterval * scenario.multiplier;
    const wins = args.legs.map((l) => legWins(l.candidate, raw));
    const payout = roundUsdc(args.legs.reduce((sum, l, i) => sum + (wins[i] ? l.sizing.payoutIfWin : 0), 0));
    const fundingPaid = roundUsdc(args.cost * scenario.multiplier);
    return {
      scenario,
      rawPerInterval: raw,
      fundingPaid,
      wins,
      payout,
      cost,
      net: roundUsdc(payout - cost - fundingPaid),
      unhedged: roundUsdc(-fundingPaid),
    };
  });
}

// ---------------------------------------------------------------- sizing

export interface BasketLeg {
  candidate: BasketCandidate;
  sizing: SizedLeg;
}

export interface DroppedLeg {
  candidate: BasketCandidate;
  reason: string;
}

export type Basket =
  | { ok: false; reason: string; dropped: DroppedLeg[] }
  | {
      ok: true;
      /** The projected funding cost the basket was sized against, USD. */
      cost: number;
      cover: number;
      /** cover × cost: what the basket adds if every leg wins. */
      target: number;
      /** target ÷ legs: what each leg adds if it wins. */
      share: number;
      legs: BasketLeg[];
      /** Markets that cannot be sized right now, left out of the split. */
      dropped: DroppedLeg[];
      totalCost: number;
      payoutIfAllWin: number;
      netIfAllWin: number;
      /** Share of the target the basket covers if every leg wins, 0 to 1. */
      covered: number;
      scenarios: ScenarioRow[];
    };

/**
 * Sizes a basket by an even split: target = cover × the projected funding cost, and each leg is sized
 * so that its win adds target ÷ n (rounded up to whole micro-USDC), with n the legs that can be sized.
 * A leg is a pool stake or tokens on the book, priced as the single-market hedge prices it. A market
 * that cannot be sized at all (no price on its side, nobody on the other side of its pool, a full pool)
 * is left out of the split with the reason; whether it can be sized does not depend on the amount.
 */
export function sizeBasket(args: {
  cost: number;
  cover?: number;
  candidates: readonly BasketCandidate[];
  rawPerInterval: number;
  scenarios?: readonly FundingScenario[];
}): Basket {
  const cover = clampCover(args.cover);
  if (args.candidates.length === 0) {
    return { ok: false, reason: "Add a market to the basket.", dropped: [] };
  }
  if (!(args.cost > 0)) return { ok: false, reason: "There is no funding cost to cover.", dropped: [] };
  const target = roundUsdc(args.cost * cover, "up");
  if (!(target > 0)) return { ok: false, reason: "The funding to cover rounds to zero USDC.", dropped: [] };
  const dropped: DroppedLeg[] = [];
  const usable: BasketCandidate[] = [];
  for (const candidate of args.candidates) {
    const probe = sizeLeg(candidate.pricing, target);
    if (probe.ok) usable.push(candidate);
    else dropped.push({ candidate, reason: probe.reason });
  }
  if (usable.length === 0) {
    return { ok: false, reason: "None of the markets in this basket can be sized right now.", dropped };
  }
  const share = roundUsdc(target / usable.length, "up");
  const legs: BasketLeg[] = [];
  for (const candidate of usable) {
    const sizing = sizeLeg(candidate.pricing, share);
    if (sizing.ok) legs.push({ candidate, sizing });
    else dropped.push({ candidate, reason: sizing.reason });
  }
  const totalCost = roundUsdc(legs.reduce((sum, l) => sum + l.sizing.cost, 0));
  const payoutIfAllWin = roundUsdc(legs.reduce((sum, l) => sum + l.sizing.payoutIfWin, 0));
  const netIfAllWin = roundUsdc(payoutIfAllWin - totalCost);
  return {
    ok: true,
    cost: args.cost,
    cover,
    target,
    share,
    legs,
    dropped,
    totalCost,
    payoutIfAllWin,
    netIfAllWin,
    // Each leg covers its share, or less when its pool is too small or full.
    covered: Math.min(1, (legs.reduce((sum, l) => sum + l.sizing.covered, 0) * share) / target),
    scenarios: scenarioTable({
      legs,
      cost: args.cost,
      rawPerInterval: args.rawPerInterval,
      scenarios: args.scenarios,
    }),
  };
}

export interface BasketPlan {
  candidates: BasketCandidate[];
  /** Funding events inside at least one leg's window, and the first and last block they span. */
  events: number;
  from: bigint | null;
  to: bigint | null;
  /** USD the position is projected to pay over those events. */
  cost: number;
  basket: Basket;
}

/**
 * The page's basket for one position: the chosen proposals as candidates, the funding the position is
 * projected to pay over their events, and the even split. `sumsAtStart` holds the funding sum at the
 * start of each template 1 window that has already started, keyed by block.
 */
export function planBasket(args: {
  chosen: readonly Proposal[];
  side: PositionSide;
  units: number;
  meta: PerpMeta;
  rawPerInterval: number;
  head: bigint;
  lastEvent: bigint;
  lastSum: bigint;
  interval: bigint;
  cover: number;
  sumsAtStart?: Readonly<Record<string, bigint>>;
}): BasketPlan {
  const candidates = args.chosen.map((p) =>
    candidateOf(p, {
      head: args.head,
      lastEvent: args.lastEvent,
      lastSum: args.lastSum,
      scalingExp: args.meta.scalingExp,
      sumAtStart: args.sumsAtStart?.[p.fm.startBlock.toString()],
    }),
  );
  const events = eventsInAnyWindow(candidates, args.lastEvent, args.interval);
  const cost = projectFunding({
    rawPerInterval: args.rawPerInterval,
    intervals: events,
    units: args.units,
    side: args.side,
    meta: args.meta,
  }).positionUsd;
  const from = candidates.reduce<bigint | null>((m, c) => (m === null || c.from < m ? c.from : m), null);
  const to = candidates.reduce<bigint | null>((m, c) => (m === null || c.to > m ? c.to : m), null);
  return {
    candidates,
    events,
    from,
    to,
    cost,
    basket: sizeBasket({ cost, cover: args.cover, candidates, rawPerInterval: args.rawPerInterval }),
  };
}

/** Start blocks of the chosen template 1 windows that have already counted funding. */
export function startedWindowStarts(chosen: readonly Proposal[], lastEvent: bigint): bigint[] {
  const blocks = chosen
    .filter((p) => p.fm.kind === "net" && windowStarted(p.fm.startBlock, lastEvent))
    .map((p) => p.fm.startBlock);
  return [...new Set(blocks)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

// ---------------------------------------------------------------- tracking a basket

const usdcOf = (v: bigint) => Number(v) / 1e6;

export interface LegValue {
  /** USDC the leg is worth: its payout once final, before that its value at the market's price. */
  value: number;
  final: boolean;
  /** Settled: whether the leg's side won. Null before settlement and after a void. */
  won: boolean | null;
  basis: string;
}

/**
 * What one leg is worth: its final payout once the market settles or voids, before that its payout if
 * it wins times the market's chance (a pool stake), or the tokens at the book's mid.
 */
export function legValue(leg: TrackedLeg, m: MarketView): LegValue {
  const won =
    (m.outcome === Outcome.Yes && leg.buy === "yes") || (m.outcome === Outcome.No && leg.buy === "no");
  const side = leg.buy === "yes" ? m.pool.yes : m.pool.no;
  const other = leg.buy === "yes" ? m.pool.no : m.pool.yes;
  const feePerToken = m.pool.total > 0n ? (PHI * Number(other)) / Number(m.pool.total) : 0;
  if (m.phase === Phase.Settled) {
    if (!won) return { value: 0, final: true, won: false, basis: "lost" };
    if (leg.mode === "book") {
      return { value: (leg.tokens ?? 0) * (1 - feePerToken), final: true, won: true, basis: "redeemable" };
    }
    // The stake is already part of the final pool, so the winnings are (1 − φ) · s · L / W.
    const winnings = ((1 - PHI) * leg.cost * usdcOf(other)) / Math.max(usdcOf(side), leg.cost);
    return { value: leg.cost + winnings, final: true, won: true, basis: "payout" };
  }
  if (m.phase === Phase.Voided) {
    return leg.mode === "book"
      ? { value: (leg.tokens ?? 0) * 0.5, final: true, won: null, basis: "void: 0.50 per token" }
      : { value: leg.cost, final: true, won: null, basis: "void: refunded" };
  }
  const chanceYes = marketChance(m).bps;
  if (chanceYes === null)
    return { value: leg.cost, final: false, won: null, basis: "no price yet: shown at cost" };
  const chance = leg.buy === "yes" ? Number(chanceYes) / 10_000 : 1 - Number(chanceYes) / 10_000;
  if (leg.mode === "book") {
    return { value: (leg.tokens ?? 0) * chance, final: false, won: null, basis: "tokens at the mid" };
  }
  const payout = leg.cost + poolNetGain(leg.cost, Math.max(usdcOf(side) - leg.cost, 0), usdcOf(other));
  return {
    value: payout * chance,
    final: false,
    won: null,
    basis: `payout × chance (${formatChance(chanceYes)})`,
  };
}

export interface BasketValue {
  /** Each leg's value, in order; null while its market is being read. */
  legs: (LegValue | null)[];
  cost: number;
  /** The sum of the legs' values; null until every leg's market is read. */
  value: number | null;
  /** Legs settled or voided. */
  final: number;
  allFinal: boolean;
  /** The last block any leg's window covers, once every leg's market is read: funding after it is not hedged. */
  endBlock: bigint | null;
}

/** A tracked basket's worth: per leg, and combined once every leg's market is read. */
export function basketValue(basket: TrackedBasket, markets: readonly (MarketView | null)[]): BasketValue {
  const legs = basket.legs.map((leg, i) => {
    const m = markets[i];
    return m ? legValue(leg, m) : null;
  });
  const cost = roundUsdc(basket.legs.reduce((sum, l) => sum + l.cost, 0));
  const read = legs.every((l) => l !== null);
  const value = read ? legs.reduce((sum, l) => sum + (l?.value ?? 0), 0) : null;
  const final = legs.filter((l) => l?.final).length;
  let endBlock: bigint | null = null;
  if (read) {
    const ends = basket.legs.map((_, i) => {
      const m = markets[i];
      return m ? (fundingMarketOf(m)?.endBlock ?? null) : null;
    });
    if (ends.every((e) => e !== null)) {
      endBlock = ends.reduce<bigint>((max, e) => ((e as bigint) > max ? (e as bigint) : max), 0n);
    }
  }
  return { legs, cost, value, final, allFinal: final === basket.legs.length, endBlock };
}

/** Names a basket by its position and its set of markets, to tell when the same basket is already tracked. */
export function basketKey(perpId: bigint | string, side: PositionSide, markets: readonly Address[]): string {
  const sorted = markets.map((m) => m.toLowerCase()).sort();
  return `${perpId.toString()}:${side}:${sorted.join(",")}`;
}

import {
  decodePerplFundingParams,
  decodePerplFundingSpikeParams,
  FEE_BPS,
  Phase,
  BPS as PROTOCOL_BPS,
  TemplateId,
} from "@hunch-book/shared";
import { marketChance } from "../market/logic";
import type { MarketView } from "../market/types";

// The hedge assistant's math (docs/HEDGE.md). Pure functions over numbers read from Perpl and from
// Hunch Book markets. Perpl's funding sum F rises when longs pay shorts; dividing a change in F by
// 10^(priceDecimals + fundingSumScalingExp) gives USD per one unit of the base asset (PROTOCOL.md §6.1).
// A position of `size` units pays size × ΔF (long) or receives it (short). This matches Perpl's own
// premiumPnlCNS for a position to the cent (checked on testnet).

/** Hunch's fee on winnings, φ = 2%. */
export const PHI = Number(FEE_BPS) / Number(PROTOCOL_BPS);

export type PositionSide = "long" | "short";

/** What the assistant needs to know about one Perpl perp. */
export interface PerpMeta {
  perpId: bigint;
  name: string;
  symbol: string;
  priceDecimals: number;
  lotDecimals: number;
  scalingExp: number;
  /** Mark price, in Perpl price units (divide by 10^priceDecimals). */
  markPNS: bigint;
}

/** A Perpl position, read from the chain or typed in by hand. */
export interface PerpPosition {
  perpId: bigint;
  side: PositionSide;
  /** Size in lots (divide by 10^lotDecimals for units of the base asset). */
  lots: bigint;
  /** Entry price in Perpl price units; null for a position typed in by hand. */
  entryPricePNS: bigint | null;
  entryBlock: bigint | null;
  /** Funding received (+) or paid (-) since entry, collateral units (6 decimals); null by hand. */
  premiumPnlCNS: bigint | null;
  source: "chain" | "manual";
}

/** One read of getFundingSumAtBlock. */
export interface FundingSample {
  block: bigint;
  sum: bigint;
  /** The funding event the sum is as of; 0 before the perp's funding started. */
  eventBlock: bigint;
}

/** Funding over one interval, ending at `block`, in Perpl's raw sum units. */
export interface FundingStep {
  block: bigint;
  raw: bigint;
}

const pow10 = (n: number): number => 10 ** n;

/** A raw funding amount (sum units) as USD per one unit of the base asset. */
export function usdPerUnit(
  raw: bigint | number,
  meta: Pick<PerpMeta, "priceDecimals" | "scalingExp">,
): number {
  return Number(raw) / pow10(meta.priceDecimals + meta.scalingExp);
}

/** USD per unit back to raw sum units, rounded toward zero (thresholds are whole raw units). */
export function rawFromUsdPerUnit(usd: number, meta: Pick<PerpMeta, "priceDecimals" | "scalingExp">): bigint {
  return BigInt(Math.trunc(usd * pow10(meta.priceDecimals + meta.scalingExp)));
}

export function sizeUnits(lots: bigint, meta: Pick<PerpMeta, "lotDecimals">): number {
  return Number(lots) / pow10(meta.lotDecimals);
}

export function lotsFromUnits(units: number, meta: Pick<PerpMeta, "lotDecimals">): bigint {
  return BigInt(Math.round(units * pow10(meta.lotDecimals)));
}

export function priceUsd(pns: bigint, meta: Pick<PerpMeta, "priceDecimals">): number {
  return Number(pns) / pow10(meta.priceDecimals);
}

/** +1 when the side pays funding as F rises (longs), -1 when it receives (shorts). */
export const payerSign = (side: PositionSide): 1 | -1 => (side === "long" ? 1 : -1);

/** Per-interval funding from consecutive grid samples, oldest first. Stops at the funding start. */
export function fundingSteps(samples: readonly FundingSample[]): FundingStep[] {
  const sorted = [...samples].sort((a, b) => (a.block < b.block ? -1 : a.block > b.block ? 1 : 0));
  const live = sorted.filter((s) => s.eventBlock !== 0n);
  const steps: FundingStep[] = [];
  for (let i = 1; i < live.length; i++) {
    const prev = live[i - 1] as FundingSample;
    const cur = live[i] as FundingSample;
    // Two reads can name the same event when the grid shifted: that interval paid nothing new.
    if (cur.eventBlock === prev.eventBlock) continue;
    steps.push({ block: cur.eventBlock, raw: cur.sum - prev.sum });
  }
  return steps;
}

/** Mean raw funding per interval over the last `n` steps (all steps when fewer). Null when none. */
export function averageStep(steps: readonly FundingStep[], n: number): number | null {
  const recent = steps.slice(-n);
  if (recent.length === 0) return null;
  return recent.reduce((sum, s) => sum + Number(s.raw), 0) / recent.length;
}

/** Funding intervals that fit in `seconds` at the measured block time. */
export function intervalsIn(seconds: number, msPerBlock: number, intervalBlocks: number): number {
  if (msPerBlock <= 0 || intervalBlocks <= 0) return 0;
  return (seconds * 1000) / msPerBlock / intervalBlocks;
}

/** Funding events on Perpl's grid in (from, to], counted from the last event seen. */
export function eventsBetween(lastEvent: bigint, interval: bigint, from: bigint, to: bigint): number {
  if (interval <= 0n || to <= from) return 0;
  const steps = (x: bigint) => (x <= lastEvent ? 0n : (x - lastEvent) / interval);
  return Number(steps(to) - steps(from));
}

export interface FundingProjection {
  intervals: number;
  /** Raw funding per interval the projection assumes. */
  rawPerInterval: number;
  perIntervalUsdPerUnit: number;
  perUnitUsd: number;
  units: number;
  /** USD the position pays over the window at that rate. Negative: it receives funding. */
  positionUsd: number;
}

/** "The rate persists": raw per interval × intervals × size, signed for the side. */
export function projectFunding(args: {
  rawPerInterval: number;
  intervals: number;
  units: number;
  side: PositionSide;
  meta: Pick<PerpMeta, "priceDecimals" | "scalingExp">;
}): FundingProjection {
  const perIntervalUsdPerUnit = usdPerUnit(args.rawPerInterval, args.meta);
  const perUnitUsd = perIntervalUsdPerUnit * args.intervals;
  return {
    intervals: args.intervals,
    rawPerInterval: args.rawPerInterval,
    perIntervalUsdPerUnit,
    perUnitUsd,
    units: args.units,
    positionUsd: payerSign(args.side) * perUnitUsd * args.units,
  };
}

/** USD a position paid (+) or received (-) between two funding sums. */
export function fundingPaidUsd(args: {
  sumFrom: bigint;
  sumTo: bigint;
  side: PositionSide;
  units: number;
  meta: Pick<PerpMeta, "priceDecimals" | "scalingExp">;
}): number {
  return payerSign(args.side) * usdPerUnit(args.sumTo - args.sumFrom, args.meta) * args.units;
}

/** Funding rate per interval as a percent of the mark price. */
export function ratePercent(rawPerInterval: number, meta: PerpMeta): number | null {
  const mark = priceUsd(meta.markPNS, meta);
  if (mark <= 0) return null;
  return (usdPerUnit(rawPerInterval, meta) / mark) * 100;
}

// ---------------------------------------------------------------- sizing

/** USDC and outcome tokens both carry 6 decimals. */
const MICRO = 1_000_000;

/**
 * An amount rounded to USDC's 6 decimals: up (what you pay), down (what you get) or to the nearest.
 * Float noise below a thousandth of a micro-USDC is dropped first, so 0.1 + 0.2 rounds up to 0.3.
 */
export function roundUsdc(value: number, mode: "up" | "down" | "nearest" = "nearest"): number {
  if (!Number.isFinite(value)) return value;
  const micros = Math.round(value * MICRO * 1_000) / 1_000;
  const whole = mode === "up" ? Math.ceil(micros) : mode === "down" ? Math.floor(micros) : Math.round(micros);
  return whole / MICRO + 0;
}

/** Share of `target` a win of `net` covers, 0 to 1. Rounding to micro-USDC can leave a win a hair under
 * its target; within two micro-USDC that still counts as covered. */
export function coveredShare(net: number, target: number): number {
  if (target <= 0) return 1;
  if (net >= target - 2 / MICRO) return 1;
  return Math.max(0, net / target);
}

export type Sizing =
  | {
      ok: true;
      mode: "pool" | "book";
      /** USDC staked (pool) or spent on tokens (book). */
      cost: number;
      /** Tokens bought (book only). */
      tokens: number | null;
      /** USDC per token paid (book only). */
      price: number | null;
      /** Redemption fee per winning token (book only): φ × losing pool / pool, fixed at graduation. */
      fee: number | null;
      /** USDC paid out if the hedge side wins, after Hunch's fee. */
      payoutIfWin: number;
      /** payoutIfWin − cost: what the hedge adds when it wins. */
      netIfWin: number;
      /** Share of the target the win covers, 0 to 1. */
      covered: number;
      /** What stopped a full cover, if anything. */
      limitedBy: "pool" | "cap" | null;
    }
  | { ok: false; reason: string };

/** Net gain of a pool stake s if its side wins, at the pool as it is now (PROTOCOL.md §5.2). */
export function poolNetGain(stake: number, sideTotal: number, otherTotal: number): number {
  if (stake <= 0) return 0;
  return ((1 - PHI) * stake * otherTotal) / (sideTotal + stake);
}

/**
 * The pool stake whose winnings cover `target` USD: solve (1 − φ)·s·L / (W + s) = target, so
 * s = target·W / ((1 − φ)·L − target). Winnings can never exceed (1 − φ)·L, so a target at or above
 * that cannot be covered in full; the stake is then capped by the room left (wallet and pool caps).
 */
export function sizePoolHedge(args: {
  target: number;
  sideTotal: number;
  otherTotal: number;
  /** USDC this wallet may still stake here: min(wallet cap − own stake, pool cap − pool). */
  room: number;
  minStake: number;
}): Sizing {
  const { target, sideTotal: w, otherTotal: l, room, minStake } = args;
  if (!(target > 0)) return { ok: false, reason: "There is no funding cost to cover." };
  if (l <= 0) {
    return {
      ok: false,
      reason: "Nobody has staked on the other side yet, so a stake here cannot win anything.",
    };
  }
  if (room < minStake)
    return { ok: false, reason: "This pool is full, or your wallet is at its limit here." };
  const ceiling = (1 - PHI) * l;
  let stake = ceiling > target ? (target * w) / (ceiling - target) : Number.POSITIVE_INFINITY;
  let limitedBy: "pool" | "cap" | null = ceiling > target ? null : "pool";
  // Round the stake up to whole micro-USDC, so rounding never leaves the target short.
  stake = roundUsdc(Math.max(stake, minStake), "up");
  if (stake > room) {
    stake = roundUsdc(room, "down");
    limitedBy ??= "cap";
  }
  const payoutIfWin = roundUsdc(stake + poolNetGain(stake, w, l), "down");
  const net = roundUsdc(payoutIfWin - stake);
  return {
    ok: true,
    mode: "pool",
    cost: stake,
    tokens: null,
    price: null,
    fee: null,
    payoutIfWin,
    netIfWin: net,
    covered: coveredShare(net, target),
    limitedBy,
  };
}

/**
 * Tokens bought on the book whose win covers `target`: each token costs `price` and redeems for
 * 1 − fee, so it adds 1 − fee − price when it wins. tokens = target / (1 − fee − price).
 */
export function sizeBookHedge(args: { target: number; price: number; feePerToken: number }): Sizing {
  const { target, price, feePerToken } = args;
  if (!(target > 0)) return { ok: false, reason: "There is no funding cost to cover." };
  if (!(price > 0 && price < 1)) return { ok: false, reason: "The book has no usable price for this side." };
  const edge = 1 - feePerToken - price;
  if (edge <= 0) {
    return { ok: false, reason: "At this price a winning token pays back no more than it costs." };
  }
  // Tokens and cost round up to whole micro-units, the payout down: the figures never flatter the hedge.
  const tokens = roundUsdc(target / edge, "up");
  const cost = roundUsdc(tokens * price, "up");
  const payoutIfWin = roundUsdc(tokens * (1 - feePerToken), "down");
  const net = roundUsdc(payoutIfWin - cost);
  return {
    ok: true,
    mode: "book",
    cost,
    tokens,
    price,
    fee: feePerToken,
    payoutIfWin,
    netIfWin: net,
    covered: coveredShare(net, target),
    limitedBy: null,
  };
}

/** How one market prices a hedge: the pool as it is now, or the book's price and redemption fee. */
export type LegPricing =
  | {
      mode: "pool";
      /** USDC on the hedge side and on the other side. */
      sideTotal: number;
      otherTotal: number;
      /** USDC this wallet may still stake: min(wallet cap, pool cap − pool). */
      room: number;
      minStake: number;
    }
  | {
      mode: "book";
      /** USDC per token: the best YES ask, or 1 − the best YES bid for NO. NaN when that side is empty. */
      price: number;
      feePerToken: number;
    };

/** Sizes one market so its win adds `target` USDC: a pool stake or tokens on the book. */
export function sizeLeg(pricing: LegPricing, target: number): Sizing {
  return pricing.mode === "pool"
    ? sizePoolHedge({
        target,
        sideTotal: pricing.sideTotal,
        otherTotal: pricing.otherTotal,
        room: pricing.room,
        minStake: pricing.minStake,
      })
    : sizeBookHedge({ target, price: pricing.price, feePerToken: pricing.feePerToken });
}

// ---------------------------------------------------------------- markets

/** A Hunch Book market on Perpl funding: template 1 (net over a window) or 4 (single-event spike). */
export interface FundingMarket {
  market: MarketView;
  kind: "net" | "spike";
  perpId: bigint;
  startBlock: bigint;
  endBlock: bigint;
  threshold: bigint;
  scalingExp: number;
}

export function fundingMarketOf(m: MarketView): FundingMarket | null {
  try {
    if (m.templateId === TemplateId.PerplFunding) {
      const p = decodePerplFundingParams(m.params);
      return {
        market: m,
        kind: "net",
        perpId: p.perpId,
        startBlock: p.startBlock,
        endBlock: p.endBlock,
        threshold: p.threshold,
        scalingExp: p.expectedScalingExp,
      };
    }
    if (m.templateId === TemplateId.PerplFundingSpike) {
      const p = decodePerplFundingSpikeParams(m.params);
      return {
        market: m,
        kind: "spike",
        perpId: p.perpId,
        startBlock: p.startBlock,
        endBlock: p.endBlock,
        threshold: p.threshold,
        scalingExp: p.expectedScalingExp,
      };
    }
  } catch {
    // Not decodable: not a market the assistant can use.
  }
  return null;
}

const PRICE_SCALE = 1e18;

export interface Proposal {
  fm: FundingMarket;
  /** The side to hold: YES for a long (pays when longs pay a lot), NO for a short. */
  buy: "yes" | "no";
  /** Funding events left in the market's window from now. */
  intervals: number;
  /** USD the position is projected to pay over those events: the hedge's target. */
  target: number;
  /** The market's threshold, USD per unit, and what the rate projects over its window. */
  thresholdUsdPerUnit: number;
  projectedUsdPerUnit: number;
  /** Market-implied chance that the hedge side wins, 0 to 1, or null. */
  chance: number | null;
  /** The market's live prices, so a basket can size it again for another target. */
  pricing: LegPricing;
  sizing: Sizing;
  /** One plain sentence on when this hedge pays. */
  pays: string;
}

export interface Skipped {
  fm: FundingMarket;
  why: string;
}

/**
 * Hedges for one position from the open funding markets on its perp. A long pays when funding stays
 * high, so it holds YES on "longs pay more than X" (template 1) or on a single-event spike
 * (template 4). A short pays when funding turns negative, so it holds NO on template 1 ("longs do not
 * pay more than X"). Each is sized so the win covers the funding the position is projected to pay
 * from now until the market's window ends.
 */
export function proposeHedges(args: {
  side: PositionSide;
  units: number;
  meta: PerpMeta;
  rawPerInterval: number;
  markets: readonly MarketView[];
  head: bigint;
  lastEvent: bigint;
  interval: bigint;
}): { proposals: Proposal[]; skipped: Skipped[] } {
  const proposals: Proposal[] = [];
  const skipped: Skipped[] = [];
  for (const m of args.markets) {
    const fm = fundingMarketOf(m);
    if (!fm || fm.perpId !== args.meta.perpId) continue;
    if (fm.endBlock <= args.head) continue;
    const pool = m.phase === Phase.Pool;
    const book = m.phase === Phase.Graduated && m.book !== null;
    if (!pool && !book) continue;
    if (args.side === "short" && fm.kind === "spike") {
      skipped.push({
        fm,
        why: "A spike market pays when longs are charged a lot once; it does not cover a short.",
      });
      continue;
    }
    const buy = args.side === "long" ? "yes" : "no";
    const from = fm.startBlock > args.head ? fm.startBlock : args.head;
    const intervals = eventsBetween(args.lastEvent, args.interval, from, fm.endBlock);
    const projection = projectFunding({
      rawPerInterval: args.rawPerInterval,
      intervals,
      units: args.units,
      side: args.side,
      meta: args.meta,
    });
    const meta = { priceDecimals: args.meta.priceDecimals, scalingExp: fm.scalingExp };
    const thresholdUsdPerUnit = usdPerUnit(fm.threshold, meta);
    if (projection.positionUsd <= 0) {
      skipped.push({
        fm,
        why:
          intervals === 0
            ? "No funding event is left in this market's window."
            : "At the current rate this position receives funding over this window, so there is nothing to cover.",
      });
      continue;
    }
    const chanceYes = marketChance(m).bps;
    const chance =
      chanceYes === null ? null : buy === "yes" ? Number(chanceYes) / 10_000 : 1 - Number(chanceYes) / 10_000;
    const usdc = (v: bigint) => Number(v) / 1e6;
    let pricing: LegPricing;
    if (pool) {
      pricing = {
        mode: "pool",
        sideTotal: usdc(buy === "yes" ? m.pool.yes : m.pool.no),
        otherTotal: usdc(buy === "yes" ? m.pool.no : m.pool.yes),
        room: Math.min(usdc(m.caps.walletCap), usdc(m.caps.poolCap - m.pool.total)),
        minStake: usdc(m.caps.minStake),
      };
    } else {
      // Book: YES costs the best ask; NO costs 1 − the best YES bid (the router mints and sells YES).
      const total = m.pool.total;
      const losing = buy === "yes" ? m.pool.no : m.pool.yes;
      const feePerToken = total > 0n ? (PHI * Number(losing)) / Number(total) : 0;
      const ask = m.quote?.ask ?? null;
      const bid = m.quote?.bid ?? null;
      const price =
        buy === "yes"
          ? ask === null
            ? Number.NaN
            : Number(ask) / PRICE_SCALE
          : bid === null
            ? Number.NaN
            : 1 - Number(bid) / PRICE_SCALE;
      pricing = { mode: "book", price, feePerToken };
    }
    const sizing = sizeLeg(pricing, projection.positionUsd);
    const unit = args.meta.symbol;
    const pays =
      fm.kind === "spike"
        ? `YES pays if any single funding event charges ${unit} longs more than ${formatUsdNumber(thresholdUsdPerUnit)} per ${unit}.`
        : buy === "yes"
          ? `YES pays if ${unit} longs pay more than ${formatUsdNumber(thresholdUsdPerUnit)} per ${unit} over the window.`
          : `NO pays if ${unit} longs pay no more than ${formatUsdNumber(thresholdUsdPerUnit)} per ${unit} over the window.`;
    proposals.push({
      fm,
      buy,
      intervals,
      target: projection.positionUsd,
      thresholdUsdPerUnit,
      projectedUsdPerUnit: projection.perUnitUsd,
      chance,
      pricing,
      sizing,
      pays,
    });
  }
  proposals.sort((a, b) => (a.fm.endBlock < b.fm.endBlock ? -1 : a.fm.endBlock > b.fm.endBlock ? 1 : 0));
  return { proposals, skipped };
}

/**
 * "$1,234.56", "$0.0042", "$0.00000031" or "-$3.10": enough digits for small funding amounts. Under a
 * cent the amount keeps four significant digits, so a perp priced in fractions of a cent (MON) still
 * shows its funding per unit.
 */
export function formatUsdNumber(value: number): string {
  if (!Number.isFinite(value)) return "n/a";
  const abs = Math.abs(value);
  const body =
    abs > 0 && abs < 0.01
      ? abs.toLocaleString("en-US", { maximumSignificantDigits: 4 })
      : abs.toLocaleString("en-US", {
          minimumFractionDigits: 2,
          maximumFractionDigits: abs < 1 && abs > 0 ? 4 : 2,
        });
  return value < 0 ? `-$${body}` : `$${body}`;
}

// ---------------------------------------------------------------- a new market

export type ThresholdChoice = "zero" | "half" | "full";

export interface NewMarketSuggestion {
  startBlock: bigint;
  endBlock: bigint;
  intervals: number;
  thresholdRaw: bigint;
  buy: "yes" | "no";
}

/**
 * A template 1 market to create when none fits: the window starts on Perpl's funding grid at least
 * `leadBlocks` ahead (staking must stay open until then) and spans the chosen horizon. The threshold
 * is 0 ("longs pay on net"), or half or all of what the current rate projects over the window, on the
 * paying side: positive for a long (who holds YES), negative for a short (who holds NO).
 */
export function suggestNewMarket(args: {
  side: PositionSide;
  rawPerInterval: number;
  head: bigint;
  lastEvent: bigint;
  interval: bigint;
  intervals: number;
  leadBlocks: bigint;
  choice: ThresholdChoice;
}): NewMarketSuggestion {
  const { interval, lastEvent } = args;
  const earliest = args.head + args.leadBlocks;
  const gridSteps = earliest <= lastEvent ? 1n : (earliest - lastEvent + interval - 1n) / interval;
  const startBlock = lastEvent + gridSteps * interval;
  const n = Math.max(1, Math.round(args.intervals));
  const endBlock = startBlock + BigInt(n) * interval;
  const projected = Math.abs(args.rawPerInterval) * n;
  const share = args.choice === "zero" ? 0 : args.choice === "half" ? 0.5 : 1;
  const magnitude = BigInt(Math.floor(projected * share));
  return {
    startBlock,
    endBlock,
    intervals: n,
    thresholdRaw: args.side === "long" ? magnitude : -magnitude,
    buy: args.side === "long" ? "yes" : "no",
  };
}

/** A raw threshold as the create form's USD-per-unit text, exact to Perpl's own decimals. */
export function thresholdText(raw: bigint, meta: Pick<PerpMeta, "priceDecimals" | "scalingExp">): string {
  const decimals = meta.priceDecimals + meta.scalingExp;
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const base = 10n ** BigInt(decimals);
  const frac = decimals > 0 ? (abs % base).toString().padStart(decimals, "0").replace(/0+$/, "") : "";
  const body = frac ? `${abs / base}.${frac}` : `${abs / base}`;
  return negative && abs !== 0n ? `-${body}` : body;
}

/**
 * The create page prefilled with a template 1 market, in the create form's own terms: the asset as
 * named in deployments, the window as unix seconds (the form snaps it to Perpl's funding grid), the
 * threshold in USD per unit, and the side for the first stake.
 */
export function createPrefillUrl(args: {
  asset: string;
  startUnix: number;
  endUnix: number;
  threshold: string;
  side: "yes" | "no";
}): string {
  const q = new URLSearchParams({
    template: String(TemplateId.PerplFunding),
    asset: args.asset,
    start: String(Math.round(args.startUnix)),
    end: String(Math.round(args.endUnix)),
    threshold: args.threshold,
    side: args.side,
  });
  return `/create?${q.toString()}`;
}

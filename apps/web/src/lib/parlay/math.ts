import {
  BPS,
  canonicalParlayLegs,
  decodeParlayParams,
  encodeParlayParams,
  Outcome,
  PARLAY_MAX_LEGS,
  PARLAY_MIN_LEGS,
  Phase,
  TemplateId,
} from "@hunch-book/shared";
import { type Address, getAddress, type Hex } from "viem";
import { createPrefillPath } from "../ladder/prefill";
import { marketChance } from "../market/logic";
import type { ChainClock, MarketView } from "../market/types";

// Parlays (roadmap A-15, template 6): "will every one of these markets settle YES?". The chance shown is the
// product of each leg's own chance, which assumes the legs are independent. Legs that move together (two
// strikes on the same asset, say) make the real chance higher than the product. The page says so.

export { PARLAY_MAX_LEGS, PARLAY_MIN_LEGS };

/** MarketOutcomeResolver's fast block time in the deploy script: block-clock legs lock no sooner than this. */
export const FAST_BLOCK_MS = 200;
/** A slow block time for when a block-clock leg's close can be counted on to have passed. */
export const SLOW_BLOCK_MS = 1_000;
/** How long before the earliest leg's lock the parlay locks by default. */
export const LOCK_MARGIN_SECONDS = 600;
/** The least time a new parlay needs before it locks, so it can still be created and staked. */
export const MIN_OPEN_SECONDS = 1_800;

/**
 * The product of the legs' chances in basis points, rounded down. Null when any leg has no chance to show.
 * Computed at 1e12 precision, so five legs lose nothing to rounding before the final basis point.
 */
export function parlayChanceBps(legs: readonly (bigint | null)[]): bigint | null {
  if (legs.length === 0) return null;
  const SCALE = 1_000_000_000_000n;
  let acc = SCALE;
  for (const bps of legs) {
    if (bps === null) return null;
    const clamped = bps < 0n ? 0n : bps > BPS ? BPS : bps;
    acc = (acc * clamped) / BPS;
  }
  return (acc * BPS) / SCALE;
}

/** "about 1 in 8" for a chance in basis points; null for 0. */
export function oneIn(bps: bigint | null): string | null {
  if (bps === null || bps <= 0n) return null;
  const n = Number(BPS) / Number(bps);
  if (n < 1.05) return "almost certain, by these prices";
  return `about 1 in ${n >= 10 ? Math.round(n).toLocaleString("en-US") : n.toFixed(1).replace(/\.0$/, "")}`;
}

/** The earliest unix time a leg could lock: its lock time, or for a block clock the fastest arrival. */
export function earliestLock(m: Pick<MarketView, "window">, clock: ChainClock | null): number | null {
  if (!m.window.blockClock) return Number(m.window.lock);
  if (!clock) return null;
  const blocks = Number(m.window.lock - clock.blockNumber);
  return clock.timestamp + Math.max(0, (blocks * FAST_BLOCK_MS) / 1000);
}

/** The latest unix time a leg could close: its close time, or for a block clock the slowest arrival. */
export function latestClose(m: Pick<MarketView, "window">, clock: ChainClock | null): number | null {
  if (!m.window.blockClock) return Number(m.window.close);
  if (!clock) return null;
  const blocks = Number(m.window.close - clock.blockNumber);
  return clock.timestamp + Math.max(0, (blocks * SLOW_BLOCK_MS) / 1000);
}

/** Why a market cannot be a leg of a new parlay, or null if it can. */
export function legBlocker(m: MarketView, clock: ChainClock | null, now: number): string | null {
  if (m.phase === Phase.Settled || m.phase === Phase.Voided) return "Already settled or voided.";
  if (m.phase === Phase.Closed || m.phase === Phase.PoolLocked) return "Already locked.";
  const lock = earliestLock(m, clock);
  if (lock === null) return "Reading the chain clock...";
  if (lock <= now) return "Already locked.";
  if (lock <= now + MIN_OPEN_SECONDS + LOCK_MARGIN_SECONDS) {
    return "Locks too soon: a parlay must lock before every leg does.";
  }
  return null;
}

export interface ParlayWindow {
  lockTime: bigint;
  closeTime: bigint;
}

/**
 * Default times for a parlay of `legs`: lock LOCK_MARGIN_SECONDS before the earliest leg could lock, and
 * close once the last leg has closed. Null when a time cannot be estimated or the lock is too soon.
 */
export function parlayWindow(
  legs: readonly MarketView[],
  clock: ChainClock | null,
  now: number,
): ParlayWindow | null {
  if (legs.length === 0) return null;
  let lock = Number.POSITIVE_INFINITY;
  let close = 0;
  for (const leg of legs) {
    const l = earliestLock(leg, clock);
    const c = latestClose(leg, clock);
    if (l === null || c === null) return null;
    lock = Math.min(lock, l);
    close = Math.max(close, c);
  }
  const lockTime = Math.floor(lock - LOCK_MARGIN_SECONDS);
  if (lockTime <= now + MIN_OPEN_SECONDS) return null;
  return { lockTime: BigInt(lockTime), closeTime: BigInt(Math.ceil(Math.max(close, lockTime))) };
}

/** The legs' chances and their product. */
export function parlayQuote(legs: readonly MarketView[]): {
  legs: (bigint | null)[];
  chanceBps: bigint | null;
} {
  const chances = legs.map((m) => marketChance(m).bps);
  return { legs: chances, chanceBps: parlayChanceBps(chances) };
}

/** /create with template 6 and the encoded legs and times (legs sorted the one way the resolver accepts). */
export function parlayPrefillPath(legs: readonly Address[], window: ParlayWindow): string {
  const params = encodeParlayParams({ legs: canonicalParlayLegs(legs), ...window });
  return createPrefillPath(TemplateId.Parlay, params, "parlay");
}

// ---------------------------------------------------------------- existing parlays

export type LegState = "yes" | "no" | "void" | "open" | "unknown";

export interface ParlayLeg {
  address: Address;
  market: MarketView | null;
  state: LegState;
  chanceBps: bigint | null;
}

export interface ParlayView {
  market: MarketView;
  legs: ParlayLeg[];
  /** What the legs say so far: NO as soon as one is NO, YES once all are YES, void once one voids. */
  verdict: "yes" | "no" | "void" | "open";
  /** The product of the legs' chances (open legs only count; settled YES legs count as certain). */
  impliedBps: bigint | null;
}

export function legState(m: MarketView | null): LegState {
  if (!m) return "unknown";
  if (m.phase === Phase.Voided) return "void";
  if (m.phase === Phase.Settled) return m.outcome === Outcome.Yes ? "yes" : "no";
  return "open";
}

/** The leg addresses of a template 6 market, or null when its params do not decode. */
export function parlayLegsOf(m: Pick<MarketView, "templateId" | "params">): Address[] | null {
  if (m.templateId !== TemplateId.Parlay) return null;
  try {
    return decodeParlayParams(m.params as Hex).legs.map((a) => getAddress(a));
  } catch {
    return null;
  }
}

/** A parlay market with each leg's state, from markets already read (`byAddress`, lowercase keys). */
export function parlayView(m: MarketView, byAddress: ReadonlyMap<string, MarketView>): ParlayView | null {
  const addresses = parlayLegsOf(m);
  if (!addresses) return null;
  const legs = addresses.map((address): ParlayLeg => {
    const market = byAddress.get(address.toLowerCase()) ?? null;
    const state = legState(market);
    const chance = market ? marketChance(market).bps : null;
    return { address, market, state, chanceBps: state === "yes" ? BPS : state === "no" ? 0n : chance };
  });
  const verdict = legs.some((l) => l.state === "no")
    ? "no"
    : legs.every((l) => l.state === "yes")
      ? "yes"
      : legs.some((l) => l.state === "void")
        ? "void"
        : "open";
  return { market: m, legs, verdict, impliedBps: parlayChanceBps(legs.map((l) => l.chanceBps)) };
}

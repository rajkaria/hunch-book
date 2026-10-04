import { Phase } from "@hunch-book/shared";
import type { Address } from "viem";
import { nextMilestone, windowMoment } from "../market/logic";
import type { ChainClock, MarketView } from "../market/types";

// The swipe feed (roadmap A-13) as pure logic: which markets are in the deck and in what order, and how a
// drag or a key press becomes YES, NO or skip.

export type Intent = "yes" | "no" | "skip";

/** How far (px) a card must be dragged sideways to count as YES or NO, or up to count as a skip. */
export const SWIPE_THRESHOLD = 110;

/** True when a person can still take a side: staking in an open pool, or trading on a live book. */
export function isOpen(m: MarketView, clock: ChainClock | null, now: number): boolean {
  if (m.phase === Phase.Pool) {
    const lock = windowMoment(m.window, m.window.lock, clock);
    return lock === null || lock.time > now;
  }
  if (m.phase === Phase.Graduated) {
    const close = windowMoment(m.window, m.window.close, clock);
    return close === null || close.time > now;
  }
  return false;
}

/**
 * The deck: open markets that were not skipped, the ones whose next deadline comes soonest first (they
 * need an answer soonest), then the rest by newest market.
 */
export function deckOrder(
  markets: readonly MarketView[],
  clock: ChainClock | null,
  now: number,
  skipped: ReadonlySet<string> = new Set(),
): MarketView[] {
  const open = markets.filter((m) => isOpen(m, clock, now) && !skipped.has(m.address.toLowerCase()));
  const due = (m: MarketView): number =>
    nextMilestone(m, clock, now)?.moment.time ?? Number.POSITIVE_INFINITY;
  return open.sort((a, b) => {
    const d = due(a) - due(b);
    if (d !== 0 && Number.isFinite(d)) return d;
    if (Number.isFinite(due(a)) !== Number.isFinite(due(b))) return Number.isFinite(due(a)) ? -1 : 1;
    return a.marketId === b.marketId ? 0 : a.marketId > b.marketId ? -1 : 1;
  });
}

/** A finished drag as an intent, or null to snap the card back. Sideways wins over up. */
export function dragIntent(dx: number, dy: number, threshold = SWIPE_THRESHOLD): Intent | null {
  if (Math.abs(dx) >= threshold && Math.abs(dx) >= Math.abs(dy)) return dx > 0 ? "yes" : "no";
  if (dy <= -threshold) return "skip";
  return null;
}

/** Keyboard on the focused card: right arrow or Y for YES, left arrow or N for NO, down arrow or S to skip. */
export function keyIntent(key: string): Intent | null {
  switch (key) {
    case "ArrowRight":
    case "y":
    case "Y":
      return "yes";
    case "ArrowLeft":
    case "n":
    case "N":
      return "no";
    case "ArrowDown":
    case "s":
    case "S":
      return "skip";
    default:
      return null;
  }
}

/** The card's transform while it is dragged: follow the finger, tilt a little unless motion is reduced. */
export function dragTransform(dx: number, dy: number, reducedMotion: boolean): string {
  const rotate = reducedMotion ? 0 : Math.max(-14, Math.min(14, dx / 16));
  return `translate3d(${dx.toFixed(1)}px, ${Math.min(dy, 40).toFixed(1)}px, 0) rotate(${rotate.toFixed(2)}deg)`;
}

/** How visible the YES or NO stamp is while dragging, 0 to 1. */
export function stampOpacity(dx: number, side: "yes" | "no", threshold = SWIPE_THRESHOLD): number {
  const towards = side === "yes" ? dx : -dx;
  return Math.max(0, Math.min(1, (towards - 24) / (threshold - 24)));
}

export const deckKey = (m: Pick<MarketView, "address">): string => m.address.toLowerCase();

export type SkipSet = Set<string>;

export function withSkip(skipped: ReadonlySet<string>, market: Address): SkipSet {
  const next = new Set(skipped);
  next.add(market.toLowerCase());
  return next;
}

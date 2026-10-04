import { type Deployment, Outcome, Phase } from "@hunch-book/shared";
import { fallbackHeadline } from "../market/params";
import type { MarketView } from "../market/types";
import { legClose, legEarliestLock, type ParlayLeg } from "./build";
import { type Head, type Pace, timeAt } from "./clock";
import { MIN_LEAD_SECONDS } from "./price";

// Template 6: which open markets can be legs of a new parlay (docs/TEMPLATES.md, template 6).

export interface ParlayCandidate extends ParlayLeg {
  phase: Phase;
  /** The earliest unix time this leg can lock, as the parlay resolver estimates it. */
  earliestLock: number;
  /** When this leg is expected to lock: exact on a time clock, from the measured pace on a block clock. */
  expectedLock: number;
  /** When this leg is expected to close. */
  expectedClose: number;
}

/**
 * Markets a new parlay can use: not settled or voided, and still far enough from their own lock that
 * the parlay can lock first (at least MIN_LEAD_SECONDS from now). Soonest lock first.
 */
export function parlayCandidates(
  markets: readonly MarketView[],
  deployment: Deployment,
  ctx: { head: Head; pace: Pace; now: number; fastBlockTimeMs: number },
): ParlayCandidate[] {
  return markets
    .filter(
      (m) => (m.phase === Phase.Pool || m.phase === Phase.Graduated) && m.outcome === Outcome.Unresolved,
    )
    .map((m) => ({
      address: m.address,
      marketId: m.marketId,
      label: m.description ?? fallbackHeadline(deployment, m.decoded),
      window: m.window,
      phase: m.phase,
      earliestLock: legEarliestLock(m.window, ctx.head, ctx.fastBlockTimeMs),
      expectedLock: m.window.blockClock
        ? timeAt(m.window.lock, ctx.head, ctx.pace.msPerBlock)
        : Number(m.window.lock),
      expectedClose: legClose(m.window, ctx.head, ctx.pace),
    }))
    .filter((c) => c.earliestLock >= ctx.now + MIN_LEAD_SECONDS)
    .sort((a, b) => a.earliestLock - b.earliestLock);
}

/** Candidates whose label or "#id" contains the query, case-insensitive. */
export function searchCandidates(candidates: readonly ParlayCandidate[], query: string): ParlayCandidate[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [...candidates];
  return candidates.filter(
    (c) =>
      c.label.toLowerCase().includes(q) ||
      `#${c.marketId.toString()}`.includes(q) ||
      c.address.toLowerCase().includes(q),
  );
}

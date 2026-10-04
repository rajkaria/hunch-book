import type { Address } from "viem";
import { type MarketState, Outcome, Phase, type Position } from "./markets.js";

// Market events from two consecutive snapshots. Pure, so every rule is unit-tested. The notifier
// compares states rather than scanning logs: a restart or a missed cycle never loses an event, it
// only reports it one cycle later.

export type MarketEvent =
  | { kind: "graduated"; market: MarketState }
  | { kind: "settled"; market: MarketState }
  | { kind: "voided"; market: MarketState }
  | { kind: "move"; market: MarketState; fromBps: number; toBps: number };

/** What the notifier remembers between cycles about one market. */
export interface Remembered {
  phase: number;
  graduated: boolean;
  /** The chance the last move message (or the first sighting) was measured from. */
  baseBps: number | null;
}

export function remember(m: MarketState, previous?: Remembered): Remembered {
  return { phase: m.phase, graduated: m.graduated, baseBps: previous?.baseBps ?? m.chanceBps };
}

/**
 * Events between `before` (what was remembered) and `now`. A market seen for the first time gives no
 * event: there is no "before" to compare with. A big move (on a graduated market's book) is measured
 * from the last move reported, so a slow drift is reported once it adds up, and is not repeated.
 */
export function diffMarkets(
  before: ReadonlyMap<string, Remembered>,
  now: readonly MarketState[],
  moveBps: number,
): { events: MarketEvent[]; next: Map<string, Remembered> } {
  const events: MarketEvent[] = [];
  const next = new Map<string, Remembered>();
  for (const m of now) {
    const key = m.address.toLowerCase();
    const prev = before.get(key);
    if (!prev) {
      next.set(key, remember(m));
      continue;
    }
    let base = prev.baseBps;
    if (m.graduated && !prev.graduated) {
      events.push({ kind: "graduated", market: m });
      base = m.chanceBps; // the book opens at a new price: measure moves from there
    }
    if (m.phase === Phase.Settled && prev.phase !== Phase.Settled)
      events.push({ kind: "settled", market: m });
    if (m.phase === Phase.Voided && prev.phase !== Phase.Voided) events.push({ kind: "voided", market: m });
    // Big moves are reported for books only: a pool's split moves with every stake by design.
    const trading = m.graduated && m.phase !== Phase.Settled && m.phase !== Phase.Voided;
    if (trading && m.chanceBps !== null) {
      if (base === null) {
        base = m.chanceBps;
      } else if (Math.abs(m.chanceBps - base) >= moveBps) {
        events.push({ kind: "move", market: m, fromBps: base, toBps: m.chanceBps });
        base = m.chanceBps;
      }
    }
    next.set(key, { phase: m.phase, graduated: m.graduated, baseBps: base });
  }
  return { events, next };
}

export interface Redeemable {
  /** USDC base units or tokens: what the wallet can collect. */
  amount: bigint;
  /** "tokens" to redeem through the vault, or a "pool" payout to claim from the market. */
  kind: "tokens" | "pool" | "claim";
  side: "yes" | "no" | null;
}

/**
 * What a wallet can collect from a final market: winning tokens (or unclaimed winning tokens), a
 * pool payout, or, after a void, any tokens (0.50 each) or the refund. Null when nothing is waiting.
 */
export function redeemable(m: MarketState, p: Position | undefined): Redeemable | null {
  if (!p) return null;
  if (m.phase === Phase.Settled) {
    if (p.claimablePool > 0n) return { amount: p.claimablePool, kind: "pool", side: null };
    const yesWon = m.outcome === Outcome.Yes;
    const tokens = yesWon ? p.yes : p.no;
    if (tokens > 0n) return { amount: tokens, kind: "tokens", side: yesWon ? "yes" : "no" };
    const unclaimed = yesWon ? p.claimableYes : p.claimableNo;
    if (unclaimed > 0n) return { amount: unclaimed, kind: "claim", side: yesWon ? "yes" : "no" };
    return null;
  }
  if (m.phase === Phase.Voided) {
    if (p.claimablePool > 0n) return { amount: p.claimablePool, kind: "pool", side: null };
    const tokens = p.yes + p.no;
    if (tokens > 0n) return { amount: tokens, kind: "tokens", side: null };
    const unclaimed = p.claimableYes + p.claimableNo;
    if (unclaimed > 0n) return { amount: unclaimed, kind: "claim", side: null };
  }
  return null;
}

export const redeemKey = (wallet: Address, market: Address) =>
  `${wallet.toLowerCase()}:${market.toLowerCase()}`;

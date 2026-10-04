import { Outcome, Phase, Side } from "@hunch-book/shared";
import type { Address } from "viem";
import type { PortfolioEntry } from "../market/types";

// Auto-redeem (roadmap K-3, AutoRedeemer in docs/PERIPHERY.md): which of the wallet's markets the keeper
// can redeem for it. Consent is two layers: the opt-in flag (and no per-market opt-out), and an allowance
// on each token. The amount redeemed per side is min(balance, allowance), so a market is covered when every
// side that can pay has an allowance at least as large as the balance.

/** What the AutoRedeemer knows about the wallet: the opt-in, and per market the opt-out and allowances. */
export interface RedeemerState {
  optedIn: boolean;
  markets: Map<string, { optedOut: boolean; allowance: { yes: bigint; no: bigint } }>;
}

export type CoverageStatus =
  /** Opted in, not opted out, and every side that pays is approved. */
  | "covered"
  /** Opted in, but a token that pays needs an approval. */
  | "needs-approval"
  /** Opted in, but this market is switched off. */
  | "opted-out"
  /** Auto-redeem is off for the wallet. */
  | "off"
  /** Nothing the AutoRedeemer could redeem: no tokens, or a pool that never graduated. */
  | "nothing";

export interface Coverage {
  status: CoverageStatus;
  /** The sides that pay at settlement (or after a void) and still need an allowance. */
  missing: Side[];
  note: string;
}

/**
 * The sides that can pay: after settlement only the winning side; after a void both; before either, both
 * sides the wallet holds (it cannot know the winner yet).
 */
export function payingSides(e: PortfolioEntry): Side[] {
  const held: Side[] = [];
  if (e.balances.yes > 0n) held.push(Side.Yes);
  if (e.balances.no > 0n) held.push(Side.No);
  if (e.market.phase === Phase.Settled) {
    const winner = e.market.outcome === Outcome.Yes ? Side.Yes : Side.No;
    return held.filter((s) => s === winner);
  }
  return held;
}

export function coverage(e: PortfolioEntry, state: RedeemerState | null): Coverage {
  if (!e.market.graduated) {
    return {
      status: "nothing",
      missing: [],
      note: "A pool that never graduated pays through its own claim, not the auto-redeemer.",
    };
  }
  const sides = payingSides(e);
  if (sides.length === 0) {
    return {
      status: "nothing",
      missing: [],
      note:
        e.market.phase === Phase.Settled
          ? "You hold none of the winning side."
          : "You hold no YES or NO here. Claim your tokens first if you staked.",
    };
  }
  if (!state?.optedIn) return { status: "off", missing: sides, note: "Auto-redeem is off." };
  const m = state.markets.get(e.market.address.toLowerCase());
  if (m?.optedOut) return { status: "opted-out", missing: [], note: "You switched this market off." };
  const missing = sides.filter((s) => {
    const balance = s === Side.Yes ? e.balances.yes : e.balances.no;
    const allowance = s === Side.Yes ? (m?.allowance.yes ?? 0n) : (m?.allowance.no ?? 0n);
    return allowance < balance;
  });
  if (missing.length > 0) {
    return {
      status: "needs-approval",
      missing,
      note: `Approve ${missing.map((s) => (s === Side.Yes ? "YES" : "NO")).join(" and ")} so the keeper can redeem all of it.`,
    };
  }
  return {
    status: "covered",
    missing: [],
    note:
      e.market.phase === Phase.Settled || e.market.phase === Phase.Voided
        ? "Covered. It is redeemed to your wallet in the keeper's next pass."
        : "Covered. Redeemed to your wallet after it settles.",
  };
}

export interface ApprovalNeed {
  market: Address;
  side: Side;
  token: Address;
}

/**
 * Every token approval the wallet's markets need for full cover, whether or not it is opted in yet:
 * graduated markets it has not switched off, on each paying side whose allowance is below the balance.
 */
export function approvalsNeeded(
  entries: readonly PortfolioEntry[],
  state: RedeemerState | null,
): ApprovalNeed[] {
  const needs: ApprovalNeed[] = [];
  for (const e of entries) {
    if (!e.market.graduated) continue;
    const m = state?.markets.get(e.market.address.toLowerCase());
    if (m?.optedOut) continue;
    for (const side of payingSides(e)) {
      const balance = side === Side.Yes ? e.balances.yes : e.balances.no;
      const allowance = side === Side.Yes ? (m?.allowance.yes ?? 0n) : (m?.allowance.no ?? 0n);
      if (allowance >= balance) continue;
      needs.push({
        market: e.market.address,
        side,
        token: side === Side.Yes ? e.market.tokens.yes : e.market.tokens.no,
      });
    }
  }
  return needs;
}

/** Counts per status, for the panel's summary line. */
export function coverageCounts(entries: readonly PortfolioEntry[], state: RedeemerState | null) {
  const counts: Record<CoverageStatus, number> = {
    covered: 0,
    "needs-approval": 0,
    "opted-out": 0,
    off: 0,
    nothing: 0,
  };
  for (const e of entries) counts[coverage(e, state).status] += 1;
  return counts;
}

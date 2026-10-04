import { ONE_USDC, Outcome, Phase, Side } from "@hunch-book/shared";
import { formatUsdc } from "../format";
import { redeemSteps } from "./actions";
import { bookMid, PRICE_SCALE } from "./logic";
import type { PortfolioEntry } from "./types";

// What the portfolio can do for a wallet across markets, as a plan of single calls: claim tokens after
// graduation, redeem after settlement or void, claim pool payouts. Pure, so the order and the amounts
// are tested; the page sends them one by one.

export type PlannedKind = "claimTokens" | "redeem" | "claimPool";

export interface PlannedAction {
  kind: PlannedKind;
  market: PortfolioEntry["market"];
  /** Redeem only. */
  side?: Side;
  /** Redeem: tokens burned. */
  amount?: bigint;
  /** USDC this call pays out (zero for a token claim). */
  paid: bigint;
  label: string;
}

const SIDE_NAME: Record<Side, string> = { [Side.Yes]: "YES", [Side.No]: "NO" };
const isFinal = (phase: number): boolean => phase === Phase.Settled || phase === Phase.Voided;

/**
 * The calls one portfolio row needs, in order. A settled market's unclaimed tokens are claimed first and
 * counted in the redemption, since `claimTokens` transfers exactly the claimable amounts.
 */
export function entryPlan(e: PortfolioEntry): PlannedAction[] {
  const m = e.market;
  const plan: PlannedAction[] = [];
  if (m.graduated) {
    const claimable = e.claimableTokens.yes + e.claimableTokens.no;
    if (claimable > 0n) {
      plan.push({
        kind: "claimTokens",
        market: m,
        paid: 0n,
        label: `Claim ${formatUsdc(e.claimableTokens.yes)} YES and ${formatUsdc(e.claimableTokens.no)} NO`,
      });
    }
    if (isFinal(m.phase)) {
      const held = {
        yes: e.balances.yes + e.claimableTokens.yes,
        no: e.balances.no + e.claimableTokens.no,
      };
      for (const step of redeemSteps(m, held)) {
        plan.push({
          kind: "redeem",
          market: m,
          side: step.side,
          amount: step.amount,
          paid: step.paid,
          label: `Redeem ${formatUsdc(step.amount)} ${SIDE_NAME[step.side]} for ${formatUsdc(step.paid)} USDC`,
        });
      }
    }
  } else if (isFinal(m.phase) && e.claimablePool.paid > 0n) {
    plan.push({
      kind: "claimPool",
      market: m,
      paid: e.claimablePool.paid,
      label: `Claim ${formatUsdc(e.claimablePool.paid)} USDC pool payout`,
    });
  }
  return plan;
}

/** Every call across the portfolio, market by market. */
export function portfolioPlan(entries: PortfolioEntry[]): PlannedAction[] {
  return entries.flatMap(entryPlan);
}

/** Held tokens at the book's mid (YES at mid, NO at 1 − mid), or null without a two-sided book. */
export function entryValueAtMid(e: PortfolioEntry): bigint | null {
  const m = e.market;
  if (!m.graduated) return null;
  const tokens = { yes: e.balances.yes + e.claimableTokens.yes, no: e.balances.no + e.claimableTokens.no };
  if (m.phase === Phase.Settled) return m.outcome === Outcome.Yes ? tokens.yes : tokens.no;
  if (m.phase === Phase.Voided) return tokens.yes / 2n + tokens.no / 2n;
  const mid = bookMid(m.quote);
  if (mid === null) return null;
  const midE6 = (mid * ONE_USDC) / PRICE_SCALE;
  return (tokens.yes * midE6 + tokens.no * (ONE_USDC - midE6)) / ONE_USDC;
}

/** USDC a row pays out if every planned call is sent now. */
export function entryRedeemable(e: PortfolioEntry): bigint {
  return entryPlan(e).reduce((sum, a) => sum + a.paid, 0n);
}

export interface PortfolioTotals {
  staked: bigint;
  claimableTokens: bigint;
  claimablePool: bigint;
  /** USDC paid out now by redeeming and claiming everything. */
  payable: bigint;
  /** Token value at mid (settled value once final), over rows that have one. */
  value: bigint;
}

export function portfolioTotals(entries: PortfolioEntry[]): PortfolioTotals {
  let staked = 0n;
  let claimablePool = 0n;
  let claimableTokens = 0n;
  let payable = 0n;
  let value = 0n;
  for (const e of entries) {
    staked += e.stake.yes + e.stake.no;
    claimablePool += e.claimablePool.paid;
    claimableTokens += e.claimableTokens.yes + e.claimableTokens.no;
    payable += entryRedeemable(e);
    value += entryValueAtMid(e) ?? 0n;
  }
  return { staked, claimablePool, claimableTokens, payable, value };
}

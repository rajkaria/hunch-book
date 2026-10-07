import {
  BPS,
  FEE_BPS,
  ONE_USDC,
  Outcome,
  Phase,
  PriceSource,
  redemptionFee,
  redemptionPayout,
  Side,
} from "@hunch-book/shared";
import { formatInt, formatUsdc, formatUtc } from "../format";
import type { MarketView } from "./types";

// Which lifecycle calls a market accepts right now, and why the others wait. Pure functions of the
// market, the chain head and the wallet's holdings, so every rule here is unit tested against the
// contracts' own phase checks (contracts/src/core/Market.sol, CollateralVault.sol).

export interface ChainHead {
  block: bigint;
  /** Unix seconds of the latest block. */
  time: number;
}

export interface Holdings {
  claimableTokens: { yes: bigint; no: bigint };
  claimablePool: { paid: bigint; fee: bigint };
  balances: { yes: bigint; no: bigint };
}

export type ActionId = "graduate" | "claimTokens" | "settle" | "void" | "redeem" | "claimPool";

export interface RedeemStep {
  side: Side;
  amount: bigint;
  /** USDC this redemption pays after the fee (settled) or at 0.50 per token (voided). */
  paid: bigint;
  fee: bigint;
}

export interface LifecycleAction {
  id: ActionId;
  label: string;
  enabled: boolean;
  /** Why it is not enabled, or a note about what it does. */
  reason: string | null;
  /** Redeem only: one vault call per side. */
  redeem?: RedeemStep[];
}

const isFinal = (phase: Phase): boolean => phase === Phase.Settled || phase === Phase.Voided;

/** True once the market's close has passed at the chain head (Market._reached). */
export function closeReached(m: Pick<MarketView, "window">, head: ChainHead | null): boolean {
  if (!head) return false;
  return m.window.blockClock ? head.block >= m.window.close : head.time >= Number(m.window.close);
}

/** True once the settlement deadline has passed (settle is refused, void is allowed). */
export function pastDeadline(m: Pick<MarketView, "window">, head: ChainHead | null): boolean {
  return head !== null && head.time > Number(m.window.settleDeadline);
}

function closeText(m: Pick<MarketView, "window">): string {
  return m.window.blockClock ? `block ${formatInt(m.window.close)}` : formatUtc(m.window.close);
}

/**
 * The phase and time gate for `settle` (Market.settle): open after close and up to the deadline. The
 * resolver may still answer "not yet", which the settle plan checks separately.
 */
export function settleGate(
  m: Pick<MarketView, "phase" | "window" | "decoded">,
  head: ChainHead | null,
): string | null {
  if (isFinal(m.phase)) return m.phase === Phase.Settled ? "Already settled." : "This market was voided.";
  if (!head) return "Reading the chain...";
  if (!closeReached(m, head)) return `Settlement opens at close: ${closeText(m)}.`;
  if (pastDeadline(m, head)) return "The settlement deadline has passed. The only action left is void.";
  if (m.decoded.kind === "price-at-time" && m.decoded.params.source === PriceSource.Pyth) {
    return "Settling needs a signed Pyth price update, which this app cannot fetch without a Pyth API key. The keeper settles these.";
  }
  if (m.decoded.kind === "unknown") return "This app does not know this template's evidence format.";
  return null;
}

/** What redeeming the wallet's tokens pays now: the winning side after a settlement, both sides after a void. */
export function redeemSteps(
  m: Pick<MarketView, "phase" | "outcome" | "graduated" | "pool">,
  balances: { yes: bigint; no: bigint },
): RedeemStep[] {
  if (!m.graduated) return [];
  if (m.phase === Phase.Voided) {
    return [
      { side: Side.Yes, amount: balances.yes, paid: balances.yes / 2n, fee: 0n },
      { side: Side.No, amount: balances.no, paid: balances.no / 2n, fee: 0n },
    ].filter((s) => s.amount > 0n);
  }
  if (m.phase !== Phase.Settled) return [];
  const side = m.outcome === Outcome.Yes ? Side.Yes : Side.No;
  const amount = side === Side.Yes ? balances.yes : balances.no;
  if (amount === 0n) return [];
  const losing = side === Side.Yes ? m.pool.no : m.pool.yes;
  return [
    {
      side,
      amount,
      paid: redemptionPayout(amount, losing, m.pool.total),
      fee: redemptionFee(amount, losing, m.pool.total),
    },
  ];
}

/** The fixed redemption fee per winning token, in USDC base units per token (Market.feePerToken). */
export function feePerToken(m: Pick<MarketView, "pool">, side: Side): bigint {
  if (m.pool.total === 0n) return 0n;
  const losing = side === Side.Yes ? m.pool.no : m.pool.yes;
  return (FEE_BPS * losing * ONE_USDC) / (BPS * m.pool.total);
}

const SIDE_NAME: Record<Side, string> = { [Side.Yes]: "YES", [Side.No]: "NO" };

/**
 * The lifecycle calls that matter for this market, each with whether it can be sent now and why not.
 * `holdings` is null without a connected wallet; wallet-specific actions then explain that.
 */
export function lifecycleActions(
  m: MarketView,
  head: ChainHead | null,
  holdings: Holdings | null,
): LifecycleAction[] {
  const actions: LifecycleAction[] = [];
  const noWallet = "Connect a wallet to see what you can claim.";

  if (m.phase === Phase.Pool) {
    // Kuru v2: only Kuru creates books, after setting the YES token up (a day or two), so the book must
    // be registered first (docs/PROTOCOL.md §8.1, Kuru v2).
    const waitingForKuru = m.kuruVersion === 2 && m.bookReady !== true;
    actions.push({
      id: "graduate",
      label: "Graduate to Kuru",
      enabled: m.ruleMet === true && !waitingForKuru,
      reason: waitingForKuru
        ? m.ruleMet === true
          ? "The rule is met. Kuru creates this market's book first (on Kuru v2 that can take a day or two); the keeper asked for it and graduates the pool once it is registered. If it never arrives, the pool settles as a pool."
          : "The pool does not meet its graduation rule yet. Kuru is creating this market's book meanwhile (Kuru v2)."
        : m.ruleMet === true
          ? "The rule is met. Anyone can graduate the pool into YES and NO tokens on a Kuru book."
          : "The pool does not meet its graduation rule yet.",
    });
  }

  if (m.graduated) {
    const claimable = holdings ? holdings.claimableTokens.yes + holdings.claimableTokens.no : 0n;
    actions.push({
      id: "claimTokens",
      label: "Claim tokens",
      enabled: claimable > 0n,
      reason: !holdings
        ? noWallet
        : claimable > 0n
          ? `${formatUsdc(holdings.claimableTokens.yes)} YES and ${formatUsdc(holdings.claimableTokens.no)} NO from your stake.`
          : "No tokens to claim: you staked nothing here or already claimed.",
    });
  }

  if (!isFinal(m.phase)) {
    const gate = settleGate(m, head);
    actions.push({ id: "settle", label: "Settle", enabled: gate === null, reason: gate });
    const voidable = pastDeadline(m, head);
    actions.push({
      id: "void",
      label: "Void",
      enabled: voidable,
      reason: voidable
        ? "Nobody settled before the deadline. Anyone can void the market now."
        : `Only if nobody settles by the deadline, ${formatUtc(m.window.settleDeadline)}.`,
    });
  }

  if (m.graduated) {
    const steps = holdings ? redeemSteps(m, holdings.balances) : [];
    let reason: string | null;
    if (!isFinal(m.phase)) reason = "Winning tokens redeem for USDC once the market settles.";
    else if (!holdings) reason = noWallet;
    else if (steps.length === 0) {
      reason =
        m.phase === Phase.Settled
          ? `You hold no ${m.outcome === Outcome.Yes ? "YES" : "NO"}, the winning side. Losing tokens are worth nothing.`
          : "You hold no YES or NO tokens from this market.";
    } else {
      const paid = steps.reduce((sum, s) => sum + s.paid, 0n);
      const fee = steps.reduce((sum, s) => sum + s.fee, 0n);
      const tokens = steps.map((s) => `${formatUsdc(s.amount)} ${SIDE_NAME[s.side]}`).join(" and ");
      reason =
        m.phase === Phase.Voided
          ? `${tokens} at 0.50 USDC each: ${formatUsdc(paid)} USDC, no fee.`
          : `${tokens} for ${formatUsdc(paid)} USDC after the fixed ${formatUsdc(fee, { exact: true })} USDC fee.`;
    }
    actions.push({
      id: "redeem",
      label: "Redeem tokens",
      enabled: isFinal(m.phase) && steps.length > 0,
      reason,
      redeem: steps,
    });
  } else if (m.phase !== Phase.Pool) {
    const paid = holdings?.claimablePool.paid ?? 0n;
    let reason: string;
    if (!isFinal(m.phase)) reason = "Pool payouts open once the market settles or voids.";
    else if (!holdings) reason = noWallet;
    else if (paid > 0n) {
      reason =
        holdings.claimablePool.fee > 0n
          ? `${formatUsdc(paid)} USDC after the 2% fee on winnings (${formatUsdc(holdings.claimablePool.fee)} USDC).`
          : m.phase === Phase.Voided
            ? `${formatUsdc(paid)} USDC: your stake back in full.`
            : `${formatUsdc(paid)} USDC.`;
    } else {
      reason = "Nothing to claim: your side lost, you staked nothing, or you already claimed.";
    }
    actions.push({
      id: "claimPool",
      label: "Claim pool payout",
      enabled: isFinal(m.phase) && paid > 0n,
      reason,
    });
  }
  return actions;
}

// ---------------------------------------------------------------- complete sets

export interface SetsAvailability {
  mint: string | null;
  merge: string | null;
}

/** Vault.mintSets needs phase Graduated; Vault.mergeSets needs Graduated, Closed or Voided. */
export function setsAvailability(m: Pick<MarketView, "phase" | "graduated">): SetsAvailability {
  if (!m.graduated) {
    const why = "Complete sets exist only once the pool graduates.";
    return { mint: why, merge: why };
  }
  return {
    mint: m.phase === Phase.Graduated ? null : "Minting stops at close.",
    merge:
      m.phase === Phase.Graduated || m.phase === Phase.Closed || m.phase === Phase.Voided
        ? null
        : "Merging stops at settlement. Redeem the winning side instead.",
  };
}

import { type GraduationRule, Phase, type Window } from "@hunch-book/shared";
import { type Address, formatUnits, isAddressEqual, zeroAddress } from "viem";
import type { Globals } from "./markets.js";
import type { ChainNow, Settler } from "./settlers/index.js";

// The keeper's decisions, as pure functions of one market's snapshot, the chain's current block and
// time, and the factory's globals. No reads, no sends: what to do comes from here, how to do it from
// keeper.ts. Every decision carries a plain reason, which is what the dry run prints.

export type JobName = "graduate" | "claims" | "settle" | "void" | "payouts";

export type ActionKind =
  | "graduate"
  | "register-book"
  | "book-request"
  | "claim-tokens"
  | "settle"
  | "void"
  | "claim-pool";

export interface Decision {
  job: JobName;
  /** What to send. Absent: nothing to do now, and `reason` says why. */
  action?: ActionKind;
  reason: string;
}

/** The fields of a market snapshot the planner looks at. */
export interface PlanMarket {
  templateId: number;
  params: `0x${string}`;
  window: Window;
  rule: GraduationRule;
  phase: Phase;
  graduated: boolean;
  yesTotal: bigint;
  noTotal: bigint;
  stakers: number;
  ruleMet: boolean;
  graduatorBook: Address;
  heldYes: bigint;
  heldNo: bigint;
  poolOwed: bigint;
}

export interface PlanInput {
  market: PlanMarket;
  now: ChainNow;
  globals: Globals;
  settler: Pick<Settler, "name" | "waitReason"> | undefined;
  /** Mainnet only: where Kuru would deploy this market's book, and whether it already has. */
  predictedBook?: { address: Address; deployed: boolean };
}

const usdc = (amount: bigint) => formatUnits(amount, 6);
const isZero = (a: Address) => isAddressEqual(a, zeroAddress);

export const isFinal = (phase: Phase) => phase === Phase.Settled || phase === Phase.Voided;

/** The market's own close rule: block number for block-clock markets, unix seconds otherwise. */
export function closeReached(window: Window, now: ChainNow): boolean {
  return window.blockClock ? now.block >= window.close : now.timestamp >= window.close;
}

/** Why a pool does not meet its graduation rule, in plain words (empty when it does). */
export function ruleShortfall(m: Pick<PlanMarket, "yesTotal" | "noTotal" | "stakers" | "rule">): string[] {
  const total = m.yesTotal + m.noTotal;
  const out: string[] = [];
  if (total < m.rule.minPool) out.push(`pool ${usdc(total)} of ${usdc(m.rule.minPool)} USDC`);
  if (m.stakers < m.rule.minStakers) out.push(`${m.stakers} of ${m.rule.minStakers} stakers`);
  if (m.yesTotal === 0n || m.noTotal === 0n) {
    out.push("one side has no stake");
  } else {
    const bps = (m.yesTotal * 10_000n) / total;
    if (bps < BigInt(m.rule.minChanceBps) || bps > BigInt(m.rule.maxChanceBps)) {
      out.push(
        `chance ${Number(bps) / 100}% is outside ${m.rule.minChanceBps / 100}% to ${m.rule.maxChanceBps / 100}%`,
      );
    }
  }
  return out;
}

/** True when the graduate job needs to know whether Kuru already created this market's book (mainnet). */
export function needsBookLookup(m: PlanMarket, g: Globals): boolean {
  return (
    m.phase === Phase.Pool &&
    m.ruleMet &&
    !g.graduationPaused &&
    !isZero(g.graduator) &&
    isZero(m.graduatorBook) &&
    !g.canCreateBooks
  );
}

function planGraduate(input: PlanInput): Decision {
  const { market: m, globals: g, predictedBook } = input;
  const job = "graduate" as const;
  if (!m.ruleMet) {
    const missing = ruleShortfall(m);
    return {
      job,
      reason: `rule not met: ${missing.length ? missing.join("; ") : "see graduationRuleMet()"}`,
    };
  }
  if (g.graduationPaused) return { job, reason: "rule met, but graduation is paused" };
  if (isZero(g.graduator)) return { job, reason: "rule met, but the factory has no graduator" };
  if (!isZero(m.graduatorBook)) {
    return { job, action: "graduate", reason: `rule met and Kuru book ${m.graduatorBook} is ready` };
  }
  if (g.canCreateBooks) {
    return {
      job,
      action: "graduate",
      reason: "rule met; the graduator creates the Kuru book in the same transaction",
    };
  }
  if (predictedBook?.deployed) {
    return {
      job,
      action: "register-book",
      reason: `rule met and Kuru has created the book at ${predictedBook.address}: register it, then graduate`,
    };
  }
  return {
    job,
    action: "book-request",
    reason: "rule met, but only Kuru can create books on this network: ask Kuru for the book",
  };
}

function planClaims(m: PlanMarket): Decision {
  if (m.heldYes === 0n && m.heldNo === 0n) return { job: "claims", reason: "every staker has their tokens" };
  return {
    job: "claims",
    action: "claim-tokens",
    reason: `the market still holds ${usdc(m.heldYes)} YES and ${usdc(m.heldNo)} NO for stakers`,
  };
}

function planSettle(input: PlanInput): Decision {
  const { market: m, now, settler } = input;
  if (!settler) return { job: "settle", reason: `no settler for template ${m.templateId}: skipped` };
  const wait = settler.waitReason(m, now) ?? (closeReached(m.window, now) ? null : "waiting for close");
  if (wait) return { job: "settle", reason: wait };
  return {
    job: "settle",
    action: "settle",
    reason: m.graduated ? "close passed: settle the market" : "close passed: settle the pool",
  };
}

function planPayouts(m: PlanMarket): Decision {
  if (m.poolOwed === 0n) return { job: "payouts", reason: "every pool payout is done" };
  return {
    job: "payouts",
    action: "claim-pool",
    reason: `${usdc(m.poolOwed)} USDC of pool payouts not yet claimed`,
  };
}

/** Every job's decision for one market at `now`. */
export function planMarket(input: PlanInput): Decision[] {
  const { market: m, now } = input;
  const out: Decision[] = [];
  const final = isFinal(m.phase);
  const pastDeadline = now.timestamp > m.window.settleDeadline;

  if (m.phase === Phase.Pool && !pastDeadline) out.push(planGraduate(input));
  if (m.graduated) out.push(planClaims(m));
  if (!final) {
    if (pastDeadline) {
      out.push({
        job: "void",
        action: "void",
        reason: `past the settlement deadline (${m.window.settleDeadline}) with no answer`,
      });
    } else if (m.phase !== Phase.Pool) {
      out.push(planSettle(input));
    }
  }
  if (final && !m.graduated) out.push(planPayouts(m));
  return out;
}

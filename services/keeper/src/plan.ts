import { type GraduationRule, Phase, type Window } from "@hunch-book/shared";
import { type Address, formatUnits, isAddressEqual, zeroAddress } from "viem";
import type { Globals } from "./markets.js";
import type { ChainNow, Settler } from "./settlers/index.js";

// The keeper's decisions, as pure functions of one market's snapshot, the chain's current block and
// time, and the factory's globals. No reads, no sends: what to do comes from here, how to do it from
// keeper.ts. Every decision carries a plain reason, which is what the dry run prints.

export type JobName = "graduate" | "claims" | "prove" | "snapshot" | "settle" | "void" | "payouts";

export type ActionKind =
  | "graduate"
  | "register-book"
  | "book-request"
  | "claim-tokens"
  | "prove"
  | "snapshot"
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
  address: Address;
  resolver: Address;
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
  settler: Pick<Settler, "name" | "waitReason" | "prover" | "snapshot"> | undefined;
  /** Where Kuru would deploy this market's book (v1 mainnet, or any Kuru v2 stack), and its state. */
  predictedBook?: PredictedBook;
}

/** A market's book as Kuru would deploy it, and whether it is there and registrable. */
export interface PredictedBook {
  address: Address;
  deployed: boolean;
  /** Kuru v2: GraduatorV2.bookProblem for the deployed book (0 = registrable), in words. */
  problem?: { code: number; text: string };
}

/** GraduatorV2.Problem, in words (contracts/src/interfaces/IGraduatorV2.sol). */
export const BOOK_PROBLEMS = [
  "none",
  "no contract there",
  "Kuru's SpotRouter did not deploy it",
  "Kuru's AccountCore has not registered it",
  "it points at another AccountCore",
  "its base or quote is not this market's YES token and USDC",
  "its precisions are not 1e6 / 1e6",
  "its tick size is outside the limits",
  "its fees are outside the limits",
  "its minimum order is above the limit",
  "Kuru has not enabled the YES token or USDC",
  "the WithdrawalLimiter has no price source for the YES token or USDC",
] as const;

/** True when a Kuru-deployed book can be registered right now. */
export const registrable = (b: PredictedBook): boolean =>
  b.deployed && (b.problem === undefined || b.problem.code === 0);

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

/** How plan reasons name the stack's books: "Hunch order book" on a Hunch venue, else "Kuru book". */
const bookName = (g: Pick<Globals, "venue">) => (g.venue === "hunch" ? "Hunch order book" : "Kuru book");

/**
 * True when the graduate job needs to know whether Kuru already created this market's book. Kuru v1
 * mainnet: once the rule is met. Kuru v2: from creation, because Kuru's setup takes days and the book
 * can be registered before the pool fills. Never on a Hunch venue: Kuru has no part in those books.
 */
export function needsBookLookup(m: PlanMarket, g: Globals): boolean {
  if (g.venue === "hunch") return false;
  if (m.phase !== Phase.Pool || isZero(g.graduator) || !isZero(m.graduatorBook) || g.canCreateBooks)
    return false;
  if (g.kuruVersion === 2) return true;
  return m.ruleMet && !g.graduationPaused;
}

function planGraduate(input: PlanInput): Decision {
  if (input.globals.kuruVersion === 2) return planGraduateV2(input);
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
    return { job, action: "graduate", reason: `rule met and ${bookName(g)} ${m.graduatorBook} is ready` };
  }
  if (g.canCreateBooks) {
    return {
      job,
      action: "graduate",
      reason: `rule met; the graduator creates the ${bookName(g)} in the same transaction`,
    };
  }
  if (g.venue === "hunch") {
    // Every graduator on a Hunch venue creates books (DeployHunchStack.s.sol). One that cannot is a
    // wiring mistake, and asking Kuru for the book would be wrong: wait, and say why.
    return {
      job,
      reason:
        "rule met, but this stack's graduator cannot create books, and on a Hunch venue nothing else does: check the graduator in the deployments file",
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

/**
 * Kuru v2: only Kuru creates books, after a per-token setup that takes days. So the keeper asks for the
 * book while the pool is still filling, registers it as soon as GraduatorV2 accepts it (the rule does not
 * matter for registration), and graduates once both the book and the rule are there.
 */
function planGraduateV2(input: PlanInput): Decision {
  const { market: m, globals: g, predictedBook } = input;
  const job = "graduate" as const;
  if (isZero(g.graduator)) return { job, reason: "the factory has no graduator yet (WireKuruV2.s.sol)" };
  if (!isZero(m.graduatorBook)) {
    if (!m.ruleMet) {
      const missing = ruleShortfall(m);
      return { job, reason: `Kuru book ${m.graduatorBook} registered; rule not met: ${missing.join("; ")}` };
    }
    if (g.graduationPaused) return { job, reason: "rule met and book registered, but graduation is paused" };
    return { job, action: "graduate", reason: `rule met and Kuru book ${m.graduatorBook} is registered` };
  }
  if (predictedBook && registrable(predictedBook)) {
    return {
      job,
      action: "register-book",
      reason: `Kuru has created the book at ${predictedBook.address}: register it`,
    };
  }
  const waiting = predictedBook?.deployed
    ? `the book at ${predictedBook.address} is not registrable yet: ${predictedBook.problem?.text ?? "unknown"}`
    : "only Kuru can create v2 books: ask Kuru for this market's book and token setup";
  return { job, action: "book-request", reason: waiting };
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

/** Templates with an early YES: hunt for the proof as soon as the market is past staking. */
function planProve(input: PlanInput): Decision | undefined {
  const { market: m, now, settler } = input;
  if (!settler?.prover) return undefined;
  const wait = settler.prover.waitReason(m, now);
  if (wait) return { job: "prove", reason: wait };
  return { job: "prove", action: "prove", reason: "look for the observation that proves YES" };
}

/** Snapshot-settled templates: take the snapshot inside the window after close. */
function planSnapshot(input: PlanInput): Decision | undefined {
  const { market: m, now, settler } = input;
  if (!settler?.snapshot) return undefined;
  const wait = settler.snapshot.waitReason(m, now);
  if (wait) return { job: "snapshot", reason: wait };
  return { job: "snapshot", action: "snapshot", reason: "the snapshot window is open: take the snapshot" };
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
      const prove = planProve(input);
      if (prove) out.push(prove);
      const snapshot = planSnapshot(input);
      if (snapshot) out.push(snapshot);
      out.push(planSettle(input));
    }
  }
  if (final && !m.graduated) out.push(planPayouts(m));
  return out;
}

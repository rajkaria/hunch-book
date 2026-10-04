import { formatEther } from "viem";
import { formatUsdc } from "../format";
import type { ServiceHealthView, ServiceName } from "./health";
import type { StatusMarket, StatusSnapshot } from "./reads";

// The status page's rules. Pure functions of one chain snapshot and the services' health, so every
// rule is unit-tested. The thresholds match the watchdog (services/watchdog/src/checks.ts), so the
// page and the phone alert agree on what amber and red mean.

export type Level = "ok" | "warn" | "fail" | "unknown";

export interface StatusCheck {
  id: string;
  title: string;
  level: Level;
  /** One plain sentence: what was confirmed, or what is wrong. */
  summary: string;
  /** Extra lines, for example the markets a rule flagged. */
  details?: string[];
}

export const PHASE = { Pool: 0, PoolLocked: 1, Graduated: 2, Closed: 3, Settled: 4, Voided: 5 } as const;

const MON = 10n ** 18n;

export const THRESHOLDS = {
  settleWarnSeconds: 2 * 3600,
  settleFailSeconds: 24 * 3600,
  /** Touch templates (3, 4) settle NO only after a 24-hour challenge period. */
  challengeSeconds: 24 * 3600,
  graduateWarnBeforeLockSeconds: 30 * 60,
  keeperWarnWei: MON,
  keeperFailWei: (3n * MON) / 10n,
  makerWarnWei: 2n * MON,
  makerFailWei: MON / 2n,
  serviceStaleSeconds: 10 * 60,
} as const;

const TOUCH_TEMPLATES = new Set([3, 4]);

const usdc = (v: bigint) => `${formatUsdc(v)} USDC`;
const mon = (wei: bigint) =>
  `${Number(formatEther(wei)).toLocaleString("en-US", { maximumFractionDigits: 2 })} MON`;

export function duration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d} d ${h} h`;
  if (h > 0) return `${h} h ${m} min`;
  if (m > 0) return `${m} min`;
  return `${s} s`;
}

const label = (m: StatusMarket) => `Market #${m.marketId.toString()} (${m.address})`;

export function checkSolvency(s: StatusSnapshot): StatusCheck {
  const v = s.vault;
  if (v.surplus >= 0n && v.balance >= v.totalObligations) {
    return {
      id: "solvency",
      title: "Solvency",
      level: "ok",
      summary: `The vault holds ${usdc(v.balance)} and owes ${usdc(v.totalObligations)}: a surplus of ${usdc(v.surplus)}.`,
    };
  }
  return {
    id: "solvency",
    title: "Solvency",
    level: "fail",
    summary: `The vault holds ${usdc(v.balance)} but owes ${usdc(v.totalObligations)}: short by ${usdc(v.totalObligations - v.balance)}.`,
  };
}

export interface Breakdown {
  pools: bigint;
  sets: bigint;
  protocolFees: bigint;
  creatorFees: bigint;
  total: bigint;
}

/** Σ pool + Σ sets + protocol fees + Σ creator fees, from the markets and creators read. */
export function obligationsBreakdown(s: StatusSnapshot): Breakdown {
  const pools = s.markets.reduce((sum, m) => sum + m.ledger.pool, 0n);
  const sets = s.markets.reduce((sum, m) => sum + m.ledger.sets, 0n);
  const creatorFees = s.creatorFees.reduce((sum, c) => sum + c.fees, 0n);
  return {
    pools,
    sets,
    protocolFees: s.vault.protocolFees,
    creatorFees,
    total: pools + sets + s.vault.protocolFees + creatorFees,
  };
}

/** The vault's own total must equal the sum of what it owes, market by market. */
export function checkObligations(s: StatusSnapshot): StatusCheck {
  const b = obligationsBreakdown(s);
  const summary = `Pools ${usdc(b.pools)} + complete sets ${usdc(b.sets)} + protocol fees ${usdc(b.protocolFees)} + creator fees ${usdc(b.creatorFees)} = ${usdc(b.total)}.`;
  if (b.total === s.vault.totalObligations) {
    return {
      id: "obligations",
      title: "Obligations add up",
      level: "ok",
      summary: `${summary} The vault's total agrees.`,
    };
  }
  if (s.partial) {
    return {
      id: "obligations",
      title: "Obligations add up",
      level: "warn",
      summary: `${summary} The vault's total is ${usdc(s.vault.totalObligations)}; only the first ${s.markets.length} of ${s.factory.marketCount} markets were read, so the sum is partial.`,
    };
  }
  return {
    id: "obligations",
    title: "Obligations add up",
    level: "fail",
    summary: `${summary} The vault's own total is ${usdc(s.vault.totalObligations)}: they differ by ${usdc(s.vault.totalObligations > b.total ? s.vault.totalObligations - b.total : b.total - s.vault.totalObligations)}.`,
  };
}

/** Before settlement every graduated market has YES supply = NO supply = complete sets. */
export function supplyProblem(m: StatusMarket): string | null {
  if (!m.graduated || m.phase === PHASE.Settled || m.phase === PHASE.Voided) return null;
  if (m.yesSupply === m.noSupply && m.noSupply === m.ledger.sets) return null;
  return `${label(m)}: YES supply ${m.yesSupply}, NO supply ${m.noSupply}, complete sets ${m.ledger.sets}.`;
}

export function checkSupply(s: StatusSnapshot): StatusCheck {
  const live = s.markets.filter((m) => m.graduated && m.phase !== PHASE.Settled && m.phase !== PHASE.Voided);
  const problems = s.markets.map(supplyProblem).filter((p): p is string => p !== null);
  if (problems.length > 0) {
    return {
      id: "supply",
      title: "Token supply",
      level: "fail",
      summary: `${problems.length} market${problems.length === 1 ? "" : "s"} where YES supply, NO supply and complete sets differ.`,
      details: problems,
    };
  }
  return {
    id: "supply",
    title: "Token supply",
    level: "ok",
    summary:
      live.length === 0
        ? "No market is trading as tokens right now, so there is no supply to compare."
        : `In all ${live.length} graduated market${live.length === 1 ? "" : "s"} before settlement, YES supply = NO supply = complete sets.`,
  };
}

/** Seconds since a window point, in the market's own clock (negative if not reached). */
export function secondsSince(m: StatusMarket, point: bigint, s: StatusSnapshot): number {
  if (m.window.blockClock) return Number(s.block - point) * (s.secondsPerBlock ?? 0.4);
  return s.timestamp - Number(point);
}

export function checkSettlement(s: StatusSnapshot): StatusCheck {
  const late: string[] = [];
  let level: Level = "ok";
  for (const m of s.markets) {
    if (m.phase === PHASE.Settled || m.phase === PHASE.Voided || m.outcome !== 0) continue;
    const pastDeadline = s.timestamp - Number(m.window.settleDeadline);
    if (pastDeadline > 0) {
      late.push(`${label(m)}: past its settlement deadline by ${duration(pastDeadline)} and not voided yet.`);
      level = "fail";
      continue;
    }
    let since = secondsSince(m, m.window.close, s);
    if (since < 0) continue;
    if (TOUCH_TEMPLATES.has(m.templateId)) since -= THRESHOLDS.challengeSeconds;
    if (since < THRESHOLDS.settleWarnSeconds) continue;
    late.push(`${label(m)}: closed ${duration(since)} ago and not settled.`);
    if (since >= THRESHOLDS.settleFailSeconds) level = "fail";
    else if (level === "ok") level = "warn";
  }
  return {
    id: "settlement",
    title: "Settlement on time",
    level,
    summary:
      late.length === 0
        ? "Every closed market settled within 2 hours of its close (touch markets: of their challenge period)."
        : `${late.length} market${late.length === 1 ? " is" : "s are"} late to settle.`,
    ...(late.length > 0 ? { details: late } : {}),
  };
}

export function checkGraduation(s: StatusSnapshot): StatusCheck {
  const waiting = s.markets
    .filter((m) => m.phase === PHASE.Pool && m.ruleMet)
    .filter((m) => -secondsSince(m, m.window.lock, s) <= THRESHOLDS.graduateWarnBeforeLockSeconds)
    .map((m) => `${label(m)}: meets its graduation rule and locks soon, but has not graduated.`);
  return waiting.length === 0
    ? {
        id: "graduation",
        title: "Graduation",
        level: "ok",
        summary: "No pool that meets its rule is about to lock ungraduated.",
      }
    : {
        id: "graduation",
        title: "Graduation",
        level: "warn",
        summary: `${waiting.length} pool${waiting.length === 1 ? "" : "s"} waiting to graduate.`,
        details: waiting,
      };
}

export function checkGuardian(s: StatusSnapshot): StatusCheck {
  const f = s.factory;
  const paused = [
    f.creationPaused ? "creating markets" : null,
    f.graduationPaused ? "graduation" : null,
  ].filter((x): x is string => x !== null);
  const details = [
    "The guardian can never pause settlement, redemption, merges or refunds, and never sets an outcome.",
  ];
  if (f.pendingGuardian !== "0x0000000000000000000000000000000000000000") {
    details.unshift(`A guardian transfer to ${f.pendingGuardian} is waiting to be accepted.`);
  }
  if (paused.length > 0) {
    return {
      id: "guardian",
      title: "Pauses",
      level: "warn",
      summary: `The guardian has paused ${paused.join(" and ")}.`,
      details,
    };
  }
  return { id: "guardian", title: "Pauses", level: "ok", summary: "Nothing is paused.", details };
}

export function checkGas(name: "keeper" | "maker", wei: bigint): StatusCheck {
  const warn = name === "keeper" ? THRESHOLDS.keeperWarnWei : THRESHOLDS.makerWarnWei;
  const fail = name === "keeper" ? THRESHOLDS.keeperFailWei : THRESHOLDS.makerFailWei;
  const title = name === "keeper" ? "Keeper gas" : "Maker gas";
  if (wei < fail)
    return {
      id: `${name}-gas`,
      title,
      level: "fail",
      summary: `The ${name} holds ${mon(wei)}, below ${mon(fail)}.`,
    };
  if (wei < warn)
    return {
      id: `${name}-gas`,
      title,
      level: "warn",
      summary: `The ${name} holds ${mon(wei)}, below ${mon(warn)}.`,
    };
  return { id: `${name}-gas`, title, level: "ok", summary: `The ${name} holds ${mon(wei)}.` };
}

export function checkService(
  name: ServiceName,
  h: ServiceHealthView | null | undefined,
  nowSeconds: number,
): StatusCheck {
  const title = name === "keeper" ? "Keeper" : "Maker";
  const id = `${name}-health`;
  if (!h) return { id, title, level: "unknown", summary: `Reading the ${name}'s health...` };
  if (!h.configured) {
    return {
      id,
      title,
      level: "unknown",
      summary: `No health URL is set for the ${name} on this site, so only its balance on chain is shown.`,
    };
  }
  if (!h.reachable || !h.lastCycleAt) {
    return {
      id,
      title,
      level: "warn",
      summary: `The ${name}'s health endpoint did not answer. ${h.error ?? ""}`.trim(),
    };
  }
  const age = nowSeconds - Math.floor(Date.parse(h.lastCycleAt) / 1000);
  const details: string[] = [];
  if (h.enabled === false) details.push(`The ${name} runs in dry-run mode: it decides but sends nothing.`);
  if (h.lastError) details.push(`Last error${h.lastErrorAt ? ` (${h.lastErrorAt})` : ""}: ${h.lastError}`);
  if (Number.isNaN(age) || age > THRESHOLDS.serviceStaleSeconds) {
    return {
      id,
      title,
      level: "fail",
      summary: `The ${name}'s last cycle was ${Number.isNaN(age) ? "at an unreadable time" : `${duration(age)} ago`}.`,
      details,
    };
  }
  return {
    id,
    title,
    level: h.enabled === false || h.lowBalance ? "warn" : "ok",
    summary: `The ${name} completed a cycle ${duration(age)} ago.`,
    ...(details.length > 0 ? { details } : {}),
  };
}

const RANK: Record<Level, number> = { ok: 0, unknown: 1, warn: 2, fail: 3 };

/** The page's headline: red if anything failed, amber if anything warns, green otherwise. */
export function overall(checks: readonly StatusCheck[]): Level {
  let worst: Level = "ok";
  for (const c of checks) if (c.level !== "unknown" && RANK[c.level] > RANK[worst]) worst = c.level;
  return worst;
}

export function evaluateChain(s: StatusSnapshot): StatusCheck[] {
  return [
    checkSolvency(s),
    checkObligations(s),
    checkSupply(s),
    checkSettlement(s),
    checkGraduation(s),
    checkGuardian(s),
    checkGas("keeper", s.wallets.keeper),
    checkGas("maker", s.wallets.maker),
  ];
}

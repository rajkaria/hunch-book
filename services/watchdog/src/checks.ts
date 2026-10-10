// Pure liveness rules. `evaluate` takes one snapshot of the chain (and of the services' health, when
// reachable) and returns a finding per rule. Nothing here reads the network, so every rule is
// unit-tested against hand-built snapshots.

export type Level = "ok" | "warn" | "fail";

export interface Finding {
  level: Level;
  check: string;
  /** One plain sentence: what is wrong, or what was confirmed. */
  message: string;
  /** Address or transaction the finding is about, for explorer links. */
  subject?: string;
}

/** Phase numbers from contracts/src/interfaces/IHunchBookTypes.sol. */
export const Phase = { Pool: 0, PoolLocked: 1, Graduated: 2, Closed: 3, Settled: 4, Voided: 5 } as const;

export interface MarketSnapshot {
  address: string;
  /** The deployment stack the market belongs to ("primary", or a name under `stacks` such as "hunch"). */
  stack?: string;
  templateId: number;
  phase: number;
  /** 0 Unresolved, 1 Yes, 2 No. */
  outcome: number;
  blockClock: boolean;
  lock: bigint;
  close: bigint;
  settleDeadline: bigint;
  graduated: boolean;
  ruleMet: boolean;
  yesSupply: bigint;
  noSupply: bigint;
  sets: bigint;
}

export interface ServiceHealth {
  name: "keeper" | "maker";
  /** ISO time of the service's last completed cycle; undefined when the health URL did not answer. */
  lastCycleAt?: string;
  error?: string;
}

/** One stack's vault: its USDC balance and what it owes. Each stack has its own vault. */
export interface VaultSnapshot {
  /** "primary", or a name under `stacks` (testnet: kuruV2, hunch). */
  stack: string;
  address: string;
  balance: bigint;
  obligations: bigint;
}

export interface Snapshot {
  network: string;
  block: bigint;
  /** Unix seconds of `block`. */
  timestamp: number;
  /** Measured seconds per block, for block-clock markets. */
  secondsPerBlock: number;
  /** Every stack's vault, the primary first. */
  vaults: VaultSnapshot[];
  /** Every stack's markets. */
  markets: MarketSnapshot[];
  /** Native MON balances in wei. */
  balances: { keeper: bigint; maker: bigint };
  services: ServiceHealth[];
}

export interface Thresholds {
  settleWarnSeconds: number;
  settleFailSeconds: number;
  /** Extra time touch templates (3, 4) get after close: their 24-hour challenge period. */
  challengeSeconds: number;
  graduateWarnBeforeLockSeconds: number;
  keeperWarnWei: bigint;
  keeperFailWei: bigint;
  makerWarnWei: bigint;
  makerFailWei: bigint;
  serviceStaleSeconds: number;
}

const MON = 10n ** 18n;

export const DEFAULT_THRESHOLDS: Thresholds = {
  settleWarnSeconds: 2 * 3600,
  settleFailSeconds: 24 * 3600,
  challengeSeconds: 24 * 3600,
  graduateWarnBeforeLockSeconds: 30 * 60,
  keeperWarnWei: MON,
  keeperFailWei: (3n * MON) / 10n,
  makerWarnWei: 2n * MON,
  makerFailWei: MON / 2n,
  serviceStaleSeconds: 10 * 60,
};

const TOUCH_TEMPLATES = new Set([3, 4]);

/** Seconds since `point` was reached, in the market's own clock (negative if not reached yet). */
export function secondsSince(m: MarketSnapshot, point: bigint, s: Snapshot): number {
  if (m.blockClock) return Number(s.block - point) * s.secondsPerBlock;
  return s.timestamp - Number(point);
}

function fmtDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const min = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h} h ${min} min` : `${min} min`;
}

function fmtMon(wei: bigint): string {
  const whole = wei / MON;
  const frac = ((wei % MON) * 100n) / MON;
  return `${whole}.${frac.toString().padStart(2, "0")} MON`;
}

/** One vault's solvency. Each stack's vault is checked on its own: one vault's surplus never covers another. */
export function checkSolvency(v: VaultSnapshot): Finding {
  const which = v.stack === "primary" ? "The vault" : `The ${v.stack} stack's vault`;
  if (v.balance >= v.obligations) {
    return {
      level: "ok",
      check: "solvency",
      subject: v.address,
      message: `${which} holds at least what it owes (surplus ${v.balance - v.obligations} base units).`,
    };
  }
  return {
    level: "fail",
    check: "solvency",
    subject: v.address,
    message: `${which} holds ${v.balance} but owes ${v.obligations} USDC base units.`,
  };
}

export function checkSupply(m: MarketSnapshot): Finding | undefined {
  if (!m.graduated || m.phase === Phase.Settled) return undefined;
  if (m.yesSupply === m.noSupply && m.noSupply === m.sets) return undefined;
  return {
    level: "fail",
    check: "supply",
    subject: m.address,
    message: `YES supply ${m.yesSupply}, NO supply ${m.noSupply} and complete sets ${m.sets} differ.`,
  };
}

export function checkSettlement(m: MarketSnapshot, s: Snapshot, t: Thresholds): Finding | undefined {
  if (m.phase === Phase.Settled || m.phase === Phase.Voided || m.outcome !== 0) return undefined;
  const sinceDeadline = s.timestamp - Number(m.settleDeadline);
  if (sinceDeadline > 0) {
    return {
      level: "fail",
      check: "void",
      subject: m.address,
      message: `Past its settlement deadline by ${fmtDuration(sinceDeadline)} and not voided: anyone can call voidIfExpired().`,
    };
  }
  let since = secondsSince(m, m.close, s);
  if (since < 0) return undefined;
  if (TOUCH_TEMPLATES.has(m.templateId)) since -= t.challengeSeconds;
  if (since < t.settleWarnSeconds) return undefined;
  return {
    level: since >= t.settleFailSeconds ? "fail" : "warn",
    check: "settlement",
    subject: m.address,
    message: `Closed ${fmtDuration(since)} ago and not settled yet.`,
  };
}

export function checkGraduation(m: MarketSnapshot, s: Snapshot, t: Thresholds): Finding | undefined {
  if (m.phase !== Phase.Pool || !m.ruleMet) return undefined;
  const toLock = -secondsSince(m, m.lock, s);
  if (toLock > t.graduateWarnBeforeLockSeconds) return undefined;
  return {
    level: "warn",
    check: "graduation",
    subject: m.address,
    message: `Meets its graduation rule and locks in ${fmtDuration(Math.max(toLock, 0))}, but has not graduated.`,
  };
}

export function checkBalance(name: "keeper" | "maker", wei: bigint, warn: bigint, fail: bigint): Finding {
  if (wei < fail) {
    return {
      level: "fail",
      check: `${name}-gas`,
      message: `The ${name} has ${fmtMon(wei)}, below ${fmtMon(fail)}.`,
    };
  }
  if (wei < warn) {
    return {
      level: "warn",
      check: `${name}-gas`,
      message: `The ${name} has ${fmtMon(wei)}, below ${fmtMon(warn)}.`,
    };
  }
  return { level: "ok", check: `${name}-gas`, message: `The ${name} has ${fmtMon(wei)}.` };
}

export function checkService(h: ServiceHealth, s: Snapshot, t: Thresholds): Finding {
  if (!h.lastCycleAt) {
    return {
      level: "warn",
      check: `${h.name}-health`,
      message: `The ${h.name}'s health endpoint did not answer${h.error ? ` (${h.error})` : ""}.`,
    };
  }
  const age = s.timestamp - Math.floor(Date.parse(h.lastCycleAt) / 1000);
  if (age > t.serviceStaleSeconds) {
    return {
      level: "fail",
      check: `${h.name}-health`,
      message: `The ${h.name}'s last cycle was ${fmtDuration(age)} ago.`,
    };
  }
  return {
    level: "ok",
    check: `${h.name}-health`,
    message: `The ${h.name} completed a cycle ${fmtDuration(Math.max(age, 0))} ago.`,
  };
}

export function evaluate(s: Snapshot, t: Thresholds = DEFAULT_THRESHOLDS): Finding[] {
  const out: Finding[] = s.vaults.map(checkSolvency);
  const marketFindings: Finding[] = [];
  for (const m of s.markets) {
    for (const f of [checkSupply(m), checkSettlement(m, s, t), checkGraduation(m, s, t)]) {
      if (f) marketFindings.push(f);
    }
  }
  out.push(...marketFindings);
  if (marketFindings.length === 0) {
    const stacks = new Set(s.markets.map((m) => m.stack ?? "primary")).size;
    out.push({
      level: "ok",
      check: "markets",
      message: `${s.markets.length === 1 ? "1 market" : `${s.markets.length} markets`}${stacks > 1 ? ` on ${stacks} stacks` : ""} checked: supply, settlement and graduation on time.`,
    });
  }
  out.push(checkBalance("keeper", s.balances.keeper, t.keeperWarnWei, t.keeperFailWei));
  out.push(checkBalance("maker", s.balances.maker, t.makerWarnWei, t.makerFailWei));
  for (const h of s.services) out.push(checkService(h, s, t));
  return out;
}

export function worst(findings: Finding[]): Level {
  if (findings.some((f) => f.level === "fail")) return "fail";
  if (findings.some((f) => f.level === "warn")) return "warn";
  return "ok";
}

const ICON: Record<Level, string> = { ok: "OK", warn: "WARN", fail: "FAIL" };

/** A Markdown report, used for the GitHub issue the scheduled check keeps up to date. */
export function toMarkdown(s: Snapshot, findings: Finding[], explorer: string): string {
  const lines = [
    `Liveness check on ${s.network} at block ${s.block} (${new Date(s.timestamp * 1000).toISOString()}): **${worst(findings).toUpperCase()}**`,
    "",
    "| Result | Check | Detail |",
    "|---|---|---|",
  ];
  for (const f of findings) {
    const subject = f.subject
      ? ` ([${f.subject.slice(0, 6)}…${f.subject.slice(-4)}](${explorer}/address/${f.subject}))`
      : "";
    lines.push(`| ${ICON[f.level]} | ${f.check} | ${f.message}${subject} |`);
  }
  return lines.join("\n");
}

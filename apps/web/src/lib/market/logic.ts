import {
  BPS,
  impliedChanceBps,
  type MarketCaps,
  Outcome,
  PHASE_LABEL,
  Phase,
  poolPayout,
  Side,
  USDC_DECIMALS,
  type Window,
} from "@hunch-book/shared";
import { maxUint256 } from "viem";
import { formatBpsPercent, formatChance, formatDuration, formatUsdc, formatUtc } from "../format";
import type { BookQuote, ChainClock, MarketView } from "./types";

// ---------- phases ----------

/** The four groups the markets list filters by. */
export type PhaseGroup = "pools" | "trading" | "settling" | "settled";

export const PHASE_GROUPS: readonly PhaseGroup[] = ["pools", "trading", "settling", "settled"];

export const PHASE_GROUP_LABEL: Record<PhaseGroup, string> = {
  pools: "Pools filling",
  trading: "Trading",
  settling: "Settling",
  settled: "Settled",
};

export function phaseGroup(phase: Phase): PhaseGroup {
  switch (phase) {
    case Phase.Pool:
      return "pools";
    case Phase.Graduated:
      return "trading";
    case Phase.PoolLocked:
    case Phase.Closed:
      return "settling";
    default:
      return "settled";
  }
}

export function parsePhaseGroup(value: string | string[] | undefined): PhaseGroup | "all" {
  const v = Array.isArray(value) ? value[0] : value;
  return PHASE_GROUPS.includes(v as PhaseGroup) ? (v as PhaseGroup) : "all";
}

export function phaseLabel(phase: Phase): string {
  return PHASE_LABEL[phase] ?? "Unknown";
}

/** Tone for the phase badge. */
export function phaseTone(phase: Phase): "accent" | "neutral" | "warn" | "muted" {
  if (phase === Phase.Pool || phase === Phase.Graduated) return "accent";
  if (phase === Phase.PoolLocked || phase === Phase.Closed) return "warn";
  if (phase === Phase.Voided) return "muted";
  return "neutral";
}

// ---------- Kuru book ----------

export const PRICE_SCALE = 10n ** 18n;

/**
 * Kuru's `bestBidAsk()` returns prices in 1e18 units. An empty bid reads as type(uint256).max and an
 * empty ask as 0 (PROTOCOL.md §8.1). Both sentinels are treated as empty on either side.
 */
export function parseBestBidAsk(bid: bigint, ask: bigint): BookQuote {
  const clean = (v: bigint): bigint | null => (v === 0n || v === maxUint256 ? null : v);
  return { bid: clean(bid), ask: clean(ask) };
}

/** Mid price in 1e18 units, only when both sides have orders. */
export function bookMid(quote: BookQuote | null): bigint | null {
  if (!quote || quote.bid === null || quote.ask === null) return null;
  return (quote.bid + quote.ask) / 2n;
}

/** A 1e18 YES price as a chance in basis points, clamped to 0 to 10,000. */
export function priceE18ToBps(price: bigint): bigint {
  const bps = (price * BPS) / PRICE_SCALE;
  return bps < 0n ? 0n : bps > BPS ? BPS : bps;
}

// ---------- chance ----------

export type ChanceSource = "pool" | "book" | "book-empty" | "settled" | "void" | "empty";

export interface Chance {
  /** YES chance in basis points, or null when there is none to show. */
  bps: bigint | null;
  source: ChanceSource;
  /** Short words for what the number is. */
  note: string;
}

/** The market's implied chance of YES: pool split before graduation, Kuru mid after. */
export function marketChance(m: Pick<MarketView, "phase" | "outcome" | "pool" | "quote">): Chance {
  if (m.phase === Phase.Settled) {
    return m.outcome === Outcome.Yes
      ? { bps: BPS, source: "settled", note: "Settled YES" }
      : { bps: 0n, source: "settled", note: "Settled NO" };
  }
  if (m.phase === Phase.Voided) return { bps: null, source: "void", note: "Voided" };
  if (m.phase === Phase.Graduated || m.phase === Phase.Closed) {
    const mid = bookMid(m.quote);
    return mid === null
      ? { bps: null, source: "book-empty", note: "No two-sided quote on the book yet" }
      : { bps: priceE18ToBps(mid), source: "book", note: "Mid price on Kuru" };
  }
  if (m.pool.total === 0n) return { bps: null, source: "empty", note: "No stakes yet" };
  return { bps: impliedChanceBps(m.pool.yes, m.pool.no), source: "pool", note: "Pool split" };
}

// ---------- time ----------

export interface Moment {
  /** Block number for block-clock markets; undefined for timestamp markets. */
  block?: bigint;
  /** Unix seconds; estimated for block-clock markets. */
  time: number;
  estimated: boolean;
}

/** Unix seconds when `block` is expected, from the chain head and the measured block time. */
export function estimateBlockTime(block: bigint, clock: ChainClock): number {
  const deltaBlocks = Number(block - clock.blockNumber);
  return Math.round(clock.timestamp + (deltaBlocks * clock.msPerBlock) / 1000);
}

/** Converts a window point (lock or close) to a moment. */
export function windowMoment(window: Window, value: bigint, clock: ChainClock | null): Moment | null {
  if (!window.blockClock) return { time: Number(value), estimated: false };
  if (!clock) return null;
  return { block: value, time: estimateBlockTime(value, clock), estimated: true };
}

export interface Milestone {
  label: string;
  moment: Moment;
}

const PASSED: Record<string, string> = {
  "Locks in": "Locking now",
  "Closes in": "Closing now",
  "Settle within": "Past the settlement deadline",
};

/** "Locks in 2d 4h", "Closes in about 3h 12m" (block clock), or what it means once the time has passed. */
export function milestoneText(milestone: Milestone, nowSeconds: number): string {
  const left = milestone.moment.time - nowSeconds;
  if (left <= 0) return PASSED[milestone.label] ?? milestone.label;
  return `${milestone.label} ${milestone.moment.estimated ? "about " : ""}${formatDuration(left)}`;
}

/** The next deadline that matters for this phase, for countdowns. */
export function nextMilestone(
  m: Pick<MarketView, "phase" | "window">,
  clock: ChainClock | null,
  nowSeconds: number,
): Milestone | null {
  const deadline: Moment = { time: Number(m.window.settleDeadline), estimated: false };
  const lock = windowMoment(m.window, m.window.lock, clock);
  const close = windowMoment(m.window, m.window.close, clock);
  switch (m.phase) {
    case Phase.Pool:
      return lock ? { label: "Locks in", moment: lock } : null;
    case Phase.Graduated:
      return close ? { label: "Closes in", moment: close } : null;
    case Phase.PoolLocked:
      if (close && close.time > nowSeconds) return { label: "Closes in", moment: close };
      return { label: "Settle within", moment: deadline };
    case Phase.Closed:
      return { label: "Settle within", moment: deadline };
    default:
      return null;
  }
}

// ---------- staking ----------

/** Parses a USDC amount typed by a person. Returns null for anything that is not a positive amount. */
export function parseUsdcInput(input: string): bigint | null {
  const s = input.trim().replace(/,/g, "");
  if (!/^\d*\.?\d*$/.test(s) || s === "" || s === ".") return null;
  const [whole = "0", frac = ""] = s.split(".");
  if (frac.length > USDC_DECIMALS) return null;
  const value =
    BigInt(whole || "0") * 10n ** BigInt(USDC_DECIMALS) + BigInt(frac.padEnd(USDC_DECIMALS, "0") || "0");
  return value > 0n ? value : null;
}

export interface StakePreview {
  /** USDC paid back if this side wins and the pool stays as it is after this stake. */
  paidIfWin: bigint;
  feeIfWin: bigint;
  profitIfWin: bigint;
  /** Pool chance of YES after this stake. */
  chanceAfterBps: bigint;
}

/**
 * What one new stake pays if its side wins, with the pool as it is now plus this stake. Uses the
 * shared payout math, which equals the contract's (PROTOCOL.md §5.2). Graduation keeps the same payoff.
 */
export function previewStake(args: {
  side: Side;
  amount: bigint;
  yesTotal: bigint;
  noTotal: bigint;
}): StakePreview {
  const yesAfter = args.side === Side.Yes ? args.yesTotal + args.amount : args.yesTotal;
  const noAfter = args.side === Side.No ? args.noTotal + args.amount : args.noTotal;
  const win =
    args.side === Side.Yes
      ? poolPayout(args.amount, yesAfter, noAfter)
      : poolPayout(args.amount, noAfter, yesAfter);
  return {
    paidIfWin: win.paid,
    feeIfWin: win.fee,
    profitIfWin: win.paid - args.amount,
    chanceAfterBps: impliedChanceBps(yesAfter, noAfter),
  };
}

/** Checks a stake against the market's own limits before asking the wallet. Returns a reason or null. */
export function validateStake(args: {
  amount: bigint | null;
  phase: Phase;
  caps: MarketCaps;
  poolTotal: bigint;
  userStake: { yes: bigint; no: bigint } | null;
  balance: bigint | null;
}): string | null {
  if (args.phase !== Phase.Pool) return "Staking is closed for this market.";
  if (args.amount === null) return "Enter an amount in USDC.";
  if (args.amount < args.caps.minStake) return `The minimum stake is ${formatUsdc(args.caps.minStake)} USDC.`;
  const poolRoom = args.caps.poolCap > args.poolTotal ? args.caps.poolCap - args.poolTotal : 0n;
  if (args.amount > poolRoom) return `The pool has room for ${formatUsdc(poolRoom)} more USDC.`;
  if (args.userStake) {
    const used = args.userStake.yes + args.userStake.no;
    const walletRoom = args.caps.walletCap > used ? args.caps.walletCap - used : 0n;
    if (args.amount > walletRoom) {
      return `One wallet can stake up to ${formatUsdc(args.caps.walletCap)} USDC here. You have ${formatUsdc(walletRoom)} left.`;
    }
  }
  if (args.balance !== null && args.amount > args.balance) {
    return `Your wallet holds ${formatUsdc(args.balance)} USDC.`;
  }
  return null;
}

// ---------- graduation ----------

export interface RuleProgress {
  label: string;
  current: string;
  target: string;
  met: boolean;
  /** 0 to 1 for a progress bar, or null when a bar does not fit. */
  ratio: number | null;
}

/** Progress toward the market's graduation rule, from its own `rule()` (PROTOCOL.md §5.3). */
export function graduationProgress(m: Pick<MarketView, "pool" | "rule">): RuleProgress[] {
  const { pool, rule } = m;
  const chance = pool.total === 0n ? null : Number(impliedChanceBps(pool.yes, pool.no));
  const ratio = (a: bigint, b: bigint): number =>
    b === 0n ? 1 : Math.min(1, Number((a * 1000n) / b) / 1000);
  return [
    {
      label: "Pool size",
      current: `${formatUsdc(pool.total)} USDC`,
      target: `${formatUsdc(rule.minPool)} USDC`,
      met: pool.total >= rule.minPool,
      ratio: ratio(pool.total, rule.minPool),
    },
    {
      label: "Stakers",
      current: pool.stakers.toString(),
      target: rule.minStakers.toString(),
      met: pool.stakers >= rule.minStakers,
      ratio: ratio(BigInt(pool.stakers), BigInt(rule.minStakers)),
    },
    {
      label: "Both sides staked",
      current: pool.yes > 0n && pool.no > 0n ? "yes" : "no",
      target: "yes",
      met: pool.yes > 0n && pool.no > 0n,
      ratio: null,
    },
    {
      label: "Chance in range",
      current: formatChance(chance),
      target: `${formatBpsPercent(rule.minChanceBps)} to ${formatBpsPercent(rule.maxChanceBps)}`,
      met: chance !== null && chance >= rule.minChanceBps && chance <= rule.maxChanceBps,
      ratio: null,
    },
  ];
}

// ---------- void terms ----------

/** What happens if the source never answers, in plain words (PROTOCOL.md §5.6). */
export function voidTerms(m: Pick<MarketView, "graduated" | "window">): string[] {
  const deadline = formatUtc(m.window.settleDeadline);
  const first = `If the source gives no answer by ${deadline}, anyone can void the market.`;
  return m.graduated
    ? [
        first,
        "This market has graduated, so after a void every YES and every NO token redeems for 0.50 USDC, with no fee.",
        "That is not a refund if you bought on the book at another price: someone who bought YES at 0.80 loses 0.30 per token.",
      ]
    : [
        first,
        "While it is a pool, a void refunds every stake in full, with no fee.",
        "If it graduates first, every YES and every NO token redeems for 0.50 USDC instead, which is not a refund for someone who bought on the book at another price.",
      ];
}

// ---------- lifecycle track ----------

export type StageState = "done" | "current" | "todo" | "skipped";

export const STAGES = ["Pool", "Graduate", "Trade", "Settle"] as const;

/** Where a market is in Pool, Graduate, Trade, Settle. A pool that locks without graduating skips two. */
export function lifecycleStages(m: Pick<MarketView, "phase" | "graduated">): StageState[] {
  switch (m.phase) {
    case Phase.Pool:
      return ["current", "todo", "todo", "todo"];
    case Phase.PoolLocked:
      return ["done", "skipped", "skipped", "current"];
    case Phase.Graduated:
      return ["done", "done", "current", "todo"];
    case Phase.Closed:
      return ["done", "done", "done", "current"];
    default:
      return m.graduated ? ["done", "done", "done", "done"] : ["done", "skipped", "skipped", "done"];
  }
}

/** The big number and its caption for a market's chance. */
export function chanceDisplay(chance: Chance): { value: string; caption: string } {
  if (chance.source === "settled") return { value: chance.bps === BPS ? "YES" : "NO", caption: "won" };
  if (chance.bps === null) return { value: "n/a", caption: chance.note };
  return { value: formatChance(chance.bps), caption: "chance of YES" };
}

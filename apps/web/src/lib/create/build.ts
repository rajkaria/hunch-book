import {
  encodeChainlinkTouchParams,
  encodeParlayParams,
  encodePerplFundingParams,
  encodePerplFundingSpikeParams,
  encodePriceAtTimeParams,
  encodePriceRangeParams,
  PARLAY_MAX_LEGS,
  PARLAY_MIN_LEGS,
  type PriceSource,
  TouchDirection,
  type Window,
} from "@hunch-book/shared";
import type { Address, Hex } from "viem";
import { formatInt, formatUtc } from "../format";
import { blockAt, fromLocalInput, type Head, type Pace, timeAt, toLocalInput } from "./clock";
import {
  eventsInWindow,
  type FundingRule,
  fundingDecimals,
  PERP_STATUS_PAUSED,
  type PerpInfo,
  snapWindow,
} from "./perpl";
import {
  DAY,
  defaultPriceTimes,
  HOUR,
  LOCK_LEAD_SECONDS,
  type LockLead,
  MIN_LEAD_SECONDS,
  MINUTE,
  type PriceFeedOption,
} from "./price";
import { parseFixed } from "./units";

// Form drafts to canonical market parameters, one builder per template. Pure functions: every check a
// person can fix is reported against the field it belongs to, and parameters are only produced when
// nothing is wrong. The resolver's own `validate` (run by the preview through eth_call) is still the
// final word.

export interface Issue {
  field: string;
  message: string;
}

const issue = (field: string, message: string): Issue => ({ field, message });

/** The message for one field, if any. */
export function issueFor(issues: readonly Issue[], field: string): string | undefined {
  return issues.find((i) => i.field === field)?.message;
}

const ceilToHour = (unix: number): number => Math.ceil(unix / HOUR) * HOUR;
const floorToMinute = (unix: number): number => Math.floor(unix / MINUTE) * MINUTE;
const ceilToMinute = (unix: number): number => Math.ceil(unix / MINUTE) * MINUTE;

/** The longest window templates 3 and 4 accept, in seconds. */
export const MAX_TOUCH_SECONDS = 31 * DAY;
/** Template 3's challenge period after the window. */
export const TOUCH_CHALLENGE_SECONDS = DAY;

/** A form's output: the params (null until valid) and what the preview needs to show the window. */
export interface FormResult {
  params: Hex | null;
  /** The chain clock, for block-clock templates (estimated times). */
  clock: { head: Head; pace: Pace } | null;
  /** The price source, for price templates (void terms differ). */
  priceSource: PriceSource | null;
  /** Touch templates: when NO can settle if nobody has proved YES. */
  challengeEnd: { block: bigint | null; unix: number | null } | null;
}

export const EMPTY_RESULT: FormResult = { params: null, clock: null, priceSource: null, challengeEnd: null };

const STAKING_LEAD = "at least 5 minutes from now, so the transaction lands before it";

// ---------- templates 1 and 4: Perpl funding over a window, and a single funding spike ----------

export interface PerplDraft {
  /** Asset key from deployments (BTC, ETH, SOL, MON). */
  asset: string;
  /** Window start (the lock), as a `datetime-local` value. */
  start: string;
  /** Window end (the close), as a `datetime-local` value. */
  end: string;
  /** Threshold in USD per unit of the asset: in total over the window (1), or for one event (4). */
  threshold: string;
  /** Snap the window to Perpl's funding grid. */
  snap: boolean;
}

export interface PerplContext {
  perpId: bigint;
  info: PerpInfo;
  interval: bigint;
  /** Grid offset from the latest funding event; 0 if unknown. */
  anchor: bigint;
  head: Head;
  pace: Pace;
  now: number;
  /** "window": template 1, total funding. "spike": template 4, any single event. */
  rule: FundingRule;
  /** Template 4's longest window in blocks (31 days of its challenge period); null for template 1. */
  maxWindowBlocks?: bigint | null;
}

export interface PerplBuild {
  params: Hex | null;
  startBlock: bigint | null;
  endBlock: bigint | null;
  /** Funding events inside the window. */
  intervals: bigint | null;
  threshold: bigint | null;
  issues: Issue[];
}

/** Window from a day ahead (so the pool has time to fill) to a day after that. */
export function defaultPerplDraft(now: number, asset: string): PerplDraft {
  const start = ceilToHour(now + DAY);
  return { asset, start: toLocalInput(start), end: toLocalInput(start + DAY), threshold: "", snap: true };
}

export function buildPerplParams(draft: PerplDraft, ctx: PerplContext): PerplBuild {
  const { info, interval, head, pace, now } = ctx;
  const out: PerplBuild = {
    params: null,
    startBlock: null,
    endBlock: null,
    intervals: null,
    threshold: null,
    issues: [],
  };
  const issues = out.issues;

  if (info.status === PERP_STATUS_PAUSED) {
    issues.push(issue("asset", "Perpl has paused this perp, so it cannot be used for a new market."));
  }

  const startUnix = fromLocalInput(draft.start);
  const endUnix = fromLocalInput(draft.end);
  if (startUnix === null) issues.push(issue("start", "Pick when the window starts."));
  else if (startUnix < now + MIN_LEAD_SECONDS) {
    issues.push(issue("start", `Staking stops when the window starts, so pick a start ${STAKING_LEAD}.`));
  }
  if (endUnix === null) issues.push(issue("end", "Pick when the window ends."));
  else if (startUnix !== null && endUnix <= startUnix) {
    issues.push(issue("end", "The window must end after it starts."));
  }

  if (startUnix !== null && endUnix !== null && endUnix > startUnix) {
    const rawStart = blockAt(startUnix, head, pace.msPerBlock);
    const rawEnd = blockAt(endUnix, head, pace.msPerBlock);
    if (draft.snap) {
      const snapped = snapWindow({ startBlock: rawStart, endBlock: rawEnd, interval, anchor: ctx.anchor });
      out.startBlock = snapped.startBlock;
      out.endBlock = snapped.endBlock;
    } else {
      out.startBlock = rawStart;
      out.endBlock = rawEnd;
    }
    out.intervals = eventsInWindow(out.startBlock, out.endBlock, interval, ctx.anchor);
    const span = out.endBlock - out.startBlock;
    if (span < interval) {
      const minutes = Math.round((Number(interval) * pace.msPerBlock) / 60_000);
      issues.push(
        issue(
          "end",
          `The window must cover at least one funding interval: ${formatInt(interval)} blocks, about ${minutes} minutes.`,
        ),
      );
    } else if (ctx.maxWindowBlocks && span > ctx.maxWindowBlocks) {
      issues.push(
        issue(
          "end",
          `A spike window can be at most ${formatInt(ctx.maxWindowBlocks)} blocks, about 31 days.`,
        ),
      );
    }
    if (info.fundingStartBlock === 0n || info.fundingStartBlock > out.startBlock) {
      issues.push(
        issue("start", "Funding on this perp starts after this window would begin. Pick a later start."),
      );
    }
  }

  const decimals = fundingDecimals(info);
  const parsed = parseFixed(draft.threshold, decimals, {
    allowNegative: true,
    unitName: `Perpl's ${info.symbol} funding`,
  });
  if (parsed === null) {
    issues.push(
      issue(
        "threshold",
        ctx.rule === "spike"
          ? `Enter a threshold in USD per ${info.symbol} for one funding event.`
          : `Enter a threshold in USD per ${info.symbol}. 0 means longs pay shorts on net.`,
      ),
    );
  } else if (!parsed.ok) {
    issues.push(issue("threshold", parsed.error));
  } else {
    out.threshold = parsed.value;
  }

  if (issues.length === 0 && out.startBlock !== null && out.endBlock !== null && out.threshold !== null) {
    const params = {
      perpId: ctx.perpId,
      startBlock: out.startBlock,
      endBlock: out.endBlock,
      threshold: out.threshold,
      expectedScalingExp: info.scalingExp,
    };
    out.params =
      ctx.rule === "spike" ? encodePerplFundingSpikeParams(params) : encodePerplFundingParams(params);
  }
  return out;
}

// ---------- templates 2 and 5: price at a time, and price in a range ----------

/** "at": template 2, at or above one level. "range": template 5, between two levels. */
export type PriceRule = "at" | "range";

export interface PriceDraft {
  /** PriceFeedOption.key. */
  feed: string;
  /** Template 2: the strike in USD. */
  strike: string;
  /** Template 5: the inclusive lower bound in USD. */
  lower: string;
  /** Template 5: the exclusive upper bound in USD. */
  upper: string;
  /** Observation time T (the close), as a `datetime-local` value. */
  close: string;
  lockLead: LockLead;
  /** Only used when lockLead is "custom". */
  lock: string;
}

export interface PriceBuild {
  params: Hex | null;
  option: PriceFeedOption | null;
  strikeE8: bigint | null;
  lowerE8: bigint | null;
  upperE8: bigint | null;
  lockTime: number | null;
  closeTime: number | null;
  issues: Issue[];
}

export function defaultPriceDraft(now: number, options: readonly PriceFeedOption[]): PriceDraft {
  const { lock, close } = defaultPriceTimes(now);
  return {
    feed: options[0]?.key ?? "",
    strike: "",
    lower: "",
    upper: "",
    close: toLocalInput(close),
    lockLead: "day",
    lock: toLocalInput(lock),
  };
}

/** The lock time the draft implies, or null if it cannot be read. */
export function priceLockTime(
  draft: Pick<PriceDraft, "lockLead" | "lock">,
  closeTime: number | null,
): number | null {
  if (draft.lockLead === "custom") return fromLocalInput(draft.lock);
  return closeTime === null ? null : closeTime - LOCK_LEAD_SECONDS[draft.lockLead];
}

/** Parses a positive USD price with up to 8 decimals into `issues` under `field`. */
function parsePrice(input: string, field: string, empty: string, issues: Issue[]): bigint | null {
  const parsed = parseFixed(input, 8, { unitName: "a price feed" });
  if (parsed === null) issues.push(issue(field, empty));
  else if (!parsed.ok) issues.push(issue(field, parsed.error));
  else if (parsed.value <= 0n) issues.push(issue(field, "The price must be above zero."));
  else return parsed.value;
  return null;
}

export function buildPriceParams(
  draft: PriceDraft,
  ctx: { options: readonly PriceFeedOption[]; now: number; rule?: PriceRule },
): PriceBuild {
  const rule = ctx.rule ?? "at";
  const option = ctx.options.find((o) => o.key === draft.feed) ?? null;
  const out: PriceBuild = {
    params: null,
    option,
    strikeE8: null,
    lowerE8: null,
    upperE8: null,
    lockTime: null,
    closeTime: null,
    issues: [],
  };
  const issues = out.issues;

  if (!option) issues.push(issue("feed", "Pick a price feed."));

  if (rule === "at") {
    out.strikeE8 = parsePrice(draft.strike, "strike", "Enter the price level in USD.", issues);
  } else {
    out.lowerE8 = parsePrice(draft.lower, "lower", "Enter the bottom of the range in USD.", issues);
    out.upperE8 = parsePrice(draft.upper, "upper", "Enter the top of the range in USD.", issues);
    if (out.lowerE8 !== null && out.upperE8 !== null && out.upperE8 <= out.lowerE8) {
      issues.push(issue("upper", "The top of the range must be above the bottom."));
    }
  }

  out.closeTime = fromLocalInput(draft.close);
  if (out.closeTime === null) issues.push(issue("close", "Pick the time the price is read."));
  out.lockTime = priceLockTime(draft, out.closeTime);
  if (out.lockTime === null) {
    if (draft.lockLead === "custom") issues.push(issue("lock", "Pick when staking stops."));
  } else if (out.lockTime < ctx.now + MIN_LEAD_SECONDS) {
    issues.push(
      issue(
        draft.lockLead === "custom" ? "lock" : "close",
        `Staking stops at the lock, which must be ${STAKING_LEAD}. Pick a later close or a shorter lead.`,
      ),
    );
  } else if (out.closeTime !== null && out.closeTime < out.lockTime) {
    issues.push(issue("lock", "The lock must be at or before the close."));
  }

  if (issues.length === 0 && option && out.lockTime !== null && out.closeTime !== null) {
    const base = {
      source: option.source,
      feed: option.feed,
      pythId: option.pythId,
      lockTime: BigInt(out.lockTime),
      closeTime: BigInt(out.closeTime),
    };
    if (rule === "at" && out.strikeE8 !== null) {
      out.params = encodePriceAtTimeParams({ ...base, strikeE8: out.strikeE8 });
    } else if (rule === "range" && out.lowerE8 !== null && out.upperE8 !== null) {
      out.params = encodePriceRangeParams({ ...base, lowerE8: out.lowerE8, upperE8: out.upperE8 });
    }
  }
  return out;
}

// ---------- template 3: price touch ----------

export interface TouchDraft {
  /** PriceFeedOption.key (Chainlink only). */
  feed: string;
  direction: "above" | "below";
  strike: string;
  /** First moment a round counts, as a `datetime-local` value. */
  start: string;
  /** Last moment a round counts (the close). */
  end: string;
  /** Staking stops when the window starts (the usual choice), or at `lock`. */
  lockAtStart: boolean;
  lock: string;
}

export interface TouchBuild {
  params: Hex | null;
  option: PriceFeedOption | null;
  strikeE8: bigint | null;
  lockTime: number | null;
  startTime: number | null;
  endTime: number | null;
  issues: Issue[];
}

/** A week-long window starting a day ahead, locked at its start. */
export function defaultTouchDraft(now: number, options: readonly PriceFeedOption[]): TouchDraft {
  const start = ceilToHour(now + DAY);
  return {
    feed: options[0]?.key ?? "",
    direction: "above",
    strike: "",
    start: toLocalInput(start),
    end: toLocalInput(start + 7 * DAY),
    lockAtStart: true,
    lock: toLocalInput(start),
  };
}

export function buildTouchParams(
  draft: TouchDraft,
  ctx: { options: readonly PriceFeedOption[]; now: number },
): TouchBuild {
  const option = ctx.options.find((o) => o.key === draft.feed) ?? null;
  const out: TouchBuild = {
    params: null,
    option,
    strikeE8: null,
    lockTime: null,
    startTime: null,
    endTime: null,
    issues: [],
  };
  const issues = out.issues;
  if (!option) issues.push(issue("feed", "Pick a price feed."));
  out.strikeE8 = parsePrice(draft.strike, "strike", "Enter the price level in USD.", issues);

  out.startTime = fromLocalInput(draft.start);
  out.endTime = fromLocalInput(draft.end);
  out.lockTime = draft.lockAtStart ? out.startTime : fromLocalInput(draft.lock);
  if (out.startTime === null) issues.push(issue("start", "Pick when the window starts."));
  if (out.endTime === null) issues.push(issue("end", "Pick when the window ends."));
  if (!draft.lockAtStart && out.lockTime === null) issues.push(issue("lock", "Pick when staking stops."));

  const lockField = draft.lockAtStart ? "start" : "lock";
  if (out.lockTime !== null && out.lockTime < ctx.now + MIN_LEAD_SECONDS) {
    issues.push(issue(lockField, `Staking stops at the lock, which must be ${STAKING_LEAD}.`));
  } else if (out.lockTime !== null && out.startTime !== null && out.startTime < out.lockTime) {
    issues.push(issue("lock", "Staking must stop at or before the window starts."));
  }
  if (out.startTime !== null && out.endTime !== null) {
    if (out.endTime <= out.startTime) issues.push(issue("end", "The window must end after it starts."));
    else if (out.endTime - out.startTime > MAX_TOUCH_SECONDS) {
      issues.push(issue("end", "A touch window can be at most 31 days long."));
    }
  }

  if (
    issues.length === 0 &&
    option &&
    out.strikeE8 !== null &&
    out.lockTime !== null &&
    out.startTime !== null &&
    out.endTime !== null
  ) {
    out.params = encodeChainlinkTouchParams({
      feed: option.feed,
      strikeE8: out.strikeE8,
      direction: draft.direction === "above" ? TouchDirection.AtOrAbove : TouchDirection.AtOrBelow,
      lockTime: BigInt(out.lockTime),
      startTime: BigInt(out.startTime),
      endTime: BigInt(out.endTime),
    });
  }
  return out;
}

// ---------- template 6: parlay ----------

/** A market that can be a parlay leg: what the picker shows and the window the resolver checks. */
export interface ParlayLeg {
  address: Address;
  marketId: bigint;
  label: string;
  window: Window;
}

export interface ParlayDraft {
  legs: Address[];
  lock: string;
  close: string;
}

export interface ParlayContext {
  /** Every leg the draft names, with its window. */
  legs: readonly ParlayLeg[];
  head: Head;
  pace: Pace;
  now: number;
  /** The parlay resolver's fast block time, used for block-clock legs exactly as the contract does. */
  fastBlockTimeMs: number;
}

export interface ParlayBuild {
  params: Hex | null;
  lockTime: number | null;
  closeTime: number | null;
  /** The earliest any leg can lock, and which leg that is. */
  firstLock: { unix: number; leg: ParlayLeg } | null;
  issues: Issue[];
}

/**
 * The earliest unix time a leg can lock, as MarketOutcomeResolver.earliestLockTime computes it: the
 * lock itself on a time clock; on a block clock, now plus the blocks left at the resolver's fast
 * block time (an early estimate, never a late one).
 */
export function legEarliestLock(window: Window, head: Head, fastBlockTimeMs: number): number {
  if (!window.blockClock) return Number(window.lock);
  if (window.lock <= head.number) return head.timestamp;
  return head.timestamp + Math.floor((Number(window.lock - head.number) * fastBlockTimeMs) / 1000);
}

/** A leg's close as a unix time: exact on a time clock, estimated from the pace on a block clock. */
export function legClose(window: Window, head: Head, pace: Pace): number {
  return window.blockClock ? timeAt(window.close, head, pace.msPerBlock) : Number(window.close);
}

/** Defaults for the chosen legs: lock a minute before the first leg can lock, close at the last leg's close. */
export function defaultParlayTimes(ctx: ParlayContext): { lock: number; close: number } | null {
  if (ctx.legs.length === 0) return null;
  const firstLock = Math.min(
    ...ctx.legs.map((l) => legEarliestLock(l.window, ctx.head, ctx.fastBlockTimeMs)),
  );
  const lastClose = Math.max(...ctx.legs.map((l) => legClose(l.window, ctx.head, ctx.pace)));
  const lock = floorToMinute(firstLock - MINUTE);
  return { lock, close: Math.max(lock, ceilToMinute(lastClose)) };
}

export function buildParlayParams(draft: ParlayDraft, ctx: ParlayContext): ParlayBuild {
  const out: ParlayBuild = { params: null, lockTime: null, closeTime: null, firstLock: null, issues: [] };
  const issues = out.issues;
  const legs = draft.legs
    .map((a) => ctx.legs.find((l) => l.address.toLowerCase() === a.toLowerCase()))
    .filter((l): l is ParlayLeg => l !== undefined);

  if (legs.length < PARLAY_MIN_LEGS || legs.length > PARLAY_MAX_LEGS) {
    issues.push(issue("legs", `Pick ${PARLAY_MIN_LEGS} to ${PARLAY_MAX_LEGS} markets.`));
  }
  for (const leg of legs) {
    const at = legEarliestLock(leg.window, ctx.head, ctx.fastBlockTimeMs);
    if (!out.firstLock || at < out.firstLock.unix) out.firstLock = { unix: at, leg };
  }

  out.lockTime = fromLocalInput(draft.lock);
  out.closeTime = fromLocalInput(draft.close);
  if (out.lockTime === null) issues.push(issue("lock", "Pick when staking stops."));
  else if (out.lockTime < ctx.now + MIN_LEAD_SECONDS) {
    issues.push(issue("lock", `Staking stops at the lock, which must be ${STAKING_LEAD}.`));
  } else if (out.firstLock && out.lockTime > out.firstLock.unix) {
    issues.push(
      issue(
        "lock",
        `A parlay must lock at or before every leg. Market #${out.firstLock.leg.marketId.toString()} can lock as early as ${formatUtc(out.firstLock.unix)}, so pick a lock at or before that.`,
      ),
    );
  }
  if (out.closeTime === null) issues.push(issue("close", "Pick when settlement opens."));
  else if (out.lockTime !== null && out.closeTime < out.lockTime) {
    issues.push(issue("close", "The close must be at or after the lock."));
  }

  if (issues.length === 0 && out.lockTime !== null && out.closeTime !== null) {
    out.params = encodeParlayParams({
      legs: legs.map((l) => l.address),
      lockTime: BigInt(out.lockTime),
      closeTime: BigInt(out.closeTime),
    });
  }
  return out;
}

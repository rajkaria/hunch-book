import { readFileSync } from "node:fs";
import { Side, TemplateId, TouchDirection } from "@hunch-book/shared";
import { parseUnits } from "viem";

// The recurring series file (KEEPER_SERIES_FILE; example: services/keeper/series.example.json, docs in
// docs/SERIES.md). Each series describes markets that repeat on a schedule: which template, which asset,
// when each period locks and closes, how the strike is chosen, and the first stake the keeper makes from
// its own USDC when it creates the market. Everything is checked when the file is read, so a mistake
// stops the keeper at startup with a plain message instead of failing at creation time.

/** A series on a block clock (templates 1 and 4): blocks, like the Perpl markets themselves. */
export interface BlockSchedule {
  clock: "block";
  /** Lock (startBlock) of period 0. Period k locks at anchorBlock + k * everyBlocks. */
  anchorBlock: bigint;
  everyBlocks: bigint;
  /** endBlock − startBlock. */
  windowBlocks: bigint;
  /** The market is created this many blocks before its lock. */
  createBeforeLockBlocks: bigint;
  /** Never create a market whose lock is closer than this (the lock must still be ahead when mined). */
  minLeadBlocks: bigint;
}

/** A series on a unix-time clock (templates 2, 3 and 5). */
export interface TimeSchedule {
  clock: "time";
  /** Close of period 0, in unix seconds. Period k closes at anchor + k * every. */
  anchor: bigint;
  every: bigint;
  /** lock = close − lockBeforeClose. For a touch market the window is [lock, close]. */
  lockBeforeClose: bigint;
  /** The market is created this long before its lock. */
  createBeforeLock: bigint;
  /** Never create a market whose lock is closer than this. */
  minLead: bigint;
}

export type StrikeRule =
  /** A fixed strike: USD with 8 decimals (price templates) or raw Perpl units (funding templates). */
  | { rule: "fixed"; value: bigint }
  /** Template 2: the Chainlink price at the creation point, rounded to a step (USD, 8 decimals). */
  | { rule: "spot-rounded"; stepE8: bigint }
  /** Template 3: the price at the creation point moved by offsetBps away from spot, rounded outwards. */
  | { rule: "spot-offset"; offsetBps: bigint; stepE8: bigint }
  /** Template 5: a band of `widthE8` that holds the price at the creation point, on a grid of `stepE8`. */
  | { rule: "range-around-spot"; widthE8: bigint; stepE8: bigint }
  /** Template 1: the median net funding of the last `windows` windows of the same length. */
  | { rule: "trailing-median-funding"; windows: number }
  /** Template 4: the q-quantile of the single-interval increments of the last `intervals` events. */
  | { rule: "funding-increment-quantile"; q: number; intervals: number };

export interface SeriesSpec {
  id: string;
  enabled: boolean;
  templateId: number;
  /** "BTC" (Perpl perp name) for funding templates; "ETH/USD" (Chainlink pair) for price templates. */
  asset: string;
  /** Template 3 only. */
  direction: TouchDirection;
  schedule: BlockSchedule | TimeSchedule;
  strike: StrikeRule;
  firstStake: { side: Side; amount: bigint };
}

const BLOCK_TEMPLATES = new Set<number>([TemplateId.PerplFunding, TemplateId.PerplFundingSpike]);
const TIME_TEMPLATES = new Set<number>([
  TemplateId.PriceAtTime,
  TemplateId.ChainlinkTouch,
  TemplateId.PriceRange,
]);
const STRIKES_FOR: Record<number, StrikeRule["rule"][]> = {
  [TemplateId.PerplFunding]: ["fixed", "trailing-median-funding"],
  [TemplateId.PriceAtTime]: ["fixed", "spot-rounded"],
  [TemplateId.ChainlinkTouch]: ["fixed", "spot-offset"],
  [TemplateId.PerplFundingSpike]: ["fixed", "funding-increment-quantile"],
  [TemplateId.PriceRange]: ["range-around-spot"],
};

const UNITS: Record<string, bigint> = { s: 1n, m: 60n, h: 3_600n, d: 86_400n, w: 604_800n };

/** "90", "45s", "30m", "1h", "1d", "1w" → seconds. */
export function parseDuration(value: unknown, field: string): bigint {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === "string") {
    const match = /^(\d+)\s*([smhdw]?)$/.exec(value.trim());
    if (match) return BigInt(match[1] as string) * (UNITS[match[2] || "s"] as bigint);
  }
  throw new Error(
    `${field} must be a duration like "30m", "1h", "1d" or a number of seconds (got ${JSON.stringify(value)})`,
  );
}

function wholeNumber(value: unknown, field: string, min = 0n): bigint {
  const ok =
    (typeof value === "number" && Number.isInteger(value)) ||
    (typeof value === "string" && /^-?\d+$/.test(value));
  if (!ok) throw new Error(`${field} must be a whole number (got ${JSON.stringify(value)})`);
  const n = BigInt(value as string | number);
  if (n < min) throw new Error(`${field} must be at least ${min} (got ${n})`);
  return n;
}

/** A USD amount like "50" or "0.25" → 8 decimals. */
function usdE8(value: unknown, field: string): bigint {
  if (typeof value !== "string" && typeof value !== "number") {
    throw new Error(`${field} must be a USD amount like "50" (got ${JSON.stringify(value)})`);
  }
  const s = String(value);
  if (!/^\d+(\.\d{1,8})?$/.test(s)) throw new Error(`${field} must be a USD amount like "50" (got ${s})`);
  const e8 = parseUnits(s, 8);
  if (e8 <= 0n) throw new Error(`${field} must be above zero`);
  return e8;
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${field} must be an object`);
  return value as Record<string, unknown>;
}

function parseSchedule(
  templateId: number,
  raw: Record<string, unknown>,
  at: string,
): BlockSchedule | TimeSchedule {
  if (BLOCK_TEMPLATES.has(templateId)) {
    const everyBlocks = wholeNumber(raw.everyBlocks, `${at}.everyBlocks`, 1n);
    return {
      clock: "block",
      anchorBlock: wholeNumber(raw.anchorBlock, `${at}.anchorBlock`, 1n),
      everyBlocks,
      windowBlocks:
        raw.windowBlocks === undefined
          ? everyBlocks
          : wholeNumber(raw.windowBlocks, `${at}.windowBlocks`, 1n),
      createBeforeLockBlocks: wholeNumber(raw.createBeforeLockBlocks ?? 0, `${at}.createBeforeLockBlocks`),
      minLeadBlocks: wholeNumber(raw.minLeadBlocks ?? 2_000, `${at}.minLeadBlocks`, 1n),
    };
  }
  const anchorMs = typeof raw.anchor === "string" ? Date.parse(raw.anchor) : Number.NaN;
  if (!Number.isFinite(anchorMs) || anchorMs % 1000 !== 0) {
    throw new Error(`${at}.anchor must be an ISO time in whole seconds, like "2026-10-05T12:00:00Z"`);
  }
  const schedule: TimeSchedule = {
    clock: "time",
    anchor: BigInt(anchorMs / 1000),
    every: parseDuration(raw.every, `${at}.every`),
    lockBeforeClose: parseDuration(raw.lockBeforeClose, `${at}.lockBeforeClose`),
    createBeforeLock: parseDuration(raw.createBeforeLock ?? 0, `${at}.createBeforeLock`),
    minLead: parseDuration(raw.minLead ?? "10m", `${at}.minLead`),
  };
  if (schedule.every <= 0n) throw new Error(`${at}.every must be above zero`);
  if (schedule.minLead <= 0n) throw new Error(`${at}.minLead must be above zero`);
  if (templateId === TemplateId.ChainlinkTouch && schedule.lockBeforeClose <= 0n) {
    throw new Error(`${at}.lockBeforeClose is the touch window's length and must be above zero`);
  }
  return schedule;
}

function parseStrike(templateId: number, raw: Record<string, unknown>, at: string): StrikeRule {
  const rule = raw.rule;
  const allowed = STRIKES_FOR[templateId] ?? [];
  if (typeof rule !== "string" || !allowed.includes(rule as StrikeRule["rule"])) {
    throw new Error(`${at}.rule must be one of ${allowed.join(", ")} for template ${templateId}`);
  }
  switch (rule) {
    case "fixed":
      return {
        rule,
        value: BLOCK_TEMPLATES.has(templateId)
          ? wholeNumber(raw.value, `${at}.value`, -(2n ** 47n))
          : usdE8(raw.value, `${at}.value`),
      };
    case "spot-rounded":
      return { rule, stepE8: usdE8(raw.step, `${at}.step`) };
    case "spot-offset": {
      const pct = Number(raw.offsetPct);
      if (!Number.isFinite(pct) || pct <= 0 || pct >= 100)
        throw new Error(`${at}.offsetPct must be between 0 and 100`);
      return { rule, offsetBps: BigInt(Math.round(pct * 100)), stepE8: usdE8(raw.step, `${at}.step`) };
    }
    case "range-around-spot": {
      const widthE8 = usdE8(raw.width, `${at}.width`);
      const stepE8 = usdE8(raw.step, `${at}.step`);
      if (widthE8 % stepE8 !== 0n) throw new Error(`${at}.width must be a whole number of steps`);
      return { rule, widthE8, stepE8 };
    }
    case "trailing-median-funding": {
      const windows = Number(wholeNumber(raw.windows, `${at}.windows`, 1n));
      if (windows > 100) throw new Error(`${at}.windows must be at most 100`);
      return { rule, windows };
    }
    default: {
      const q = Number(raw.q);
      if (!Number.isFinite(q) || q <= 0 || q >= 1) throw new Error(`${at}.q must be between 0 and 1`);
      const intervals = Number(wholeNumber(raw.intervals, `${at}.intervals`, 10n));
      if (intervals > 5_000) throw new Error(`${at}.intervals must be at most 5000`);
      return { rule: "funding-increment-quantile", q, intervals };
    }
  }
}

/** Parses and checks a series file's JSON text. */
export function parseSeriesFile(text: string): SeriesSpec[] {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new Error(`the series file is not JSON: ${String(error)}`);
  }
  const list = record(json, "the series file").series;
  if (!Array.isArray(list)) throw new Error('the series file needs a "series" list');
  const ids = new Set<string>();
  return list.map((item, i) => {
    const raw = record(item, `series[${i}]`);
    const id = raw.id;
    if (typeof id !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) {
      throw new Error(`series[${i}].id must be lower-case letters, digits and dashes`);
    }
    if (ids.has(id)) throw new Error(`series id "${id}" appears twice`);
    ids.add(id);
    const at = `series "${id}"`;
    const templateId = Number(raw.template);
    if (!BLOCK_TEMPLATES.has(templateId) && !TIME_TEMPLATES.has(templateId)) {
      throw new Error(`${at}: template must be 1, 2, 3, 4 or 5 (parlays have no schedule)`);
    }
    if (typeof raw.asset !== "string" || raw.asset.trim() === "") throw new Error(`${at}: asset is missing`);
    const direction =
      raw.direction === undefined || raw.direction === "up"
        ? TouchDirection.AtOrAbove
        : raw.direction === "down"
          ? TouchDirection.AtOrBelow
          : undefined;
    if (direction === undefined) throw new Error(`${at}: direction must be "up" or "down"`);
    const stake = record(raw.firstStake, `${at}.firstStake`);
    const side = stake.side === "yes" ? Side.Yes : stake.side === "no" ? Side.No : undefined;
    if (side === undefined) throw new Error(`${at}.firstStake.side must be "yes" or "no"`);
    if (typeof stake.usdc !== "string" || !/^\d+(\.\d{1,6})?$/.test(stake.usdc)) {
      throw new Error(`${at}.firstStake.usdc must be an amount like "5"`);
    }
    return {
      id,
      enabled: raw.enabled !== false,
      templateId,
      asset: raw.asset.trim(),
      direction,
      schedule: parseSchedule(templateId, record(raw.schedule, `${at}.schedule`), `${at}.schedule`),
      strike: parseStrike(templateId, record(raw.strike, `${at}.strike`), `${at}.strike`),
      firstStake: { side, amount: parseUnits(stake.usdc, 6) },
    };
  });
}

export function loadSeriesFile(path: string): SeriesSpec[] {
  return parseSeriesFile(readFileSync(path, "utf8"));
}

import {
  decodeChainlinkTouchParams,
  decodePerplFundingParams,
  decodePerplFundingSpikeParams,
  decodePriceAtTimeParams,
  decodePriceRangeParams,
  encodeChainlinkTouchParams,
  encodePerplFundingParams,
  encodePerplFundingSpikeParams,
  encodePriceAtTimeParams,
  encodePriceRangeParams,
  PriceSource,
  TemplateId,
  TouchDirection,
} from "@hunch-book/shared";
import type { Address, Hex } from "viem";
import type { BlockSchedule, SeriesSpec, StrikeRule, TimeSchedule } from "./config.js";

// The series job's decisions as pure functions: which period comes next, whether it is due, the strike
// a rule gives for the data read at the creation point, the market's params, and the identity that
// tells whether a period already has a market. The job (jobs/series.ts) does the reads and the sends.

export interface Period {
  index: bigint;
  /** Block (block clock) or unix seconds (time clock). */
  lock: bigint;
  close: bigint;
  /** When the market may be created; the strike is measured at this point, so it is the same on a rerun. */
  createAt: bigint;
}

export interface Now {
  block: bigint;
  timestamp: bigint;
}

const ceilDiv = (a: bigint, b: bigint) => (a <= 0n ? 0n : (a + b - 1n) / b);

export function periodAt(schedule: BlockSchedule | TimeSchedule, index: bigint): Period {
  if (schedule.clock === "block") {
    const lock = schedule.anchorBlock + index * schedule.everyBlocks;
    return {
      index,
      lock,
      close: lock + schedule.windowBlocks,
      createAt: lock - schedule.createBeforeLockBlocks,
    };
  }
  const close = schedule.anchor + index * schedule.every;
  const lock = close - schedule.lockBeforeClose;
  return { index, lock, close, createAt: lock - schedule.createBeforeLock };
}

/** The next period whose lock is still at least the minimum lead away. */
export function nextPeriod(schedule: BlockSchedule | TimeSchedule, now: Now): Period {
  if (schedule.clock === "block") {
    const k = ceilDiv(now.block + schedule.minLeadBlocks - schedule.anchorBlock, schedule.everyBlocks);
    return periodAt(schedule, k);
  }
  const k = ceilDiv(
    now.timestamp + schedule.minLead + schedule.lockBeforeClose - schedule.anchor,
    schedule.every,
  );
  return periodAt(schedule, k);
}

export type SeriesDecision =
  | { due: true; period: Period; reason: string }
  | { due: false; period: Period; reason: string };

const clockNow = (schedule: BlockSchedule | TimeSchedule, now: Now) =>
  schedule.clock === "block" ? now.block : now.timestamp;
const unit = (schedule: BlockSchedule | TimeSchedule) => (schedule.clock === "block" ? "block" : "time");

/** Whether the next period's market should be created now. */
export function seriesDecision(spec: SeriesSpec, now: Now): SeriesDecision {
  const period = nextPeriod(spec.schedule, now);
  if (!spec.enabled) return { due: false, period, reason: "series is disabled in the file" };
  const t = clockNow(spec.schedule, now);
  if (t < period.createAt) {
    return {
      due: false,
      period,
      reason: `period ${period.index} is created at ${unit(spec.schedule)} ${period.createAt} (lock ${period.lock}, close ${period.close})`,
    };
  }
  return {
    due: true,
    period,
    reason: `period ${period.index} is due (lock ${period.lock}, close ${period.close})`,
  };
}

// ---------------------------------------------------------------- strikes

/** `value` on a grid of `step`: down, up, or to the nearest (half away from zero). */
export function roundToStep(value: bigint, step: bigint, mode: "down" | "up" | "nearest"): bigint {
  if (step <= 0n) throw new Error("step must be above zero");
  const floor = value >= 0n ? (value / step) * step : -ceilDiv(-value, step) * step;
  if (mode === "down" || floor === value) return floor;
  if (mode === "up") return floor + step;
  return (value - floor) * 2n >= step ? floor + step : floor;
}

/** The median (the lower middle for an even count). */
export function median(values: readonly bigint[]): bigint {
  if (values.length === 0) throw new Error("no values");
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return sorted[Math.floor((sorted.length - 1) / 2)] as bigint;
}

/** The q-quantile by nearest rank: the smallest value with at least q of the values at or below it. */
export function quantile(values: readonly bigint[], q: number): bigint {
  if (values.length === 0) throw new Error("no values");
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const rank = Math.max(1, Math.ceil(q * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1] as bigint;
}

/** Net funding of consecutive windows from F read at C, C − W, C − 2W, ... (newest first). */
export function windowDeltas(sumsNewestFirst: readonly bigint[]): bigint[] {
  const out: bigint[] = [];
  for (let i = 0; i + 1 < sumsNewestFirst.length; i++) {
    out.push((sumsNewestFirst[i] as bigint) - (sumsNewestFirst[i + 1] as bigint));
  }
  return out;
}

export type PriceStrike = { strikeE8: bigint } | { lowerE8: bigint; upperE8: bigint };

/** The strike (or band) a price rule gives for the spot price at the creation point. */
export function priceStrike(rule: StrikeRule, spotE8: bigint, direction: TouchDirection): PriceStrike {
  switch (rule.rule) {
    case "fixed":
      return { strikeE8: rule.value };
    case "spot-rounded":
      return { strikeE8: roundToStep(spotE8, rule.stepE8, "nearest") };
    case "spot-offset": {
      const up = direction === TouchDirection.AtOrAbove;
      const moved = (spotE8 * (10_000n + (up ? rule.offsetBps : -rule.offsetBps))) / 10_000n;
      return { strikeE8: roundToStep(moved, rule.stepE8, up ? "up" : "down") };
    }
    case "range-around-spot": {
      const half = rule.widthE8 / 2n;
      const lowerE8 = roundToStep(spotE8 - half, rule.stepE8, "nearest");
      return { lowerE8, upperE8: lowerE8 + rule.widthE8 };
    }
    default:
      throw new Error(`strike rule ${rule.rule} is not a price rule`);
  }
}

// ---------------------------------------------------------------- params and identity

export interface ParamInputs {
  /** Funding templates. */
  perpId?: bigint;
  scalingExp?: number;
  threshold?: bigint;
  /** Price templates. */
  feed?: Address;
  strike?: PriceStrike;
}

const ZERO_ID = `0x${"00".repeat(32)}` as Hex;

/** The market params for `period` of `spec`. */
export function buildParams(spec: SeriesSpec, period: Period, x: ParamInputs): Hex {
  const need = <T>(value: T | undefined, name: string): T => {
    if (value === undefined) throw new Error(`series "${spec.id}": ${name} is missing`);
    return value;
  };
  switch (spec.templateId) {
    case TemplateId.PerplFunding:
      return encodePerplFundingParams({
        perpId: need(x.perpId, "perpId"),
        startBlock: period.lock,
        endBlock: period.close,
        threshold: need(x.threshold, "threshold"),
        expectedScalingExp: need(x.scalingExp, "scalingExp"),
      });
    case TemplateId.PerplFundingSpike:
      return encodePerplFundingSpikeParams({
        perpId: need(x.perpId, "perpId"),
        startBlock: period.lock,
        endBlock: period.close,
        threshold: need(x.threshold, "threshold"),
        expectedScalingExp: need(x.scalingExp, "scalingExp"),
      });
    case TemplateId.PriceAtTime: {
      const s = need(x.strike, "strike");
      if (!("strikeE8" in s)) throw new Error("template 2 needs a strike");
      return encodePriceAtTimeParams({
        source: PriceSource.Chainlink,
        feed: need(x.feed, "feed"),
        pythId: ZERO_ID,
        strikeE8: s.strikeE8,
        lockTime: period.lock,
        closeTime: period.close,
      });
    }
    case TemplateId.ChainlinkTouch: {
      const s = need(x.strike, "strike");
      if (!("strikeE8" in s)) throw new Error("template 3 needs a strike");
      return encodeChainlinkTouchParams({
        feed: need(x.feed, "feed"),
        strikeE8: s.strikeE8,
        direction: spec.direction,
        lockTime: period.lock,
        startTime: period.lock,
        endTime: period.close,
      });
    }
    case TemplateId.PriceRange: {
      const s = need(x.strike, "strike");
      if (!("lowerE8" in s)) throw new Error("template 5 needs a band");
      return encodePriceRangeParams({
        source: PriceSource.Chainlink,
        feed: need(x.feed, "feed"),
        pythId: ZERO_ID,
        lowerE8: s.lowerE8,
        upperE8: s.upperE8,
        lockTime: period.lock,
        closeTime: period.close,
      });
    }
    default:
      throw new Error(`series "${spec.id}": template ${spec.templateId} has no schedule`);
  }
}

/**
 * What makes two markets the same period of a series, whatever their strike: template, asset (perp or
 * feed, and direction for touches) and window. A period that already has a market under this identity
 * is never created again, even after the strike rule changes.
 */
export function periodIdentity(templateId: number, params: Hex): string | undefined {
  try {
    switch (templateId) {
      case TemplateId.PerplFunding: {
        const p = decodePerplFundingParams(params);
        return `1:${p.perpId}:${p.startBlock}:${p.endBlock}`;
      }
      case TemplateId.PerplFundingSpike: {
        const p = decodePerplFundingSpikeParams(params);
        return `4:${p.perpId}:${p.startBlock}:${p.endBlock}`;
      }
      case TemplateId.PriceAtTime: {
        const p = decodePriceAtTimeParams(params);
        return `2:${p.source}:${p.feed.toLowerCase()}:${p.pythId}:${p.lockTime}:${p.closeTime}`;
      }
      case TemplateId.ChainlinkTouch: {
        const p = decodeChainlinkTouchParams(params);
        return `3:${p.feed.toLowerCase()}:${p.direction}:${p.startTime}:${p.endTime}`;
      }
      case TemplateId.PriceRange: {
        const p = decodePriceRangeParams(params);
        return `5:${p.source}:${p.feed.toLowerCase()}:${p.pythId}:${p.lockTime}:${p.closeTime}`;
      }
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
}

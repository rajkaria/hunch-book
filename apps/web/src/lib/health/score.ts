import { Phase, TemplateId } from "@hunch-book/shared";

// A market's health: one number from 0 to 100 for "how good is this market to trade or stake in right
// now", built from three parts anyone can check: liquidity (book spread and depth, or the pool's way to
// graduation), time (enough left to trade, or a settlement that is not overdue) and the source (how
// reliably the template's answer can be read on this network). Every part says why it scored what it
// did. Pure, so the market page, the cards and the data API agree. docs/HEALTH.md has the table.

export type HealthGrade = "good" | "fair" | "thin" | "finished";

export interface HealthPart {
  name: "liquidity" | "time" | "source";
  points: number;
  max: number;
  why: string;
}

export interface Health {
  /** 0 to 100, or null once the market has settled or voided. */
  score: number | null;
  grade: HealthGrade;
  parts: HealthPart[];
}

export interface HealthInput {
  phase: Phase;
  graduated: boolean;
  templateId: number;
  network: "monad-testnet" | "monad-mainnet";
  /** Best bid and ask in USDC per YES token (0 to 1); null for an empty side. */
  bid?: number | null;
  ask?: number | null;
  /** USDC resting within 5 cents of the mid on both sides together, when the full book was read. */
  depthUsdc?: number | null;
  pool: { yesUsdc: number; noUsdc: number; stakers: number };
  rule: { minPoolUsdc: number; minStakers: number };
  /** Unix seconds now, and when the market closes (estimated for block-clock markets). */
  now: number;
  closeAt: number;
  /** When staking ends, for a pool (defaults to the close). */
  lockAt?: number;
  /** When settlement can first happen, if later than close (touch NO after its challenge period). */
  settleFrom?: number;
}

export const HEALTH_WEIGHTS = { liquidity: 50, time: 20, source: 30 } as const;
/** A spread at or under this is full marks; at or over WIDE_SPREAD, none. In USDC per token. */
export const TIGHT_SPREAD = 0.02;
export const WIDE_SPREAD = 0.2;
/** Depth within 5 cents of the mid that earns full marks, in USDC. */
export const FULL_DEPTH_USDC = 500;

const HOUR = 3_600;
const DAY = 86_400;
const clamp01 = (x: number): number => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);
const round = (x: number): number => Math.round(x);
const usd = (x: number): string => (x >= 100 ? x.toFixed(0) : x.toFixed(2));

function duration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s >= 2 * DAY) return `${Math.round(s / DAY)} days`;
  if (s >= 2 * HOUR) return `${Math.round(s / HOUR)} hours`;
  if (s >= 120) return `${Math.round(s / 60)} minutes`;
  return `${s} seconds`;
}

function liquidity(i: HealthInput): HealthPart {
  const max = HEALTH_WEIGHTS.liquidity;
  if (i.graduated) {
    if (i.bid == null || i.ask == null) {
      return {
        name: "liquidity",
        points: 0,
        max,
        why: "One side of the book is empty, so there is no price to trade at.",
      };
    }
    const spread = Math.max(0, i.ask - i.bid);
    const spreadFactor = clamp01((WIDE_SPREAD - spread) / (WIDE_SPREAD - TIGHT_SPREAD));
    const spreadText = `${(spread * 100).toFixed(1)} cent spread`;
    if (i.depthUsdc == null) {
      return {
        name: "liquidity",
        points: round(max * spreadFactor),
        max,
        why: `${spreadText} (from the best bid and ask; depth is on the market page).`,
      };
    }
    const depthFactor = clamp01(i.depthUsdc / FULL_DEPTH_USDC);
    return {
      name: "liquidity",
      points: round(30 * spreadFactor + 20 * depthFactor),
      max,
      why: `${spreadText}, ${usd(i.depthUsdc)} USDC within 5 cents of the mid.`,
    };
  }
  const total = i.pool.yesUsdc + i.pool.noUsdc;
  const poolFactor = clamp01(total / Math.max(1, i.rule.minPoolUsdc));
  const stakerFactor = clamp01(i.pool.stakers / Math.max(1, i.rule.minStakers));
  const bothSides = i.pool.yesUsdc > 0 && i.pool.noUsdc > 0;
  return {
    name: "liquidity",
    points: round(25 * poolFactor + 15 * stakerFactor + (bothSides ? 10 : 0)),
    max,
    why: `Pool of ${usd(total)} of ${usd(i.rule.minPoolUsdc)} USDC and ${i.pool.stakers} of ${i.rule.minStakers} stakers to graduate${bothSides ? "" : "; one side has no stake yet"}.`,
  };
}

function time(i: HealthInput): HealthPart {
  const max = HEALTH_WEIGHTS.time;
  if (!Number.isFinite(i.now) || !Number.isFinite(i.closeAt)) {
    return { name: "time", points: round(max / 2), max, why: "The close time could not be read." };
  }
  if (i.phase === Phase.Closed || i.now >= i.closeAt) {
    const from = Math.max(i.closeAt, i.settleFrom ?? i.closeAt);
    if (i.now < from) {
      return {
        name: "time",
        points: max,
        max,
        why: `Closed; settlement opens in ${duration(from - i.now)}.`,
      };
    }
    const overdue = i.now - from;
    if (overdue <= HOUR) return { name: "time", points: max, max, why: "Closed; settlement is due now." };
    return {
      name: "time",
      points: round(max * clamp01(1 - (overdue - HOUR) / (23 * HOUR))),
      max,
      why: `Closed and waiting for settlement for ${duration(overdue)}. Anyone can settle it.`,
    };
  }
  // A pool takes stakes until its lock; a book trades until close.
  const staking = i.phase === Phase.Pool && i.lockAt !== undefined && Number.isFinite(i.lockAt);
  const until = staking ? (i.lockAt as number) : i.closeAt;
  const left = Math.max(0, until - i.now);
  const factor =
    left >= DAY ? 1 : left >= HOUR ? 0.5 + (0.5 * (left - HOUR)) / (DAY - HOUR) : 0.25 * (left / HOUR);
  const why = staking
    ? `Staking ends in ${duration(left)}.`
    : i.phase === Phase.PoolLocked
      ? `Staking has ended; closes in ${duration(left)}.`
      : left >= DAY
        ? `${duration(left)} until close.`
        : `Closes in ${duration(left)}.`;
  return { name: "time", points: round(max * factor), max, why };
}

function source(i: HealthInput): HealthPart {
  const max = HEALTH_WEIGHTS.source;
  const testnet = i.network === "monad-testnet";
  switch (i.templateId) {
    case TemplateId.PerplFunding:
    case TemplateId.PerplFundingSpike:
      return {
        name: "source",
        points: max,
        max,
        why: "Perpl's funding history is stored onchain at every block, so the answer is always readable.",
      };
    case TemplateId.PriceAtTime:
    case TemplateId.ChainlinkTouch:
    case TemplateId.PriceRange:
      return testnet
        ? {
            name: "source",
            points: 15,
            max,
            why: "Chainlink feeds on Monad testnet update about once a day, so a round may not bracket the time and the market can void.",
          }
        : {
            name: "source",
            points: max,
            max,
            why: "Chainlink rounds are stored onchain; the bracketing round settles it.",
          };
    case TemplateId.Snapshot:
      return {
        name: "source",
        points: 20,
        max,
        why: "A snapshot read right after close: the first snapshot taker picks the block inside a short window, with no challenge period.",
      };
    case TemplateId.Parlay:
      return {
        name: "source",
        points: 20,
        max,
        why: "Settles from its legs, so it is only as reliable as the weakest of them.",
      };
    default:
      return { name: "source", points: 0, max, why: "Unknown template." };
  }
}

/**
 * Seconds after close before a market can settle NO: touch (template 3) and spike (template 4) markets
 * wait out a 24-hour challenge period in which YES can still be proved. Zero for every other template.
 */
export function challengeSecondsFor(templateId: number): number {
  return templateId === TemplateId.ChainlinkTouch || templateId === TemplateId.PerplFundingSpike ? DAY : 0;
}

export function gradeOf(score: number): Exclude<HealthGrade, "finished"> {
  if (score >= 70) return "good";
  if (score >= 40) return "fair";
  return "thin";
}

export function marketHealth(i: HealthInput): Health {
  if (i.phase === Phase.Settled || i.phase === Phase.Voided) {
    return { score: null, grade: "finished", parts: [] };
  }
  const parts = [liquidity(i), time(i), source(i)];
  const score = parts.reduce((sum, p) => sum + p.points, 0);
  return { score, grade: gradeOf(score), parts };
}

/** Badge text: "Health 72". */
export function healthLabel(h: Health): string {
  return h.score === null ? "Finished" : `Health ${h.score}`;
}

import {
  type BracketResult,
  type ChainlinkTouchParams,
  chainlinkAggregatorAbi,
  chainlinkAggregatorRound,
  chainlinkLatestRoundAbi,
  chainlinkPhase,
  chainlinkRoundId,
  findBracketingRound,
  priceToE8,
  TouchDirection,
} from "@hunch-book/shared";
import type { Address } from "viem";
import type { HunchContext } from "../context.js";
import { multicall, ok } from "../multicall.js";

// Chainlink reads for settlement: rounds by id (batched), the feed's latest round, the round that
// brackets a time (templates 2 and 5), the decimals of the aggregator that wrote a round, and a scan
// of the rounds inside a touch market's window (template 3).

export interface Round {
  roundId: bigint;
  answer: bigint;
  /** Unix seconds. */
  updatedAt: bigint;
  answeredInRound: bigint;
}

type RoundData = readonly [bigint, bigint, bigint, bigint, bigint];

/** Reads rounds through the proxy. A round that reverts, echoes another id or is empty reads as null. */
export async function readRounds(
  ctx: HunchContext,
  feed: Address,
  ids: readonly bigint[],
  options: { blockNumber?: bigint } = {},
): Promise<(Round | null)[]> {
  const results = await multicall(
    ctx,
    ids.map((id) => ({
      address: feed,
      abi: chainlinkAggregatorAbi,
      functionName: "getRoundData",
      args: [id],
    })),
    options,
  );
  return results.map((r, i) => {
    const data = ok<RoundData>(r);
    if (!data) return null;
    const [roundId, answer, , updatedAt, answeredInRound] = data;
    if (roundId !== ids[i] || updatedAt === 0n) return null;
    return { roundId, answer, updatedAt, answeredInRound };
  });
}

export async function latestRound(
  ctx: HunchContext,
  feed: Address,
  options: { blockNumber?: bigint } = {},
): Promise<Round> {
  const [roundId, answer, , updatedAt, answeredInRound] = await ctx.publicClient.readContract({
    address: feed,
    abi: chainlinkLatestRoundAbi,
    functionName: "latestRoundData",
    ...(options.blockNumber === undefined ? {} : { blockNumber: options.blockNumber }),
  });
  return { roundId, answer, updatedAt, answeredInRound };
}

/** The round PriceAtTimeResolver accepts for time `target`: updatedAt(r) <= T < updatedAt(r + 1), same phase. */
export async function findBracket(ctx: HunchContext, feed: Address, target: bigint): Promise<BracketResult> {
  const latest = await latestRound(ctx, feed);
  return findBracketingRound({
    latest,
    target,
    read: (ids) => readRounds(ctx, feed, ids),
  });
}

/** Decimals of the aggregator that wrote `roundId` (a round keeps its own phase's decimals). */
export async function roundDecimals(ctx: HunchContext, feed: Address, roundId: bigint): Promise<number> {
  const aggregator = await ctx.publicClient.readContract({
    address: feed,
    abi: chainlinkAggregatorAbi,
    functionName: "phaseAggregators",
    args: [Number(chainlinkPhase(roundId))],
  });
  const decimals = await ctx.publicClient.readContract({
    address: aggregator,
    abi: chainlinkAggregatorAbi,
    functionName: "decimals",
  });
  return Number(decimals);
}

/** PriceScale.toE8Ceil: like `priceToE8`, but scaling a positive price down rounds up. */
export function priceToE8Ceil(value: bigint, exponent: number): bigint {
  const floor = priceToE8(value, exponent);
  const shift = exponent + 8;
  if (value <= 0n || shift >= 0) return floor;
  if (shift < -76) return 1n;
  return value % 10n ** BigInt(-shift) === 0n ? floor : floor + 1n;
}

/** True if a round's price touches the strike in the market's direction, rounded the resolver's way. */
export function touches(
  answer: bigint,
  decimals: number,
  p: Pick<ChainlinkTouchParams, "strikeE8" | "direction">,
): {
  touched: boolean;
  priceE8: bigint;
} {
  if (p.direction === TouchDirection.AtOrAbove) {
    const priceE8 = priceToE8(answer, -decimals);
    return { touched: priceE8 >= p.strikeE8, priceE8 };
  }
  const priceE8 = priceToE8Ceil(answer, -decimals);
  return { touched: priceE8 <= p.strikeE8, priceE8 };
}

export interface TouchRound extends Round {
  priceE8: bigint;
  decimals: number;
}

export interface TouchScan {
  /** Rounds in the window that prove YES, oldest first. */
  touches: TouchRound[];
  /** Rounds read inside the window. */
  scanned: number;
  /** The newest round read, if any. */
  lastRound: Round | null;
  /** False when part of the window could not be scanned (see `note`). */
  complete: boolean;
  note: string | null;
}

const SCAN_BATCH = 50n;

/**
 * Scans the rounds updated in [startTime, min(endTime, until)] for ones that prove a touch: answered in
 * themselves, positive, and at or past the strike in the market's direction (ChainlinkTouchResolver).
 * Stops at the first touch unless `all` is set.
 */
export async function scanTouches(
  ctx: HunchContext,
  p: ChainlinkTouchParams,
  options: { until: bigint; all?: boolean; maxRounds?: number },
): Promise<TouchScan> {
  const latest = await latestRound(ctx, p.feed);
  const last = options.until < p.endTime ? options.until : p.endTime;
  const empty: TouchScan = { touches: [], scanned: 0, lastRound: null, complete: true, note: null };
  if (latest.updatedAt < p.startTime) return { ...empty, lastRound: latest };

  // The first round updated at or after startTime is the one after the round that brackets startTime - 1.
  const bracket = await findBracketingRound({
    latest,
    target: p.startTime - 1n,
    read: (ids) => readRounds(ctx, p.feed, ids),
    maxStaleness: 2n ** 64n,
  });
  let complete = true;
  let note: string | null = null;
  let first: bigint;
  if (bracket.status === "found" || bracket.status === "stale") {
    first = chainlinkAggregatorRound(bracket.next.roundId);
  } else if (bracket.status === "phase-start") {
    // Every round of the current phase is at or after startTime. Phase 1 is the feed's first, so
    // nothing came before it; a later phase may have left rounds in the window that this scan skips.
    first = chainlinkAggregatorRound(bracket.first.roundId);
    if (chainlinkPhase(bracket.first.roundId) > 1n) {
      complete = false;
      note =
        "The feed moved to a new phase inside the window; rounds from the earlier phase were not scanned.";
    }
  } else {
    return { ...empty, lastRound: latest };
  }

  const phase = chainlinkPhase(latest.roundId);
  const top = chainlinkAggregatorRound(latest.roundId);
  const decimals = await roundDecimals(ctx, p.feed, latest.roundId);
  const touchesFound: TouchRound[] = [];
  let scanned = 0;
  let lastRound: Round | null = null;
  const max = BigInt(options.maxRounds ?? 20_000);
  for (let i = first; i <= top; i += SCAN_BATCH) {
    const ids: bigint[] = [];
    for (let j = i; j < i + SCAN_BATCH && j <= top; j++) ids.push(chainlinkRoundId(phase, j));
    const rounds = await readRounds(ctx, p.feed, ids);
    for (const round of rounds) {
      if (!round) continue;
      if (round.updatedAt > last) return { touches: touchesFound, scanned, lastRound, complete, note };
      if (round.updatedAt < p.startTime) continue;
      scanned++;
      lastRound = round;
      if (round.answeredInRound !== round.roundId || round.answer <= 0n) continue;
      const t = touches(round.answer, decimals, p);
      if (t.touched) {
        touchesFound.push({ ...round, priceE8: t.priceE8, decimals });
        if (!options.all) return { touches: touchesFound, scanned, lastRound, complete, note };
      }
    }
    if (BigInt(scanned) >= max) {
      return {
        touches: touchesFound,
        scanned,
        lastRound,
        complete: false,
        note: `Stopped after ${scanned} rounds.`,
      };
    }
  }
  return { touches: touchesFound, scanned, lastRound, complete, note };
}

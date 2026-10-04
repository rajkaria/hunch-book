import { type TouchDirection, touchesStrike, touchPriceE8 } from "@hunch-book/shared";
import { type Address, type PublicClient, parseAbi } from "viem";
import { aggregatorRoundOf, phaseOf } from "./chainlink.js";

// Hunts for the Chainlink round that proves a template 3 touch (docs/TEMPLATES.md, template 3).
//
// A proof is a round r, readable through the proxy, with answeredInRound == r, T1 <= updatedAt(r) <= T2,
// a positive answer, and a price that touches the strike in the market's direction (equal counts;
// scaled with the decimals of the phase aggregator that wrote it). The hunt reads every round of the
// window once, oldest first, and remembers how far it got, so each cycle only reads the rounds written
// since the last one. It also knows when it has read every round that can count (it has seen a round
// updated after T2): only then may NO be settled, because the keeper is the honest prover the template
// relies on.
//
// Round ids are (phaseId << 64) | aggregatorRound. Within a phase the aggregator rounds are numbered
// from 1 and updatedAt never decreases. A phase that started inside the window means earlier phases
// can hold rounds of the window too, so the hunt reads those as well.

export interface FullRound {
  roundId: bigint;
  answer: bigint;
  updatedAt: bigint;
  answeredInRound: bigint;
}

export interface TouchReader {
  latest(): Promise<FullRound>;
  /** The rounds, in order; undefined for a round the proxy cannot return (reverts, wrong id, never written). */
  rounds(roundIds: bigint[]): Promise<(FullRound | undefined)[]>;
  /** Decimals of the aggregator that wrote rounds of `phase` (`phaseAggregators(phase).decimals()`). */
  decimals(phase: bigint): Promise<number>;
}

export interface TouchQuestion {
  strikeE8: bigint;
  direction: TouchDirection;
  startTime: bigint;
  endTime: bigint;
}

/** Aggregator rounds of one phase still to read: `from` up to `to` (undefined: the latest round). */
export interface Segment {
  phase: bigint;
  from: bigint;
  to: bigint | undefined;
}

export interface TouchHunt {
  /** Segments still to read, oldest first. The last one is the current phase, open-ended. */
  segments: Segment[];
  /** Rounds read inside the window so far. */
  checked: number;
  /** Every round that can count has been read (a round after T2 was seen). */
  complete: boolean;
  found?: FullRound & { priceE8: bigint };
  /** The price closest to the strike so far (highest for direction 0, lowest for 1), in E8. */
  closest?: bigint;
}

export type TouchScan =
  | { status: "found"; round: FullRound & { priceE8: bigint }; hunt: TouchHunt; reads: number }
  | { status: "none"; reason: string; hunt: TouchHunt | undefined; reads: number };

const roundIdOf = (phase: bigint, aggregatorRound: bigint) => (phase << 64n) | aggregatorRound;

/** Rounds read per request while scanning. */
export const TOUCH_BATCH = 100;

type Count = { reads: number };

async function readOne(
  reader: TouchReader,
  phase: bigint,
  agg: bigint,
  count: Count,
): Promise<FullRound | undefined> {
  count.reads++;
  const [r] = await reader.rounds([roundIdOf(phase, agg)]);
  return r;
}

/** The first aggregator round in [1, last] of `phase` updated at or after `target` (last + 1 if none). */
async function firstAtOrAfter(
  reader: TouchReader,
  phase: bigint,
  last: FullRound,
  target: bigint,
  count: Count,
): Promise<bigint> {
  const lastAgg = aggregatorRoundOf(last.roundId);
  if (last.updatedAt < target) return lastAgg + 1n;
  // Gallop back from the last round until one is before the target (or round 1 is reached).
  let hi = lastAgg; // updated at or after the target
  let lo = 0n; // before the target; 0 means "none found"
  for (let step = 1n; lo === 0n && hi > 1n; step *= 2n) {
    const candidate = hi - step >= 1n ? hi - step : 1n;
    const r = await readOne(reader, phase, candidate, count);
    if (r && r.updatedAt < target) lo = candidate;
    else hi = candidate;
  }
  if (lo === 0n) return 1n;
  while (hi - lo > 1n) {
    const mid: bigint = lo + (hi - lo) / 2n;
    const r = await readOne(reader, phase, mid, count);
    if (r && r.updatedAt < target) lo = mid;
    else hi = mid;
  }
  return hi;
}

/** The last readable round of a phase, found by galloping forward from round 1. */
async function lastOfPhase(reader: TouchReader, phase: bigint, count: Count): Promise<FullRound | undefined> {
  let best = await readOne(reader, phase, 1n, count);
  if (!best) return undefined;
  let lo = 1n;
  let hi = 0n; // first unreadable; 0 means "not found yet"
  for (let step = 2n; hi === 0n && step < 1n << 63n; step *= 2n) {
    const r = await readOne(reader, phase, step, count);
    if (r) {
      lo = step;
      best = r;
    } else {
      hi = step;
    }
  }
  if (hi === 0n) return best;
  while (hi - lo > 1n) {
    const mid: bigint = lo + (hi - lo) / 2n;
    const r = await readOne(reader, phase, mid, count);
    if (r) {
      lo = mid;
      best = r;
    } else {
      hi = mid;
    }
  }
  return best;
}

/** Where the hunt starts: the first round at or after T1 in every phase that can hold rounds of the window. */
async function startHunt(
  reader: TouchReader,
  q: TouchQuestion,
  latest: FullRound,
  count: Count,
): Promise<TouchHunt> {
  const latestPhase = phaseOf(latest.roundId);
  const segments: Segment[] = [];
  const first = await firstAtOrAfter(reader, latestPhase, latest, q.startTime, count);
  segments.push({ phase: latestPhase, from: first, to: undefined });
  // The current phase started inside the window: earlier phases may hold rounds of it too.
  let startsInside = first === 1n;
  for (let phase = latestPhase - 1n; startsInside && phase >= 1n; phase--) {
    const last = await lastOfPhase(reader, phase, count);
    if (!last || last.updatedAt < q.startTime) break;
    const from = await firstAtOrAfter(reader, phase, last, q.startTime, count);
    segments.unshift({ phase, from, to: aggregatorRoundOf(last.roundId) });
    startsInside = from === 1n;
  }
  return { segments, checked: 0, complete: false };
}

function closer(current: bigint | undefined, price: bigint, direction: TouchDirection): bigint {
  if (current === undefined) return price;
  if (direction === 0) return price > current ? price : current;
  return price < current ? price : current;
}

function noTouchReason(hunt: TouchHunt): string {
  return `no round in the window touched the strike (${hunt.checked} rounds read, closest ${hunt.closest ?? "none"})`;
}

/**
 * Reads the rounds written since the last call (about `maxReads` reads at most) and returns the first
 * one that proves the touch. `previous` is the hunt the last call returned (undefined the first time);
 * it is never changed in place. `chainTime` is a recent block's timestamp: once it is past T2, no round
 * written later can count.
 */
export async function huntTouch(
  reader: TouchReader,
  q: TouchQuestion,
  previous: TouchHunt | undefined,
  chainTime: bigint,
  maxReads = 2_000,
): Promise<TouchScan> {
  if (previous?.found) return { status: "found", round: previous.found, hunt: previous, reads: 0 };
  if (previous?.complete) {
    return { status: "none", reason: noTouchReason(previous), hunt: previous, reads: 0 };
  }
  const count: Count = { reads: 1 };
  const latest = await reader.latest();
  if (!previous && latest.updatedAt < q.startTime) {
    return {
      status: "none",
      reason: `no round in the window yet: the feed's latest round was updated at ${latest.updatedAt}, the window opens at ${q.startTime}`,
      hunt: undefined,
      reads: count.reads,
    };
  }
  const hunt: TouchHunt = previous
    ? { ...previous, segments: previous.segments.map((s) => ({ ...s })) }
    : await startHunt(reader, q, latest, count);
  const latestPhase = phaseOf(latest.roundId);
  const latestAgg = aggregatorRoundOf(latest.roundId);

  // The feed moved to a new phase since the last call: the open segment ends at its phase's last
  // round, and every newer phase is read from its first round.
  const open = hunt.segments.at(-1);
  if (open && open.to === undefined && open.phase < latestPhase) {
    const last = await lastOfPhase(reader, open.phase, count);
    open.to = last ? aggregatorRoundOf(last.roundId) : open.from - 1n;
    for (let phase = open.phase + 1n; phase < latestPhase; phase++) {
      const lastOfOlder = await lastOfPhase(reader, phase, count);
      if (lastOfOlder) hunt.segments.push({ phase, from: 1n, to: aggregatorRoundOf(lastOfOlder.roundId) });
    }
    hunt.segments.push({ phase: latestPhase, from: 1n, to: undefined });
  }

  const decimals = new Map<bigint, number>();
  const decimalsOf = async (phase: bigint) => {
    let d = decimals.get(phase);
    if (d === undefined) {
      count.reads++;
      d = await reader.decimals(phase);
      decimals.set(phase, d);
    }
    return d;
  };

  while (hunt.segments.length > 0 && count.reads < maxReads) {
    const segment = hunt.segments[0] as Segment;
    const end = segment.to ?? latestAgg;
    if (segment.from > end) {
      if (segment.to === undefined) break; // the current phase has nothing new yet
      hunt.segments.shift();
      continue;
    }
    const size = BigInt(Math.max(1, Math.min(TOUCH_BATCH, maxReads - count.reads)));
    const last = segment.from + size - 1n < end ? segment.from + size - 1n : end;
    const ids: bigint[] = [];
    for (let agg = segment.from; agg <= last; agg++) ids.push(roundIdOf(segment.phase, agg));
    count.reads += ids.length;
    const rounds = await reader.rounds(ids);
    for (const [i, r] of rounds.entries()) {
      segment.from = aggregatorRoundOf(ids[i] as bigint) + 1n;
      if (!r) continue;
      if (r.updatedAt > q.endTime) {
        hunt.complete = true;
        hunt.segments = [];
        break;
      }
      if (r.updatedAt < q.startTime) continue;
      hunt.checked++;
      if (r.answeredInRound !== r.roundId || r.answer <= 0n) continue;
      const d = await decimalsOf(segment.phase);
      const priceE8 = touchPriceE8(r.answer, d, q.direction);
      hunt.closest = closer(hunt.closest, priceE8, q.direction);
      if (touchesStrike(r.answer, d, q.strikeE8, q.direction)) {
        hunt.found = { ...r, priceE8 };
        return { status: "found", round: hunt.found, hunt, reads: count.reads };
      }
    }
  }
  // Caught up with the latest round after T2: a round written from now on is updated after T2, so
  // every round that can count has been read.
  const head = hunt.segments[0];
  const caughtUp =
    hunt.segments.length === 1 &&
    head !== undefined &&
    head.to === undefined &&
    head.phase === latestPhase &&
    head.from > latestAgg;
  if (!hunt.complete && caughtUp && chainTime > q.endTime) {
    hunt.complete = true;
    hunt.segments = [];
  }
  if (hunt.complete) return { status: "none", reason: noTouchReason(hunt), hunt, reads: count.reads };
  return {
    status: "none",
    reason: `no touch in the ${hunt.checked} rounds of the window read so far (closest ${hunt.closest ?? "none"}, strike ${q.strikeE8})`,
    hunt,
    reads: count.reads,
  };
}

const touchFeedAbi = parseAbi([
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function getRoundData(uint80 _roundId) view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function phaseAggregators(uint16 phaseId) view returns (address)",
  "function decimals() view returns (uint8)",
]);

/** A TouchReader over a Chainlink proxy onchain: batched getRoundData through Multicall3. */
export function chainlinkTouchReader(client: PublicClient, feed: Address): TouchReader {
  return {
    async latest() {
      const [roundId, answer, , updatedAt, answeredInRound] = await client.readContract({
        address: feed,
        abi: touchFeedAbi,
        functionName: "latestRoundData",
      });
      return { roundId, answer, updatedAt, answeredInRound };
    },
    async rounds(ids) {
      if (ids.length === 0) return [];
      const results = await client.multicall({
        allowFailure: true,
        batchSize: 16_384,
        contracts: ids.map((id) => ({
          address: feed,
          abi: touchFeedAbi,
          functionName: "getRoundData" as const,
          args: [id] as const,
        })),
      });
      return results.map((r, i) => {
        if (r.status !== "success") return undefined;
        const [roundId, answer, , updatedAt, answeredInRound] = r.result;
        // The resolver accepts only a round the proxy echoes; updatedAt 0 is a round never written.
        if (roundId !== ids[i] || updatedAt === 0n) return undefined;
        return { roundId, answer, updatedAt, answeredInRound };
      });
    },
    async decimals(phase) {
      const aggregator = await client.readContract({
        address: feed,
        abi: touchFeedAbi,
        functionName: "phaseAggregators",
        args: [Number(phase)],
      });
      return Number(
        await client.readContract({ address: aggregator, abi: touchFeedAbi, functionName: "decimals" }),
      );
    },
  };
}

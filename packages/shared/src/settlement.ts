import { type Address, decodeAbiParameters, encodeAbiParameters, type Hex, keccak256 } from "viem";
import { Outcome } from "./types.js";

// What the resolvers read and commit to, rebuilt in TypeScript so anyone can check a settlement and
// anyone can settle with the right evidence: the Chainlink round that brackets the close, the
// evidence bytes each template takes (contracts/src/interfaces/ITemplates.sol), and the evidence hash
// each resolver stores (contracts/src/resolvers/*.sol).

// ---------------------------------------------------------------- Chainlink

/** A proxy round id is (phaseId << 64) | aggregatorRoundId. */
export const CHAINLINK_PHASE_SHIFT = 64n;
export const CHAINLINK_ROUND_MASK = (1n << 64n) - 1n;

/** PriceAtTimeResolver.MAX_STALENESS: the accepted round must be at most this old at the close. */
export const CHAINLINK_MAX_STALENESS = 3_600n;

/** AggregatorV3Interface.latestRoundData, which the resolver interface leaves out. */
export const chainlinkLatestRoundAbi = [
  {
    type: "function",
    name: "latestRoundData",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
  },
] as const;

export interface ChainlinkRound {
  roundId: bigint;
  answer: bigint;
  /** Unix seconds. */
  updatedAt: bigint;
}

export const chainlinkPhase = (roundId: bigint): bigint => roundId >> CHAINLINK_PHASE_SHIFT;
export const chainlinkAggregatorRound = (roundId: bigint): bigint => roundId & CHAINLINK_ROUND_MASK;
export const chainlinkRoundId = (phase: bigint, aggregatorRound: bigint): bigint =>
  (phase << CHAINLINK_PHASE_SHIFT) | aggregatorRound;

/**
 * Reads several rounds at once (getRoundData). Return null for a round that does not exist: the call
 * reverts, returns updatedAt == 0, or echoes a different round id.
 */
export type RoundReader = (roundIds: readonly bigint[]) => Promise<(ChainlinkRound | null)[]>;

export type BracketResult =
  /** Round `round` brackets the target: updatedAt(round) <= T < updatedAt(next), same phase, fresh enough. */
  | { status: "found"; round: ChainlinkRound; next: ChainlinkRound; staleSeconds: bigint }
  /** The bracketing round is more than an hour older than T: the resolver refuses, the market voids. */
  | { status: "stale"; round: ChainlinkRound; next: ChainlinkRound; staleSeconds: bigint }
  /** No round after T yet: settlement waits. */
  | { status: "waiting"; latest: ChainlinkRound }
  /** The latest phase starts after T, so no round in it brackets T: the market voids at its deadline. */
  | { status: "phase-start"; first: ChainlinkRound };

/** Probes per batch while narrowing down: each batch cuts the range by about this factor. */
const PROBES = 16n;
/** Backward steps (1, 2, 4, ... rounds) read per batch while looking for a round at or before T. */
const GALLOP_BATCH = 6;

/**
 * Finds the one round the resolver accepts for target time `target`: rounds r and r + 1 in the same
 * phase with updatedAt(r) <= T < updatedAt(r + 1). Starts from the latest round, steps back in powers of
 * two until a round at or before T, then narrows down with batched probes. Within one phase updatedAt
 * never decreases, so the search is exact.
 */
export async function findBracketingRound(args: {
  latest: ChainlinkRound;
  target: bigint;
  read: RoundReader;
  maxStaleness?: bigint;
}): Promise<BracketResult> {
  const { latest, target, read } = args;
  const maxStaleness = args.maxStaleness ?? CHAINLINK_MAX_STALENESS;
  if (latest.updatedAt <= target) return { status: "waiting", latest };

  const phase = chainlinkPhase(latest.roundId);
  const top = chainlinkAggregatorRound(latest.roundId);
  const known = new Map<bigint, ChainlinkRound>([[top, latest]]);

  const fetch = async (indices: bigint[]): Promise<void> => {
    const wanted = indices.filter((i) => !known.has(i));
    if (wanted.length === 0) return;
    const rounds = await read(wanted.map((i) => chainlinkRoundId(phase, i)));
    wanted.forEach((i, n) => {
      const round = rounds[n];
      if (!round || round.updatedAt === 0n) {
        throw new Error(`Chainlink round ${chainlinkRoundId(phase, i).toString()} could not be read`);
      }
      known.set(i, round);
    });
  };
  const at = (i: bigint): ChainlinkRound => known.get(i) as ChainlinkRound;

  // Step back 1, 2, 4, ... rounds, a few steps per batch, until a round at or before T (or round 1).
  const steps: bigint[] = [];
  for (let step = 1n; ; step *= 2n) {
    const i = top - step;
    if (i <= 1n) {
      if (top > 1n) steps.push(1n);
      break;
    }
    steps.push(i);
  }
  let hi = top;
  let lo: bigint | null = null;
  for (let b = 0; b < steps.length && lo === null; b += GALLOP_BATCH) {
    const batch = steps.slice(b, b + GALLOP_BATCH);
    await fetch(batch);
    for (const i of batch) {
      if (at(i).updatedAt <= target) {
        lo = i;
        break;
      }
      hi = i;
    }
  }
  if (lo === null) return { status: "phase-start", first: at(hi) };

  // Narrow (lo, hi) with batched probes: updatedAt(lo) <= T < updatedAt(hi).
  while (hi - lo > 1n) {
    const gap = hi - lo;
    const probes: bigint[] = [];
    const count = gap - 1n < PROBES ? gap - 1n : PROBES;
    for (let n = 1n; n <= count; n++) probes.push(lo + (gap * n) / (count + 1n));
    const low: bigint = lo;
    const unique = [...new Set(probes)].filter((i) => i > low && i < hi);
    await fetch(unique);
    // Ascending probes: every one at or before T moves `lo` up; the first one after T is the new `hi`.
    for (const i of unique) {
      if (at(i).updatedAt <= target) {
        lo = i;
      } else {
        hi = i;
        break;
      }
    }
  }
  const round = at(lo);
  const next = at(hi);
  const staleSeconds = target - round.updatedAt;
  return staleSeconds > maxStaleness
    ? { status: "stale", round, next, staleSeconds }
    : { status: "found", round, next, staleSeconds };
}

/** S-2 Chainlink evidence: abi.encode(uint80 roundId). */
export function chainlinkEvidence(roundId: bigint): Hex {
  return encodeAbiParameters([{ type: "uint80" }], [roundId]);
}

export function decodeChainlinkEvidence(evidence: Hex): bigint {
  const [roundId] = decodeAbiParameters([{ type: "uint80" }], evidence);
  return roundId;
}

/**
 * PriceAtTimeResolver's Chainlink evidence hash: keccak256(abi.encode(uint8 0, address feed, uint80 r,
 * int256 answer, uint256 updatedAt(r), uint256 updatedAt(r + 1), uint256 T)).
 */
export function chainlinkEvidenceHash(a: {
  feed: Address;
  roundId: bigint;
  answer: bigint;
  updatedAt: bigint;
  nextUpdatedAt: bigint;
  target: bigint;
}): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "uint8" },
        { type: "address" },
        { type: "uint80" },
        { type: "int256" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
      ],
      [0, a.feed, a.roundId, a.answer, a.updatedAt, a.nextUpdatedAt, a.target],
    ),
  );
}

/**
 * PriceScale.toE8: `value × 10^exponent` in 8 decimals. Scaling down truncates toward zero, as Solidity's
 * signed division does.
 */
export function priceToE8(value: bigint, exponent: number): bigint {
  const shift = exponent + 8;
  if (shift >= 0) return value * 10n ** BigInt(shift);
  if (shift < -76) return 0n;
  return value / 10n ** BigInt(-shift);
}

/** YES if the round's price is at or above the strike (both in 8 decimals once scaled). */
export function chainlinkOutcome(answer: bigint, decimals: number, strikeE8: bigint): Outcome {
  return priceToE8(answer, -decimals) >= strikeE8 ? Outcome.Yes : Outcome.No;
}

// ---------------------------------------------------------------- Perpl

/** S-1 evidence is empty: the resolver reads Perpl itself. */
export const PERPL_EVIDENCE: Hex = "0x";

/**
 * PerplFundingResolver's evidence hash: keccak256(abi.encode(address exchange, uint256 perpId,
 * uint64 startBlock, uint64 endBlock, int48 F(start), int48 F(end), uint256 eventBlock(start),
 * uint256 eventBlock(end))).
 */
export function perplEvidenceHash(a: {
  exchange: Address;
  perpId: bigint;
  startBlock: bigint;
  endBlock: bigint;
  sumStart: bigint;
  sumEnd: bigint;
  eventStart: bigint;
  eventEnd: bigint;
}): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "uint256" },
        { type: "uint64" },
        { type: "uint64" },
        { type: "int48" },
        { type: "int48" },
        { type: "uint256" },
        { type: "uint256" },
      ],
      [
        a.exchange,
        a.perpId,
        a.startBlock,
        a.endBlock,
        Number(a.sumStart),
        Number(a.sumEnd),
        a.eventStart,
        a.eventEnd,
      ],
    ),
  );
}

/** YES if ΔF = F(end) − F(start) is above the threshold; equal is NO. */
export function perplOutcome(sumStart: bigint, sumEnd: bigint, threshold: bigint): Outcome {
  return sumEnd - sumStart > threshold ? Outcome.Yes : Outcome.No;
}

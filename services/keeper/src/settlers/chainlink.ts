import type { Address, PublicClient } from "viem";
import { chainlinkFeedAbi } from "../abis.js";

// Finds the Chainlink round that brackets a time T: the round r with updatedAt(r) <= T < updatedAt(r+1),
// both in the same phase. That is the only round PriceAtTimeResolver accepts (docs/PROTOCOL.md §6.2).
//
// A proxy's round id is (phaseId << 64) | aggregatorRoundId. Within a phase the aggregator round ids are
// consecutive from 1 and updatedAt never decreases, so the search walks back from latestRoundData in
// doubling steps until it passes T, then halves the gap: about 2·log2(n) reads for a T n rounds back.

export interface Round {
  roundId: bigint;
  answer: bigint;
  updatedAt: bigint;
}

export interface RoundReader {
  latest(): Promise<Round>;
  /** The round, or undefined when the feed has no such round (reverts, or updatedAt is 0). */
  round(roundId: bigint): Promise<Round | undefined>;
}

export type BracketResult =
  /** Settle with `round.roundId`. */
  | { status: "found"; round: Round; next: Round; reads: number }
  /** Not yet: no round after T exists. Try again later. */
  | { status: "wait"; reason: string; reads: number }
  /** Never through Chainlink: the resolver would refuse every round. The market voids at its deadline. */
  | { status: "unsettleable"; reason: string; round?: Round; reads: number };

const AGGREGATOR_MASK = (1n << 64n) - 1n;
/** The resolver's staleness rule: the round must be updated at most one hour before T. */
export const MAX_STALENESS_SECONDS = 3_600n;

export const phaseOf = (roundId: bigint) => roundId >> 64n;
export const aggregatorRoundOf = (roundId: bigint) => roundId & AGGREGATOR_MASK;
const roundIdOf = (phase: bigint, aggregatorRound: bigint) => (phase << 64n) | aggregatorRound;

export async function findBracketingRound(
  reader: RoundReader,
  target: bigint,
  maxStaleness: bigint = MAX_STALENESS_SECONDS,
): Promise<BracketResult> {
  let reads = 1;
  const latest = await reader.latest();
  if (latest.updatedAt <= target) {
    return {
      status: "wait",
      reason: `no Chainlink round after T yet (latest round ${latest.roundId} was updated at ${latest.updatedAt}, T is ${target})`,
      reads,
    };
  }
  const phase = phaseOf(latest.roundId);
  const cache = new Map<bigint, Round>([[aggregatorRoundOf(latest.roundId), latest]]);
  const read = async (aggregatorRound: bigint): Promise<Round | undefined> => {
    const cached = cache.get(aggregatorRound);
    if (cached) return cached;
    reads++;
    const r = await reader.round(roundIdOf(phase, aggregatorRound));
    if (r) cache.set(aggregatorRound, r);
    return r;
  };

  // Gallop back: `hi` is a round updated after T; find a `lo` updated at or before T.
  let hi = aggregatorRoundOf(latest.roundId);
  let lo = 0n; // 0 is never a round: "not found yet"
  for (let step = 1n; lo === 0n; step *= 2n) {
    if (hi <= 1n) {
      return {
        status: "unsettleable",
        reason: `T (${target}) is before the first round of the feed's current phase ${phase}; the resolver needs both rounds in one phase`,
        reads,
      };
    }
    const candidate = hi - step >= 1n ? hi - step : 1n;
    const r = await read(candidate);
    if (!r) {
      return {
        status: "unsettleable",
        reason: `round ${roundIdOf(phase, candidate)} cannot be read from the feed`,
        reads,
      };
    }
    if (r.updatedAt <= target) lo = candidate;
    else hi = candidate;
  }

  // Halve the gap: updatedAt(lo) <= T < updatedAt(hi).
  while (hi - lo > 1n) {
    const mid: bigint = lo + (hi - lo) / 2n;
    const r = await read(mid);
    if (!r) {
      return {
        status: "unsettleable",
        reason: `round ${roundIdOf(phase, mid)} cannot be read from the feed`,
        reads,
      };
    }
    if (r.updatedAt <= target) lo = mid;
    else hi = mid;
  }

  const round = cache.get(lo) as Round;
  const next = cache.get(hi) as Round;
  if (target - round.updatedAt > maxStaleness) {
    return {
      status: "unsettleable",
      reason: `the last round before T (${round.roundId}) was updated ${target - round.updatedAt} s before T, more than the resolver's ${maxStaleness} s limit`,
      round,
      reads,
    };
  }
  if (round.answer <= 0n) {
    return {
      status: "unsettleable",
      reason: `round ${round.roundId} has a price of ${round.answer}`,
      round,
      reads,
    };
  }
  return { status: "found", round, next, reads };
}

/** Reads rounds from a Chainlink aggregator proxy onchain. */
export function chainlinkReader(client: PublicClient, feed: Address): RoundReader {
  return {
    async latest() {
      const [roundId, answer, , updatedAt] = await client.readContract({
        address: feed,
        abi: chainlinkFeedAbi,
        functionName: "latestRoundData",
      });
      return { roundId, answer, updatedAt };
    },
    async round(id) {
      try {
        const [roundId, answer, , updatedAt] = await client.readContract({
          address: feed,
          abi: chainlinkFeedAbi,
          functionName: "getRoundData",
          args: [id],
        });
        // A proxy echoes the full id; anything else is not the round asked for (as the resolver checks).
        if (roundId !== id || updatedAt === 0n) return undefined;
        return { roundId, answer, updatedAt };
      } catch {
        return undefined;
      }
    },
  };
}

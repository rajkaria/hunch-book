import { readFileSync } from "node:fs";
import type { Round, RoundReader } from "../src/settlers/chainlink.js";

// The Chainlink fixtures are the maker's (services/maker/test/fixtures), recorded from Monad mainnet by
// its capture script: 301 consecutive rounds of one phase per feed. They are never edited by hand.

export type Pair = "btc-usd" | "eth-usd" | "mon-usd";

export interface ChainlinkFixture {
  source: { block: number; blockTimestamp: number; contract: string };
  decimals: number;
  rounds: { roundId: string; answer: string; updatedAt: number }[];
}

export function chainlinkFixture(pair: Pair): ChainlinkFixture {
  return JSON.parse(
    readFileSync(new URL(`../../maker/test/fixtures/chainlink-${pair}.json`, import.meta.url), "utf8"),
  );
}

export function fixtureRounds(pair: Pair): Round[] {
  return chainlinkFixture(pair).rounds.map((r) => ({
    roundId: BigInt(r.roundId),
    answer: BigInt(r.answer),
    updatedAt: BigInt(r.updatedAt),
  }));
}

/**
 * A RoundReader over a list of rounds (the last is the latest), counting reads.
 *
 * A real feed keeps every round of its phase, back to round 1; a fixture only recorded the last 301.
 * With `olderRounds`, rounds of the same phase before the first recorded one exist too, one minute
 * apart and all older than it, so a search may step past the recorded start the way it can onchain.
 * Without it, those rounds cannot be read (a feed whose history is gone).
 */
export function arrayReader(
  rounds: Round[],
  opts: { olderRounds?: boolean } = {},
): RoundReader & { reads: number } {
  const byId = new Map(rounds.map((r) => [r.roundId, r]));
  const first = rounds[0] as Round;
  const reader = {
    reads: 0,
    async latest() {
      reader.reads++;
      return rounds.at(-1) as Round;
    },
    async round(id: bigint) {
      reader.reads++;
      const known = byId.get(id);
      if (known || !opts.olderRounds) return known;
      const samePhase = id >> 64n === first.roundId >> 64n;
      const back = first.roundId - id;
      if (!samePhase || back <= 0n || (id & ((1n << 64n) - 1n)) === 0n) return undefined;
      return { roundId: id, answer: first.answer, updatedAt: first.updatedAt - back * 60n };
    },
  };
  return reader;
}

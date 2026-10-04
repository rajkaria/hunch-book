import {
  decodePerplFundingSpikeParams,
  EMPTY_EVIDENCE,
  encodeFundingEventEvidence,
  perplExchangeAbi,
} from "@hunch-book/shared";
import { type Address, getAddress, type PublicClient, parseAbi } from "viem";
import { type FundingReader, huntSpike, perplFundingReader, type SpikeHunt } from "./fundingEvents.js";
import type { Prover, SettleDeps, SettleMarket, Settler } from "./index.js";

// Template 4, Perpl funding spike (docs/TEMPLATES.md). YES is proved by pointing at the funding event
// whose single-interval increment is above the threshold: the prover checks every event of
// (startBlock, endBlock] as it becomes final and sends `proveYes(abi.encode(uint64 e))` for the first
// spike. NO needs no proof: once block.number > endBlock + challengeBlocks, `settle(0x)` settles NO (if
// Perpl is still the source the market was created on and funding was live at the end of the window).
// The keeper only sends that NO after it has checked every event of the window and none spiked.

const spikeResolverAbi = parseAbi([
  "function exchange() view returns (address)",
  "function challengeBlocks() view returns (uint256)",
]);

export interface SpikeSettlerOptions {
  /** Builds the funding reader for a perp (tests pass one over recorded events). */
  reader?: (client: PublicClient, exchange: Address, perpId: bigint) => FundingReader;
  /** How long a read of the funding interval is reused, in milliseconds. */
  intervalTtlMs?: number;
}

interface ResolverInfo {
  exchange: Address;
  challengeBlocks: bigint;
}

export function fundingSpikeSettler(options: SpikeSettlerOptions = {}): Settler {
  const makeReader = options.reader ?? perplFundingReader;
  const intervalTtlMs = options.intervalTtlMs ?? 3_600_000;
  const hunts = new Map<Address, SpikeHunt>();
  const resolvers = new Map<Address, ResolverInfo>();
  const intervals = new Map<Address, { at: number; interval: bigint }>();

  async function resolverInfo(market: SettleMarket, deps: SettleDeps): Promise<ResolverInfo> {
    let info = resolvers.get(market.resolver);
    if (!info) {
      const [exchange, challengeBlocks] = await deps.client.multicall({
        allowFailure: false,
        contracts: [
          { address: market.resolver, abi: spikeResolverAbi, functionName: "exchange" },
          { address: market.resolver, abi: spikeResolverAbi, functionName: "challengeBlocks" },
        ],
      });
      info = { exchange: getAddress(exchange), challengeBlocks };
      resolvers.set(market.resolver, info);
    }
    return info;
  }

  async function fundingInterval(exchange: Address, deps: SettleDeps): Promise<bigint> {
    const cached = intervals.get(exchange);
    if (cached && Date.now() - cached.at < intervalTtlMs) return cached.interval;
    const interval = await deps.client.readContract({
      address: exchange,
      abi: perplExchangeAbi,
      functionName: "getFundingInterval",
    });
    if (interval === 0n) throw new Error(`Perpl's funding interval reads 0 on ${exchange}`);
    intervals.set(exchange, { at: Date.now(), interval });
    return interval;
  }

  async function scan(market: SettleMarket, block: bigint, deps: SettleDeps) {
    const p = decodePerplFundingSpikeParams(market.params);
    const info = await resolverInfo(market, deps);
    const interval = await fundingInterval(info.exchange, deps);
    const result = await huntSpike(
      makeReader(deps.client, info.exchange, p.perpId),
      { startBlock: p.startBlock, endBlock: p.endBlock, threshold: p.threshold },
      interval,
      hunts.get(market.address),
      block,
    );
    hunts.set(market.address, result.hunt);
    return { p, info, interval, result };
  }

  const challengeEnd = (market: { resolver: Address }, endBlock: bigint) => {
    const info = resolvers.get(market.resolver);
    return info ? endBlock + info.challengeBlocks : undefined;
  };

  const prover: Prover = {
    waitReason(market, now) {
      const p = decodePerplFundingSpikeParams(market.params);
      // An event counts only after startBlock, and only once its block has passed.
      if (now.block <= p.startBlock + 1n)
        return `waiting for the first funding event after block ${p.startBlock}`;
      const hunt = hunts.get(market.address);
      if (hunt?.complete && !hunt.found) {
        const end = challengeEnd(market, p.endBlock);
        return `no funding event in the window was above ${p.threshold} (${hunt.checked} events checked): NO settles after block ${end ?? `${p.endBlock} + the challenge period`}`;
      }
      return null;
    },

    async findProof(market, now, deps) {
      const { p, info, interval, result } = await scan(market, now.block, deps);
      if (result.status === "none") return { status: "none", reason: result.reason };
      return {
        status: "found",
        proof: encodeFundingEventEvidence(result.event.block),
        detail: {
          exchange: info.exchange,
          perpId: p.perpId,
          eventBlock: result.event.block,
          previousEventBlock: result.event.previousBlock,
          increment: result.event.increment,
          threshold: p.threshold,
          interval,
          eventsChecked: result.hunt.checked,
          reads: result.reads,
        },
      };
    },
  };

  return {
    name: "perpl-funding-spike",
    prover,

    waitReason(market, now) {
      const p = decodePerplFundingSpikeParams(market.params);
      const end = challengeEnd(market, p.endBlock);
      if (end === undefined) return now.block > p.endBlock ? null : `waiting for block > ${p.endBlock}`;
      return now.block > end
        ? null
        : `waiting for block > ${end}, the end of the challenge period, before NO`;
    },

    async evidence(market, now, deps) {
      const p = decodePerplFundingSpikeParams(market.params);
      const info = await resolverInfo(market, deps);
      const end = p.endBlock + info.challengeBlocks;
      if (now.block <= end) {
        return { status: "wait", reason: `waiting for block > ${end}, the end of the challenge period` };
      }
      // Finish the hunt first: NO only after every event of the window is checked.
      let { result } = await scan(market, now.block, deps);
      for (let i = 0; result.status === "none" && !result.hunt.complete && i < 20; i++) {
        ({ result } = await scan(market, now.block, deps));
      }
      if (result.status === "found") {
        return {
          status: "ready",
          evidence: encodeFundingEventEvidence(result.event.block),
          value: 0n,
          detail: { answer: "yes", eventBlock: result.event.block, increment: result.event.increment },
        };
      }
      if (!result.hunt.complete) {
        return {
          status: "wait",
          reason: `NO waits until every event of the window is checked: ${result.reason}`,
        };
      }
      return {
        status: "ready",
        evidence: EMPTY_EVIDENCE,
        value: 0n,
        detail: {
          answer: "no",
          perpId: p.perpId,
          threshold: p.threshold,
          eventsChecked: result.hunt.checked,
          largestIncrement: result.hunt.largest,
          challengeEndBlock: end,
        },
      };
    },
  };
}

import type { Address, PublicClient } from "viem";
import { chainlinkAggregatorAbi, perplExchangeAbi } from "../abis.js";
import type { FundingSample } from "./perplFunding.js";

// Onchain reads behind the pricing models. Shared by the bot and by scripts/capture-fixtures.ts, so the
// test fixtures come from exactly the reads the bot makes.

const CHUNK = 100;

async function chunked<T, R>(items: T[], run: (chunk: T[]) => Promise<R[]>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += CHUNK) out.push(...(await run(items.slice(i, i + CHUNK))));
  return out;
}

export interface PerpInfo {
  symbol: string;
  priceDecimals: number;
  fundingSumScalingExp: number;
  fundingStartBlock: number;
}

export async function readPerpInfo(
  client: PublicClient,
  exchange: Address,
  perpId: bigint,
): Promise<PerpInfo> {
  const info = await client.readContract({
    address: exchange,
    abi: perplExchangeAbi,
    functionName: "getPerpetualInfoV2",
    args: [perpId],
  });
  return {
    symbol: info.symbol,
    priceDecimals: Number(info.priceDecimals),
    fundingSumScalingExp: Number(info.fundingSumScalingExp),
    fundingStartBlock: Number(info.fundingStartBlock),
  };
}

/** getFundingSumAtBlock at each block. History lives in Perpl's storage, so this needs no archive node. */
export async function readFundingSamples(
  client: PublicClient,
  exchange: Address,
  perpId: bigint,
  blocks: number[],
): Promise<FundingSample[]> {
  return chunked(blocks, async (chunk) => {
    const results = await client.multicall({
      allowFailure: false,
      contracts: chunk.map((block) => ({
        address: exchange,
        abi: perplExchangeAbi,
        functionName: "getFundingSumAtBlock" as const,
        args: [perpId, BigInt(block)] as const,
      })),
    });
    return results.map(([sum, eventBlock], i) => ({
      block: chunk[i] as number,
      sum: Number(sum),
      eventBlock: Number(eventBlock),
    }));
  });
}

export interface FundingHistory {
  interval: number;
  /** The last funding event at or before `atBlock`. */
  lastEvent: number;
  /** F at lastEvent − k·interval for k = count … 0, oldest first. */
  samples: FundingSample[];
}

/** The last `count` intervals of funding, read at Perpl's grid blocks ending at the latest event. */
export async function readFundingHistory(
  client: PublicClient,
  exchange: Address,
  perpId: bigint,
  atBlock: number,
  count: number,
): Promise<FundingHistory> {
  const [interval, latest] = await Promise.all([
    client.readContract({ address: exchange, abi: perplExchangeAbi, functionName: "getFundingInterval" }),
    client.readContract({
      address: exchange,
      abi: perplExchangeAbi,
      functionName: "getFundingSumAtBlock",
      args: [perpId, BigInt(atBlock)],
    }),
  ]);
  const step = Number(interval);
  const lastEvent = Number(latest[1]);
  if (lastEvent === 0) throw new Error(`perp ${perpId} has no funding events yet`);
  const blocks: number[] = [];
  for (let k = count; k >= 0; k--) {
    const block = lastEvent - k * step;
    if (block > 0) blocks.push(block);
  }
  return { interval: step, lastEvent, samples: await readFundingSamples(client, exchange, perpId, blocks) };
}

export interface ChainlinkRound {
  roundId: bigint;
  answer: bigint;
  updatedAt: number;
}

export interface ChainlinkHistory {
  decimals: number;
  description: string;
  /** Oldest first, all in the latest round's phase. */
  rounds: ChainlinkRound[];
}

const AGGREGATOR_ROUND_MASK = (1n << 64n) - 1n;

/** The latest round plus up to `count` earlier rounds of the same phase, walked back with getRoundData. */
export async function readChainlinkHistory(
  client: PublicClient,
  feed: Address,
  count: number,
): Promise<ChainlinkHistory> {
  const [decimals, description, latest] = await Promise.all([
    client.readContract({ address: feed, abi: chainlinkAggregatorAbi, functionName: "decimals" }),
    client.readContract({ address: feed, abi: chainlinkAggregatorAbi, functionName: "description" }),
    client.readContract({ address: feed, abi: chainlinkAggregatorAbi, functionName: "latestRoundData" }),
  ]);
  const latestId = latest[0];
  const phase = latestId >> 64n;
  const aggregatorRound = latestId & AGGREGATOR_ROUND_MASK;
  const ids: bigint[] = [];
  for (let k = BigInt(count); k >= 1n; k--) {
    if (aggregatorRound - k >= 1n) ids.push((phase << 64n) | (aggregatorRound - k));
  }
  const earlier = await chunked(ids, async (chunk) => {
    const results = await client.multicall({
      allowFailure: true,
      contracts: chunk.map((id) => ({
        address: feed,
        abi: chainlinkAggregatorAbi,
        functionName: "getRoundData" as const,
        args: [id] as const,
      })),
    });
    return results.flatMap((r, i) =>
      r.status === "success" && r.result[3] > 0n
        ? [{ roundId: chunk[i] as bigint, answer: r.result[1], updatedAt: Number(r.result[3]) }]
        : [],
    );
  });
  return {
    decimals: Number(decimals),
    description,
    rounds: [...earlier, { roundId: latestId, answer: latest[1], updatedAt: Number(latest[3]) }],
  };
}

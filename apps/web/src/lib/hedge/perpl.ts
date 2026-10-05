import { type Address, BaseError, ContractFunctionRevertedError } from "viem";
import { MULTICALL3, type ReadClient } from "../chain/client";
import { perplReadAbi } from "./abi";
import type { FundingSample, PerpMeta, PerpPosition } from "./math";

// Reads from Perpl's Exchange for the hedge assistant. Every function takes the client and the
// Exchange address, so it runs in the browser and in tests alike.

export interface PositionBanks {
  bank1: bigint;
  bank2: bigint;
  bank3: bigint;
  bank4: bigint;
}

/** Perp ids an account holds positions in: bit (id % 256) of bank (id / 256 + 1). */
export function perpIdsFromBanks(banks: PositionBanks): bigint[] {
  const ids: bigint[] = [];
  [banks.bank1, banks.bank2, banks.bank3, banks.bank4].forEach((bank, word) => {
    for (let bit = 0n; bit < 256n; bit++) {
      if ((bank >> bit) & 1n) ids.push(BigInt(word) * 256n + bit);
    }
  });
  return ids;
}

export type PositionsResult =
  | { status: "no-account" }
  | { status: "ok"; accountId: bigint; positions: PerpPosition[]; metas: PerpMeta[] };

function isRevert(error: unknown): boolean {
  return error instanceof BaseError && error.walk((e) => e instanceof ContractFunctionRevertedError) !== null;
}

type PerpInfo = {
  name: string;
  symbol: string;
  priceDecimals: bigint;
  lotDecimals: bigint;
  markPNS: bigint;
  fundingSumScalingExp: bigint;
};

function toMeta(perpId: bigint, info: PerpInfo): PerpMeta {
  return {
    perpId,
    name: info.name,
    symbol: info.symbol,
    priceDecimals: Number(info.priceDecimals),
    lotDecimals: Number(info.lotDecimals),
    scalingExp: Number(info.fundingSumScalingExp),
    markPNS: info.markPNS,
  };
}

export async function readPerpMeta(client: ReadClient, exchange: Address, perpId: bigint): Promise<PerpMeta> {
  const info = await client.readContract({
    address: exchange,
    abi: perplReadAbi,
    functionName: "getPerpetualInfoV2",
    args: [perpId],
  });
  return toMeta(perpId, info);
}

/**
 * Every open position of `owner` on Perpl: the account from getAccountByAddr (which reverts for an
 * address with no Perpl account), its perps from the position bitmap, then getPositionV2 and
 * getPerpetualInfoV2 for each, in one multicall.
 */
export async function readPerplPositions(
  client: ReadClient,
  exchange: Address,
  owner: Address,
): Promise<PositionsResult> {
  let account: { accountId: bigint; positions: PositionBanks };
  try {
    account = await client.readContract({
      address: exchange,
      abi: perplReadAbi,
      functionName: "getAccountByAddr",
      args: [owner],
    });
  } catch (error) {
    if (isRevert(error)) return { status: "no-account" };
    throw error;
  }
  if (account.accountId === 0n) return { status: "no-account" };
  const perps = perpIdsFromBanks(account.positions);
  if (perps.length === 0) return { status: "ok", accountId: account.accountId, positions: [], metas: [] };
  const results = await client.multicall({
    allowFailure: false,
    multicallAddress: MULTICALL3,
    contracts: perps.flatMap((perpId) => [
      {
        address: exchange,
        abi: perplReadAbi,
        functionName: "getPositionV2" as const,
        args: [perpId, account.accountId] as const,
      },
      {
        address: exchange,
        abi: perplReadAbi,
        functionName: "getPerpetualInfoV2" as const,
        args: [perpId] as const,
      },
    ]),
  });
  const positions: PerpPosition[] = [];
  const metas: PerpMeta[] = [];
  perps.forEach((perpId, i) => {
    const [position] = results[i * 2] as readonly [
      {
        accountId: bigint;
        positionType: number;
        pricePNS: bigint;
        lotLNS: bigint;
        entryBlock: bigint;
        premiumPnlCNS: bigint;
      },
      bigint,
      boolean,
    ];
    const info = results[i * 2 + 1] as PerpInfo;
    if (position.accountId !== account.accountId || position.lotLNS === 0n) return;
    positions.push({
      perpId,
      side: position.positionType === 1 ? "short" : "long",
      lots: position.lotLNS,
      entryPricePNS: position.pricePNS,
      entryBlock: position.entryBlock,
      premiumPnlCNS: position.premiumPnlCNS,
      source: "chain",
    });
    metas.push(toMeta(perpId, info));
  });
  return { status: "ok", accountId: account.accountId, positions, metas };
}

export interface FundingHistory {
  interval: bigint;
  /** The last funding event at or before the head. */
  lastEvent: bigint;
  /** The sum at lastEvent. */
  lastSum: bigint;
  /** Samples at lastEvent − k·interval for k = count … 0, oldest first. */
  samples: FundingSample[];
}

/** The last `count` funding intervals of a perp, read at Perpl's grid blocks. Needs no archive node. */
export async function readFundingHistory(
  client: ReadClient,
  exchange: Address,
  perpId: bigint,
  head: bigint,
  count: number,
): Promise<FundingHistory> {
  const [interval, latest] = await Promise.all([
    client.readContract({ address: exchange, abi: perplReadAbi, functionName: "getFundingInterval" }),
    client.readContract({
      address: exchange,
      abi: perplReadAbi,
      functionName: "getFundingSumAtBlock",
      args: [perpId, head],
    }),
  ]);
  const lastEvent = latest[1];
  if (lastEvent === 0n) return { interval, lastEvent, lastSum: 0n, samples: [] };
  const blocks: bigint[] = [];
  for (let k = BigInt(count); k >= 1n; k--) {
    const block = lastEvent - k * interval;
    if (block > 0n) blocks.push(block);
  }
  const sums = await client.multicall({
    allowFailure: false,
    multicallAddress: MULTICALL3,
    contracts: blocks.map((block) => ({
      address: exchange,
      abi: perplReadAbi,
      functionName: "getFundingSumAtBlock" as const,
      args: [perpId, block] as const,
    })),
  });
  const samples: FundingSample[] = blocks.map((block, i) => {
    const [sum, eventBlock] = sums[i] as readonly [number, bigint];
    return { block, sum: BigInt(sum), eventBlock };
  });
  samples.push({ block: lastEvent, sum: BigInt(latest[0]), eventBlock: lastEvent });
  return { interval, lastEvent, lastSum: BigInt(latest[0]), samples };
}

/** The funding sum at one block (for tracking a hedge from the moment it was opened). */
export async function readFundingSum(
  client: ReadClient,
  exchange: Address,
  perpId: bigint,
  block: bigint,
): Promise<{ sum: bigint; eventBlock: bigint }> {
  const [sum, eventBlock] = await client.readContract({
    address: exchange,
    abi: perplReadAbi,
    functionName: "getFundingSumAtBlock",
    args: [perpId, block],
  });
  return { sum: BigInt(sum), eventBlock };
}

/**
 * The funding sum at several blocks, in one multicall, keyed by block: a window's start (what a started
 * window has counted so far) or a basket's end (funding after it is not hedged).
 */
export async function readFundingSums(
  client: ReadClient,
  exchange: Address,
  perpId: bigint,
  blocks: readonly bigint[],
): Promise<Record<string, bigint>> {
  if (blocks.length === 0) return {};
  const sums = await client.multicall({
    allowFailure: false,
    multicallAddress: MULTICALL3,
    contracts: blocks.map((block) => ({
      address: exchange,
      abi: perplReadAbi,
      functionName: "getFundingSumAtBlock" as const,
      args: [perpId, block] as const,
    })),
  });
  const out: Record<string, bigint> = {};
  blocks.forEach((block, i) => {
    const [sum] = sums[i] as readonly [number, bigint];
    out[block.toString()] = BigInt(sum);
  });
  return out;
}

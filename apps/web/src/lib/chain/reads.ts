import {
  type Deployment,
  type GraduationRule,
  hunchBookFactoryAbi,
  type MarketCaps,
  marketAbi,
  type Outcome,
  type Phase,
  resolverAbi,
  type Window,
} from "@hunch-book/shared";
import {
  type Abi,
  type Address,
  type ContractFunctionParameters,
  erc20Abi,
  type Hex,
  isAddressEqual,
  zeroAddress,
} from "viem";
import { usdcOf } from "../config";
import { parseBestBidAsk } from "../market/logic";
import { decodeMarketParams, fallbackHeadline } from "../market/params";
import type { MarketView, PortfolioEntry, ReadResult } from "../market/types";
import { MULTICALL3, type ReadClient } from "./client";
import { kuruOrderBookAbi } from "./kuru";

// A small typed read layer over a viem public client and the shared ABIs. Every function takes the
// client and the deployment, so it runs the same in the browser, on the server and in tests.

/** The newest markets the list reads. Older ones need the indexer (next build). */
export const MARKET_LIST_LIMIT = 100;

/** Calldata bytes per Multicall3 chunk: about 150 calls per eth_call. */
const MULTICALL_BATCH_BYTES = 16_384;

const MARKET_READS = [
  "phase",
  "poolTotals",
  "window",
  "tokens",
  "book",
  "outcome",
  "templateId",
  "params",
  "resolver",
  "caps",
  "rule",
  "creator",
  "graduated",
  "evidenceHash",
  "marketId",
  "graduationRuleMet",
] as const;
type MarketRead = (typeof MARKET_READS)[number];

type CallResult = { status: "success"; result: unknown } | { status: "failure"; error: Error };

interface Call {
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
}

/** Multicall3 with per-call failure, typed loosely on purpose: each result is parsed field by field. */
async function multicall(client: ReadClient, calls: Call[]): Promise<CallResult[]> {
  if (calls.length === 0) return [];
  const results = await client.multicall({
    contracts: calls as unknown as readonly ContractFunctionParameters[],
    allowFailure: true,
    batchSize: MULTICALL_BATCH_BYTES,
    multicallAddress: MULTICALL3,
  });
  return results as CallResult[];
}

const ok = <T>(r: CallResult | undefined): T | undefined =>
  r?.status === "success" ? (r.result as T) : undefined;

function marketCalls(address: Address): Call[] {
  return MARKET_READS.map((functionName) => ({ address, abi: marketAbi as Abi, functionName }));
}

/** Parses one market's results, starting at `offset`. Returns null if a required field failed. */
export function parseMarketResults(address: Address, results: CallResult[], offset = 0): MarketView | null {
  const get = <T>(name: MarketRead): T | undefined => ok<T>(results[offset + MARKET_READS.indexOf(name)]);
  const phase = get<number>("phase");
  const poolTotals = get<readonly [bigint, bigint, number]>("poolTotals");
  const window = get<Window>("window");
  const tokens = get<readonly [Address, Address]>("tokens");
  const templateId = get<number>("templateId");
  const params = get<Hex>("params");
  const resolver = get<Address>("resolver");
  const caps = get<MarketCaps>("caps");
  const rule = get<GraduationRule>("rule");
  if (
    phase === undefined ||
    poolTotals === undefined ||
    window === undefined ||
    tokens === undefined ||
    templateId === undefined ||
    params === undefined ||
    resolver === undefined ||
    caps === undefined ||
    rule === undefined
  ) {
    return null;
  }
  const book = get<Address>("book");
  const [yes, no, stakers] = poolTotals;
  return {
    address,
    marketId: get<bigint>("marketId") ?? 0n,
    templateId: Number(templateId),
    phase: Number(phase) as Phase,
    outcome: Number(get<number>("outcome") ?? 0) as Outcome,
    graduated: get<boolean>("graduated") ?? false,
    pool: { yes, no, total: yes + no, stakers: Number(stakers) },
    window: {
      blockClock: window.blockClock,
      lock: BigInt(window.lock),
      close: BigInt(window.close),
      settleDeadline: BigInt(window.settleDeadline),
    },
    tokens: { yes: tokens[0], no: tokens[1] },
    book: book && !isAddressEqual(book, zeroAddress) ? book : null,
    resolver,
    creator: get<Address>("creator") ?? zeroAddress,
    params,
    decoded: decodeMarketParams(Number(templateId), params),
    rule: {
      minPool: BigInt(rule.minPool),
      minStakers: Number(rule.minStakers),
      minChanceBps: Number(rule.minChanceBps),
      maxChanceBps: Number(rule.maxChanceBps),
    },
    caps: {
      poolCap: BigInt(caps.poolCap),
      walletCap: BigInt(caps.walletCap),
      minStake: BigInt(caps.minStake),
      creatorMinStake: BigInt(caps.creatorMinStake),
    },
    evidenceHash: get<Hex>("evidenceHash") ?? `0x${"00".repeat(32)}`,
    description: null,
    quote: null,
    ruleMet: get<boolean>("graduationRuleMet") ?? null,
  };
}

/** Second pass: the resolver's rule sentence for each market, and Kuru's best bid/ask once graduated. */
async function readExtras(client: ReadClient, markets: MarketView[]): Promise<MarketView[]> {
  const calls: Call[] = [];
  const slots: { describe: number; quote: number | null }[] = [];
  for (const m of markets) {
    const describe = calls.push({
      address: m.resolver,
      abi: resolverAbi as Abi,
      functionName: "describe",
      args: [m.params],
    });
    let quote: number | null = null;
    if (m.graduated && m.book) {
      quote = calls.push({ address: m.book, abi: kuruOrderBookAbi as Abi, functionName: "bestBidAsk" });
    }
    slots.push({ describe: describe - 1, quote: quote === null ? null : quote - 1 });
  }
  const results = await multicall(client, calls);
  return markets.map((m, i) => {
    const slot = slots[i];
    if (!slot) return m;
    const description = ok<string>(results[slot.describe]);
    const bidAsk = slot.quote === null ? undefined : ok<readonly [bigint, bigint]>(results[slot.quote]);
    return {
      ...m,
      description: description && description.trim().length > 0 ? description.trim() : null,
      quote: bidAsk ? parseBestBidAsk(bidAsk[0], bidAsk[1]) : null,
    };
  });
}

/** Reads full views for a list of market addresses. Markets whose core reads fail are skipped. */
export async function readMarketViews(
  client: ReadClient,
  addresses: readonly Address[],
): Promise<MarketView[]> {
  const perMarket = MARKET_READS.length;
  const results = await multicall(client, addresses.flatMap(marketCalls));
  const views = addresses.flatMap((address, i) => {
    const view = parseMarketResults(address, results, i * perMarket);
    return view ? [view] : [];
  });
  return readExtras(client, views);
}

/** Lists markets from the factory, newest first: marketCount, then marketAt for each index. */
export async function listMarkets(
  client: ReadClient,
  deployment: Deployment,
  { limit = MARKET_LIST_LIMIT }: { limit?: number } = {},
): Promise<ReadResult<{ markets: MarketView[]; total: number }>> {
  const factory = deployment.hunchBook.factory;
  if (!factory) return { status: "not-deployed" };
  const count = await client.readContract({
    address: factory,
    abi: hunchBookFactoryAbi,
    functionName: "marketCount",
  });
  const total = Number(count);
  const start = Math.max(0, total - limit);
  const indexCalls: Call[] = [];
  for (let i = total - 1; i >= start; i--) {
    indexCalls.push({
      address: factory,
      abi: hunchBookFactoryAbi as Abi,
      functionName: "marketAt",
      args: [BigInt(i)],
    });
  }
  const addresses = (await multicall(client, indexCalls)).flatMap((r) => {
    const a = ok<Address>(r);
    return a ? [a] : [];
  });
  const markets = await readMarketViews(client, addresses);
  return { status: "ok", data: { markets, total } };
}

/**
 * Reads one market. The factory must confirm the address with `isMarket`, so a page for an arbitrary
 * address never shows it as a Hunch Book market or offers to stake in it.
 */
export async function readMarket(
  client: ReadClient,
  deployment: Deployment,
  address: Address,
): Promise<ReadResult<MarketView>> {
  const factory = deployment.hunchBook.factory;
  if (!factory) return { status: "not-deployed" };
  const results = await multicall(client, [
    { address: factory, abi: hunchBookFactoryAbi as Abi, functionName: "isMarket", args: [address] },
    ...marketCalls(address),
  ]);
  const check = results[0];
  if (!check || check.status === "failure") {
    throw check?.error ?? new Error("Could not ask the factory about this address.");
  }
  if (check.result !== true) return { status: "not-market" };
  const view = parseMarketResults(address, results, 1);
  if (!view) throw new Error("Could not read this market from the chain.");
  const [full] = await readExtras(client, [view]);
  return { status: "ok", data: full ?? view };
}

/** The connected wallet's position in every listed market; only rows with something in them. */
export async function readPortfolio(
  client: ReadClient,
  deployment: Deployment,
  user: Address,
): Promise<ReadResult<PortfolioEntry[]>> {
  const list = await listMarkets(client, deployment);
  if (list.status !== "ok") return list;
  const markets = list.data.markets;
  const PER = 5;
  const calls = markets.flatMap((m): Call[] => [
    { address: m.address, abi: marketAbi as Abi, functionName: "stakeOf", args: [user] },
    { address: m.address, abi: marketAbi as Abi, functionName: "claimableTokens", args: [user] },
    { address: m.address, abi: marketAbi as Abi, functionName: "claimablePool", args: [user] },
    { address: m.tokens.yes, abi: erc20Abi as Abi, functionName: "balanceOf", args: [user] },
    { address: m.tokens.no, abi: erc20Abi as Abi, functionName: "balanceOf", args: [user] },
  ]);
  const results = await multicall(client, calls);
  const pair = (r: CallResult | undefined): readonly [bigint, bigint] =>
    ok<readonly [bigint, bigint]>(r) ?? [0n, 0n];
  const entries = markets.map((market, i): PortfolioEntry => {
    const at = i * PER;
    const stake = pair(results[at]);
    const claimable = pair(results[at + 1]);
    const pool = pair(results[at + 2]);
    return {
      market,
      stake: { yes: stake[0], no: stake[1] },
      claimableTokens: { yes: claimable[0], no: claimable[1] },
      claimablePool: { paid: pool[0], fee: pool[1] },
      balances: { yes: ok<bigint>(results[at + 3]) ?? 0n, no: ok<bigint>(results[at + 4]) ?? 0n },
    };
  });
  return { status: "ok", data: entries.filter(hasPosition) };
}

export interface UserPosition {
  stake: { yes: bigint; no: bigint };
  claimableTokens: { yes: bigint; no: bigint };
  claimablePool: { paid: bigint; fee: bigint };
}

/** One wallet's stake and claims in one market. */
export async function readUserPosition(
  client: ReadClient,
  market: Address,
  user: Address,
): Promise<UserPosition> {
  const results = await multicall(client, [
    { address: market, abi: marketAbi as Abi, functionName: "stakeOf", args: [user] },
    { address: market, abi: marketAbi as Abi, functionName: "claimableTokens", args: [user] },
    { address: market, abi: marketAbi as Abi, functionName: "claimablePool", args: [user] },
  ]);
  const stake = ok<readonly [bigint, bigint]>(results[0]);
  if (!stake) throw new Error("Could not read your stake in this market.");
  const claimable = ok<readonly [bigint, bigint]>(results[1]) ?? [0n, 0n];
  const pool = ok<readonly [bigint, bigint]>(results[2]) ?? [0n, 0n];
  return {
    stake: { yes: stake[0], no: stake[1] },
    claimableTokens: { yes: claimable[0], no: claimable[1] },
    claimablePool: { paid: pool[0], fee: pool[1] },
  };
}

export function hasPosition(e: PortfolioEntry): boolean {
  return (
    e.stake.yes +
      e.stake.no +
      e.claimableTokens.yes +
      e.claimableTokens.no +
      e.claimablePool.paid +
      e.balances.yes +
      e.balances.no >
    0n
  );
}

/**
 * The vault (USDC spender for stakes) and the collateral token. Both come from deployments first; if
 * a deploy script left one out, it is read from the factory listed in deployments, never from a market.
 */
export async function readProtocolAddresses(
  client: ReadClient,
  deployment: Deployment,
): Promise<{ vault: Address; usdc: Address } | null> {
  const factory = deployment.hunchBook.factory;
  if (!factory) return null;
  const vault =
    deployment.hunchBook.vault ??
    (await client.readContract({ address: factory, abi: hunchBookFactoryAbi, functionName: "vault" }));
  const usdc =
    usdcOf(deployment) ??
    (await client.readContract({ address: factory, abi: hunchBookFactoryAbi, functionName: "usdc" }));
  return { vault, usdc };
}

/** USDC balance and allowance to the vault for one wallet. */
export async function readUsdcState(
  client: ReadClient,
  usdc: Address,
  vault: Address,
  user: Address,
): Promise<{ balance: bigint; allowance: bigint }> {
  const results = await multicall(client, [
    { address: usdc, abi: erc20Abi as Abi, functionName: "balanceOf", args: [user] },
    { address: usdc, abi: erc20Abi as Abi, functionName: "allowance", args: [user, vault] },
  ]);
  const balance = ok<bigint>(results[0]);
  const allowance = ok<bigint>(results[1]);
  if (balance === undefined || allowance === undefined) throw new Error("Could not read your USDC balance.");
  return { balance, allowance };
}

/** The latest block number and its timestamp. */
export async function readChainHead(client: ReadClient): Promise<{ blockNumber: bigint; timestamp: number }> {
  const block = await client.getBlock({ blockTag: "latest" });
  return { blockNumber: block.number, timestamp: Number(block.timestamp) };
}

/** Average milliseconds per block over the last `span` blocks, measured on chain. */
export async function measureMsPerBlock(
  client: ReadClient,
  head: bigint,
  span = 10_000n,
): Promise<number | null> {
  if (head <= span) return null;
  const [latest, earlier] = await Promise.all([
    client.getBlock({ blockNumber: head }),
    client.getBlock({ blockNumber: head - span }),
  ]);
  const ms = (Number(latest.timestamp - earlier.timestamp) * 1000) / Number(span);
  return ms > 0 ? ms : null;
}

/**
 * A market's headline for page metadata: the resolver's sentence, else one built from its params.
 * Gives up after `timeoutMs` so a slow RPC never holds the page.
 */
export async function readMarketHeadline(
  client: ReadClient,
  deployment: Deployment,
  address: Address,
  timeoutMs = 2_500,
): Promise<string | null> {
  const work = (async () => {
    const result = await readMarket(client, deployment, address);
    if (result.status !== "ok") return null;
    return result.data.description ?? fallbackHeadline(deployment, result.data.decoded);
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    return await Promise.race([work, timeout]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

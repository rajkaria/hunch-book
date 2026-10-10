import {
  type Deployment,
  defaultStackOf,
  type GraduationRule,
  hunchBookFactoryAbi,
  type MarketCaps,
  PriceSource,
  perplExchangeAbi,
  type Venue,
  type Window,
} from "@hunch-book/shared";
import {
  type Abi,
  type Address,
  type ContractFunctionParameters,
  type Hex,
  isAddressEqual,
  zeroAddress,
} from "viem";
import { MULTICALL3, type ReadClient } from "../chain/client";
import { measureMsPerBlock, readChainHead, readProtocolAddresses } from "../chain/reads";
import { chainlinkFeedName } from "../market/params";
import {
  chainlinkLatestAbi,
  parlayResolverViewsAbi,
  priceResolverViewsAbi,
  pythPriceAbi,
  resolverWithErrorsAbi,
  spikeResolverViewsAbi,
} from "./abis";
import { type Head, PACE_SPAN, type Pace, paceFrom } from "./clock";
import { describeCreateError } from "./errors";
import { type FundingHistory, type FundingSample, gridAnchor, type PerpInfo } from "./perpl";
import { chainlinkOption, type PriceFeedOption, pythOption, pythToE8, toE8 } from "./price";
import { TEMPLATE_IDS } from "./templates";

// Chain reads for the create flow. Each takes a client and the deployment, so it runs the same in
// the browser and in tests with a stub client.

interface Call {
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
}

type CallResult = { status: "success"; result: unknown } | { status: "failure"; error: Error };

async function multicall(client: ReadClient, calls: Call[]): Promise<CallResult[]> {
  if (calls.length === 0) return [];
  const results = await client.multicall({
    contracts: calls as unknown as readonly ContractFunctionParameters[],
    allowFailure: true,
    batchSize: 16_384,
    multicallAddress: MULTICALL3,
  });
  return results as CallResult[];
}

const ok = <T>(r: CallResult | undefined): T | undefined =>
  r?.status === "success" ? (r.result as T) : undefined;

// ---------- factory ----------

export interface RegisteredTemplate {
  resolver: Address;
  rule: GraduationRule;
}

export interface CreateConfig {
  /** The stack new markets go to (deployments `defaultStack`): "primary" or a name under `stacks`. */
  stack: string;
  /** Where that stack's books are, for the flow's copy (lib/stacks.ts names it). */
  venue: Venue;
  kuruVersion: 1 | 2;
  factory: Address;
  vault: Address;
  usdc: Address;
  paused: boolean;
  caps: MarketCaps;
  /** Templates with a resolver, by id. Unregistered ids are left out. */
  templates: Record<number, RegisteredTemplate>;
}

/**
 * The stack new markets go to (deployments `defaultStack`): whether creation is paused on its factory,
 * the caps new markets copy, and which template ids are registered there, with its vault and USDC.
 */
export async function readCreateConfig(
  client: ReadClient,
  deployment: Deployment,
): Promise<CreateConfig | null> {
  const stack = defaultStackOf(deployment);
  const factory = stack?.contracts.factory;
  if (!stack || !factory) return null;
  const abi = hunchBookFactoryAbi as Abi;
  const [results, protocol] = await Promise.all([
    multicall(client, [
      { address: factory, abi, functionName: "creationPaused" },
      { address: factory, abi, functionName: "caps" },
      ...TEMPLATE_IDS.map((id) => ({ address: factory, abi, functionName: "templateOf", args: [id] })),
    ]),
    readProtocolAddresses(client, deployment, stack.name),
  ]);
  const paused = ok<boolean>(results[0]);
  const caps = ok<MarketCaps>(results[1]);
  if (paused === undefined || caps === undefined || !protocol) {
    throw new Error("Could not read the factory's settings.");
  }
  const templates: Record<number, RegisteredTemplate> = {};
  TEMPLATE_IDS.forEach((id, i) => {
    const t = ok<{ resolver: Address; rule: GraduationRule }>(results[2 + i]);
    if (t && !isAddressEqual(t.resolver, zeroAddress)) {
      templates[id] = {
        resolver: t.resolver,
        rule: {
          minPool: BigInt(t.rule.minPool),
          minStakers: Number(t.rule.minStakers),
          minChanceBps: Number(t.rule.minChanceBps),
          maxChanceBps: Number(t.rule.maxChanceBps),
        },
      };
    }
  });
  return {
    stack: stack.name,
    venue: stack.venue,
    kuruVersion: stack.kuruVersion,
    factory,
    vault: protocol.vault,
    usdc: protocol.usdc,
    paused,
    caps: {
      poolCap: BigInt(caps.poolCap),
      walletCap: BigInt(caps.walletCap),
      minStake: BigInt(caps.minStake),
      creatorMinStake: BigInt(caps.creatorMinStake),
    },
    templates,
  };
}

/** The market already created for this key, or null. */
export async function readMarketOf(client: ReadClient, factory: Address, key: Hex): Promise<Address | null> {
  const market = await client.readContract({
    address: factory,
    abi: hunchBookFactoryAbi,
    functionName: "marketOf",
    args: [key],
  });
  return isAddressEqual(market, zeroAddress) ? null : market;
}

// ---------- the chain clock ----------

/** The head, and the block pace over the last two PACE_SPAN spans. */
export async function readClock(client: ReadClient, nominalMs: number): Promise<{ head: Head; pace: Pace }> {
  const h = await readChainHead(client);
  const head: Head = { number: h.blockNumber, timestamp: h.timestamp };
  const [recent, older] = await Promise.all([
    measureMsPerBlock(client, head.number, PACE_SPAN).catch(() => null),
    head.number > 2n * PACE_SPAN
      ? measureMsPerBlock(client, head.number - PACE_SPAN, PACE_SPAN).catch(() => null)
      : Promise.resolve(null),
  ]);
  return { head, pace: paceFrom(recent, older, nominalMs) };
}

// ---------- Perpl ----------

/** About ten days of funding events: enough for rolling windows up to a week. */
export const FUNDING_HISTORY_EVENTS = 337;

export interface PerpContext {
  info: PerpInfo;
  interval: bigint;
  anchor: bigint;
  history: FundingHistory;
}

interface RawPerpInfo {
  name: string;
  symbol: string;
  priceDecimals: bigint;
  status: number;
  fundingStartBlock: bigint;
  markPNS: bigint;
  fundingSumScalingExp: bigint;
}

/** Perp info, the funding interval and recent funding events, read live from Perpl. */
export async function readPerpContext(
  client: ReadClient,
  deployment: Deployment,
  perpId: bigint,
  headBlock: bigint,
  events = FUNDING_HISTORY_EVENTS,
): Promise<PerpContext> {
  const exchange = deployment.external.perpl.exchange;
  const abi = perplExchangeAbi as Abi;
  const first = await multicall(client, [
    { address: exchange, abi, functionName: "getPerpetualInfoV2", args: [perpId] },
    { address: exchange, abi, functionName: "getFundingInterval" },
    { address: exchange, abi, functionName: "getFundingSumAtBlock", args: [perpId, headBlock] },
  ]);
  const raw = ok<RawPerpInfo>(first[0]);
  const interval = ok<bigint>(first[1]);
  const latest = ok<readonly [number | bigint, bigint]>(first[2]);
  if (!raw) throw new Error(`Perpl does not describe perp ${perpId.toString()} on this network.`);
  if (!interval || interval <= 0n) throw new Error("Could not read Perpl's funding interval.");
  const info: PerpInfo = {
    perpId,
    name: raw.name,
    symbol: raw.symbol,
    priceDecimals: Number(raw.priceDecimals),
    scalingExp: Number(raw.fundingSumScalingExp),
    status: Number(raw.status),
    fundingStartBlock: BigInt(raw.fundingStartBlock),
    markPrice: BigInt(raw.markPNS),
  };
  const lastEvent = latest ? BigInt(latest[1]) : 0n;
  if (lastEvent === 0n) {
    return { info, interval, anchor: 0n, history: { interval, lastEvent, samples: [] } };
  }

  const blocks: bigint[] = [];
  for (let k = events; k >= 0; k--) {
    const b = lastEvent - BigInt(k) * interval;
    if (b > 0n) blocks.push(b);
  }
  const results = await multicall(
    client,
    blocks.map((b) => ({ address: exchange, abi, functionName: "getFundingSumAtBlock", args: [perpId, b] })),
  );
  const samples: FundingSample[] = [];
  results.forEach((r, i) => {
    const v = ok<readonly [number | bigint, bigint]>(r);
    const block = blocks[i];
    // (0, 0) means funding had not started yet at that block.
    if (v && block !== undefined && BigInt(v[1]) !== 0n) samples.push({ block, sum: BigInt(v[0]) });
  });
  return {
    info,
    interval,
    anchor: gridAnchor(lastEvent, interval),
    history: { interval, lastEvent, samples },
  };
}

/** Template 4's challenge period in blocks: NO can settle once block close + this has passed. */
export async function readChallengeBlocks(client: ReadClient, resolver: Address): Promise<bigint> {
  return client.readContract({
    address: resolver,
    abi: spikeResolverViewsAbi,
    functionName: "challengeBlocks",
  });
}

/** Template 6's fast block time: how the parlay resolver estimates the earliest lock of a block-clock leg. */
export async function readFastBlockTime(client: ReadClient, resolver: Address): Promise<number> {
  const ms = await client.readContract({
    address: resolver,
    abi: parlayResolverViewsAbi,
    functionName: "fastBlockTimeMs",
  });
  return Number(ms);
}

// ---------- prices ----------

/**
 * The feeds a price resolver accepts, labelled: Chainlink proxies first, then Pyth ids. The touch
 * resolver has no Pyth ids (its `pythIds()` call fails), so it lists Chainlink only.
 */
export async function readPriceFeeds(
  client: ReadClient,
  deployment: Deployment,
  resolver: Address,
): Promise<PriceFeedOption[]> {
  const abi = priceResolverViewsAbi as Abi;
  const [feedsResult, idsResult] = await multicall(client, [
    { address: resolver, abi, functionName: "feeds" },
    { address: resolver, abi, functionName: "pythIds" },
  ]);
  const feeds = ok<readonly Address[]>(feedsResult) ?? [];
  const ids = ok<readonly Hex[]>(idsResult) ?? [];
  if (!feedsResult || feedsResult.status === "failure") {
    throw new Error("Could not read which price feeds the resolver accepts.");
  }
  const unnamed = feeds.filter((f) => !chainlinkFeedName(deployment, f));
  const labels = await multicall(client, [
    ...unnamed.map((f) => ({ address: f, abi: chainlinkLatestAbi as Abi, functionName: "description" })),
    ...ids.map((id) => ({ address: resolver, abi, functionName: "pythLabel", args: [id] })),
  ]);
  const options: PriceFeedOption[] = feeds.map((feed) => {
    const known = chainlinkFeedName(deployment, feed);
    const read = ok<string>(labels[unnamed.indexOf(feed)]);
    return chainlinkOption(known ?? read ?? feed, feed);
  });
  ids.forEach((id, i) => {
    const label = ok<string>(labels[unnamed.length + i]);
    options.push(pythOption(label && label.length > 0 ? label : id, id));
  });
  return options;
}

export interface SpotPrice {
  priceE8: bigint;
  /** Unix seconds of the reading. */
  updatedAt: number;
}

/** The feed's latest price: Chainlink's latest round, or Pyth's last price stored onchain. */
export async function readSpotPrice(
  client: ReadClient,
  deployment: Deployment,
  option: PriceFeedOption,
): Promise<SpotPrice | null> {
  if (option.source === PriceSource.Chainlink) {
    const [round, decimals] = await multicall(client, [
      { address: option.feed, abi: chainlinkLatestAbi as Abi, functionName: "latestRoundData" },
      { address: option.feed, abi: chainlinkLatestAbi as Abi, functionName: "decimals" },
    ]);
    const r = ok<readonly [bigint, bigint, bigint, bigint, bigint]>(round);
    const d = ok<number>(decimals);
    if (!r || d === undefined || r[1] <= 0n) return null;
    return { priceE8: toE8(r[1], Number(d)), updatedAt: Number(r[3]) };
  }
  const pyth = deployment.external.pyth.contract;
  const p = (await client.readContract({
    address: pyth,
    abi: pythPriceAbi,
    functionName: "getPriceUnsafe",
    args: [option.pythId],
  })) as { price: bigint; expo: number; publishTime: bigint };
  if (p.price <= 0n) return null;
  return { priceE8: pythToE8(p.price, Number(p.expo)), updatedAt: Number(p.publishTime) };
}

// ---------- preview ----------

export interface Preview {
  /** The window `validate` returned, or null if it reverted. */
  window: Window | null;
  /** The resolver's rule sentence, or null if `describe` failed. */
  sentence: string | null;
  /** Why `validate` refused, in plain words, or null. */
  error: string | null;
}

/** Runs the resolver's `validate` and `describe` on the params through eth_call. */
export async function previewMarket(client: ReadClient, resolver: Address, params: Hex): Promise<Preview> {
  const [v, d] = await multicall(client, [
    { address: resolver, abi: resolverWithErrorsAbi, functionName: "validate", args: [params] },
    { address: resolver, abi: resolverWithErrorsAbi, functionName: "describe", args: [params] },
  ]);
  const w = ok<Window>(v);
  const sentence = ok<string>(d);
  return {
    window: w
      ? {
          blockClock: w.blockClock,
          lock: BigInt(w.lock),
          close: BigInt(w.close),
          settleDeadline: BigInt(w.settleDeadline),
        }
      : null,
    sentence: sentence && sentence.trim().length > 0 ? sentence.trim() : null,
    error: v?.status === "failure" ? describeCreateError(v.error) : null,
  };
}

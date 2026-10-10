import {
  bestPricesV2,
  type GraduationRule,
  hunchBookFactoryAbi,
  impliedChanceBps,
  kuruOrderBookAbi,
  kuruV2OrderBookAbi,
  type MarketCaps,
  marketAbi,
  Outcome,
  PHASE_LABEL,
  Phase,
  resolverAbi,
  type Stack,
  snapshotResolverAbi,
  stacksOf,
  templateLabel,
  type Venue,
  venueLabel,
  type Window,
} from "@hunch-book/shared";
import { type Abi, type Address, erc20Abi, getAddress, type Hex, isAddressEqual, zeroAddress } from "viem";
import type { HunchContext } from "./context.js";
import { type Call, type CallResult, multicall, ok } from "./multicall.js";
import { type DecodedParams, decodeMarketParams, marketAsset } from "./params.js";
import { snapshotAsset } from "./settlement/snapshot.js";

// Reads of markets from the chain: the factory's list, one market in full (decoded params, the
// resolver's rule sentence, phase, pool totals, the book's best prices and the implied chance), and a
// wallet's position. Each market costs one Multicall3 pass plus one for the extras. A market's book is
// on its stack's venue: Kuru (v1 or v2), or Hunch Book's own order book, which speaks Kuru v1's interface.

export type OutcomeLabel = "unresolved" | "yes" | "no";
export type PhaseName = "pool" | "pool-locked" | "trading" | "closed" | "settled" | "voided";

export const PHASE_NAME: Readonly<Record<Phase, PhaseName>> = {
  [Phase.Pool]: "pool",
  [Phase.PoolLocked]: "pool-locked",
  [Phase.Graduated]: "trading",
  [Phase.Closed]: "closed",
  [Phase.Settled]: "settled",
  [Phase.Voided]: "voided",
};

export const OUTCOME_LABEL: Readonly<Record<Outcome, OutcomeLabel>> = {
  [Outcome.Unresolved]: "unresolved",
  [Outcome.Yes]: "yes",
  [Outcome.No]: "no",
};

/** The YES book's best prices, in USDC base units per whole YES token (E6). Null means that side is empty. */
export interface BestPrices {
  bidE6: bigint | null;
  askE6: bigint | null;
}

export type ChanceSource =
  /** Pool phase: Y / T. */
  | "pool"
  /** Trading: the mid of the YES book's best bid and ask. */
  | "book"
  /** Trading with one side empty: that side's price, as the onchain oracle reads it. */
  | "book-one-sided"
  /** Trading with an empty book: no price to show. */
  | "book-empty"
  | "settled"
  | "voided"
  /** A pool with no stakes. */
  | "empty";

export interface Chance {
  /** Chance of YES in basis points (0 to 10,000), or null when there is no number to show. */
  bps: number | null;
  source: ChanceSource;
}

export interface MarketInfo {
  address: Address;
  /** The factory's market number: 1, 2, 3... */
  id: number;
  templateId: number;
  template: string;
  phase: Phase;
  phaseName: PhaseName;
  phaseLabel: string;
  outcome: Outcome;
  outcomeLabel: OutcomeLabel;
  graduated: boolean;
  /** USDC base units staked on each side. */
  pool: { yes: bigint; no: bigint; total: bigint; stakers: number };
  window: Window;
  tokens: { yes: Address; no: Address };
  /** The YES/USDC order book (Kuru's, or Hunch Book's own: see `venue`), or null before one is set. */
  book: Address | null;
  resolver: Address;
  creator: Address;
  params: Hex;
  decoded: DecodedParams;
  /** "BTC" or "BTC/USD" from the deployments file, or null. */
  asset: string | null;
  /** The resolver's own sentence for the rule, the rule of record. Null if `describe` failed. */
  rule: string | null;
  graduationRule: GraduationRule;
  /** IMarket.graduationRuleMet(): the pool meets its rule now, ignoring book readiness and pauses. */
  graduationRuleMet: boolean | null;
  caps: MarketCaps;
  /** Zero until the market settles. */
  evidenceHash: Hex;
  /** Best bid and ask once the market has a book. */
  prices: BestPrices | null;
  chance: Chance;
  /** Template 7: what the snapshot reads, from the resolver's `source(sourceId)`. */
  snapshotSource?: { label: string; unit: string; decimals: number } | null;
  /**
   * The deployment stack the market belongs to ("primary", or a name under `stacks` such as "kuruV2" or
   * "hunch"), its Kuru version, and its venue: "kuru", or "hunch" for Hunch Book's own order book (whose
   * books speak Kuru v1's interface, so `kuruVersion` is 1). All three absent means the primary stack on
   * Kuru v1. `marketVenue` gives the venue with its name for copy.
   */
  stack?: string;
  kuruVersion?: 1 | 2;
  venue?: Venue;
}

/**
 * Where a market's book is, and what to call it in copy: "Hunch order book", "Kuru v2" or "Kuru".
 * Works on any MarketInfo (absent fields mean Kuru v1).
 */
export function marketVenue(m: Pick<MarketInfo, "venue" | "kuruVersion">): { venue: Venue; label: string } {
  const venue = m.venue ?? "kuru";
  return { venue, label: venueLabel({ venue, kuruVersion: m.kuruVersion ?? 1 }) };
}

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

const ZERO_HASH: Hex = `0x${"00".repeat(32)}`;

function marketCalls(address: Address): Call[] {
  return MARKET_READS.map((functionName) => ({ address, abi: marketAbi, functionName }));
}

/** 1e18-scale `bestBidAsk()` to E6, with Kuru's empty sentinels as null. Bids round down, asks up. */
export function bestPricesFromKuru(bid: bigint, ask: bigint): BestPrices {
  const SCALE = 10n ** 12n;
  const emptyBid = bid === 0n || bid === 2n ** 256n - 1n;
  const emptyAsk = ask === 0n || ask === 2n ** 256n - 1n;
  return {
    bidE6: emptyBid ? null : bid / SCALE,
    askE6: emptyAsk ? null : (ask + SCALE - 1n) / SCALE,
  };
}

/** The implied chance of YES: the pool split before graduation, the book after (docs/PROTOCOL.md §2). */
export function marketChance(m: {
  phase: Phase;
  outcome: Outcome;
  pool: { yes: bigint; no: bigint; total: bigint };
  prices: BestPrices | null;
}): Chance {
  if (m.phase === Phase.Settled) {
    return { bps: m.outcome === Outcome.Yes ? 10_000 : 0, source: "settled" };
  }
  if (m.phase === Phase.Voided) return { bps: 5_000, source: "voided" };
  if (m.phase === Phase.Graduated || m.phase === Phase.Closed) {
    const toBps = (e6: bigint): number => Math.min(10_000, Number(e6 / 100n));
    const bid = m.prices?.bidE6 ?? null;
    const ask = m.prices?.askE6 ?? null;
    if (bid !== null && ask !== null) return { bps: toBps((bid + ask) / 2n), source: "book" };
    if (bid !== null) return { bps: toBps(bid), source: "book-one-sided" };
    if (ask !== null) return { bps: toBps(ask), source: "book-one-sided" };
    return { bps: null, source: "book-empty" };
  }
  if (m.pool.total === 0n) return { bps: null, source: "empty" };
  return { bps: Number(impliedChanceBps(m.pool.yes, m.pool.no)), source: "pool" };
}

/** Parses one market's reads, starting at `offset`. Null if a required read failed. */
function parseMarket(
  ctx: HunchContext,
  address: Address,
  results: CallResult[],
  offset: number,
): Omit<MarketInfo, "rule" | "prices" | "chance"> | null {
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
  const decoded = decodeMarketParams(Number(templateId), params);
  const outcome = Number(get<number>("outcome") ?? 0) as Outcome;
  const p = Number(phase) as Phase;
  return {
    address: getAddress(address),
    id: Number(get<bigint>("marketId") ?? 0n),
    templateId: Number(templateId),
    template: templateLabel(Number(templateId)),
    phase: p,
    phaseName: PHASE_NAME[p] ?? "pool",
    phaseLabel: PHASE_LABEL[p] ?? "Unknown",
    outcome,
    outcomeLabel: OUTCOME_LABEL[outcome] ?? "unresolved",
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
    decoded,
    asset: marketAsset(ctx.deployment, decoded),
    graduationRule: {
      minPool: BigInt(rule.minPool),
      minStakers: Number(rule.minStakers),
      minChanceBps: Number(rule.minChanceBps),
      maxChanceBps: Number(rule.maxChanceBps),
    },
    graduationRuleMet: get<boolean>("graduationRuleMet") ?? null,
    caps: {
      poolCap: BigInt(caps.poolCap),
      walletCap: BigInt(caps.walletCap),
      minStake: BigInt(caps.minStake),
      creatorMinStake: BigInt(caps.creatorMinStake),
    },
    evidenceHash: get<Hex>("evidenceHash") ?? ZERO_HASH,
  };
}

/** Second pass: each resolver's rule sentence, and the book's best prices once there is a book. */
async function withExtras(
  ctx: HunchContext,
  markets: Omit<MarketInfo, "rule" | "prices" | "chance">[],
): Promise<MarketInfo[]> {
  const calls: Call[] = [];
  const slots: { describe: number; prices: number | null; source: number | null }[] = [];
  for (const m of markets) {
    const describe = calls.push({
      address: m.resolver,
      abi: resolverAbi,
      functionName: "describe",
      args: [m.params],
    });
    let prices: number | null = null;
    if (m.book && m.graduated) {
      const abi = (m.kuruVersion === 2 ? kuruV2OrderBookAbi : kuruOrderBookAbi) as Abi;
      prices = calls.push({ address: m.book, abi, functionName: "bestBidAsk" });
    }
    let source: number | null = null;
    if (m.decoded.kind === "snapshot") {
      source = calls.push({
        address: m.resolver,
        abi: snapshotResolverAbi,
        functionName: "source",
        args: [m.decoded.params.sourceId],
      });
    }
    slots.push({
      describe: describe - 1,
      prices: prices === null ? null : prices - 1,
      source: source === null ? null : source - 1,
    });
  }
  const results = await multicall(ctx, calls);
  return markets.map((m, i) => {
    const slot = slots[i] as { describe: number; prices: number | null; source: number | null };
    const rule = ok<string>(results[slot.describe]);
    const bidAsk =
      slot.prices === null
        ? undefined
        : ok<readonly [bigint | number, bigint | number]>(results[slot.prices]);
    let prices: BestPrices | null = null;
    if (bidAsk && m.kuruVersion === 2) {
      const p = bestPricesV2(BigInt(bidAsk[0]), BigInt(bidAsk[1]));
      prices = { bidE6: p.bid, askE6: p.ask };
    } else if (bidAsk) {
      prices = bestPricesFromKuru(BigInt(bidAsk[0]), BigInt(bidAsk[1]));
    }
    const info: MarketInfo = {
      ...m,
      rule: rule?.trim() ? rule.trim() : null,
      prices,
      chance: { bps: null, source: "empty" },
    };
    info.chance = marketChance(info);
    if (slot.source !== null) {
      const src = ok<{ label: string; unit: string; decimals: number }>(results[slot.source]);
      info.snapshotSource = src ? { label: src.label, unit: src.unit, decimals: Number(src.decimals) } : null;
      if (src && info.asset === null) info.asset = snapshotAsset(src);
    }
    return info;
  });
}

/** The stack fields a market carries (absent for the primary stack on Kuru v1). */
function stackTag(stack: Stack | undefined): Pick<MarketInfo, "stack" | "kuruVersion" | "venue"> {
  if (!stack || (stack.primary && stack.kuruVersion === 1 && stack.venue === "kuru")) return {};
  return { stack: stack.name, kuruVersion: stack.kuruVersion, venue: stack.venue };
}

/**
 * Full reads for a list of market addresses, in order. Markets whose core reads fail are left out.
 * `stack` is the stack every address belongs to (default: the primary one).
 */
export async function readMarkets(
  ctx: HunchContext,
  addresses: readonly Address[],
  stack?: Stack,
): Promise<MarketInfo[]> {
  const per = MARKET_READS.length;
  const results = await multicall(ctx, addresses.flatMap(marketCalls));
  const tag = stackTag(stack ?? stacksOf(ctx.deployment).find((s) => s.primary));
  const parsed = addresses.flatMap((address, i) => {
    const m = parseMarket(ctx, address, results, i * per);
    return m ? [{ ...m, ...tag }] : [];
  });
  return withExtras(ctx, parsed);
}

/** Every stack with a factory, the primary first; throws when none is deployed. */
function stacks(ctx: HunchContext): Stack[] {
  const out = stacksOf(ctx.deployment);
  if (out.length === 0) throw new Error(`Hunch Book is not deployed on ${ctx.deployment.network} yet.`);
  return out;
}

/** How many markets the factories have created, all stacks together. */
export async function marketCount(ctx: HunchContext): Promise<number> {
  const counts = await stackCounts(ctx);
  return counts.reduce((sum, c) => sum + c, 0);
}

async function stackCounts(ctx: HunchContext): Promise<number[]> {
  const results = await multicall(
    ctx,
    stacks(ctx).map((s) => ({
      address: s.contracts.factory as Address,
      abi: hunchBookFactoryAbi,
      functionName: "marketCount",
    })),
  );
  return results.map((r) => {
    const c = ok<bigint>(r);
    if (c === undefined) throw new Error("Could not read a factory's market count.");
    return Number(c);
  });
}

export interface ListOptions {
  /** Markets to skip from the start of the order. Default 0. */
  offset?: number;
  /** Most markets to return, 1 to 200. Default 50. */
  limit?: number;
  /** "newest" (the default) or "oldest" first. */
  order?: "newest" | "oldest";
}

export interface MarketPage {
  total: number;
  offset: number;
  limit: number;
  markets: MarketInfo[];
}

export const MAX_PAGE = 200;

/**
 * The factories' markets, a page at a time. With several stacks the order is the primary stack's
 * markets, then each extra stack's, each newest (or oldest) first.
 */
export async function listMarkets(ctx: HunchContext, options: ListOptions = {}): Promise<MarketPage> {
  const all = stacks(ctx);
  const counts = await stackCounts(ctx);
  const offset = Math.max(0, Math.floor(options.offset ?? 0));
  const limit = Math.min(MAX_PAGE, Math.max(1, Math.floor(options.limit ?? 50)));
  const total = counts.reduce((sum, c) => sum + c, 0);
  // Positions offset..offset+limit of the stacks laid end to end, as (stack, factory index).
  const picks: { stack: number; index: number }[] = [];
  for (let n = offset; n < Math.min(total, offset + limit); n++) {
    let rest = n;
    let s = 0;
    while (rest >= (counts[s] as number)) rest -= counts[s++] as number;
    const count = counts[s] as number;
    picks.push({ stack: s, index: options.order === "oldest" ? rest : count - 1 - rest });
  }
  const results = await multicall(
    ctx,
    picks.map((p) => ({
      address: all[p.stack]?.contracts.factory as Address,
      abi: hunchBookFactoryAbi,
      functionName: "marketAt",
      args: [BigInt(p.index)],
    })),
  );
  const markets: MarketInfo[] = [];
  for (let s = 0; s < all.length; s++) {
    const addresses = picks.flatMap((p, i) => {
      const a = p.stack === s ? ok<Address>(results[i]) : undefined;
      return a ? [a] : [];
    });
    if (addresses.length > 0) markets.push(...(await readMarkets(ctx, addresses, all[s])));
  }
  return { total, offset, limit, markets };
}

/** Every market the factories have created (all stacks), read in pages. */
export async function listAllMarkets(ctx: HunchContext): Promise<MarketInfo[]> {
  const out: MarketInfo[] = [];
  for (let offset = 0; ; offset += MAX_PAGE) {
    const page = await listMarkets(ctx, { offset, limit: MAX_PAGE });
    out.push(...page.markets);
    if (offset + MAX_PAGE >= page.total) return out;
  }
}

/**
 * One market in full, or null when no factory knows the address. Every stack's factory is asked with
 * `isMarket` first, so an arbitrary contract is never read as a Hunch Book market.
 */
export async function getMarket(ctx: HunchContext, address: Address): Promise<MarketInfo | null> {
  const all = stacks(ctx);
  const results = await multicall(ctx, [
    ...all.map((s) => ({
      address: s.contracts.factory as Address,
      abi: hunchBookFactoryAbi,
      functionName: "isMarket",
      args: [address],
    })),
    ...marketCalls(address),
  ]);
  const checks = results.slice(0, all.length);
  const failed = checks.find((c) => !c || c.status === "failure");
  if (failed && failed.status === "failure") throw failed.error;
  if (failed) throw new Error("Could not ask the factory about this address.");
  const at = checks.findIndex((c) => c?.status === "success" && c.result === true);
  if (at < 0) return null;
  const parsed = parseMarket(ctx, address, results, all.length);
  if (!parsed) throw new Error(`Could not read market ${address} from the chain.`);
  const [full] = await withExtras(ctx, [{ ...parsed, ...stackTag(all[at]) }]);
  return full ?? null;
}

/** A market by address, or the error that says it is not one. */
export async function requireMarket(ctx: HunchContext, market: Address | MarketInfo): Promise<MarketInfo> {
  if (typeof market !== "string") return market;
  const info = await getMarket(ctx, market);
  if (!info) throw new Error(`${market} is not a Hunch Book market on ${ctx.deployment.network}.`);
  return info;
}

/** One wallet in one market: stakes, claims, token balances. */
export interface Position {
  market: Address;
  stake: { yes: bigint; no: bigint };
  claimableTokens: { yes: bigint; no: bigint };
  claimablePool: { paid: bigint; fee: bigint };
  balances: { yes: bigint; no: bigint };
}

export function hasPosition(p: Position): boolean {
  return (
    p.stake.yes +
      p.stake.no +
      p.claimableTokens.yes +
      p.claimableTokens.no +
      p.claimablePool.paid +
      p.balances.yes +
      p.balances.no >
    0n
  );
}

const PER_POSITION = 5;

function positionCalls(m: Pick<MarketInfo, "address" | "tokens">, user: Address): Call[] {
  return [
    { address: m.address, abi: marketAbi, functionName: "stakeOf", args: [user] },
    { address: m.address, abi: marketAbi, functionName: "claimableTokens", args: [user] },
    { address: m.address, abi: marketAbi, functionName: "claimablePool", args: [user] },
    { address: m.tokens.yes, abi: erc20Abi, functionName: "balanceOf", args: [user] },
    { address: m.tokens.no, abi: erc20Abi, functionName: "balanceOf", args: [user] },
  ];
}

function parsePosition(market: Address, results: CallResult[], at: number): Position {
  const pair = (r: CallResult | undefined): readonly [bigint, bigint] =>
    ok<readonly [bigint, bigint]>(r) ?? [0n, 0n];
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
}

/** One wallet's position in one market. */
export async function getPosition(
  ctx: HunchContext,
  market: Address | MarketInfo,
  user: Address,
): Promise<Position> {
  const m = await requireMarket(ctx, market);
  const results = await multicall(ctx, positionCalls(m, user));
  return parsePosition(m.address, results, 0);
}

export interface PortfolioEntry extends Position {
  info: MarketInfo;
}

/** A wallet's positions across every market, only the ones with something in them. */
export async function getPortfolio(
  ctx: HunchContext,
  user: Address,
  options: { markets?: MarketInfo[] } = {},
): Promise<PortfolioEntry[]> {
  const markets = options.markets ?? (await listAllMarkets(ctx));
  const results = await multicall(
    ctx,
    markets.flatMap((m) => positionCalls(m, user)),
  );
  return markets
    .map((info, i) => ({ ...parsePosition(info.address, results, i * PER_POSITION), info }))
    .filter(hasPosition);
}

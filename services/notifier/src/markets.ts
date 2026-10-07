import { type Deployment, hunchBookFactoryAbi, marketAbi, resolverAbi, stacksOf } from "@hunch-book/shared";
import {
  type Abi,
  type Address,
  type ContractFunctionParameters,
  erc20Abi,
  getAddress,
  isAddressEqual,
  maxUint256,
  zeroAddress,
} from "viem";

// What the notifier knows about each market at one moment, read from the chain (the factory and each
// market, with Kuru's best bid and ask for the book price) or, when INDEXER_URL is set, from the
// indexer with the chain as the fallback.

export const Phase = { Pool: 0, PoolLocked: 1, Graduated: 2, Closed: 3, Settled: 4, Voided: 5 } as const;
export const Outcome = { Unresolved: 0, Yes: 1, No: 2 } as const;

export interface MarketState {
  address: Address;
  marketId: number;
  phase: number;
  outcome: number;
  graduated: boolean;
  /** YES chance in basis points: pool split before graduation, book mid after. Null when there is none. */
  chanceBps: number | null;
  /** Pool total in USDC base units (frozen at graduation). */
  poolTotal: bigint;
  /** The resolver's rule sentence, or null. */
  question: string | null;
  yes: Address;
  no: Address;
}

export interface Position {
  stakeYes: bigint;
  stakeNo: bigint;
  yes: bigint;
  no: bigint;
  claimableYes: bigint;
  claimableNo: bigint;
  /** Pool payout claimable after a pool-only settlement or void. */
  claimablePool: bigint;
}

type Client = {
  readContract(args: {
    address: Address;
    abi: Abi;
    functionName: string;
    args?: readonly unknown[];
  }): Promise<unknown>;
  multicall(args: {
    contracts: readonly ContractFunctionParameters[];
    allowFailure: true;
    batchSize?: number;
  }): Promise<({ status: "success"; result: unknown } | { status: "failure"; error: Error })[]>;
};

const kuruBestBidAskAbi = [
  {
    type: "function",
    name: "bestBidAsk",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "", type: "uint256" },
      { name: "", type: "uint256" },
    ],
  },
] as const;

const call = (address: Address, abi: Abi, functionName: string, args?: readonly unknown[]) =>
  ({ address, abi, functionName, ...(args ? { args } : {}) }) as unknown as ContractFunctionParameters;

const ok = <T>(r: { status: string; result?: unknown } | undefined): T | undefined =>
  r?.status === "success" ? (r.result as T) : undefined;

const PRICE_SCALE = 10n ** 18n;

/**
 * Book mid as basis points; null unless both sides have orders. Kuru v1 answers best bid and ask at 1e18
 * (empty: 0 or 2^256 - 1); Kuru v2 answers uint32 prices in pricePrecision units, 1e6 on Hunch books
 * (empty: 0 or 2^32 - 1).
 */
export function midBps(bid: bigint, ask: bigint, kuruVersion: 1 | 2 = 1): number | null {
  const v2 = kuruVersion === 2;
  const empty = (v: bigint) => v === 0n || (v2 ? v >= 2n ** 32n - 1n : v === maxUint256);
  if (empty(bid) || empty(ask)) return null;
  const bps = Number((((bid + ask) / 2n) * 10_000n) / (v2 ? 1_000_000n : PRICE_SCALE));
  return Math.min(10_000, Math.max(0, bps));
}

const FIELDS = [
  "marketId",
  "phase",
  "outcome",
  "graduated",
  "poolTotals",
  "tokens",
  "book",
  "resolver",
  "params",
] as const;

/** Every market of every stack's factory, with its chance and its rule sentence. */
export async function readMarketsFromChain(
  client: Client,
  deployment: Deployment,
  limit = 500,
): Promise<MarketState[]> {
  const addresses: Address[] = [];
  const version = new Map<string, 1 | 2>();
  for (const stack of stacksOf(deployment)) {
    const factory = stack.contracts.factory as Address;
    const count = Number(
      (await client.readContract({
        address: factory,
        abi: hunchBookFactoryAbi as Abi,
        functionName: "marketCount",
      })) as bigint,
    );
    const n = Math.min(count, limit);
    const at = await client.multicall({
      allowFailure: true,
      batchSize: 16_384,
      contracts: Array.from({ length: n }, (_, i) =>
        call(factory, hunchBookFactoryAbi as Abi, "marketAt", [BigInt(i)]),
      ),
    });
    for (const r of at) {
      const a = ok<Address>(r);
      if (!a) continue;
      addresses.push(a);
      version.set(a.toLowerCase(), stack.kuruVersion);
    }
  }
  const fields = await client.multicall({
    allowFailure: true,
    batchSize: 16_384,
    contracts: addresses.flatMap((a) => FIELDS.map((f) => call(a, marketAbi as Abi, f))),
  });
  const base = addresses.flatMap((address, i) => {
    const get = <T>(f: (typeof FIELDS)[number]) => ok<T>(fields[i * FIELDS.length + FIELDS.indexOf(f)]);
    const totals = get<readonly [bigint, bigint, number]>("poolTotals");
    const tokens = get<readonly [Address, Address]>("tokens");
    const phase = get<number>("phase");
    if (!totals || !tokens || phase === undefined) return [];
    const book = get<Address>("book");
    return [
      {
        address,
        marketId: Number(get<bigint>("marketId") ?? 0n),
        phase: Number(phase),
        outcome: Number(get<number>("outcome") ?? 0),
        graduated: get<boolean>("graduated") ?? false,
        yesTotal: totals[0],
        noTotal: totals[1],
        yes: tokens[0],
        no: tokens[1],
        book: book && !isAddressEqual(book, zeroAddress) ? book : null,
        resolver: get<Address>("resolver"),
        params: get<`0x${string}`>("params"),
      },
    ];
  });
  const extra = await client.multicall({
    allowFailure: true,
    batchSize: 16_384,
    contracts: base.flatMap((m) => [
      m.resolver && m.params
        ? call(m.resolver, resolverAbi as Abi, "describe", [m.params])
        : call(m.address, marketAbi as Abi, "phase"),
      m.book
        ? call(m.book, kuruBestBidAskAbi as Abi, "bestBidAsk")
        : call(m.address, marketAbi as Abi, "phase"),
    ]),
  });
  return base.map((m, i) => {
    const sentence = m.resolver && m.params ? ok<string>(extra[i * 2]) : undefined;
    const quote = m.book ? ok<readonly [bigint, bigint]>(extra[i * 2 + 1]) : undefined;
    const total = m.yesTotal + m.noTotal;
    const chanceBps = m.graduated
      ? quote
        ? midBps(quote[0], quote[1], version.get(m.address.toLowerCase()) ?? 1)
        : null
      : total > 0n
        ? Number((m.yesTotal * 10_000n) / total)
        : null;
    return {
      address: m.address,
      marketId: m.marketId,
      phase: m.phase,
      outcome: m.outcome,
      graduated: m.graduated,
      chanceBps,
      poolTotal: total,
      question: sentence?.trim() ? sentence.trim() : null,
      yes: m.yes,
      no: m.no,
    };
  });
}

const STAGE_PHASE: Record<string, number> = {
  Pool: Phase.Pool,
  Graduated: Phase.Graduated,
  Settled: Phase.Settled,
  Voided: Phase.Voided,
};
const OUTCOME: Record<string, number> = { Unresolved: Outcome.Unresolved, Yes: Outcome.Yes, No: Outcome.No };

export const INDEXER_MARKETS_QUERY = `query NotifierMarkets {
  Market(order_by: {number: asc}, limit: 500) {
    id number stage outcome graduated impliedChanceBps lastPriceE6 question poolTotal yesToken noToken
  }
}`;

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** The same states from the indexer. Pool-locked and closed read as their stage (Pool, Graduated). */
export async function readMarketsFromIndexer(
  indexerUrl: string,
  fetchImpl: Fetch = fetch,
): Promise<MarketState[]> {
  const res = await fetchImpl(indexerUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: INDEXER_MARKETS_QUERY }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`the indexer answered ${res.status}`);
  const body = (await res.json()) as {
    data?: {
      Market?: {
        id: string;
        number: number;
        stage: string;
        outcome: string;
        graduated: boolean;
        impliedChanceBps: number;
        lastPriceE6: string | null;
        question: string | null;
        poolTotal: string;
        yesToken: string;
        noToken: string;
      }[];
    };
    errors?: unknown;
  };
  if (body.errors || !body.data?.Market) throw new Error("the indexer answered with errors");
  return body.data.Market.map((m) => ({
    address: getAddress(m.id),
    marketId: Number(m.number),
    phase: STAGE_PHASE[m.stage] ?? Phase.Pool,
    outcome: OUTCOME[m.outcome] ?? Outcome.Unresolved,
    graduated: m.graduated,
    chanceBps: m.graduated
      ? m.lastPriceE6 === null
        ? null
        : Math.round(Number(m.lastPriceE6) / 100)
      : BigInt(m.poolTotal) > 0n
        ? m.impliedChanceBps
        : null,
    poolTotal: BigInt(m.poolTotal),
    question: m.question,
    yes: getAddress(m.yesToken),
    no: getAddress(m.noToken),
  }));
}

/** Each wallet's position in each market: stakes, token balances and claims, one multicall. */
export async function readPositions(
  client: Client,
  markets: readonly MarketState[],
  wallets: readonly Address[],
): Promise<Map<string, Position>> {
  const pairs = wallets.flatMap((w) => markets.map((m) => ({ w, m })));
  const PER = 5;
  const results = await client.multicall({
    allowFailure: true,
    batchSize: 16_384,
    contracts: pairs.flatMap(({ w, m }) => [
      call(m.address, marketAbi as Abi, "stakeOf", [w]),
      call(m.address, marketAbi as Abi, "claimableTokens", [w]),
      call(m.address, marketAbi as Abi, "claimablePool", [w]),
      call(m.yes, erc20Abi as Abi, "balanceOf", [w]),
      call(m.no, erc20Abi as Abi, "balanceOf", [w]),
    ]),
  });
  const out = new Map<string, Position>();
  pairs.forEach(({ w, m }, i) => {
    const pair = (k: number) => ok<readonly [bigint, bigint]>(results[i * PER + k]) ?? [0n, 0n];
    const stake = pair(0);
    const claimable = pair(1);
    const pool = pair(2);
    out.set(positionKey(w, m.address), {
      stakeYes: stake[0],
      stakeNo: stake[1],
      claimableYes: claimable[0],
      claimableNo: claimable[1],
      claimablePool: pool[0],
      yes: ok<bigint>(results[i * PER + 3]) ?? 0n,
      no: ok<bigint>(results[i * PER + 4]) ?? 0n,
    });
  });
  return out;
}

export const positionKey = (wallet: Address, market: Address) =>
  `${wallet.toLowerCase()}:${market.toLowerCase()}`;

export function hasPosition(p: Position | undefined): boolean {
  if (!p) return false;
  return p.stakeYes + p.stakeNo + p.yes + p.no + p.claimableYes + p.claimableNo + p.claimablePool > 0n;
}

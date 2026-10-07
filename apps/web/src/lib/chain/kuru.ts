import {
  decodeL2Book,
  type KuruMatchParams,
  kuruOrderBookAbi as kuruBookAbi,
  kuruV2OrderBookAbi,
  type L2Level,
  l2BookFromV2,
} from "@hunch-book/shared";
import { type Abi, type Address, isAddressEqual } from "viem";
import { MULTICALL3, type ReadClient } from "./client";

// The one Kuru OrderBook view the market list needs. This matches
// `function bestBidAsk() external view returns (uint256, uint256)` on Kuru's OrderBook (PROTOCOL.md §8.1).
export const kuruOrderBookAbi = [
  {
    type: "function",
    name: "bestBidAsk",
    inputs: [],
    outputs: [
      { name: "bestBid", type: "uint256", internalType: "uint256" },
      { name: "bestAsk", type: "uint256", internalType: "uint256" },
    ],
    stateMutability: "view",
  },
] as const;

/** Kuru's MarketState: 0 active, 1 soft-paused (cancels only), 2 hard-paused. */
export const BookState = { Active: 0, SoftPaused: 1, HardPaused: 2 } as const;

/** Levels per side whose resting orders are attributed to an owner (our maker). */
export const ATTRIBUTED_LEVELS = 12;
/** Orders followed per level before giving up on attribution for it. */
const MAX_ORDERS_PER_LEVEL = 64;

export interface BookParams extends KuruMatchParams {
  tickSize: bigint;
  minSize: bigint;
  maxSize: bigint;
  base: Address;
  quote: Address;
}

/** One read of a Kuru YES/USDC book: resting levels, the market params and who rests where. */
export interface BookSnapshot {
  address: Address;
  /** The block the L2 view was read at. */
  block: bigint;
  /** Browser time of the read, unix milliseconds. */
  readAt: number;
  /** Best (highest) bid first, book units. */
  bids: L2Level[];
  /** Best (lowest) ask first, book units. */
  asks: L2Level[];
  params: BookParams;
  state: number;
  /**
   * Size resting from `owner` at each of the first ATTRIBUTED_LEVELS levels (same order as bids and asks),
   * or null when the owner is unknown or the walk failed.
   */
  owned: { bids: bigint[]; asks: bigint[] } | null;
}

type Result = { status: "success"; result: unknown } | { status: "failure"; error: Error };

async function multicall(
  client: ReadClient,
  calls: { address: Address; functionName: string; args?: readonly unknown[] }[],
): Promise<Result[]> {
  if (calls.length === 0) return [];
  const results = await client.multicall({
    contracts: calls.map((c) => ({ ...c, abi: kuruBookAbi as Abi })) as never,
    allowFailure: true,
    multicallAddress: MULTICALL3,
  });
  return results as Result[];
}

const value = <T>(r: Result | undefined): T => {
  if (r?.status !== "success") throw r?.status === "failure" ? r.error : new Error("missing result");
  return r.result as T;
};

type MarketParamsTuple = readonly [
  number,
  bigint,
  Address,
  bigint,
  Address,
  bigint,
  number,
  bigint,
  bigint,
  bigint,
  bigint,
];

export function parseBookParams(t: MarketParamsTuple): BookParams {
  return {
    pricePrecision: BigInt(t[0]),
    sizePrecision: BigInt(t[1]),
    base: t[2],
    baseDecimals: Number(t[3]),
    quote: t[4],
    quoteDecimals: Number(t[5]),
    tickSize: BigInt(t[6]),
    minSize: BigInt(t[7]),
    maxSize: BigInt(t[8]),
    takerFeeBps: BigInt(t[9]),
  };
}

/**
 * Sums `owner`'s resting size at each level by walking each price point's order list from its head
 * (Kuru keeps only live orders from the head on; an order's `size` is what still rests).
 */
export async function readOwnedSizes(
  client: ReadClient,
  book: Address,
  levels: { bids: readonly L2Level[]; asks: readonly L2Level[] },
  owner: Address,
): Promise<{ bids: bigint[]; asks: bigint[] }> {
  const points = [
    ...levels.bids.slice(0, ATTRIBUTED_LEVELS).map((l, i) => ({ side: "bids" as const, i, price: l.price })),
    ...levels.asks.slice(0, ATTRIBUTED_LEVELS).map((l, i) => ({ side: "asks" as const, i, price: l.price })),
  ];
  const owned = {
    bids: levels.bids.slice(0, ATTRIBUTED_LEVELS).map(() => 0n),
    asks: levels.asks.slice(0, ATTRIBUTED_LEVELS).map(() => 0n),
  };
  const heads = await multicall(
    client,
    points.map((p) => ({
      address: book,
      functionName: p.side === "bids" ? "s_buyPricePoints" : "s_sellPricePoints",
      args: [p.price],
    })),
  );
  let frontier = points
    .map((p, n) => ({ point: p, id: BigInt(value<readonly [number, number]>(heads[n])[0]) }))
    .filter((f) => f.id !== 0n);
  for (let depth = 0; frontier.length > 0 && depth < MAX_ORDERS_PER_LEVEL; depth++) {
    const orders = await multicall(
      client,
      frontier.map((f) => ({ address: book, functionName: "s_orders", args: [Number(f.id)] })),
    );
    const next: typeof frontier = [];
    frontier.forEach((f, n) => {
      const [orderOwner, size, , nextId, , price] = value<
        readonly [Address, bigint, number, number, number, number, number, boolean]
      >(orders[n]);
      if (price !== 0 && isAddressEqual(orderOwner, owner)) {
        owned[f.point.side][f.point.i] = (owned[f.point.side][f.point.i] ?? 0n) + size;
      }
      if (nextId !== 0) next.push({ point: f.point, id: BigInt(nextId) });
    });
    frontier = next;
  }
  return owned;
}

/** Levels per side read from a Kuru v2 book. */
const V2_LEVELS = 64n;

/**
 * A Kuru v2 book (docs/PROTOCOL.md §8.1, Kuru v2) as the same snapshot: levels from getL2Book(levels),
 * the params with the taker fee in pps (which selects v2 matching in the shared quote code), and no
 * owner attribution (v2 orders sit in per-account slots that the book does not expose by price).
 * Swaps have no minimum size; minQuoteNotional applies to resting orders only.
 */
export async function readBookSnapshotV2(client: ReadClient, book: Address): Promise<BookSnapshot> {
  const [head, results] = await Promise.all([
    client.getBlock(),
    client.multicall({
      contracts: [
        { address: book, abi: kuruV2OrderBookAbi, functionName: "getL2Book", args: [V2_LEVELS] },
        { address: book, abi: kuruV2OrderBookAbi, functionName: "getMarketParams" },
        { address: book, abi: kuruV2OrderBookAbi, functionName: "marketState" },
        { address: book, abi: kuruV2OrderBookAbi, functionName: "baseToken" },
        { address: book, abi: kuruV2OrderBookAbi, functionName: "quoteToken" },
      ],
      allowFailure: true,
      multicallAddress: MULTICALL3,
    }),
  ]);
  const [l2, params, state, base, quote] = results;
  if (
    l2.status !== "success" ||
    params.status !== "success" ||
    base.status !== "success" ||
    quote.status !== "success"
  ) {
    throw new Error("Could not read this Kuru v2 book.");
  }
  const block = head.number;
  const levels = l2BookFromV2(l2.result, block);
  const [pricePrecision, sizePrecision, tickSize, , maxQuoteNotional, takerFeePps] = params.result;
  return {
    address: book,
    block,
    readAt: Date.now(),
    bids: levels.bids,
    asks: levels.asks,
    params: {
      pricePrecision: BigInt(pricePrecision),
      sizePrecision: BigInt(sizePrecision),
      // Hunch books are 6-decimal YES against 6-decimal USDC on both versions (GraduatorV2 checks it).
      baseDecimals: 6,
      quoteDecimals: 6,
      base: base.result,
      quote: quote.result,
      tickSize: BigInt(tickSize),
      minSize: 1n,
      maxSize: (BigInt(maxQuoteNotional) * BigInt(sizePrecision)) / BigInt(pricePrecision),
      takerFeeBps: takerFeePps / 1000n,
      takerFeePps,
    },
    state: state.status === "success" ? Number(state.result) : BookState.Active,
    owned: null,
  };
}

/** Reads a book's L2 levels, params and state in one call, then attributes `owner`'s orders. */
export async function readBookSnapshot(
  client: ReadClient,
  book: Address,
  owner?: Address,
  kuruVersion: 1 | 2 = 1,
): Promise<BookSnapshot> {
  if (kuruVersion === 2) return readBookSnapshotV2(client, book);
  const [l2, params, state] = await multicall(client, [
    { address: book, functionName: "getL2Book" },
    { address: book, functionName: "getMarketParams" },
    { address: book, functionName: "marketState" },
  ]);
  const decoded = decodeL2Book(value<`0x${string}`>(l2));
  const snapshot: BookSnapshot = {
    address: book,
    block: decoded.block,
    readAt: Date.now(),
    bids: decoded.bids,
    asks: decoded.asks,
    params: parseBookParams(value<MarketParamsTuple>(params)),
    state: state?.status === "success" ? Number(state.result) : BookState.Active,
    owned: null,
  };
  if (owner) {
    // Walking the order lists costs extra calls, so it runs again only when the levels change (or every
    // OWNED_TTL_MS, in case orders changed hands at the same price and size).
    const key = `${book}:${owner}:${levelsKey(decoded)}`;
    const cached = ownedCache.get(book.toLowerCase());
    if (cached?.key === key && Date.now() - cached.at < OWNED_TTL_MS) {
      snapshot.owned = cached.owned;
    } else {
      try {
        snapshot.owned = await readOwnedSizes(client, book, decoded, owner);
        ownedCache.set(book.toLowerCase(), { key, owned: snapshot.owned, at: Date.now() });
      } catch {
        snapshot.owned = null;
      }
    }
  }
  return snapshot;
}

const OWNED_TTL_MS = 30_000;
const ownedCache = new Map<string, { key: string; owned: { bids: bigint[]; asks: bigint[] }; at: number }>();

const levelsKey = (l: { bids: readonly L2Level[]; asks: readonly L2Level[] }): string =>
  [...l.bids.slice(0, ATTRIBUTED_LEVELS), { price: 0n, size: 0n }, ...l.asks.slice(0, ATTRIBUTED_LEVELS)]
    .map((x) => `${x.price}:${x.size}`)
    .join(",");

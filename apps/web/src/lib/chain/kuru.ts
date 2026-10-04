import {
  decodeL2Book,
  type KuruMatchParams,
  kuruOrderBookAbi as kuruBookAbi,
  type L2Level,
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

/** Reads a book's L2 levels, params and state in one call, then attributes `owner`'s orders. */
export async function readBookSnapshot(
  client: ReadClient,
  book: Address,
  owner?: Address,
): Promise<BookSnapshot> {
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
    try {
      snapshot.owned = await readOwnedSizes(client, book, decoded, owner);
    } catch {
      snapshot.owned = null;
    }
  }
  return snapshot;
}

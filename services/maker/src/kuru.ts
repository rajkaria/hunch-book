import { decodeL2Book, kuruOrderBookAbi, type L2Book } from "@hunch-book/shared";
import { type Address, isAddressEqual, type PublicClient } from "viem";
import { classifyOrder, type LiveOrder, type OrderStatus } from "./orders.js";
import type { BookSpec } from "./quotes.js";

// Reads from one Kuru book. Nothing here sends a transaction.

export interface BookInfo extends BookSpec {
  base: Address;
  quote: Address;
  takerFeeBps: bigint;
  makerFeeBps: bigint;
}

/** Kuru's MarketState: 0 active, 1 soft-paused (cancels only), 2 hard-paused. */
export const MarketState = { Active: 0, SoftPaused: 1, HardPaused: 2 } as const;

export async function readBookInfo(client: PublicClient, book: Address): Promise<BookInfo> {
  const [
    pricePrecision,
    sizePrecision,
    base,
    baseDecimals,
    quote,
    quoteDecimals,
    tickSize,
    minSize,
    maxSize,
    takerFeeBps,
    makerFeeBps,
  ] = await client.readContract({ address: book, abi: kuruOrderBookAbi, functionName: "getMarketParams" });
  return {
    pricePrecision: Number(pricePrecision),
    sizePrecision,
    tickSize: Number(tickSize),
    minSize,
    maxSize,
    baseDecimals: Number(baseDecimals),
    quoteDecimals: Number(quoteDecimals),
    base,
    quote,
    takerFeeBps,
    makerFeeBps,
  };
}

export async function readL2Book(client: PublicClient, book: Address): Promise<L2Book> {
  const data = await client.readContract({ address: book, abi: kuruOrderBookAbi, functionName: "getL2Book" });
  return decodeL2Book(data);
}

export async function readMarketState(client: PublicClient, book: Address): Promise<number> {
  return client.readContract({ address: book, abi: kuruOrderBookAbi, functionName: "marketState" });
}

interface RawOrder {
  owner: Address;
  size: bigint;
  next: bigint;
  price: number;
  isBuy: boolean;
}

async function readOrders(client: PublicClient, book: Address, ids: bigint[]): Promise<RawOrder[]> {
  if (ids.length === 0) return [];
  const results = await client.multicall({
    allowFailure: false,
    contracts: ids.map((id) => ({
      address: book,
      abi: kuruOrderBookAbi,
      functionName: "s_orders" as const,
      args: [Number(id)] as const,
    })),
  });
  return results.map(([owner, size, , next, , price, , isBuy]) => ({
    owner,
    size,
    next: BigInt(next),
    price: Number(price),
    isBuy,
  }));
}

async function readHeads(
  client: PublicClient,
  book: Address,
  points: { price: number; isBuy: boolean }[],
): Promise<bigint[]> {
  if (points.length === 0) return [];
  const results = await client.multicall({
    allowFailure: false,
    contracts: points.map((p) => ({
      address: book,
      abi: kuruOrderBookAbi,
      functionName: p.isBuy ? ("s_buyPricePoints" as const) : ("s_sellPricePoints" as const),
      args: [BigInt(p.price)] as const,
    })),
  });
  return results.map(([head]) => BigInt(head));
}

/** Where each of our ids stands now: resting (with its remaining size), filled, or gone. */
export async function readOrderStatuses(
  client: PublicClient,
  book: Address,
  ids: bigint[],
  me: Address,
): Promise<Map<bigint, OrderStatus>> {
  const orders = await readOrders(client, book, ids);
  const heads = await readHeads(
    client,
    book,
    orders.map((o) => ({ price: o.price, isBuy: o.isBuy })),
  );
  const out = new Map<bigint, OrderStatus>();
  ids.forEach((id, i) => {
    const order = orders[i] as RawOrder;
    out.set(id, classifyOrder(order, heads[i] as bigint, id, me));
  });
  return out;
}

/**
 * Every order of ours resting on the book, found by walking each price level's linked list from its head.
 * Used at startup and after a transaction whose outcome is unknown, so no order is ever lost track of.
 */
export async function findOwnOrders(
  client: PublicClient,
  book: Address,
  me: Address,
  l2: L2Book,
): Promise<LiveOrder[]> {
  const points = [
    ...l2.bids.map((l) => ({ price: Number(l.price), isBuy: true })),
    ...l2.asks.map((l) => ({ price: Number(l.price), isBuy: false })),
  ];
  let frontier = (await readHeads(client, book, points)).filter((id) => id !== 0n);
  const found: LiveOrder[] = [];
  for (let depth = 0; frontier.length > 0 && depth < 1_000; depth++) {
    const orders = await readOrders(client, book, frontier);
    const next: bigint[] = [];
    orders.forEach((o, i) => {
      if (o.price !== 0 && isAddressEqual(o.owner, me)) {
        found.push({
          id: frontier[i] as bigint,
          isBuy: o.isBuy,
          price: o.price,
          size: o.size,
          remaining: o.size,
        });
      }
      if (o.next !== 0n) next.push(o.next);
    });
    frontier = next;
  }
  return found;
}

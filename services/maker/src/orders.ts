import { kuruOrderBookAbi } from "@hunch-book/shared";
import { type Address, decodeEventLog, getAbiItem, isAddressEqual, type Log, toEventSelector } from "viem";
import type { Order, Quotes } from "./quotes.js";

// Tracks the bot's own resting orders on one Kuru book.
//
// Kuru facts this encodes:
// - Order ids exist only in the unindexed OrderCreated event (or s_orderIdCounter), so ids are read from
//   our own receipts, filtering by the book's address and our address.
// - Cancelling an id twice reverts (OnlyOwnerAllowedError), even inside batchUpdate. Once an id has been
//   sent in a cancel that landed, or seen filled or gone, it is retired and never cancelled again.
// - Cancelling a filled id inside batchUpdate is a no-op, so an order that fills between our status read
//   and our batch is harmless.

export interface LiveOrder {
  id: bigint;
  isBuy: boolean;
  price: number;
  /** Size when placed, sizePrecision units. */
  size: bigint;
  /** Size still resting, sizePrecision units. */
  remaining: bigint;
}

/** What the book says about one of our ids right now. */
export type OrderStatus =
  | { kind: "active"; remaining: bigint }
  | { kind: "filled" }
  /** Deleted: cancelled (perhaps by another process) or cancelled after filling. */
  | { kind: "gone" };

export interface Fill {
  id: bigint;
  isBuy: boolean;
  price: number;
  size: bigint;
  /** True when the order has no size left. */
  complete: boolean;
}

const ORDER_CREATED = toEventSelector(getAbiItem({ abi: kuruOrderBookAbi, name: "OrderCreated" }));

/** Orders created for `owner` on `book` in a receipt's logs. Other books and other owners are ignored. */
export function parseOrderCreated(logs: Log[], book: Address, owner: Address): LiveOrder[] {
  const out: LiveOrder[] = [];
  for (const log of logs) {
    if (!isAddressEqual(log.address, book) || log.topics[0] !== ORDER_CREATED) continue;
    const { args } = decodeEventLog({
      abi: kuruOrderBookAbi,
      eventName: "OrderCreated",
      data: log.data,
      topics: log.topics,
    });
    if (!isAddressEqual(args.owner, owner)) continue;
    out.push({
      id: BigInt(args.orderId),
      isBuy: args.isBuy,
      price: Number(args.price),
      size: args.size,
      remaining: args.size,
    });
  }
  return out;
}

/**
 * Kuru's own rule (OrderBook._checkIfCancelledOrFilled): a deleted order has price 0; an order is filled
 * once its price point's head has moved past it (or the point is empty).
 */
export function classifyOrder(
  order: { owner: Address; size: bigint; price: number },
  head: bigint,
  id: bigint,
  me: Address,
): OrderStatus {
  if (order.price === 0 || !isAddressEqual(order.owner, me)) return { kind: "gone" };
  if (head === 0n || head > id) return { kind: "filled" };
  return { kind: "active", remaining: order.size };
}

export class OrderTracker {
  private readonly live = new Map<bigint, LiveOrder>();
  private readonly retired = new Set<bigint>();

  /** Starts tracking orders (from our receipts, or found on the book after a restart). */
  adopt(orders: LiveOrder[]): void {
    for (const order of orders) {
      if (!this.retired.has(order.id) && !this.live.has(order.id)) this.live.set(order.id, { ...order });
    }
  }

  /** Applies fresh statuses; returns the fills since the last update. Filled and gone ids are retired. */
  update(statuses: Map<bigint, OrderStatus>): Fill[] {
    const fills: Fill[] = [];
    for (const [id, order] of this.live) {
      const status = statuses.get(id);
      if (!status) continue;
      if (status.kind === "active") {
        if (status.remaining < order.remaining) {
          fills.push({ ...pick(order), size: order.remaining - status.remaining, complete: false });
          order.remaining = status.remaining;
        }
      } else {
        if (status.kind === "filled") fills.push({ ...pick(order), size: order.remaining, complete: true });
        this.retire([id]);
      }
    }
    return fills;
  }

  /** Ids to put in the next cancel. Never includes a retired id. */
  cancelIds(): bigint[] {
    return [...this.live.keys()].sort((a, b) => (a < b ? -1 : 1));
  }

  /** Call once a transaction that cancelled these ids has landed. They are never cancelled again. */
  retire(ids: bigint[]): void {
    for (const id of ids) {
      this.live.delete(id);
      this.retired.add(id);
    }
  }

  isRetired(id: bigint): boolean {
    return this.retired.has(id);
  }

  orders(): LiveOrder[] {
    return [...this.live.values()];
  }

  /** Resting orders as quotes (remaining sizes), for comparison with what the bot wants. */
  quotes(): Quotes {
    const toOrder = (o: LiveOrder): Order => ({ price: o.price, size: o.remaining });
    const all = this.orders();
    return { bids: all.filter((o) => o.isBuy).map(toOrder), asks: all.filter((o) => !o.isBuy).map(toOrder) };
  }

  /** Remaining size by price, per side. */
  sizeByPrice(): { bids: Map<number, bigint>; asks: Map<number, bigint> } {
    const bids = new Map<number, bigint>();
    const asks = new Map<number, bigint>();
    for (const o of this.live.values()) {
      const side = o.isBuy ? bids : asks;
      side.set(o.price, (side.get(o.price) ?? 0n) + o.remaining);
    }
    return { bids, asks };
  }
}

function pick(order: LiveOrder) {
  return { id: order.id, isBuy: order.isBuy, price: order.price };
}

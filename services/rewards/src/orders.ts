import type { L2Level } from "@hunch-book/shared";
import { type Address, getAddress } from "viem";

// Who rests what on a Kuru book, rebuilt from Kuru's own events (getL2Book has prices and sizes but no
// owners). Each maker order is created by OrderCreated, shrinks with every Trade that fills it (Trade's
// updatedSize is the maker order's size left), and leaves on OrderCanceled or OrdersCanceled. Hunch
// books use price and size precision 10^6, so prices are USDC base units per YES (E6) and sizes are YES
// base units.

export type BookEvent =
  | {
      kind: "created";
      block: bigint;
      logIndex: number;
      orderId: bigint;
      owner: Address;
      price: bigint;
      size: bigint;
      isBuy: boolean;
    }
  | { kind: "filled"; block: bigint; logIndex: number; orderId: bigint; remaining: bigint }
  | { kind: "cancelled"; block: bigint; logIndex: number; orderIds: readonly bigint[] };

export interface RestingOrder {
  orderId: bigint;
  owner: Address;
  /** E6. */
  price: bigint;
  /** Size left, YES base units. */
  size: bigint;
  isBuy: boolean;
}

/** Events in chain order. */
export function sortEvents<T extends { block: bigint; logIndex: number }>(events: readonly T[]): T[] {
  return [...events].sort((a, b) =>
    a.block === b.block ? a.logIndex - b.logIndex : a.block < b.block ? -1 : 1,
  );
}

export class OrderBookState {
  private readonly orders = new Map<bigint, RestingOrder>();
  /** The last block whose events were applied. */
  block = 0n;

  apply(e: BookEvent): void {
    this.block = e.block;
    switch (e.kind) {
      case "created":
        if (e.size > 0n) {
          this.orders.set(e.orderId, {
            orderId: e.orderId,
            owner: getAddress(e.owner),
            price: e.price,
            size: e.size,
            isBuy: e.isBuy,
          });
        }
        return;
      case "filled": {
        const o = this.orders.get(e.orderId);
        if (!o) return;
        if (e.remaining === 0n) this.orders.delete(e.orderId);
        else o.size = e.remaining;
        return;
      }
      case "cancelled":
        for (const id of e.orderIds) this.orders.delete(id);
        return;
    }
  }

  applyAll(events: readonly BookEvent[]): void {
    for (const e of sortEvents(events)) this.apply(e);
  }

  resting(): RestingOrder[] {
    return [...this.orders.values()].map((o) => ({ ...o }));
  }

  /** The book by price level, as getL2Book reports it: bids high to low, asks low to high. */
  levels(): { bids: L2Level[]; asks: L2Level[] } {
    const bids = new Map<bigint, bigint>();
    const asks = new Map<bigint, bigint>();
    for (const o of this.orders.values()) {
      const side = o.isBuy ? bids : asks;
      side.set(o.price, (side.get(o.price) ?? 0n) + o.size);
    }
    const toLevels = (m: Map<bigint, bigint>, desc: boolean): L2Level[] =>
      [...m.entries()]
        .map(([price, size]) => ({ price, size }))
        .sort((a, b) => (a.price === b.price ? 0 : a.price < b.price !== desc ? -1 : 1));
    return { bids: toLevels(bids, true), asks: toLevels(asks, false) };
  }
}

/** True when two books hold the same size at every price: a check of the rebuilt book against getL2Book. */
export function sameLevels(
  a: { bids: L2Level[]; asks: L2Level[] },
  b: { bids: L2Level[]; asks: L2Level[] },
): boolean {
  const eq = (x: L2Level[], y: L2Level[]) =>
    x.length === y.length && x.every((l, i) => l.price === y[i]?.price && l.size === y[i]?.size);
  return eq(a.bids, b.bids) && eq(a.asks, b.asks);
}

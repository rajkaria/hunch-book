import { kuruOrderBookAbi } from "@hunch-book/shared";
import {
  type Address,
  encodeAbiParameters,
  encodeEventTopics,
  getAbiItem,
  type Hex,
  type Log,
  zeroAddress,
} from "viem";
import { describe, expect, it } from "vitest";
import {
  classifyOrder,
  type LiveOrder,
  type OrderStatus,
  OrderTracker,
  parseOrderCreated,
} from "../src/orders.js";

const BOOK = "0x00000000000000000000000000000000000000b0" as Address;
const OTHER_BOOK = "0x00000000000000000000000000000000000000b1" as Address;
const ME = "0x0f1156Eb25DBebee5386EC80F1EB0B85C7dD232A" as Address;
const SOMEONE = "0x1f5AC9bB0DF7d0E0DD133cBd71388e1078475569" as Address;

const created = getAbiItem({ abi: kuruOrderBookAbi, name: "OrderCreated" });

function orderCreatedLog(
  address: Address,
  id: number,
  owner: Address,
  size: bigint,
  price: number,
  isBuy: boolean,
): Log {
  return {
    address,
    topics: encodeEventTopics({ abi: kuruOrderBookAbi, eventName: "OrderCreated" }) as [Hex],
    data: encodeAbiParameters(created.inputs, [id, owner, size, price, isBuy]),
    blockHash: null,
    blockNumber: null,
    logIndex: null,
    transactionHash: null,
    transactionIndex: null,
    removed: false,
  };
}

function cancelledLog(address: Address): Log {
  const item = getAbiItem({ abi: kuruOrderBookAbi, name: "OrderCanceled" });
  return {
    ...orderCreatedLog(address, 0, ME, 0n, 0, true),
    topics: encodeEventTopics({ abi: kuruOrderBookAbi, eventName: "OrderCanceled" }) as [Hex],
    data: encodeAbiParameters(item.inputs, [9, ME, 405_000, 1_000_000n, true]),
  };
}

const order = (id: bigint, isBuy: boolean, price: number, size: bigint): LiveOrder => ({
  id,
  isBuy,
  price,
  size,
  remaining: size,
});

describe("parseOrderCreated", () => {
  it("keeps only our orders on this book", () => {
    const logs = [
      orderCreatedLog(BOOK, 11, ME, 20_000_000n, 405_000, true),
      orderCreatedLog(BOOK, 12, SOMEONE, 5_000_000n, 404_000, true),
      orderCreatedLog(OTHER_BOOK, 13, ME, 20_000_000n, 435_000, false),
      cancelledLog(BOOK),
      orderCreatedLog(BOOK, 14, ME, 20_000_000n, 435_000, false),
    ];
    expect(parseOrderCreated(logs, BOOK, ME)).toEqual([
      order(11n, true, 405_000, 20_000_000n),
      order(14n, false, 435_000, 20_000_000n),
    ]);
  });
});

describe("classifyOrder (Kuru's _checkIfCancelledOrFilled)", () => {
  const resting = { owner: ME, size: 7_000_000n, price: 405_000 };
  it("reads a deleted or foreign order as gone", () => {
    expect(classifyOrder({ owner: zeroAddress, size: 0n, price: 0 }, 5n, 5n, ME)).toEqual({ kind: "gone" });
    expect(classifyOrder({ ...resting, owner: SOMEONE }, 5n, 5n, ME)).toEqual({ kind: "gone" });
  });
  it("reads an order behind the price point's head as filled", () => {
    expect(classifyOrder(resting, 0n, 5n, ME)).toEqual({ kind: "filled" });
    expect(classifyOrder(resting, 6n, 5n, ME)).toEqual({ kind: "filled" });
  });
  it("reads an order at or after the head as resting, with its remaining size", () => {
    expect(classifyOrder(resting, 5n, 5n, ME)).toEqual({ kind: "active", remaining: 7_000_000n });
    expect(classifyOrder(resting, 3n, 5n, ME)).toEqual({ kind: "active", remaining: 7_000_000n });
  });
});

describe("OrderTracker", () => {
  it("never puts the same id in two cancels", () => {
    const t = new OrderTracker();
    t.adopt([order(1n, true, 405_000, 20_000_000n), order(2n, false, 435_000, 20_000_000n)]);
    const first = t.cancelIds();
    expect(first).toEqual([1n, 2n]);
    t.retire(first);
    t.adopt([order(3n, true, 406_000, 20_000_000n), order(4n, false, 436_000, 20_000_000n)]);
    // A stale read of the book must not bring a cancelled id back.
    t.adopt([order(1n, true, 405_000, 20_000_000n)]);
    expect(t.cancelIds()).toEqual([3n, 4n]);
    expect(t.isRetired(1n)).toBe(true);
  });

  it("records partial and complete fills, and retires filled and vanished orders without cancelling them", () => {
    const t = new OrderTracker();
    t.adopt([
      order(1n, true, 405_000, 20_000_000n),
      order(2n, false, 435_000, 20_000_000n),
      order(3n, false, 445_000, 20_000_000n),
    ]);
    const statuses = new Map<bigint, OrderStatus>([
      [1n, { kind: "active", remaining: 12_000_000n }],
      [2n, { kind: "filled" }],
      [3n, { kind: "gone" }],
    ]);
    expect(t.update(statuses)).toEqual([
      { id: 1n, isBuy: true, price: 405_000, size: 8_000_000n, complete: false },
      { id: 2n, isBuy: false, price: 435_000, size: 20_000_000n, complete: true },
    ]);
    expect(t.cancelIds()).toEqual([1n]);
    expect(t.isRetired(2n) && t.isRetired(3n)).toBe(true);
    // Unchanged status: no new fill.
    expect(t.update(new Map([[1n, { kind: "active", remaining: 12_000_000n }]]))).toEqual([]);
    expect(t.quotes()).toEqual({ bids: [{ price: 405_000, size: 12_000_000n }], asks: [] });
  });

  it("sums remaining size by price for the book view", () => {
    const t = new OrderTracker();
    t.adopt([
      order(1n, true, 405_000, 20_000_000n),
      order(2n, true, 405_000, 5_000_000n),
      order(3n, false, 435_000, 20_000_000n),
    ]);
    const sizes = t.sizeByPrice();
    expect(sizes.bids.get(405_000)).toBe(25_000_000n);
    expect(sizes.asks.get(435_000)).toBe(20_000_000n);
  });
});

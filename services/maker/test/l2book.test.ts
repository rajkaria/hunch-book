import {
  bestPriceToPrecision,
  decodeBestBidAsk,
  decodeL2Book,
  KURU_EMPTY_ASK,
  KURU_EMPTY_BID,
} from "@hunch-book/shared";
import { encodePacked, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { l2Fixture } from "./fixtures.js";

const words = (values: bigint[]): Hex =>
  encodePacked(
    values.map(() => "uint256"),
    values,
  );

describe("decodeL2Book on Kuru's live MON-USDC book", () => {
  const fx = l2Fixture();
  const book = decodeL2Book(fx.l2);
  const pp = BigInt(fx.pricePrecision);

  it("reads the block it was captured at", () => {
    expect(book.block).toBe(BigInt(fx.source.block));
  });

  it("orders bids high to low and asks low to high, without crossing", () => {
    expect(book.bids.length).toBeGreaterThan(0);
    expect(book.asks.length).toBeGreaterThan(0);
    for (let i = 1; i < book.bids.length; i++) {
      expect(book.bids[i]?.price).toBeLessThan(book.bids[i - 1]?.price as bigint);
    }
    for (let i = 1; i < book.asks.length; i++) {
      expect(book.asks[i]?.price).toBeGreaterThan(book.asks[i - 1]?.price as bigint);
    }
    expect(book.bids[0]?.price).toBeLessThan(book.asks[0]?.price as bigint);
    for (const level of [...book.bids, ...book.asks]) {
      expect(level.size).toBeGreaterThan(0n);
      expect(level.price % BigInt(fx.tickSize)).toBe(0n);
    }
  });

  it("agrees with bestBidAsk() read at the same block", () => {
    const best = decodeBestBidAsk(BigInt(fx.bestBidAsk[0]), BigInt(fx.bestBidAsk[1]));
    expect(bestPriceToPrecision(best.bid as bigint, pp)).toBe(book.bids[0]?.price);
    expect(bestPriceToPrecision(best.ask as bigint, pp)).toBe(book.asks[0]?.price);
  });
});

describe("decodeL2Book layouts", () => {
  it("decodes an empty book", () => {
    expect(decodeL2Book(words([42n, 0n]))).toEqual({ block: 42n, bids: [], asks: [] });
  });

  it("decodes one-sided books", () => {
    expect(decodeL2Book(words([7n, 500_000n, 3_000_000n, 0n]))).toEqual({
      block: 7n,
      bids: [{ price: 500_000n, size: 3_000_000n }],
      asks: [],
    });
    expect(decodeL2Book(words([7n, 0n, 510_000n, 2_000_000n, 520_000n, 1_000_000n]))).toEqual({
      block: 7n,
      bids: [],
      asks: [
        { price: 510_000n, size: 2_000_000n },
        { price: 520_000n, size: 1_000_000n },
      ],
    });
  });

  it("rejects malformed data", () => {
    expect(() => decodeL2Book("0x1234")).toThrow(/malformed/);
    expect(() => decodeL2Book(words([7n, 500_000n, 3_000_000n]))).toThrow(/separator/);
    expect(() => decodeL2Book(words([7n, 0n, 510_000n]))).toThrow(/pair/);
  });
});

describe("bestBidAsk sentinels", () => {
  it("maps Kuru's empty-side values to null", () => {
    expect(decodeBestBidAsk(KURU_EMPTY_BID, KURU_EMPTY_ASK)).toEqual({ bid: null, ask: null });
    expect(decodeBestBidAsk(5n, 6n)).toEqual({ bid: 5n, ask: 6n });
    expect(bestPriceToPrecision(500_000_000_000_000_000n, 1_000_000n)).toBe(500_000n);
  });
});

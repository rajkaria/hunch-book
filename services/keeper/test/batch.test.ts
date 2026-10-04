import type { Address } from "viem";
import { describe, expect, it } from "vitest";
import { chunks, claimableUsers, halves, uniqueAddresses } from "../src/batch.js";
import { bufferedGas, gasLimitFor } from "../src/tx.js";

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;

describe("batching", () => {
  it("cuts stakers into chunks of the batch size, in order", () => {
    const users = Array.from({ length: 120 }, (_, i) => addr(i + 1));
    const batches = chunks(users, 50);
    expect(batches.map((b) => b.length)).toEqual([50, 50, 20]);
    expect(batches.flat()).toEqual(users);
    expect(chunks([], 50)).toEqual([]);
    expect(chunks([1, 2, 3], 1)).toEqual([[1], [2], [3]]);
    expect(() => chunks([1], 0)).toThrow();
  });

  it("halves a batch for the gas cap, never losing anyone", () => {
    expect(halves([1, 2, 3, 4, 5])).toEqual([
      [1, 2, 3],
      [4, 5],
    ]);
    expect(halves([1])).toEqual([[1], []]);
  });

  it("keeps the first copy of each address, checksummed", () => {
    const a = "0x2a44b99014cf73065bfb89197a08de09d18d3982";
    const b = "0x1f5ac9bb0df7d0e0dd133cbd71388e1078475569";
    expect(uniqueAddresses([a, b, a.toUpperCase().replace("0X", "0x")])).toEqual([
      "0x2A44B99014cF73065BFb89197a08DE09D18d3982",
      "0x1f5AC9bB0DF7d0E0DD133cBd71388e1078475569",
    ]);
  });

  it("keeps only users with something to claim", () => {
    const users = [addr(1), addr(2), addr(3)];
    expect(claimableUsers(users, [0n, 5n, 1n])).toEqual([addr(2), addr(3)]);
    expect(claimableUsers(users, [0n, 0n, 0n])).toEqual([]);
  });
});

describe("gas limits", () => {
  it("adds 10% to the estimate, rounded up, and never goes above the cap", () => {
    expect(bufferedGas(1_000_000n)).toBe(1_100_000n);
    expect(bufferedGas(918_908n)).toBe(1_010_799n);
    expect(gasLimitFor(1_000_000n, 6_000_000n)).toBe(1_100_000n);
    expect(gasLimitFor(5_800_000n, 6_000_000n)).toBe(6_000_000n);
  });
});

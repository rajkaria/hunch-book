import { describe, expect, it } from "vitest";
import {
  isFundingSpike,
  priceToE8,
  priceToE8Ceil,
  TouchDirection,
  touchesStrike,
  touchPriceE8,
} from "../src/index.js";

// The same edges as contracts/test/resolvers/PriceScale.t.sol and ChainlinkTouchResolver.t.sol.

const K = 70_000n * 10n ** 8n;

describe("priceToE8Ceil", () => {
  it("rounds a positive price up when scaling down, and is exact otherwise", () => {
    expect(priceToE8Ceil(70_000n * 10n ** 18n, -18)).toBe(K);
    expect(priceToE8Ceil(70_000n * 10n ** 18n + 1n, -18)).toBe(K + 1n);
    expect(priceToE8(70_000n * 10n ** 18n + 1n, -18)).toBe(K);
    expect(priceToE8Ceil(K, -8)).toBe(K);
    expect(priceToE8Ceil(7n, -6)).toBe(700n);
    expect(priceToE8Ceil(-5n, -10)).toBe(0n);
    expect(priceToE8Ceil(1n, -90)).toBe(1n);
  });
});

describe("touchesStrike", () => {
  it("counts equal to the strike in both directions", () => {
    expect(touchesStrike(K, 8, K, TouchDirection.AtOrAbove)).toBe(true);
    expect(touchesStrike(K, 8, K, TouchDirection.AtOrBelow)).toBe(true);
    expect(touchesStrike(K - 1n, 8, K, TouchDirection.AtOrAbove)).toBe(false);
    expect(touchesStrike(K + 1n, 8, K, TouchDirection.AtOrBelow)).toBe(false);
  });

  it("rounds per direction so a sub-unit price never flips the rule", () => {
    const justAbove = 70_000n * 10n ** 18n + 1n; // 70,000.000000000000000001 with 18 decimals
    expect(touchPriceE8(justAbove, 18, TouchDirection.AtOrAbove)).toBe(K);
    expect(touchPriceE8(justAbove, 18, TouchDirection.AtOrBelow)).toBe(K + 1n);
    expect(touchesStrike(justAbove, 18, K, TouchDirection.AtOrAbove)).toBe(true);
    expect(touchesStrike(justAbove, 18, K, TouchDirection.AtOrBelow)).toBe(false);
    const justBelow = 70_000n * 10n ** 18n - 1n;
    expect(touchesStrike(justBelow, 18, K, TouchDirection.AtOrAbove)).toBe(false);
    expect(touchesStrike(justBelow, 18, K, TouchDirection.AtOrBelow)).toBe(true);
  });

  it("never counts a price that is not positive", () => {
    expect(touchesStrike(0n, 8, 1n, TouchDirection.AtOrBelow)).toBe(false);
    expect(touchesStrike(-1n, 8, 1n, TouchDirection.AtOrBelow)).toBe(false);
  });
});

describe("isFundingSpike", () => {
  it("is strictly above the threshold", () => {
    expect(isFundingSpike(34n, 33n)).toBe(true);
    expect(isFundingSpike(33n, 33n)).toBe(false);
    expect(isFundingSpike(-40n, -41n)).toBe(true);
  });
});

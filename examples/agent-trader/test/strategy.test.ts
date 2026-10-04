import { describe, expect, it } from "vitest";
import { decide, estimateYes, fillStillWorthIt, normalCdf } from "../src/strategy.js";

describe("agent-trader strategy", () => {
  it("has a normal CDF accurate to well below a basis point", () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 7);
    expect(normalCdf(1.959964)).toBeCloseTo(0.975, 5);
    expect(normalCdf(-1)).toBeCloseTo(0.158655, 5);
  });

  it("projects the recent rate over the events left", () => {
    // 10 units per event so far, 20 events left, 50 already paid: expected 250.
    const e = estimateYes({ accrued: 50, increments: Array(12).fill(10), eventsLeft: 20, threshold: 100 });
    expect(e.expected).toBe(250);
    expect(e.pYes).toBeGreaterThan(0.99);
    const below = estimateYes({
      accrued: 50,
      increments: Array(12).fill(10),
      eventsLeft: 20,
      threshold: 400,
    });
    expect(below.pYes).toBeLessThan(0.01);
  });

  it("is certain once no event is left, with equal counting as NO", () => {
    expect(estimateYes({ accrued: 100, increments: [1, 2], eventsLeft: 0, threshold: 100 }).pYes).toBe(0);
    expect(estimateYes({ accrued: 101, increments: [1, 2], eventsLeft: 0, threshold: 100 }).pYes).toBe(1);
  });

  it("buys only with enough edge and budget, capped per trade", () => {
    expect(decide({ pYes: 0.7, ask: 0.6, budgetLeft: 20, maxTrade: 5, minEdge: 0.05 })).toEqual({
      action: "buy",
      usdc: 5,
      edge: expect.closeTo(0.1, 9),
    });
    expect(decide({ pYes: 0.62, ask: 0.6, budgetLeft: 20, maxTrade: 5, minEdge: 0.05 })).toMatchObject({
      action: "skip",
    });
    expect(decide({ pYes: 0.9, ask: null, budgetLeft: 20, maxTrade: 5, minEdge: 0.05 })).toMatchObject({
      action: "skip",
      reason: "no asks on the book",
    });
    expect(decide({ pYes: 0.9, ask: 0.5, budgetLeft: 3.5, maxTrade: 5, minEdge: 0.05 })).toMatchObject({
      action: "buy",
      usdc: 3.5,
    });
    expect(decide({ pYes: 0.9, ask: 0.5, budgetLeft: 0.5, maxTrade: 5, minEdge: 0.05 })).toMatchObject({
      action: "skip",
      reason: "budget spent",
    });
  });

  it("re-checks the edge against the fill's average price", () => {
    expect(fillStillWorthIt(0.7, 0.66, 0.05)).toBe(true);
    expect(fillStillWorthIt(0.7, 0.68, 0.05)).toBe(false);
    expect(fillStillWorthIt(0.7, null, 0.05)).toBe(false);
  });
});

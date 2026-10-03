import { describe, expect, it } from "vitest";
import {
  type FundingSample,
  forecastErrors,
  fundingFairValue,
  fundingIncrements,
  historyNeeded,
  MIN_FUNDING_SAMPLES,
  windowSteps,
} from "../src/pricing/perplFunding.js";
import { fundingFixture } from "./fixtures.js";

// All inputs come from real Perpl funding sums recorded on Monad mainnet (test/fixtures).

const WEEK = 234;

for (const asset of ["btc", "mon"] as const) {
  describe(`Perpl funding fair value on live ${asset.toUpperCase()} data`, () => {
    const fx = fundingFixture(asset);
    const increments = fundingIncrements(fx.samples);
    const currentRate = increments.at(-1) as number;

    it("reads one sample per funding event on the 8,571-block grid", () => {
      expect(fx.interval).toBe(8571);
      expect(increments).toHaveLength(fx.samples.length - 1);
      for (let i = 1; i < fx.samples.length; i++) {
        const prev = fx.samples[i - 1] as FundingSample;
        const cur = fx.samples[i] as FundingSample;
        expect(cur.block - prev.block).toBe(fx.interval);
        expect(cur.eventBlock).toBe(cur.block);
        expect(increments[i - 1]).toBe(cur.sum - prev.sum);
      }
      expect(fx.samples.at(-1)?.block).toBe(fx.lastEvent);
    });

    it("computes forecast errors that match a direct sum", () => {
      const from = 3;
      const to = 40;
      const errors = forecastErrors(increments, from, to);
      expect(errors).toHaveLength(increments.length - to);
      for (const t of [0, 17, errors.length - 1]) {
        let actual = 0;
        for (let j = from + 1; j <= to; j++) actual += increments[t + j] as number;
        expect(errors[t]).toBe(actual - (to - from) * (increments[t] as number));
      }
    });

    it("prices a week-long window starting at the next event", () => {
      const startBlock = fx.lastEvent + 100;
      const endBlock = startBlock + WEEK * fx.interval;
      const steps = windowSteps(fx.lastEvent, fx.interval, startBlock, endBlock);
      expect(steps).toEqual({ stepsToStart: 0, stepsToEnd: WEEK });
      expect(increments.length).toBeGreaterThanOrEqual(historyNeeded(WEEK));

      const at = (threshold: number) =>
        fundingFairValue({ accrued: 0, currentRate, ...steps, threshold, increments });
      const mid = at(WEEK * currentRate);
      expect(mid.expected).toBe(WEEK * currentRate);
      expect(mid.samples).toBe(increments.length - WEEK);
      expect(mid.decided).toBe(false);
      expect(mid.p).toBeGreaterThan(0.05);
      expect(mid.p).toBeLessThan(0.95);
      expect(at(-1e9).p).toBeGreaterThan(0.99);
      expect(at(1e9).p).toBeLessThan(0.01);
    });

    it("never raises the chance of YES when the threshold rises", () => {
      const steps = windowSteps(
        fx.lastEvent,
        fx.interval,
        fx.lastEvent + 1,
        fx.lastEvent + 1 + 100 * fx.interval,
      );
      let previous = 1;
      for (let threshold = -20_000; threshold <= 20_000; threshold += 250) {
        const { p } = fundingFairValue({ accrued: 0, currentRate, ...steps, threshold, increments });
        expect(p).toBeGreaterThan(0);
        expect(p).toBeLessThan(1);
        expect(p).toBeLessThanOrEqual(previous);
        previous = p;
      }
    });

    it("prices a window already under way from the funding accrued so far", () => {
      // A window that started 100 events ago and ends 34 events from now.
      const startSample = fx.samples.at(-101) as FundingSample;
      const startBlock = startSample.block + 10;
      const endBlock = fx.lastEvent + 34 * fx.interval + 5;
      const steps = windowSteps(fx.lastEvent, fx.interval, startBlock, endBlock);
      expect(steps).toEqual({ stepsToStart: 0, stepsToEnd: 34 });
      const accrued = (fx.samples.at(-1) as FundingSample).sum - startSample.sum;
      const expected = accrued + 34 * currentRate;
      const base = { accrued, currentRate, ...steps, increments };
      expect(fundingFairValue({ ...base, threshold: expected }).expected).toBe(expected);
      // Less time left means less room for the forecast to be wrong.
      const near = fundingFairValue({ ...base, threshold: expected + 2_000 }).p;
      const far = fundingFairValue({
        ...base,
        stepsToEnd: 200,
        threshold: accrued + 200 * currentRate + 2_000,
      }).p;
      expect(near).toBeLessThanOrEqual(far);
    });

    it("counts only events inside the window when it starts later", () => {
      const startBlock = fx.lastEvent + 10 * fx.interval;
      const endBlock = startBlock + 50 * fx.interval;
      const steps = windowSteps(fx.lastEvent, fx.interval, startBlock, endBlock);
      expect(steps).toEqual({ stepsToStart: 10, stepsToEnd: 60 });
      const fair = fundingFairValue({ accrued: 0, currentRate, ...steps, threshold: 0, increments });
      expect(fair.expected).toBe(50 * currentRate);
      expect(fair.samples).toBe(increments.length - 60);
    });

    it("is decided once no event is left in the window; equal is NO", () => {
      const accrued = increments.slice(-20).reduce((a, b) => a + b, 0);
      const steps = { stepsToStart: 0, stepsToEnd: 0 };
      const at = (threshold: number) =>
        fundingFairValue({ accrued, currentRate, ...steps, threshold, increments });
      expect(at(accrued - 1)).toMatchObject({ p: 1, decided: true });
      expect(at(accrued)).toMatchObject({ p: 0, decided: true });
      expect(at(accrued + 1)).toMatchObject({ p: 0, decided: true });
    });

    it("refuses to price a horizon longer than its history supports", () => {
      const steps = { stepsToStart: 0, stepsToEnd: increments.length - MIN_FUNDING_SAMPLES + 1 };
      expect(() => fundingFairValue({ accrued: 0, currentRate, ...steps, threshold: 0, increments })).toThrow(
        /not enough funding history/,
      );
    });
  });
}

describe("fundingIncrements", () => {
  it("starts at the perp's first funding event", () => {
    const fx = fundingFixture("btc");
    // The same real samples, with the first ten marked as read before funding started.
    const before = fx.samples.map((s, i) => (i < 10 ? { ...s, sum: 0, eventBlock: 0 } : s));
    expect(fundingIncrements(before)).toEqual(fundingIncrements(fx.samples.slice(10)));
    expect(fundingIncrements(before.map((s) => ({ ...s, eventBlock: 0 })))).toEqual([]);
  });
});

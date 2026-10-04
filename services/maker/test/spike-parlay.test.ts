import { describe, expect, it } from "vitest";
import { parlayFairValue } from "../src/pricing/parlay.js";
import { MIN_SPIKE_STRETCHES, singleIntervalIncrements, spikeFairValue } from "../src/pricing/spike.js";
import { fundingFixture } from "./fixtures.js";

// Spike inputs are real Perpl funding sums recorded on Monad mainnet (test/fixtures).

for (const asset of ["btc", "mon"] as const) {
  describe(`funding spike fair value on live ${asset.toUpperCase()} data`, () => {
    const fx = fundingFixture(asset);
    const events = singleIntervalIncrements(fx.samples, fx.interval);
    const increments = events.map((e) => e.increment);
    const sorted = [...increments].sort((a, b) => a - b);
    const q90 = sorted[Math.floor(sorted.length * 0.9)] as number;
    const max = sorted.at(-1) as number;

    it("reads one single-interval increment per pair of consecutive grid events", () => {
      expect(events).toHaveLength(fx.samples.length - 1);
      for (const [i, e] of events.entries()) {
        const prev = fx.samples[i] as { sum: number };
        const cur = fx.samples[i + 1] as { sum: number; block: number };
        expect(e).toEqual({ block: cur.block, increment: cur.sum - prev.sum });
      }
      // A gap in the grid (an event missing) is not one interval: it is left out.
      const gapped = fx.samples.filter((_, i) => i !== 10);
      expect(singleIntervalIncrements(gapped, fx.interval)).toHaveLength(fx.samples.length - 3);
    });

    it("rises with the events left and falls with the threshold", () => {
      let previous = 0;
      for (const n of [1, 5, 20, 60, 120]) {
        const p = spikeFairValue({ increments, threshold: q90, eventsLeft: n, spiked: false }).p;
        expect(p).toBeGreaterThanOrEqual(previous);
        previous = p;
      }
      let last = 1;
      for (const x of [sorted[0] as number, q90, max]) {
        const p = spikeFairValue({ increments, threshold: x, eventsLeft: 30, spiked: false }).p;
        expect(p).toBeLessThanOrEqual(last);
        last = p;
      }
    });

    it("counts real stretches of the history: the share of 30-event stretches with an increment above X", () => {
      const n = 30;
      const fair = spikeFairValue({ increments, threshold: q90, eventsLeft: n, spiked: false });
      expect(fair.method).toBe("stretches");
      let hits = 0;
      const stretches = increments.length - n + 1;
      for (let t = 0; t < stretches; t++) if (increments.slice(t, t + n).some((x) => x > q90)) hits++;
      expect(fair.p).toBeCloseTo((hits + 0.5) / (stretches + 1), 12);
      // Above the largest increment ever seen, the chance is only the smoothing.
      expect(spikeFairValue({ increments, threshold: max, eventsLeft: n, spiked: false }).p).toBeLessThan(
        0.01,
      );
    });

    it("falls back to independent events when the window is longer than the history allows", () => {
      const n = increments.length - MIN_SPIKE_STRETCHES + 2;
      const fair = spikeFairValue({ increments, threshold: q90, eventsLeft: n, spiked: false });
      expect(fair.method).toBe("independent-events");
      expect(fair.p).toBeCloseTo(1 - (1 - fair.perEvent) ** n, 12);
    });

    it("is decided by a spike already seen, and once no event is left", () => {
      expect(spikeFairValue({ increments, threshold: max, eventsLeft: 10, spiked: true })).toMatchObject({
        p: 1,
        decided: true,
      });
      expect(spikeFairValue({ increments, threshold: q90, eventsLeft: 0, spiked: false })).toMatchObject({
        p: 0,
        decided: true,
      });
    });
  });
}

describe("parlay fair value", () => {
  it("multiplies the legs' chances, and says it assumes they are independent", () => {
    const fair = parlayFairValue([
      { market: "a", state: "open", p: 0.6, source: "book" },
      { market: "b", state: "open", p: 0.5, source: "model" },
      { market: "c", state: "settled-yes" },
    ]);
    expect(fair.p).toBeCloseTo(0.3, 12);
    expect(fair).toMatchObject({ decided: false, assumption: "legs are independent" });
  });

  it("is 0 once a leg settles NO, and 1 once all settle YES", () => {
    expect(
      parlayFairValue([
        { market: "a", state: "settled-no" },
        { market: "b", state: "open", p: 0.9 },
      ]),
    ).toMatchObject({
      p: 0,
      decided: true,
    });
    expect(
      parlayFairValue([
        { market: "a", state: "settled-yes" },
        { market: "b", state: "settled-yes" },
      ]),
    ).toMatchObject({
      p: 1,
      decided: true,
    });
  });

  it("after a void: worth 0.50 unless another leg settles NO", () => {
    expect(
      parlayFairValue([
        { market: "a", state: "voided" },
        { market: "b", state: "open", p: 0.8 },
      ]),
    ).toMatchObject({
      p: 0.4,
      decided: false,
    });
    expect(
      parlayFairValue([
        { market: "a", state: "voided" },
        { market: "b", state: "settled-yes" },
      ]),
    ).toMatchObject({
      p: 0.5,
      decided: true,
    });
  });
});

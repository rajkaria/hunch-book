import { describe, expect, it } from "vitest";
import {
  priceAtTimeFairValue,
  rangeFairValue,
  realisedVariancePerSecond,
} from "../src/pricing/priceAtTime.js";
import { DISCRETE_MONITORING_BETA, hitProbability, touchFairValue } from "../src/pricing/touch.js";
import { chainlinkFixture, priceRounds } from "./fixtures.js";

// Spot and volatility from real Chainlink rounds recorded on Monad mainnet (test/fixtures).

const DAY = 86_400;

/** A small deterministic generator, so the Monte Carlo check is the same on every run. */
function rng(seed: number) {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  return () => {
    const u = Math.max(next(), 1e-12);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next());
  };
}

describe("hitProbability", () => {
  it("is 1 at or past the barrier, 0 with no time left, and grows with time", () => {
    expect(hitProbability(100, 100, true, 1e-8, DAY)).toBe(1);
    expect(hitProbability(100, 101, false, 1e-8, DAY)).toBe(1);
    expect(hitProbability(100, 105, true, 1e-8, 0)).toBe(0);
    let previous = 0;
    for (const t of [600, 3_600, DAY, 7 * DAY]) {
      const p = hitProbability(100, 105, true, 1e-8, t);
      expect(p).toBeGreaterThan(previous);
      previous = p;
    }
  });

  it("matches a Monte Carlo of the same driftless price, both ways", () => {
    const variance = 4e-8; // about 112% a year: enough hits for a tight check
    const seconds = DAY;
    const steps = 400;
    const dt = seconds / steps;
    const normal = rng(7);
    for (const [barrier, up] of [
      [104, true],
      [96, false],
    ] as const) {
      let hits = 0;
      const paths = 4_000;
      for (let i = 0; i < paths; i++) {
        let x = Math.log(100);
        for (let k = 0; k < steps; k++) {
          x += -variance * dt * 0.5 + Math.sqrt(variance * dt) * normal();
          if (up ? x >= Math.log(barrier) : x <= Math.log(barrier)) {
            hits++;
            break;
          }
        }
      }
      // A path checked at `steps` points misses some touches: compare with the barrier moved by the
      // discrete-monitoring correction for that spacing.
      const shift = Math.exp(DISCRETE_MONITORING_BETA * Math.sqrt(variance * dt));
      const corrected = hitProbability(100, up ? barrier * shift : barrier / shift, up, variance, seconds);
      expect(Math.abs(hits / paths - corrected)).toBeLessThan(0.025);
    }
  });
});

for (const pair of ["btc-usd", "eth-usd", "mon-usd", "sol-usd"] as const) {
  describe(`touch and range fair values on live ${pair.toUpperCase()} rounds`, () => {
    const fx = chainlinkFixture(pair);
    const rounds = priceRounds(fx);
    const latest = fx.rounds.at(-1) as { answer: string };
    const spot = Number(latest.answer) / 10 ** fx.decimals;
    const measured = realisedVariancePerSecond(rounds);
    const roundSeconds = measured.seconds / measured.returns;
    const touch = (strike: number, over: Partial<Parameters<typeof touchFairValue>[0]> = {}) =>
      touchFairValue({
        spot,
        strike,
        direction: strike >= spot ? "up" : "down",
        variancePerSecond: measured.variance,
        secondsToStart: 0,
        secondsToEnd: 7 * DAY,
        touched: false,
        roundSeconds,
        ...over,
      });

    it("falls as the barrier moves away, on either side", () => {
      let up = 1;
      let down = 1;
      for (let k = 1.01; k <= 1.3; k += 0.01) {
        const pu = touch(spot * k).p;
        const pd = touch(spot / k).p;
        expect(pu).toBeLessThanOrEqual(up);
        expect(pd).toBeLessThanOrEqual(down);
        up = pu;
        down = pd;
      }
    });

    it("is at least the chance of ending beyond the barrier, and about twice it at most", () => {
      const strike = spot * 1.05;
      const end = priceAtTimeFairValue({
        spot,
        strike,
        variancePerSecond: measured.variance,
        secondsToClose: 7 * DAY,
      }).p;
      const p = touch(strike, { roundSeconds: 0 }).p;
      expect(p).toBeGreaterThan(end);
      // Twice is exact for a driftless log price (the reflection principle); the price here is the
      // martingale, whose log drifts down at half the variance, which tilts the ratio a little above 2.
      expect(p).toBeLessThan(2.1 * end + 1e-9);
    });

    it("counts rounds, not a continuous path: the correction lowers the chance", () => {
      expect(touch(spot * 1.05).p).toBeLessThan(touch(spot * 1.05, { roundSeconds: 0 }).p);
      expect(touch(spot * 1.05).barrier).toBeGreaterThan(spot * 1.05);
    });

    it("before the window opens, the chance is lower than with the window open now", () => {
      const now = touch(spot * 1.04).p;
      const later = touch(spot * 1.04, { secondsToStart: DAY, secondsToEnd: 8 * DAY }).p;
      expect(later).toBeGreaterThan(0);
      // The same 7-day window, starting a day from now: the price may drift either way first.
      expect(Math.abs(later - now)).toBeLessThan(0.2);
    });

    it("is decided by a touch already seen, and after the window", () => {
      expect(touch(spot * 1.5, { touched: true })).toMatchObject({ p: 1, decided: true });
      expect(touch(spot * 1.5, { secondsToEnd: 0 })).toMatchObject({ p: 0, decided: true });
    });

    it("ranges: adjacent bands add up, and every band sits between 0 and 1", () => {
      const at = (lower: number, upper: number) =>
        rangeFairValue({ spot, lower, upper, variancePerSecond: measured.variance, secondsToClose: DAY }).p;
      const a = spot * 0.97;
      const b = spot;
      const c = spot * 1.03;
      expect(at(a, b) + at(b, c)).toBeCloseTo(at(a, c), 9);
      for (const p of [at(a, b), at(b, c), at(a, c)]) {
        expect(p).toBeGreaterThanOrEqual(0);
        expect(p).toBeLessThanOrEqual(1);
      }
      const wide = rangeFairValue({
        spot,
        lower: a,
        upper: c,
        variancePerSecond: measured.variance,
        secondsToClose: 0,
      });
      expect(wide).toMatchObject({ p: 1, decided: true });
    });
  });
}

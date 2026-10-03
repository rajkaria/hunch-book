import { describe, expect, it } from "vitest";
import { normalCdf } from "../src/pricing/normal.js";
import {
  annualisedVol,
  MIN_ANNUAL_VOL,
  priceAtTimeFairValue,
  realisedVariancePerSecond,
} from "../src/pricing/priceAtTime.js";
import { chainlinkFixture, priceRounds } from "./fixtures.js";

// Volatility and spot come from real Chainlink rounds recorded on Monad mainnet (test/fixtures).

const DAY = 86_400;

describe("normalCdf", () => {
  it("matches the standard normal table", () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 7);
    expect(normalCdf(1.959964)).toBeCloseTo(0.975, 6);
    expect(normalCdf(-1)).toBeCloseTo(0.158655, 6);
    expect(normalCdf(3)).toBeCloseTo(0.99865, 5);
    for (const x of [0.3, 1.1, 2.5]) expect(normalCdf(x) + normalCdf(-x)).toBeCloseTo(1, 9);
  });
});

for (const pair of ["btc-usd", "eth-usd", "mon-usd"] as const) {
  describe(`price-at-time fair value on live ${pair.toUpperCase()} rounds`, () => {
    const fx = chainlinkFixture(pair);
    const rounds = priceRounds(fx);
    const latest = fx.rounds.at(-1) as { answer: string };
    const spot = Number(latest.answer) / 10 ** fx.decimals;
    const measured = realisedVariancePerSecond(rounds);

    it("walks back consecutive rounds of one phase", () => {
      expect(fx.rounds.length).toBeGreaterThan(200);
      const ids = fx.rounds.map((r) => BigInt(r.roundId));
      for (let i = 1; i < ids.length; i++) expect((ids[i] as bigint) - (ids[i - 1] as bigint)).toBe(1n);
      expect(new Set(ids.map((id) => id >> 64n)).size).toBe(1);
    });

    it("measures a plausible realised volatility", () => {
      expect(measured.returns).toBe(rounds.length - 1);
      const vol = annualisedVol(measured.variance);
      expect(vol).toBeGreaterThan(0.03);
      expect(vol).toBeLessThan(3);
    });

    it("puts an at-the-money strike just under one half", () => {
      const fair = priceAtTimeFairValue({
        spot,
        strike: spot,
        variancePerSecond: measured.variance,
        secondsToClose: DAY,
      });
      expect(fair.p).toBeLessThan(0.5);
      expect(fair.p).toBeGreaterThan(0.45);
      expect(fair.decided).toBe(false);
    });

    it("falls as the strike rises", () => {
      let previous = 1;
      for (let k = 0.8; k <= 1.2; k += 0.01) {
        const { p } = priceAtTimeFairValue({
          spot,
          strike: spot * k,
          variancePerSecond: measured.variance,
          secondsToClose: DAY,
        });
        expect(p).toBeLessThanOrEqual(previous);
        previous = p;
      }
    });

    it("gives an out-of-the-money strike more chance with more time", () => {
      const at = (secondsToClose: number) =>
        priceAtTimeFairValue({
          spot,
          strike: spot * 1.03,
          variancePerSecond: measured.variance,
          secondsToClose,
        }).p;
      expect(at(3_600)).toBeLessThan(at(DAY));
      expect(at(DAY)).toBeLessThan(at(7 * DAY));
      expect(at(7 * DAY)).toBeLessThan(0.5);
    });

    it("is decided at the observation time; at the strike is YES", () => {
      const v = measured.variance;
      expect(
        priceAtTimeFairValue({ spot, strike: spot, variancePerSecond: v, secondsToClose: 0 }),
      ).toMatchObject({
        p: 1,
        decided: true,
      });
      expect(
        priceAtTimeFairValue({ spot, strike: spot * 1.0001, variancePerSecond: v, secondsToClose: -5 }),
      ).toMatchObject({ p: 0, decided: true });
    });
  });
}

describe("volatility inputs", () => {
  it("ranks MON as more volatile than BTC on the recorded rounds", () => {
    const btc = realisedVariancePerSecond(priceRounds(chainlinkFixture("btc-usd"))).variance;
    const mon = realisedVariancePerSecond(priceRounds(chainlinkFixture("mon-usd"))).variance;
    expect(mon).toBeGreaterThan(btc);
  });

  it("orders rounds by id, counts rounds that share a timestamp, and skips repeats", () => {
    const rounds = priceRounds(chainlinkFixture("eth-usd"));
    // The recorded ETH/USD history has two rounds written in the same second.
    const stamps = rounds.map((r) => r.updatedAt);
    expect(new Set(stamps).size).toBeLessThan(stamps.length);
    const base = realisedVariancePerSecond(rounds);
    expect(base.returns).toBe(rounds.length - 1);
    expect(realisedVariancePerSecond([...rounds].reverse()).variance).toBe(base.variance);
    const repeated = [...rounds, { ...(rounds[5] as (typeof rounds)[number]) }];
    expect(realisedVariancePerSecond(repeated)).toEqual(base);
  });

  it("never goes below the volatility floor", () => {
    const fair = priceAtTimeFairValue({ spot: 100, strike: 101, variancePerSecond: 0, secondsToClose: DAY });
    expect(fair.vol).toBeCloseTo(MIN_ANNUAL_VOL, 9);
    expect(fair.p).toBeGreaterThan(0);
  });

  it("refuses a feed with a single round", () => {
    const one = priceRounds(chainlinkFixture("btc-usd")).slice(-1);
    expect(() => realisedVariancePerSecond(one)).toThrow(/not enough rounds/);
  });
});

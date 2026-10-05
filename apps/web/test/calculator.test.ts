import { deployments } from "@hunch-book/shared";
import { describe, expect, it } from "vitest";
import {
  assumptionText,
  chosenRate,
  DAY_SECONDS,
  estimateFundingCost,
  formatRateUsd,
  horizonSeconds,
  horizonWords,
  parseAmount,
  perpsOf,
  sizeText,
  unitsFromSize,
} from "../src/lib/calculator/math";
import { calculatorUrl, parseCalculatorQuery } from "../src/lib/calculator/query";
import type { FundingStep, PerpMeta } from "../src/lib/hedge/math";
import { hedgeUrl, parseHedgePrefill, perpIdOf, prefillPosition } from "../src/lib/hedge/prefill";

// The funding-cost calculator's helpers, and the hedge page's query-string prefill.

const BTC: PerpMeta = {
  perpId: 16n,
  name: "Bitcoin",
  symbol: "BTC",
  priceDecimals: 1,
  lotDecimals: 5,
  scalingExp: 0,
  markPNS: 850_138n, // $85,013.80
};

const INTERVAL = 8_571;
const MS = 300;
/** Funding events in 7 days at 300 ms per block: 2,016,000 blocks ÷ 8,571. */
const WEEK_EVENTS = (7 * DAY_SECONDS * 1000) / MS / INTERVAL;

const steps = (raws: number[]): FundingStep[] =>
  raws.map((raw, i) => ({ block: BigInt(1_000_000 + i * INTERVAL), raw: BigInt(raw) }));

describe("calculator inputs", () => {
  it("reads typed amounts, with commas and leading dots", () => {
    expect(parseAmount("0.5")).toBe(0.5);
    expect(parseAmount(" 10,000 ")).toBe(10_000);
    expect(parseAmount(".25")).toBe(0.25);
    expect(parseAmount("3.")).toBe(3);
    for (const bad of ["", "0", "-1", "1e3", "abc", "1.2.3", "Infinity"]) expect(parseAmount(bad)).toBeNull();
  });

  it("turns a USD notional into units at the mark price", () => {
    expect(unitsFromSize(0.5, "units", 85_013.8)).toBe(0.5);
    expect(unitsFromSize(85_013.8, "usd", 85_013.8)).toBeCloseTo(1, 12);
    expect(unitsFromSize(10_000, "usd", 0)).toBeNull();
    expect(unitsFromSize(0, "units", 1)).toBeNull();
  });

  it("counts the horizon in seconds, refusing custom ones that are empty or over a year", () => {
    expect(horizonSeconds("day", "", "hours")).toBe(86_400);
    expect(horizonSeconds("week", "", "hours")).toBe(604_800);
    expect(horizonSeconds("custom", "36", "hours")).toBe(129_600);
    expect(horizonSeconds("custom", "2.5", "days")).toBe(216_000);
    expect(horizonSeconds("custom", "365", "days")).toBe(365 * 86_400);
    expect(horizonSeconds("custom", "366", "days")).toBeNull();
    expect(horizonSeconds("custom", "", "days")).toBeNull();
  });

  it("says the horizon in words", () => {
    expect(horizonWords(86_400)).toBe("the next 24 hours");
    expect(horizonWords(604_800)).toBe("the next 7 days");
    expect(horizonWords(3_600)).toBe("the next hour");
    expect(horizonWords(129_600)).toBe("the next 36 hours");
    expect(horizonWords(216_000)).toBe("the next 2.5 days");
  });

  it("never rounds a tiny funding rate to $0.00", () => {
    expect(formatRateUsd(3.4)).toBe("$3.40");
    expect(formatRateUsd(0.0042)).toBe("$0.0042");
    expect(formatRateUsd(-0.000000338)).toBe("-$0.000000338");
    expect(formatRateUsd(0.0000012345)).toBe("$0.00000123");
    expect(formatRateUsd(0)).toBe("$0.00");
    expect(formatRateUsd(Number.NaN)).toBe("n/a");
  });

  it("writes sizes to the perp's lot decimals with no exponent", () => {
    expect(sizeText(0.05978, 5)).toBe("0.05978");
    expect(sizeText(0.117628, 5)).toBe("0.11763");
    expect(sizeText(2, 5)).toBe("2");
    expect(sizeText(1e-7, 5)).toBe("0");
    expect(sizeText(12.5, 0)).toBe("13");
  });

  it("lists the deployment's perps in order", () => {
    expect(perpsOf(deployments["monad-testnet"])).toEqual([
      { symbol: "BTC", id: 16n },
      { symbol: "ETH", id: 32n },
      { symbol: "SOL", id: 48n },
      { symbol: "MON", id: 64n },
    ]);
  });
});

describe("the funding cost", () => {
  it("projects a long's cost from the last interval, with the hedge assistant's math", () => {
    const cost = estimateFundingCost({
      meta: BTC,
      steps: steps([4, 6, 8]),
      basis: "current",
      side: "long",
      units: 0.5,
      seconds: 7 * DAY_SECONDS,
      msPerBlock: MS,
      intervalBlocks: INTERVAL,
    });
    expect(cost).not.toBeNull();
    if (!cost) return;
    expect(cost.intervals).toBeCloseTo(WEEK_EVENTS, 9);
    expect(cost.projection.perIntervalUsdPerUnit).toBeCloseTo(0.8, 12); // 8 ÷ 10^(1 + 0)
    expect(cost.costUsd).toBeCloseTo(0.8 * WEEK_EVENTS * 0.5, 9);
    expect(cost.markUsd).toBeCloseTo(85_013.8, 9);
    expect(cost.notionalUsd).toBeCloseTo(42_506.9, 9);
    expect(cost.costPercent).toBeCloseTo(((0.8 * WEEK_EVENTS * 0.5) / 42_506.9) * 100, 9);
    expect(cost.ratePercentPerInterval).toBeCloseTo((0.8 / 85_013.8) * 100, 12);
    expect(cost.intervalMinutes).toBeCloseTo(42.855, 9);
    expect(cost.rateIntervals).toBe(1);
  });

  it("gives a short the same amount as funding received", () => {
    const args = {
      meta: BTC,
      steps: steps([8]),
      basis: "current" as const,
      units: 2,
      seconds: DAY_SECONDS,
      msPerBlock: MS,
      intervalBlocks: INTERVAL,
    };
    const long = estimateFundingCost({ ...args, side: "long" });
    const short = estimateFundingCost({ ...args, side: "short" });
    expect(long?.costUsd).toBeGreaterThan(0);
    expect(short?.costUsd).toBeCloseTo(-(long?.costUsd ?? 0), 12);
    expect(short?.costPercent).toBeCloseTo(long?.costPercent ?? 0, 12);
  });

  it("averages the last 24 hours of intervals when asked", () => {
    // 33.6 events a day at 300 ms per block: the mean of the last 34.
    const raws = [...Array.from({ length: 14 }, () => 1_000), ...Array.from({ length: 34 }, () => 10)];
    expect(chosenRate(steps(raws), "average", 33.6)).toEqual({ raw: 10, count: 34 });
    expect(chosenRate(steps([5, 15]), "average", 33.6)).toEqual({ raw: 10, count: 2 });
    expect(chosenRate([], "average", 33.6)).toEqual({ raw: null, count: 0 });
    expect(chosenRate([], "current", 33.6)).toEqual({ raw: null, count: 0 });
    const cost = estimateFundingCost({
      meta: BTC,
      steps: steps(raws),
      basis: "average",
      side: "long",
      units: 1,
      seconds: DAY_SECONDS,
      msPerBlock: MS,
      intervalBlocks: INTERVAL,
    });
    expect(cost?.projection.rawPerInterval).toBe(10);
    expect(cost?.rateIntervals).toBe(34);
  });

  it("has nothing to project without funding history", () => {
    expect(
      estimateFundingCost({
        meta: BTC,
        steps: [],
        basis: "current",
        side: "long",
        units: 1,
        seconds: DAY_SECONDS,
        msPerBlock: MS,
        intervalBlocks: INTERVAL,
      }),
    ).toBeNull();
  });

  it("states the assumption in plain words", () => {
    expect(
      assumptionText({
        basis: "current",
        rateIntervals: 1,
        rateText: "$0.80 per BTC",
        horizon: "the next 7 days",
      }),
    ).toBe(
      "This assumes the funding rate of the last interval ($0.80 per BTC per event) holds for every funding event in the next 7 days. Perpl sets a new rate every interval, so this is an estimate, not a forecast.",
    );
    expect(
      assumptionText({
        basis: "average",
        rateIntervals: 34,
        rateText: "$1.00 per BTC",
        horizon: "the next 24 hours",
      }),
    ).toContain(
      "the average funding rate of the last 34 intervals, about 24 hours ($1.00 per BTC per event)",
    );
  });
});

describe("the calculator's address", () => {
  it("reads every input from the query and ignores what it cannot use", () => {
    expect(
      parseCalculatorQuery(
        new URLSearchParams("perp=btc&side=short&size=0.5&unit=units&horizon=36h&rate=24h"),
      ),
    ).toEqual({
      asset: "BTC",
      side: "short",
      size: "0.5",
      unit: "units",
      horizon: "custom",
      custom: "36",
      customUnit: "hours",
      basis: "average",
    });
    expect(parseCalculatorQuery({ horizon: "7d", rate: "last" })).toEqual({
      horizon: "week",
      basis: "current",
    });
    expect(parseCalculatorQuery({ horizon: "24h" })).toEqual({ horizon: "day" });
    expect(parseCalculatorQuery({ horizon: "3d" })).toMatchObject({
      horizon: "custom",
      custom: "3",
      customUnit: "days",
    });
    expect(
      parseCalculatorQuery({
        perp: "<x>",
        side: "up",
        size: "-1",
        unit: "lots",
        horizon: "soon",
        rate: "max",
      }),
    ).toEqual({});
  });

  it("writes the inputs back in the same terms", () => {
    const url = calculatorUrl({
      asset: "BTC",
      side: "long",
      size: "10,000",
      unit: "usd",
      horizon: "custom",
      custom: "2.5",
      customUnit: "days",
      basis: "current",
    });
    expect(url).toBe("/calculator?perp=BTC&side=long&size=10000&unit=usd&horizon=2.5d&rate=last");
    const back = parseCalculatorQuery(new URLSearchParams(url.split("?")[1]));
    expect(back).toMatchObject({
      asset: "BTC",
      size: "10000",
      horizon: "custom",
      custom: "2.5",
      customUnit: "days",
    });
    expect(calculatorUrl({ asset: "ETH", horizon: "week" })).toBe("/calculator?perp=ETH&horizon=7d");
  });
});

describe("the hedge page's prefill", () => {
  it("reads perp, side and size, with long as the default side", () => {
    expect(parseHedgePrefill(new URLSearchParams("perp=btc&side=short&size=0.25"))).toEqual({
      asset: "BTC",
      side: "short",
      size: 0.25,
    });
    expect(parseHedgePrefill({ perp: "ETH", size: "3" })).toEqual({ asset: "ETH", side: "long", size: 3 });
    expect(parseHedgePrefill({ perp: ["SOL", "BTC"], size: ["1"] })).toEqual({
      asset: "SOL",
      side: "long",
      size: 1,
    });
  });

  it("ignores links it cannot use", () => {
    expect(parseHedgePrefill({ perp: "BTC" })).toBeNull();
    expect(parseHedgePrefill({ size: "1" })).toBeNull();
    expect(parseHedgePrefill({ perp: "BTC", size: "0" })).toBeNull();
    expect(parseHedgePrefill({ perp: "BTC", size: "1e3" })).toBeNull();
    expect(parseHedgePrefill({ perp: "BTC/USD", size: "1" })).toBeNull();
  });

  it("finds the perp on the active network and sizes the position in lots", () => {
    expect(perpIdOf(deployments["monad-testnet"], "btc")).toBe(16n);
    expect(perpIdOf(deployments["monad-mainnet"], "BTC")).toBe(1n);
    expect(perpIdOf(deployments["monad-testnet"], "DOGE")).toBeUndefined();
    expect(prefillPosition({ asset: "BTC", side: "short", size: 0.05978 }, BTC)).toEqual({
      perpId: 16n,
      side: "short",
      lots: 5_978n,
      entryPricePNS: null,
      entryBlock: null,
      premiumPnlCNS: null,
      source: "manual",
    });
    expect(prefillPosition({ asset: "BTC", side: "long", size: 0.000001 }, BTC)).toBeNull();
  });

  it("links to the hedge page in the terms it reads", () => {
    const url = hedgeUrl({ asset: "BTC", side: "long", size: "0.5" });
    expect(url).toBe("/hedge?perp=BTC&side=long&size=0.5");
    expect(parseHedgePrefill(new URLSearchParams(url.split("?")[1]))).toEqual({
      asset: "BTC",
      side: "long",
      size: 0.5,
    });
  });
});

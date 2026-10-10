import { readFileSync } from "node:fs";
import {
  decodeChainlinkTouchParams,
  decodePerplFundingParams,
  decodePriceAtTimeParams,
  decodePriceRangeParams,
  deployments,
  Side,
  TemplateId,
  TouchDirection,
} from "@hunch-book/shared";
import { type Address, zeroAddress } from "viem";
import { describe, expect, it } from "vitest";
import type { JobContext } from "../src/jobs/context.js";
import { SeriesJob } from "../src/jobs/series.js";
import { parseDuration, parseSeriesFile, type SeriesSpec } from "../src/series/config.js";
import {
  buildParams,
  median,
  nextPeriod,
  periodAt,
  periodIdentity,
  priceStrike,
  quantile,
  roundToStep,
  seriesDecision,
  windowDeltas,
} from "../src/series/schedule.js";

const EXAMPLE = new URL("../series.example.json", import.meta.url);
const FEED = "0x5c8c8482f064049248F86D9F4aFa4B1f2F5b6d31" as Address;

describe("the series file", () => {
  it("parses the committed example", () => {
    const specs = parseSeriesFile(readFileSync(EXAMPLE, "utf8"));
    expect(specs.map((s) => [s.id, s.templateId])).toEqual([
      ["btc-funding-weekly", TemplateId.PerplFunding],
      ["eth-noon-daily", TemplateId.PriceAtTime],
      ["btc-touch-weekly", TemplateId.ChainlinkTouch],
      ["mon-funding-spike-daily", TemplateId.PerplFundingSpike],
      ["eth-range-daily", TemplateId.PriceRange],
    ]);
    for (const s of specs) expect(s.firstStake.amount).toBeGreaterThanOrEqual(5_000_000n);
  });

  it("reads durations in seconds, minutes, hours, days and weeks", () => {
    expect(parseDuration("90", "x")).toBe(90n);
    expect(parseDuration(45, "x")).toBe(45n);
    expect(parseDuration("30m", "x")).toBe(1_800n);
    expect(parseDuration("1h", "x")).toBe(3_600n);
    expect(parseDuration("1d", "x")).toBe(86_400n);
    expect(parseDuration("2w", "x")).toBe(1_209_600n);
    expect(() => parseDuration("1y", "x")).toThrow(/duration/);
  });

  const base = {
    id: "eth-noon",
    template: 2,
    asset: "ETH/USD",
    schedule: { anchor: "2026-10-05T12:00:00Z", every: "1d", lockBeforeClose: "1h" },
    strike: { rule: "spot-rounded", step: "50" },
    firstStake: { side: "yes", usdc: "5" },
  };
  const parse = (series: unknown[]) => parseSeriesFile(JSON.stringify({ series }));

  it("checks every field and says which one is wrong", () => {
    expect(parse([base])[0]).toMatchObject({
      id: "eth-noon",
      enabled: true,
      schedule: { clock: "time", anchor: 1_791_201_600n, every: 86_400n, minLead: 600n },
      strike: { rule: "spot-rounded", stepE8: 5_000_000_000n },
      firstStake: { side: Side.Yes, amount: 5_000_000n },
    });
    expect(() => parse([base, base])).toThrow(/appears twice/);
    expect(() => parse([{ ...base, id: "Bad Id" }])).toThrow(/lower-case/);
    expect(() => parse([{ ...base, template: 6 }])).toThrow(/parlays have no schedule/);
    expect(() => parse([{ ...base, strike: { rule: "trailing-median-funding", windows: 4 } }])).toThrow(
      /must be one of fixed, spot-rounded for template 2/,
    );
    expect(() => parse([{ ...base, firstStake: { side: "maybe", usdc: "5" } }])).toThrow(/side/);
    expect(() => parse([{ ...base, schedule: { ...base.schedule, anchor: "tomorrow" } }])).toThrow(
      /ISO time/,
    );
    expect(() =>
      parse([{ ...base, template: 5, strike: { rule: "range-around-spot", width: "150", step: "100" } }]),
    ).toThrow(/whole number of steps/);
    expect(() => parseSeriesFile("{}")).toThrow(/"series" list/);
  });
});

const funding: SeriesSpec = parseSeriesFile(readFileSync(EXAMPLE, "utf8"))[0] as SeriesSpec;
// The example ships the price series switched off (testnet feeds are slow); the schedule is the same.
const daily: SeriesSpec = {
  ...(parseSeriesFile(readFileSync(EXAMPLE, "utf8"))[1] as SeriesSpec),
  enabled: true,
};

describe("schedule", () => {
  it("block clock: picks the next period whose lock is at least the minimum lead away", () => {
    if (funding.schedule.clock !== "block") throw new Error("expected a block schedule");
    const s = funding.schedule;
    expect(periodAt(s, 0n)).toEqual({
      index: 0n,
      lock: s.anchorBlock,
      close: s.anchorBlock + s.windowBlocks,
      createAt: s.anchorBlock - s.createBeforeLockBlocks,
    });
    expect(nextPeriod(s, { block: 0n, timestamp: 0n }).index).toBe(0n);
    expect(nextPeriod(s, { block: s.anchorBlock - s.minLeadBlocks, timestamp: 0n }).index).toBe(0n);
    expect(nextPeriod(s, { block: s.anchorBlock - s.minLeadBlocks + 1n, timestamp: 0n }).index).toBe(1n);
  });

  it("time clock: due from the creation point until the lock is too close", () => {
    if (daily.schedule.clock !== "time") throw new Error("expected a time schedule");
    const s = daily.schedule;
    const p0 = periodAt(s, 0n);
    expect(p0.close).toBe(s.anchor);
    expect(p0.lock).toBe(s.anchor - s.lockBeforeClose);
    const before = seriesDecision(daily, { block: 0n, timestamp: p0.createAt - 1n });
    expect(before).toMatchObject({ due: false, period: { index: 0n } });
    expect(seriesDecision(daily, { block: 0n, timestamp: p0.createAt })).toMatchObject({
      due: true,
      period: { index: 0n },
    });
    // Too close to the lock: the next period is the one to wait for.
    expect(seriesDecision(daily, { block: 0n, timestamp: p0.lock - s.minLead + 1n }).period.index).toBe(1n);
    expect(seriesDecision({ ...daily, enabled: false }, { block: 0n, timestamp: p0.createAt }).due).toBe(
      false,
    );
  });
});

describe("strikes", () => {
  it("roundToStep", () => {
    expect(roundToStep(4_123n, 50n, "nearest")).toBe(4_100n);
    expect(roundToStep(4_125n, 50n, "nearest")).toBe(4_150n);
    expect(roundToStep(4_101n, 50n, "up")).toBe(4_150n);
    expect(roundToStep(4_149n, 50n, "down")).toBe(4_100n);
    expect(roundToStep(4_150n, 50n, "up")).toBe(4_150n);
    expect(roundToStep(-30n, 50n, "down")).toBe(-50n);
  });

  it("median and quantile", () => {
    expect(median([5n, 1n, 3n])).toBe(3n);
    expect(median([4n, 1n, 3n, 2n])).toBe(2n);
    expect(quantile([1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n, 9n, 10n], 0.9)).toBe(9n);
    expect(quantile([1n, 2n, 3n], 0.999)).toBe(3n);
    expect(windowDeltas([100n, 70n, 60n])).toEqual([30n, 10n]);
  });

  it("price rules from the spot price at the creation point", () => {
    const spot = 412_345_000_000n; // 4,123.45 USD
    expect(
      priceStrike({ rule: "spot-rounded", stepE8: 50n * 10n ** 8n }, spot, TouchDirection.AtOrAbove),
    ).toEqual({
      strikeE8: 4_100n * 10n ** 8n,
    });
    expect(
      priceStrike(
        { rule: "spot-offset", offsetBps: 500n, stepE8: 100n * 10n ** 8n },
        spot,
        TouchDirection.AtOrAbove,
      ),
    ).toEqual({ strikeE8: 4_400n * 10n ** 8n });
    expect(
      priceStrike(
        { rule: "spot-offset", offsetBps: 500n, stepE8: 100n * 10n ** 8n },
        spot,
        TouchDirection.AtOrBelow,
      ),
    ).toEqual({ strikeE8: 3_900n * 10n ** 8n });
    const band = priceStrike(
      { rule: "range-around-spot", widthE8: 200n * 10n ** 8n, stepE8: 100n * 10n ** 8n },
      spot,
      TouchDirection.AtOrAbove,
    );
    expect(band).toEqual({ lowerE8: 4_000n * 10n ** 8n, upperE8: 4_200n * 10n ** 8n });
  });

  it("the trailing median of real BTC funding windows on Perpl", () => {
    // 600 consecutive BTC funding events recorded from Monad mainnet (services/maker/test/fixtures).
    const fixture = JSON.parse(
      readFileSync(new URL("../../maker/test/fixtures/perpl-funding-btc.json", import.meta.url), "utf8"),
    ) as { samples: { sum: number }[] };
    // Windows of 50 events, newest first, as the series reads F at C, C − W, C − 2W, ...
    const sums = [600, 550, 500, 450, 400, 350, 300, 250, 200].map((i) =>
      BigInt(fixture.samples[i]?.sum ?? 0),
    );
    const deltas = windowDeltas(sums);
    expect(deltas).toHaveLength(8);
    const m = median(deltas);
    expect(deltas.filter((d) => d <= m).length).toBeGreaterThanOrEqual(4);
    expect(deltas.filter((d) => d >= m).length).toBeGreaterThanOrEqual(4);
  });
});

describe("params and identity", () => {
  it("builds each template's params from the period", () => {
    const p = { index: 3n, lock: 1_000n, close: 2_000n, createAt: 500n };
    const f = decodePerplFundingParams(
      buildParams(funding, p, { perpId: 16n, scalingExp: 0, threshold: 30n }),
    );
    expect(f).toEqual({
      perpId: 16n,
      startBlock: 1_000n,
      endBlock: 2_000n,
      threshold: 30n,
      expectedScalingExp: 0,
    });
    const t2 = decodePriceAtTimeParams(buildParams(daily, p, { feed: FEED, strike: { strikeE8: 7n } }));
    expect(t2).toMatchObject({ feed: FEED, strikeE8: 7n, lockTime: 1_000n, closeTime: 2_000n });
    const touch = { ...daily, templateId: TemplateId.ChainlinkTouch, direction: TouchDirection.AtOrBelow };
    const t3 = decodeChainlinkTouchParams(buildParams(touch, p, { feed: FEED, strike: { strikeE8: 7n } }));
    expect(t3).toMatchObject({
      direction: TouchDirection.AtOrBelow,
      lockTime: 1_000n,
      startTime: 1_000n,
      endTime: 2_000n,
    });
    const range = { ...daily, templateId: TemplateId.PriceRange };
    const t5 = decodePriceRangeParams(
      buildParams(range, p, { feed: FEED, strike: { lowerE8: 1n, upperE8: 2n } }),
    );
    expect(t5).toMatchObject({ lowerE8: 1n, upperE8: 2n });
    expect(() => buildParams(daily, p, { feed: FEED })).toThrow(/strike is missing/);
  });

  it("identity ignores the strike, so a changed rule never creates a period twice", () => {
    const p = { index: 0n, lock: 1_000n, close: 2_000n, createAt: 500n };
    const a = buildParams(daily, p, { feed: FEED, strike: { strikeE8: 7n } });
    const b = buildParams(daily, p, { feed: FEED, strike: { strikeE8: 8n } });
    expect(a).not.toBe(b);
    expect(periodIdentity(TemplateId.PriceAtTime, a)).toBe(periodIdentity(TemplateId.PriceAtTime, b));
    const later = buildParams(daily, { ...p, lock: 1_001n }, { feed: FEED, strike: { strikeE8: 7n } });
    expect(periodIdentity(TemplateId.PriceAtTime, later)).not.toBe(periodIdentity(TemplateId.PriceAtTime, a));
    expect(periodIdentity(TemplateId.Parlay, a)).toBeUndefined();
  });
});

describe("the series job across stacks", () => {
  // Series run on the default stack. A period already created on another stack (before `defaultStack`
  // moved, for example from the primary stack to `hunch`) is found there by its exact params and never
  // created again.
  const OWN = "0x846Cd400B832203befe5902ef43DAdc969985AF2" as Address;
  const OTHER = "0x2c30da53F8C384D6eD6603E3138a98fd15E4928A" as Address;
  const EXISTING = "0x2A44B99014cF73065BFb89197a08DE09D18d3982" as Address;
  const KEEPER = "0x1f5AC9bB0DF7d0E0DD133cBd71388e1078475569" as Address;
  const fixed: SeriesSpec = {
    ...daily,
    id: "eth-fixed",
    strike: { rule: "fixed", value: 400_000_000_000n },
  };
  if (fixed.schedule.clock !== "time") throw new Error("expected a time schedule");
  const createAt = periodAt(fixed.schedule, 0n).createAt;
  const now = { block: 1n, timestamp: createAt };

  function run(otherHas: Address) {
    const sent: { action: string; to: Address }[] = [];
    const asked: Address[] = [];
    const ctx = {
      deployment: {
        ...deployments["monad-testnet"],
        hunchBook: { factory: OWN, vault: OWN, usdc: OWN },
      },
      client: {
        readContract: async ({ address }: { address: Address }) => {
          asked.push(address);
          return zeroAddress;
        },
        multicall: async ({ contracts }: { contracts: { address: Address; functionName: string }[] }) =>
          contracts.map((c) => {
            if (c.functionName === "marketOf") {
              asked.push(c.address);
              return c.address === OTHER ? otherHas : zeroAddress;
            }
            if (c.functionName === "balanceOf" || c.functionName === "allowance") return 10n ** 12n;
            return false;
          }),
      },
      tx: { account: KEEPER, enabled: true },
      health: { jobInfo: () => {} },
      alerter: { send: async () => {} },
      verbose: false,
      knownMarkets: () => [],
      failed: (_job: string, _label: string, error: unknown) => {
        throw error;
      },
      send: async (_job: string, _label: string, request: { action: string; to: Address }) => {
        sent.push({ action: request.action, to: request.to });
        return { status: "dry-run", simulation: { ok: true } };
      },
    } as unknown as JobContext;
    return { ctx, sent, asked };
  }

  it("does not create a period another stack's factory already has", async () => {
    const job = new SeriesJob([fixed], { enabled: true, otherFactories: [OTHER] });
    const { ctx, sent, asked } = run(EXISTING);
    const result = await job.run(ctx, [], now);
    expect(result).toEqual({ sent: 0, due: 0 });
    expect(sent).toEqual([]);
    expect(asked).toEqual([OWN, OTHER]);
  });

  it("creates it on its own stack when no stack has it", async () => {
    const job = new SeriesJob([fixed], { enabled: true, otherFactories: [OTHER] });
    const { ctx, sent } = run(zeroAddress);
    const result = await job.run(ctx, [], now);
    expect(result.due).toBe(1);
    expect(sent).toEqual([{ action: "createMarket", to: OWN }]);
  });
});

import {
  decodeChainlinkTouchParams,
  decodePriceAtTimeParams,
  decodePriceRangeParams,
  deployments,
  encodeChainlinkTouchParams,
  encodeParlayParams,
  encodePerplFundingParams,
  encodePerplFundingSpikeParams,
  encodePriceAtTimeParams,
  encodePriceRangeParams,
  Outcome,
  Phase,
  PriceSource,
  TemplateId,
  TouchDirection,
} from "@hunch-book/shared";
import type { Address, Hex } from "viem";
import { describe, expect, it } from "vitest";
import { chartGeometry, compactStrike, curvePath, niceTicks, xDomain } from "../src/lib/ladder/chart";
import {
  groupLadders,
  ladderOpen,
  ladderSpec,
  ladderStep,
  missingStrikes,
  monotoneBreaks,
  niceStep,
  rungLabel,
  strikeLabel,
} from "../src/lib/ladder/group";
import { createPrefillPath, parsePrefill } from "../src/lib/ladder/prefill";
import type { MarketView } from "../src/lib/market/types";
import { clock, makeMarket } from "./fixtures";

const testnet = deployments["monad-testnet"];
const BTC = testnet.external.chainlink["BTC/USD"] as Address;
const ETH = testnet.external.chainlink["ETH/USD"] as Address;
const ZERO32 = `0x${"00".repeat(32)}` as Hex;
const E8 = 100_000_000n;

let n = 0;
const addr = (): Address => `0x${(0xa00 + ++n).toString(16).padStart(40, "0")}` as Address;

function priceMarket(
  strike: bigint,
  yesBps: number | null,
  over: Partial<MarketView> = {},
  feed = BTC,
): MarketView {
  const params = encodePriceAtTimeParams({
    source: PriceSource.Chainlink,
    feed,
    pythId: ZERO32,
    strikeE8: strike * E8,
    lockTime: 1_800_000_000n,
    closeTime: 1_800_086_400n,
  });
  const yes = yesBps === null ? 0n : BigInt(yesBps) * 1_000n;
  const no = yesBps === null ? 0n : BigInt(10_000 - yesBps) * 1_000n;
  return makeMarket({
    address: addr(),
    templateId: TemplateId.PriceAtTime,
    params,
    pool: { yes, no, total: yes + no, stakers: 3 },
    ...over,
  });
}

describe("ladderSpec", () => {
  it("keys price-at-time markets by everything but the strike, and can re-encode another strike", () => {
    const a = ladderSpec(priceMarket(120_000n, 4_000), testnet);
    const b = ladderSpec(priceMarket(125_000n, 3_000), testnet);
    expect(a?.key).toBe(b?.key);
    expect(a).toMatchObject({
      shape: "strike",
      axis: "usd",
      sense: "above",
      asset: "BTC/USD",
      x: 120_000n * E8,
    });
    const re = a?.withStrike(130_000n * E8) as Hex;
    expect(decodePriceAtTimeParams(re)).toMatchObject({ strikeE8: 130_000n * E8, closeTime: 1_800_086_400n });
    expect(ladderSpec(priceMarket(120_000n, 4_000, {}, ETH), testnet)?.key).not.toBe(a?.key);
  });

  it("reads touch, range and both Perpl templates, and refuses parlays and bad bytes", () => {
    const touch = ladderSpec(
      makeMarket({
        templateId: TemplateId.ChainlinkTouch,
        params: encodeChainlinkTouchParams({
          feed: BTC,
          strikeE8: 70_000n * E8,
          direction: TouchDirection.AtOrBelow,
          lockTime: 1n,
          startTime: 2n,
          endTime: 3n,
        }),
      }),
      testnet,
    );
    expect(touch).toMatchObject({ sense: "below", x: 70_000n * E8 });
    expect(decodeChainlinkTouchParams(touch?.withStrike(60_000n * E8) as Hex).strikeE8).toBe(60_000n * E8);

    const range = ladderSpec(
      makeMarket({
        templateId: TemplateId.PriceRange,
        params: encodePriceRangeParams({
          source: PriceSource.Chainlink,
          feed: BTC,
          pythId: ZERO32,
          lowerE8: 80_000n * E8,
          upperE8: 85_000n * E8,
          lockTime: 1n,
          closeTime: 2n,
        }),
      }),
      testnet,
    );
    expect(range).toMatchObject({ shape: "range", sense: "range", x: 80_000n * E8, upper: 85_000n * E8 });
    expect(decodePriceRangeParams(range?.withStrike(85_000n * E8, 90_000n * E8) as Hex)).toMatchObject({
      lowerE8: 85_000n * E8,
      upperE8: 90_000n * E8,
    });

    const perpl = { perpId: 16n, startBlock: 10n, endBlock: 20n, threshold: 5n, expectedScalingExp: 0 };
    const funding = ladderSpec(
      makeMarket({ templateId: TemplateId.PerplFunding, params: encodePerplFundingParams(perpl) }),
      testnet,
    );
    expect(funding).toMatchObject({ axis: "perpl", sense: "more", asset: "BTC", x: 5n });
    const spike = ladderSpec(
      makeMarket({ templateId: TemplateId.PerplFundingSpike, params: encodePerplFundingSpikeParams(perpl) }),
      testnet,
    );
    expect(spike?.key.startsWith("4:")).toBe(true);
    expect(spike?.key).not.toBe(funding?.key);

    const parlay = encodeParlayParams({ legs: [addr(), addr()], lockTime: 1n, closeTime: 2n });
    expect(ladderSpec(makeMarket({ templateId: TemplateId.Parlay, params: parlay }), testnet)).toBeNull();
    expect(
      ladderSpec(makeMarket({ templateId: TemplateId.PriceRange, params: "0x1234" }), testnet),
    ).toBeNull();
  });
});

describe("groupLadders", () => {
  it("groups same-question markets, sorts rungs by strike, and drops single markets by default", () => {
    const markets = [
      priceMarket(125_000n, 3_000),
      priceMarket(115_000n, 6_000),
      priceMarket(120_000n, 4_500),
      priceMarket(100_000n, 9_000, {}, ETH),
    ];
    const ladders = groupLadders(markets, testnet);
    expect(ladders).toHaveLength(1);
    expect(ladders[0]?.points.map((p) => p.x / E8)).toEqual([115_000n, 120_000n, 125_000n]);
    expect(ladders[0]?.points.map((p) => p.chanceBps)).toEqual([6_000n, 4_500n, 3_000n]);
    expect(ladders[0]?.title).toMatch(/^BTC\/USD at or above a strike at /);
    expect(groupLadders(markets, testnet, { minPoints: 1 })).toHaveLength(2);
  });

  it("puts bigger ladders first", () => {
    const small = [priceMarket(1n, 5_000, {}, ETH), priceMarket(2n, 4_000, {}, ETH)];
    const big = [priceMarket(1n, 5_000), priceMarket(2n, 4_000), priceMarket(3n, 3_000)];
    expect(groupLadders([...small, ...big], testnet).map((l) => l.points.length)).toEqual([3, 2]);
  });
});

describe("missing strikes", () => {
  it("finds the step as the commonest gap, or a round share of a single strike", () => {
    expect(niceStep(6_000n)).toBe(5_000n);
    expect(niceStep(2_500n)).toBe(2_000n);
    expect(niceStep(1_999n)).toBe(1_000n);
    expect(niceStep(0n)).toBe(1n);
    expect(ladderStep([100n, 110n, 120n, 140n], "usd")).toBe(10n);
    expect(ladderStep([120_000n * E8], "usd")).toBe(5_000n * E8);
    expect(ladderStep([40n], "perpl")).toBe(10n);
  });

  it("fills gaps first, then extends one step past each end", () => {
    const ladder = groupLadders(
      [priceMarket(110_000n, 7_000), priceMarket(115_000n, 6_000), priceMarket(130_000n, 2_000)],
      testnet,
    )[0];
    expect(ladder).toBeDefined();
    const got = missingStrikes(ladder as never, 6).map((s) => [s.x / E8, s.where]);
    expect(got).toEqual([
      [120_000n, "gap"],
      [125_000n, "gap"],
      [135_000n, "above"],
      [105_000n, "below"],
    ]);
  });

  it("suggests the neighbouring buckets of a range ladder", () => {
    const bucket = (lo: bigint, hi: bigint) =>
      makeMarket({
        address: addr(),
        templateId: TemplateId.PriceRange,
        params: encodePriceRangeParams({
          source: PriceSource.Chainlink,
          feed: BTC,
          pythId: ZERO32,
          lowerE8: lo * E8,
          upperE8: hi * E8,
          lockTime: 1n,
          closeTime: 2n,
        }),
      });
    const ladder = groupLadders([bucket(80_000n, 85_000n), bucket(90_000n, 95_000n)], testnet)[0];
    const got = missingStrikes(ladder as never).map((s) => [s.x / E8, (s.upper as bigint) / E8, s.where]);
    expect(got).toEqual([
      [85_000n, 90_000n, "gap"],
      [95_000n, 100_000n, "above"],
      [75_000n, 80_000n, "below"],
    ]);
  });

  it("never suggests a price at or below zero", () => {
    const ladder = groupLadders([priceMarket(5n, 5_000), priceMarket(10n, 4_000)], testnet)[0];
    expect(missingStrikes(ladder as never).every((s) => s.x > 0n)).toBe(true);
  });
});

describe("ladder checks", () => {
  it("flags neighbours whose chances run the wrong way", () => {
    const ladder = groupLadders(
      [priceMarket(110_000n, 5_000), priceMarket(120_000n, 6_000), priceMarket(130_000n, 1_000)],
      testnet,
    )[0];
    const breaks = monotoneBreaks(ladder as never);
    expect(breaks).toHaveLength(1);
    expect(breaks[0]?.[1].x).toBe(120_000n * E8);
    const settled = priceMarket(120_000n, 6_000, { phase: Phase.Settled, outcome: Outcome.Yes });
    expect(
      monotoneBreaks(groupLadders([priceMarket(110_000n, 5_000), settled], testnet)[0] as never),
    ).toEqual([]);
  });

  it("is open for new rungs only while the shared lock is in the future", () => {
    const ladder = groupLadders([priceMarket(1n, 5_000), priceMarket(2n, 4_000)], testnet)[0];
    expect(ladderOpen(ladder as never, null, 1_799_999_000)).toBe(true);
    expect(ladderOpen(ladder as never, null, 1_800_000_000)).toBe(false);
    const block = {
      ...(ladder as never as { window: MarketView["window"] }),
      window: { blockClock: true, lock: 1_000_000n, close: 1_002_000n, settleDeadline: 0n },
    };
    expect(ladderOpen(block, clock, clock.timestamp)).toBe(true);
    expect(ladderOpen(block, null, clock.timestamp)).toBe(false);
  });

  it("labels strikes and buckets in plain words", () => {
    expect(strikeLabel(120_000n * E8, "usd")).toBe("$120,000");
    expect(strikeLabel(33n, "perpl")).toBe("33 raw units");
    expect(rungLabel({ x: 80_000n * E8, upper: 85_000n * E8 }, "usd")).toBe("$80,000 to $85,000");
  });
});

describe("ladder chart", () => {
  it("pads the domain and draws round ticks", () => {
    expect(
      xDomain([
        { x: 100n, upper: null },
        { x: 200n, upper: null },
      ]),
    ).toEqual({ min: 90n, max: 210n });
    expect(niceTicks(90n, 210n)).toEqual([100n, 120n, 140n, 160n, 180n, 200n]);
    expect(niceTicks(-7n, 12n, 4)).toEqual([-5n, 0n, 5n, 10n]);
    const single = xDomain([{ x: 120_000n * E8, upper: null }]);
    expect(single.min < 120_000n * E8 && single.max > 120_000n * E8).toBe(true);
  });

  it("maps strikes across and chances up, and draws the curve through priced rungs only", () => {
    const ladder = groupLadders(
      [priceMarket(110_000n, 7_000), priceMarket(120_000n, 4_000), priceMarket(130_000n, null)],
      testnet,
    )[0];
    const g = chartGeometry(ladder?.points ?? [], "usd");
    expect(g.y(10_000n)).toBe(g.box.pad.top);
    expect(g.y(0n)).toBe(g.box.height - g.box.pad.bottom);
    expect(g.x(g.xMin)).toBe(g.box.pad.left);
    const path = curvePath(ladder?.points ?? [], g);
    expect(path.startsWith("M")).toBe(true);
    expect(path.match(/L/g)).toHaveLength(1);
    expect(g.yTicks.map((t) => t.label)).toEqual(["0%", "25%", "50%", "75%", "100%"]);
  });

  it("writes compact strike labels", () => {
    expect(compactStrike(120_000n * E8, "usd")).toBe("$120k");
    expect(compactStrike(1_500_000n * E8, "usd")).toBe("$1.5M");
    expect(compactStrike(3_500n * E8, "usd")).toBe("$3,500");
    expect(compactStrike(12_500n * E8, "usd")).toBe("$12.5k");
    expect(compactStrike(-4n, "perpl")).toBe("-4");
  });
});

describe("create prefill", () => {
  it("round-trips the template id and the exact params", () => {
    const params = encodePriceAtTimeParams({
      source: PriceSource.Chainlink,
      feed: BTC,
      pythId: ZERO32,
      strikeE8: 1n,
      lockTime: 2n,
      closeTime: 3n,
    });
    const path = createPrefillPath(TemplateId.PriceAtTime, params, "ladder");
    expect(path.startsWith("/create?template=2&params=0x")).toBe(true);
    expect(path.endsWith("&from=ladder")).toBe(true);
    const back = parsePrefill(new URL(path, "https://x").searchParams);
    expect(back).toEqual({ templateId: 2, params });
    expect(parsePrefill(new URLSearchParams("template=2&params=0x123"))).toBeNull();
    expect(parsePrefill(new URLSearchParams("template=x&params=0x12"))).toBeNull();
  });
});

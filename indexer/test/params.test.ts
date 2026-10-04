// Market parameters: decoding and the one-sentence summary, against the contracts' own shapes.
import { describe, expect, it } from "vitest";
import {
  templateParamsCodecAbi,
  templateParamsCodecV2Abi,
  templateParamsCodecV3Abi,
} from "../../packages/shared/src/abis/generated.js";
import {
  encodeChainlinkTouchParams,
  encodeParlayParams,
  encodePerplFundingSpikeParams,
  encodePriceRangeParams,
  encodeSnapshotParams,
  snapshotKey as sharedSnapshotKey,
} from "../../packages/shared/src/templates.js";
import { TemplateId } from "../../packages/shared/src/types.js";
import { networkOf } from "../src/lib/network.js";
import {
  chainlinkTouchParamsAbi,
  comparatorOf,
  formatDecimal,
  formatUsd,
  formatUtc,
  marketTerms,
  parlayDetails,
  parlayParamsAbi,
  perplFundingParamsAbi,
  perplFundingSpikeParamsAbi,
  priceAtTimeParamsAbi,
  priceRangeParamsAbi,
  snapshotId,
  snapshotKey,
  snapshotParamsAbi,
  TEMPLATE_CHAINLINK_TOUCH,
  TEMPLATE_PARLAY,
  TEMPLATE_PERPL_FUNDING,
  TEMPLATE_PERPL_FUNDING_SPIKE,
  TEMPLATE_PRICE_AT_TIME,
  TEMPLATE_PRICE_RANGE,
  TEMPLATE_SNAPSHOT,
  touchDirectionOf,
} from "../src/lib/params.js";
import { perplParams, priceParams, SEED, snapshotParams } from "./helpers.js";

const testnet = networkOf(10143);
const shapeOf = (components: readonly { name?: string; type: string }[]) =>
  components.map((c) => [c.name, c.type]);

describe("template parameters", () => {
  it("use the structs from ITemplates.sol and the factory's template ids", () => {
    const codec = (name: string) => {
      const fn = templateParamsCodecAbi.find((x) => x.type === "function" && x.name === name);
      if (fn?.type !== "function") throw new Error(name);
      return (fn.inputs[0] as { components: readonly { name: string; type: string }[] }).components;
    };
    expect(shapeOf(perplFundingParamsAbi[0].components)).toEqual(shapeOf(codec("perplFunding")));
    expect(shapeOf(priceAtTimeParamsAbi[0].components)).toEqual(shapeOf(codec("priceAtTime")));
    expect(TEMPLATE_PERPL_FUNDING).toBe(BigInt(TemplateId.PerplFunding));
    expect(TEMPLATE_PRICE_AT_TIME).toBe(BigInt(TemplateId.PriceAtTime));
  });

  it("use the structs from ITemplatesV2.sol for templates 3 to 6", () => {
    const codec = (name: string) => {
      const fn = templateParamsCodecV2Abi.find((x) => x.type === "function" && x.name === name);
      if (fn?.type !== "function") throw new Error(name);
      return (fn.inputs[0] as { components: readonly { name: string; type: string }[] }).components;
    };
    expect(shapeOf(chainlinkTouchParamsAbi[0].components)).toEqual(shapeOf(codec("chainlinkTouch")));
    expect(shapeOf(perplFundingSpikeParamsAbi[0].components)).toEqual(shapeOf(codec("perplFundingSpike")));
    expect(shapeOf(priceRangeParamsAbi[0].components)).toEqual(shapeOf(codec("priceRange")));
    expect(shapeOf(parlayParamsAbi[0].components)).toEqual(shapeOf(codec("parlay")));
    expect([
      TEMPLATE_CHAINLINK_TOUCH,
      TEMPLATE_PERPL_FUNDING_SPIKE,
      TEMPLATE_PRICE_RANGE,
      TEMPLATE_PARLAY,
    ]).toEqual([
      BigInt(TemplateId.ChainlinkTouch),
      BigInt(TemplateId.PerplFundingSpike),
      BigInt(TemplateId.PriceRange),
      BigInt(TemplateId.Parlay),
    ]);
  });

  it("decodes touch, spike, range and parlay markets", () => {
    const touch = encodeChainlinkTouchParams({
      feed: "0x12C0F44368a02081ce58a936d1C1F606BB301715",
      strikeE8: 10_000_000_000_000n,
      direction: 0,
      lockTime: 1_791_158_400n,
      startTime: 1_791_158_400n,
      endTime: 1_791_244_800n,
    });
    expect(marketTerms(3n, touch, testnet)).toEqual({
      question:
        "Will Chainlink's BTC/USD feed report a price at or above $100,000 in any round updated from 2026-10-05 00:00:00 UTC to 2026-10-06 00:00:00 UTC?",
      asset: "BTC/USD",
      priceSource: "Chainlink",
      feed: "0x12c0f44368a02081ce58a936d1c1f606bb301715",
      pythId: undefined,
      strikeE8: 10_000_000_000_000n,
      comparator: "AtOrAbove",
      blockClock: false,
      windowStart: 1_791_158_400n,
      lockAt: 1_791_158_400n,
      closeAt: 1_791_244_800n,
      settleDeadline: 1_791_244_800n + 86_400n + 604_800n,
    });
    const down = encodeChainlinkTouchParams({
      feed: "0x00000000000000000000000000000000000000aa",
      strikeE8: 5_000_000_000n,
      direction: 1,
      lockTime: 1n,
      startTime: 1n,
      endTime: 2n,
    });
    expect(marketTerms(3n, down, testnet)).toMatchObject({ comparator: "AtOrBelow", asset: undefined });

    const spike = encodePerplFundingSpikeParams({
      perpId: 16n,
      startBlock: 100n,
      endBlock: 200n,
      threshold: 7_500n,
      expectedScalingExp: 3,
    });
    expect(marketTerms(4n, spike, testnet)).toEqual({
      question:
        "Will any single funding event on Perpl (perp 16) after block 100 and at or before block 200 charge BTC longs more than 7,500 raw funding units?",
      asset: "BTC",
      perpId: 16n,
      threshold: 7_500n,
      blockClock: true,
      windowStart: 100n,
      lockAt: 100n,
      closeAt: 200n,
    });

    const btcPyth = Object.keys(testnet.pythIds).find(
      (id) => testnet.pythIds[id] === "BTC/USD",
    ) as `0x${string}`;
    const range = encodePriceRangeParams({
      source: 1,
      feed: "0x0000000000000000000000000000000000000000",
      pythId: btcPyth,
      lowerE8: 9_000_000_000_000n,
      upperE8: 9_500_000_000_000n,
      lockTime: 10n,
      closeTime: 1_791_244_800n,
    });
    expect(marketTerms(5n, range, testnet)).toEqual({
      question:
        "Will BTC/USD be at or above $90,000 and below $95,000 at 2026-10-06 00:00:00 UTC (unix time 1791244800), per Pyth's BTC/USD feed?",
      asset: "BTC/USD",
      priceSource: "Pyth",
      feed: undefined,
      pythId: btcPyth,
      lowerE8: 9_000_000_000_000n,
      upperE8: 9_500_000_000_000n,
      blockClock: false,
      lockAt: 10n,
      closeAt: 1_791_244_800n,
      settleDeadline: 1_791_244_800n + 604_800n,
    });

    const legs = [
      "0x00000000000000000000000000000000000000b2",
      "0x00000000000000000000000000000000000000B1",
    ] as const;
    const parlay = encodeParlayParams({ legs, lockTime: 5n, closeTime: 1_791_244_800n });
    // Without the legs' markets, the summary names the legs by address and the deadline stays unknown.
    expect(marketTerms(6n, parlay, testnet)).toEqual({
      question:
        "Will all 2 of these Hunch Book markets settle YES: 0x00000000000000000000000000000000000000b1, 0x00000000000000000000000000000000000000b2?",
      settleDeadline: undefined,
      legs: ["0x00000000000000000000000000000000000000b1", "0x00000000000000000000000000000000000000b2"],
      blockClock: false,
      lockAt: 5n,
      closeAt: 1_791_244_800n,
    });
    expect(
      parlayDetails(
        [
          { id: "0xb1", number: 3, settleDeadline: 1_791_900_000n },
          { id: "0xb2", number: 4, settleDeadline: 1_791_000_000n },
        ],
        1_791_244_800n,
      ),
    ).toEqual({
      question: "Will all 2 of these Hunch Book markets settle YES: #3, #4?",
      settleDeadline: 1_791_900_000n + 604_800n,
    });
    expect(touchDirectionOf(1)).toBe("AtOrBelow");
    expect(() => touchDirectionOf(2)).toThrow(/unknown touch direction 2/);
  });

  it("decodes the seeded testnet market", () => {
    expect(marketTerms(1n, SEED.params, testnet)).toEqual({
      question:
        "Will MON longs pay more than 1,500 raw funding units on Perpl (perp 64) between block 68058301 and block 68264005?",
      asset: "MON",
      perpId: 64n,
      threshold: 1_500n,
      blockClock: true,
      lockAt: 68_058_301n,
      closeAt: 68_264_005n,
    });
  });

  it("words net funding, negative thresholds and unknown perps", () => {
    const net = marketTerms(
      1n,
      perplParams({ perpId: 16n, startBlock: 10n, endBlock: 20n, threshold: 0n }),
      testnet,
    );
    expect(net.question).toBe(
      "Will BTC longs pay shorts on net in funding on Perpl (perp 16) between block 10 and block 20?",
    );
    const negative = marketTerms(
      1n,
      perplParams({ perpId: 999n, startBlock: 1n, endBlock: 2n, threshold: -36_874n }),
      testnet,
    );
    expect(negative.question).toBe(
      "Will longs pay more than -36,874 raw funding units on Perpl (perp 999) between block 1 and block 2?",
    );
    expect(negative.asset).toBeUndefined();
  });

  it("decodes price markets with Chainlink feeds it knows and ones it does not", () => {
    const known = marketTerms(
      2n,
      priceParams({
        feed: "0x12C0F44368a02081ce58a936d1C1F606BB301715",
        strikeE8: 8_469_650_000_000n,
        lockTime: 100n,
        closeTime: 1_791_244_800n,
      }),
      testnet,
    );
    expect(known).toMatchObject({
      asset: "BTC/USD",
      priceSource: "Chainlink",
      feed: "0x12c0f44368a02081ce58a936d1c1f606bb301715",
      pythId: undefined,
      blockClock: false,
      lockAt: 100n,
      closeAt: 1_791_244_800n,
      settleDeadline: 1_791_244_800n + 604_800n,
    });
    const unknown = marketTerms(
      2n,
      priceParams({
        feed: "0x00000000000000000000000000000000000000aa",
        strikeE8: -25_000_000n,
        lockTime: 1n,
        closeTime: 0n,
      }),
      testnet,
    );
    expect(unknown.question).toBe(
      "Will 0x00000000000000000000000000000000000000aa be at or above -$0.25 at 1970-01-01 00:00:00 UTC (unix time 0), per Chainlink's 0x00000000000000000000000000000000000000aa feed?",
    );
    expect(unknown.asset).toBeUndefined();
  });

  it("names Pyth feeds by their price id", () => {
    const params = priceParams({
      feed: "0x0000000000000000000000000000000000000000",
      strikeE8: 1n,
      lockTime: 1n,
      closeTime: 2n,
    });
    // Swap the source byte to Pyth and the id to BTC/USD's.
    const btc = testnet.pythIds;
    const btcId = Object.keys(btc).find((id) => btc[id] === "BTC/USD") as string;
    const pythParams = `0x${"0".repeat(63)}1${params.slice(66, 130)}${btcId.slice(2)}${params.slice(194)}`;
    const terms = marketTerms(2n, pythParams, testnet);
    expect(terms).toMatchObject({ asset: "BTC/USD", priceSource: "Pyth", pythId: btcId, feed: undefined });
    expect(terms.question).toContain("per Pyth's BTC/USD feed?");
  });

  it("decodes template 7 with the struct from ITemplatesV3.sol and the resolver's snapshot key", () => {
    const fn = templateParamsCodecV3Abi.find((x) => x.type === "function" && x.name === "snapshot");
    if (fn?.type !== "function") throw new Error("snapshot");
    const components = (fn.inputs[0] as { components: readonly { name: string; type: string }[] }).components;
    expect(shapeOf(snapshotParamsAbi[0].components)).toEqual(shapeOf(components));
    expect(TEMPLATE_SNAPSHOT).toBe(BigInt(TemplateId.Snapshot));

    const terms = {
      sourceId: 7,
      threshold: -2_500n,
      comparator: 2,
      lockTime: 100n,
      closeTime: 1_791_244_800n,
    };
    const params = snapshotParams({ ...terms, snapshotWindow: 1_800 });
    expect(params).toBe(encodeSnapshotParams({ ...terms, comparator: 2, snapshotWindow: 1_800 }));
    expect(marketTerms(7n, params, testnet)).toEqual({
      question:
        "Will snapshot source 7 read below -2,500 (raw units) in the first snapshot taken from 2026-10-06 00:00:00 UTC to 2026-10-06 00:30:00 UTC?",
      threshold: -2_500n,
      blockClock: false,
      lockAt: 100n,
      closeAt: 1_791_244_800n,
      settleDeadline: 1_791_244_800n + 1_800n + 604_800n,
      snapshotKey: sharedSnapshotKey(7, 1_791_244_800n, 1_800),
      snapshotSourceId: 7,
      snapshotWindow: 1_800,
      comparator: "Below",
    });
    expect(snapshotKey(0, 5n, 60)).toBe(sharedSnapshotKey(0, 5n, 60));
    expect(["Above", "AtOrAbove", "Below", "AtOrBelow"].map((_, i) => comparatorOf(i))).toEqual([
      "Above",
      "AtOrAbove",
      "Below",
      "AtOrBelow",
    ]);
    expect(() => comparatorOf(4)).toThrow(/unknown comparator 4/);
    // A comparator the resolver would refuse leaves the market without terms rather than failing.
    expect(marketTerms(7n, snapshotParams({ ...terms, comparator: 9, snapshotWindow: 60 }), testnet)).toEqual(
      {},
    );
    expect(snapshotId("0xABCDEF", "0x12AB")).toBe("0xabcdef-0x12ab");
  });

  it("gives no terms for unknown templates or malformed bytes", () => {
    expect(marketTerms(3n, SEED.params, testnet)).toEqual({});
    expect(marketTerms(99n, SEED.params, testnet)).toEqual({});
    expect(marketTerms(1n, "0x1234", testnet)).toEqual({});
    expect(marketTerms(7n, "0x1234", testnet)).toEqual({});
  });

  it("formats numbers like ResolverText", () => {
    expect(formatDecimal(8_469_650_000_000n, 8)).toBe("84,696.5");
    expect(formatDecimal(1_234_567n, 0)).toBe("1,234,567");
    expect(formatDecimal(25n, 2)).toBe("0.25");
    expect(formatDecimal(0n, 8)).toBe("0");
    expect(formatDecimal(-36_874n, 0)).toBe("-36,874");
    expect(formatUsd(-25_000_000n, 8)).toBe("-$0.25");
    expect(formatUsd(100_000_000n, 8)).toBe("$1");
    expect(formatUtc(1_791_244_800n)).toBe("2026-10-06 00:00:00 UTC");
  });
});

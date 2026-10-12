import {
  deployments,
  encodePerplFundingParams,
  encodePerplFundingSpikeParams,
  TemplateId,
} from "@hunch-book/shared";
import { describe, expect, it } from "vitest";
import { formatInt, formatShortUtc } from "../src/lib/format";
import { decodeMarketParams } from "../src/lib/market/params";
import {
  blockWindowWords,
  friendlyQuestion,
  fundingThresholdRate,
  marketTitle,
  ratePercentText,
  roundedBlockTime,
  type TitleClock,
  titleDiffersFromRule,
} from "../src/lib/market/title";
import type { FundingScale } from "../src/lib/market/types";
import { makeMarket } from "./fixtures";

// Market titles: Perpl's resolver sentences name block numbers; titles read them as estimated times.

const testnet = deployments["monad-testnet"];

// Head block 68,036,598 at 2026-10-04 01:00:00 UTC, 400 ms per block.
const HEAD_TIME = Date.UTC(2026, 9, 4, 1, 0, 0) / 1000;
const clock: TitleClock = { blockNumber: 68_036_598n, timestamp: HEAD_TIME, msPerBlock: 400 };
/** The block expected `seconds` after the head. */
const blockIn = (seconds: number): bigint => clock.blockNumber + BigInt((seconds * 1000) / 400);

// Market #1 on testnet, as its resolver describes it.
const START = blockIn(5 * 3_600 + 10 * 60); // about 06:10
const END = blockIn(24 * 3_600); // about 01:00 the next day
const RULE_1 = `Will MON longs pay more than $0.000015 per MON in funding on Perpl (MON Perp, perp 64) between block ${START} and block ${END}?`;

describe("formatShortUtc", () => {
  it("writes a short UTC month, day and time", () => {
    expect(formatShortUtc(HEAD_TIME)).toBe("Oct 4, 01:00");
    expect(formatShortUtc(Date.UTC(2027, 0, 16, 8, 5) / 1000)).toBe("Jan 16, 08:05");
    expect(formatShortUtc(Number.NaN)).toBe("unknown time");
  });
});

describe("block times in titles", () => {
  it("estimates a block's time from the head and the pace, rounded to five minutes", () => {
    expect(roundedBlockTime(START, clock)).toBe(HEAD_TIME + 5 * 3_600 + 10 * 60);
    // Two minutes past a five-minute mark rounds down; three minutes past rounds up.
    expect(roundedBlockTime(blockIn(120), clock)).toBe(HEAD_TIME);
    expect(roundedBlockTime(blockIn(180), clock)).toBe(HEAD_TIME + 300);
    // A block in the past works the same way.
    expect(roundedBlockTime(clock.blockNumber - 9_000n, clock)).toBe(HEAD_TIME - 3_600);
  });

  it("names the window with times, or the grouped blocks while there is no clock", () => {
    expect(blockWindowWords(START, END, clock)).toBe("between about Oct 4, 06:10 and Oct 5, 01:00 UTC");
    expect(blockWindowWords(68_058_301n, 68_264_005n, null)).toBe(
      "between block 68,058,301 and block 68,264,005",
    );
    expect(blockWindowWords(1n, 2n, { ...clock, msPerBlock: 0 })).toBe("between block 1 and block 2");
  });
});

describe("friendlyQuestion", () => {
  it("turns template 1's sentence into times and drops the venue detail", () => {
    expect(friendlyQuestion(RULE_1, clock)).toBe(
      "Will MON longs pay more than $0.000015 per MON in funding on Perpl between about Oct 4, 06:10 and Oct 5, 01:00 UTC?",
    );
    expect(friendlyQuestion(RULE_1, null)).toBe(
      `Will MON longs pay more than $0.000015 per MON in funding on Perpl between block ${formatInt(START)} and block ${formatInt(END)}?`,
    );
  });

  it("handles the net-funding shape and the resolver's text when Perpl did not answer", () => {
    expect(
      friendlyQuestion(
        `Will BTC longs pay shorts on net in funding on Perpl (BTC Perp, perp 16) between block ${START} and block ${END}?`,
        clock,
      ),
    ).toBe(
      "Will BTC longs pay shorts on net in funding on Perpl between about Oct 4, 06:10 and Oct 5, 01:00 UTC?",
    );
    expect(
      friendlyQuestion(
        `Will longs on Perpl perp 64 pay more than 15 raw funding units between block ${START} and block ${END}?`,
        clock,
      ),
    ).toBe(
      "Will longs on Perpl perp 64 pay more than 15 raw funding units between about Oct 4, 06:10 and Oct 5, 01:00 UTC?",
    );
  });

  it("asks template 4's rule as a question", () => {
    const spike = `YES if any single funding event on Perpl (BTC Perp, perp 16) after block ${START} and at or before block ${END} charges BTC longs more than $2.5 per BTC; NO if nobody proves one by block ${END + 216_000n}, about 24 hours after the window.`;
    expect(friendlyQuestion(spike, clock)).toBe(
      "Will any single BTC funding event on Perpl charge longs more than $2.5 per BTC between about Oct 4, 06:10 and Oct 5, 01:00 UTC?",
    );
    const raw = `YES if any single funding event on Perpl perp 16 after block ${START} and at or before block ${END} charges longs more than 25 raw funding units; NO if nobody proves one by block 1, about 24 hours after the window.`;
    expect(friendlyQuestion(raw, clock)).toBe(
      "Will any single funding event on Perpl charge longs more than 25 raw funding units between about Oct 4, 06:10 and Oct 5, 01:00 UTC?",
    );
  });

  it("leaves text without a block window as it is", () => {
    const price = "Will BTC/USD be at or above $120,000 at 2027-01-16 08:00:00 UTC?";
    expect(friendlyQuestion(price, clock)).toBe(price);
  });
});

// Template 7 and template 6 sentences, word for word as SnapshotResolver and MarketOutcomeResolver
// return them on testnet.
const SNAPSHOT_RULE =
  "YES if Perpl's MON mark price (perp 64) is at or above $0.025 in the first snapshot taken from 2026-10-12 16:00:00 UTC to 2026-10-12 16:30:00 UTC; NO otherwise. If nobody takes a snapshot in that window, the market voids.";
const OI_RULE =
  "YES if Perpl's BTC open interest (perp 16) is below 22.00000 BTC in the first snapshot taken from 2026-10-15 18:00:00 UTC to 2026-10-15 18:30:00 UTC; NO otherwise. If nobody takes a snapshot in that window, the market voids.";
const PARLAY_RULE =
  "YES if all 2 of these Hunch Book markets settle YES: #5 (0x6ac842C5240eAC9207e0C66e7AA99448887Abdb1), #6 (0xb9cA87cb725aa34444d3Be1906D5472C63bB00A9); NO if any of them settles NO; if one voids while none has settled NO, this market voids at its deadline.";

describe("friendlyQuestion for snapshot and parlay rules", () => {
  it("asks a snapshot rule at the time its window opens, without the perp detail", () => {
    expect(friendlyQuestion(SNAPSHOT_RULE, null)).toBe(
      "Will Perpl's MON mark price be at or above $0.025 at Oct 12, 16:00 UTC?",
    );
    expect(friendlyQuestion(OI_RULE, clock)).toBe(
      "Will Perpl's BTC open interest be below 22.00000 BTC at Oct 15, 18:00 UTC?",
    );
  });

  it("asks a parlay rule by its legs' market numbers", () => {
    expect(friendlyQuestion(PARLAY_RULE, null)).toBe("Will markets #5 and #6 both settle YES?");
    const three = PARLAY_RULE.replace("all 2", "all 3").replace(
      "; NO if",
      ", 0x37A0dFD460d61E1e60D5AD8770B71C0B47F1920E; NO if",
    );
    expect(friendlyQuestion(three, null)).toBe("Will markets #5, #6 and 0x37A0...920E all settle YES?");
  });

  it("is used as the title of snapshot and parlay markets, and the page then shows the rule too", () => {
    const snap = makeMarket({ templateId: TemplateId.Snapshot, description: SNAPSHOT_RULE });
    const title = marketTitle(snap, testnet, null);
    expect(title).toBe("Will Perpl's MON mark price be at or above $0.025 at Oct 12, 16:00 UTC?");
    expect(titleDiffersFromRule(snap, title)).toBe(true);
    const parlay = makeMarket({ templateId: TemplateId.Parlay, description: PARLAY_RULE });
    expect(marketTitle(parlay, testnet, null)).toBe("Will markets #5 and #6 both settle YES?");
  });
});

describe("marketTitle", () => {
  it("uses the resolver's sentence for Perpl markets, with times", () => {
    const m = makeMarket({ templateId: TemplateId.PerplFunding, description: RULE_1 });
    expect(marketTitle(m, testnet, clock)).toBe(
      "Will MON longs pay more than $0.000015 per MON in funding on Perpl between about Oct 4, 06:10 and Oct 5, 01:00 UTC?",
    );
    expect(titleDiffersFromRule(m, marketTitle(m, testnet, clock))).toBe(true);
  });

  it("builds a Perpl title from the params when the resolver did not answer", () => {
    // The fixture's window is blocks 1,000,000 to 1,002,000 with threshold 0, on testnet's BTC perp.
    const m = makeMarket({ templateId: TemplateId.PerplFunding, description: null });
    expect(marketTitle(m, testnet, null)).toBe(
      "Will BTC longs pay shorts on net on Perpl between block 1,000,000 and block 1,002,000?",
    );
    const old = { blockNumber: 1_001_000n, timestamp: HEAD_TIME, msPerBlock: 400 };
    expect(marketTitle(m, testnet, old)).toBe(
      "Will BTC longs pay shorts on net on Perpl between about Oct 4, 00:55 and Oct 4, 01:05 UTC?",
    );
    expect(titleDiffersFromRule(m, marketTitle(m, testnet, old))).toBe(false);
  });

  it("builds a spike title from the params when the resolver did not answer", () => {
    const params = encodePerplFundingSpikeParams({
      perpId: 16n,
      startBlock: 1_000_000n,
      endBlock: 1_002_000n,
      threshold: 25n,
      expectedScalingExp: 0,
    });
    const m = makeMarket({
      templateId: TemplateId.PerplFundingSpike,
      params,
      decoded: decodeMarketParams(TemplateId.PerplFundingSpike, params),
      description: null,
    });
    expect(marketTitle(m, testnet, null)).toBe(
      "Will any single BTC funding event on Perpl charge longs more than 25 (raw Perpl units) between block 1,000,000 and block 1,002,000?",
    );
  });

  it("keeps every other template's sentence, and falls back to one from the params", () => {
    const price = makeMarket();
    expect(marketTitle(price, testnet, clock)).toBe(price.description);
    expect(titleDiffersFromRule(price, marketTitle(price, testnet, clock))).toBe(false);
    expect(marketTitle(makeMarket({ description: null }), deployments["monad-mainnet"], clock)).toBe(
      "Will BTC/USD be at or above $120,000.00 at Sat 16 Jan 2027, 08:00 UTC?",
    );
  });

  it("never throws on bad params", () => {
    const m = makeMarket({ templateId: TemplateId.PerplFunding, params: "0x1234", description: null });
    expect(marketTitle(m, testnet, clock)).toBe("Market with an unknown template");
    const scaled = { ...m, funding: { markUsd: 1, priceDecimals: 6, intervalBlocks: 8_571 } };
    expect(marketTitle(scaled, testnet, clock)).toBe("Market with an unknown template");
  });
});

// ---------- funding thresholds as rates ----------

// Perpl's funding interval on Monad (getFundingInterval, testnet and mainnet alike).
const INTERVAL = 8_571;
// MON as Perpl reads it: funding sums carry priceDecimals 6 + scaling exponent 2 = 8 decimals.
const MON_SCALE: FundingScale = { markUsd: 0.025, priceDecimals: 6, intervalBlocks: INTERVAL };
// BTC: priceDecimals 1, scaling exponent 0.
const BTC_SCALE: FundingScale = { markUsd: 83_000, priceDecimals: 1, intervalBlocks: INTERVAL };

function perplMarket(args: {
  perpId: bigint;
  threshold: bigint;
  scalingExp: number;
  intervals: number;
  funding?: FundingScale;
  description?: string | null;
}) {
  const params = encodePerplFundingParams({
    perpId: args.perpId,
    startBlock: START,
    endBlock: START + BigInt(args.intervals * INTERVAL),
    threshold: args.threshold,
    expectedScalingExp: args.scalingExp,
  });
  return makeMarket({
    templateId: TemplateId.PerplFunding,
    params,
    decoded: decodeMarketParams(TemplateId.PerplFunding, params),
    description: args.description ?? null,
    ...(args.funding ? { funding: args.funding } : {}),
  });
}

describe("ratePercentText", () => {
  it("keeps two significant digits and never rounds a small rate to zero", () => {
    expect(ratePercentText(0.0024276)).toBe("0.0024%");
    expect(ratePercentText(-0.00062)).toBe("-0.00062%");
    expect(ratePercentText(0.0053999999)).toBe("0.0054%");
    expect(ratePercentText(0.000999)).toBe("0.0010%");
    expect(ratePercentText(7.609)).toBe("7.6%");
    expect(ratePercentText(-7.609)).toBe("-7.6%");
    expect(ratePercentText(22.35)).toBe("22%");
    expect(ratePercentText(150.4)).toBe("150%");
    expect(ratePercentText(0)).toBe("0%");
    expect(ratePercentText(Number.NaN)).toBe("0%");
  });
});

describe("fundingThresholdRate", () => {
  it("spreads a window total over its funding events, as a percent of the mark price", () => {
    // -$0.00000031 per MON over 2 intervals at $0.025: -0.00000031 / 2 / 0.025 = -0.00062%.
    // At 400 ms per block an interval is 3,428.4 s, so a year holds about 9,204.7 of them.
    const r = fundingThresholdRate({
      threshold: -31n,
      scalingExp: 2,
      scale: MON_SCALE,
      events: 2,
      msPerBlock: 400,
    });
    expect(r?.perInterval).toBeCloseTo(-0.00062, 10);
    expect(r?.perYear).toBeCloseTo(-0.00062 * (31_557_600 / 3_428.4), 6);
  });

  it("gives no yearly rate without a block time, and nothing without a price or events", () => {
    const base = { threshold: 135n, scalingExp: 2, scale: MON_SCALE, events: 1 };
    const noClock = fundingThresholdRate({ ...base, msPerBlock: null });
    expect(noClock?.perInterval).toBeCloseTo(0.0054, 10);
    expect(noClock?.perYear).toBeNull();
    expect(
      fundingThresholdRate({ ...base, msPerBlock: 400, scale: { ...MON_SCALE, markUsd: 0 } }),
    ).toBeNull();
    expect(fundingThresholdRate({ ...base, msPerBlock: 400, events: 0 })).toBeNull();
    expect(
      fundingThresholdRate({ ...base, msPerBlock: 400, scale: { ...MON_SCALE, intervalBlocks: 0 } }),
    ).toBeNull();
  });
});

describe("Perpl funding titles state a rate", () => {
  it("turns a tiny negative USD threshold into a rate per interval and a year", () => {
    const rule = `Will MON longs pay more than -$0.00000031 per MON in funding on Perpl (MON Perp, perp 64) between block ${START} and block ${START + 17_142n}?`;
    const m = perplMarket({
      perpId: 64n,
      threshold: -31n,
      scalingExp: 2,
      intervals: 2,
      funding: MON_SCALE,
      description: rule,
    });
    const title = marketTitle(m, testnet, clock);
    expect(title).toBe(
      "Will MON's funding rate on Perpl average above roughly -0.00062% per interval (-5.7% a year) between about Oct 4, 06:10 and Oct 4, 08:05 UTC?",
    );
    // The resolver's sentence stays the rule of record, shown next to the title.
    expect(titleDiffersFromRule(m, title)).toBe(true);
  });

  it("reads a long BTC window as an average rate", () => {
    // $1,080 per BTC over 536 intervals at $83,000: 0.0024% per interval, 22% a year at 400 ms blocks.
    const m = perplMarket({
      perpId: 16n,
      threshold: 10_800n,
      scalingExp: 0,
      intervals: 536,
      funding: BTC_SCALE,
    });
    expect(marketTitle(m, testnet, clock)).toMatch(
      /^Will BTC's funding rate on Perpl average above roughly 0\.0024% per interval \(22% a year\) between about Oct 4, 06:10 and Oct \d+, \d\d:\d\d UTC\?$/,
    );
  });

  it("states a spike threshold as one event's rate", () => {
    const params = encodePerplFundingSpikeParams({
      perpId: 64n,
      startBlock: START,
      endBlock: END,
      threshold: 135n,
      expectedScalingExp: 2,
    });
    const m = makeMarket({
      templateId: TemplateId.PerplFundingSpike,
      params,
      decoded: decodeMarketParams(TemplateId.PerplFundingSpike, params),
      description: null,
      funding: MON_SCALE,
    });
    expect(marketTitle(m, testnet, clock)).toBe(
      "Will any single MON funding event on Perpl charge longs more than roughly 0.0054% of the price (50% a year) between about Oct 4, 06:10 and Oct 5, 01:00 UTC?",
    );
  });

  it("drops the yearly figure without a clock, and names blocks", () => {
    const m = perplMarket({ perpId: 64n, threshold: -31n, scalingExp: 2, intervals: 2, funding: MON_SCALE });
    expect(marketTitle(m, testnet, null)).toBe(
      `Will MON's funding rate on Perpl average above roughly -0.00062% per interval between block ${formatInt(START)} and block ${formatInt(START + 17_142n)}?`,
    );
  });

  it("keeps the net-funding question and the dollar title when there is no rate to give", () => {
    const net = perplMarket({ perpId: 16n, threshold: 0n, scalingExp: 0, intervals: 2, funding: BTC_SCALE });
    expect(marketTitle(net, testnet, null)).toBe(
      `Will BTC longs pay shorts on net on Perpl between block ${formatInt(START)} and block ${formatInt(START + 17_142n)}?`,
    );
    // No funding scale (Perpl did not answer): the resolver's sentence, with times.
    const m = makeMarket({ templateId: TemplateId.PerplFunding, description: RULE_1 });
    expect(marketTitle(m, testnet, clock)).toBe(
      "Will MON longs pay more than $0.000015 per MON in funding on Perpl between about Oct 4, 06:10 and Oct 5, 01:00 UTC?",
    );
  });
});

describe("price rules asked as questions", () => {
  it("asks a touch rule over its window", () => {
    const touch =
      "YES if Chainlink's BTC/USD feed reports a price at or above $86,000 in any round updated from 2026-10-04 13:36:39 UTC to 2026-10-07 13:06:39 UTC; NO if nobody proves that by 2026-10-08 13:06:39 UTC, the end of a 24-hour challenge period.";
    expect(friendlyQuestion(touch, null)).toBe(
      "Will Chainlink's BTC/USD feed report a price at or above $86,000 between Oct 4, 13:36 and Oct 7, 13:06 UTC?",
    );
    expect(friendlyQuestion(touch.replace("at or above", "at or below"), null)).toContain(
      "report a price at or below $86,000",
    );
  });

  it("drops the unix time from a price-at-time question and a price range rule", () => {
    expect(
      friendlyQuestion(
        "Will BTC/USD be at or above $120,000 at 2027-01-16 08:00:00 UTC (unix time 1800086400), per Chainlink's BTC/USD feed?",
        null,
      ),
    ).toBe("Will BTC/USD be at or above $120,000 at Jan 16, 08:00 UTC, per Chainlink?");
    expect(
      friendlyQuestion(
        "YES if Pyth's SOL/USD feed puts SOL/USD at or above $100 and below $120 at 2027-01-16 08:00:00 UTC (unix time 1800086400); NO otherwise.",
        null,
      ),
    ).toBe("Will SOL/USD be at or above $100 and below $120 at Jan 16, 08:00 UTC, per Pyth?");
  });
});

// ---------- no title says a word twice ----------

/** Hedge words: a title that needs two of them uses two different ones. */
const HEDGES = ["about", "roughly", "around", "approximately"];

/** The words a title doubles: the same word back to back ("the the"), or a hedge used twice ("about ... about"). */
function doubledWords(title: string): string[] {
  const words = title.toLowerCase().match(/[a-z']+/g) ?? [];
  const doubled = new Set<string>();
  words.forEach((w, i) => {
    if (i > 0 && words[i - 1] === w) doubled.add(w);
  });
  for (const hedge of HEDGES) {
    if (words.filter((w) => w === hedge).length > 1) doubled.add(hedge);
  }
  return [...doubled];
}

describe("no title doubles a word", () => {
  it("finds the doubles it is meant to find", () => {
    expect(doubledWords("Will the the market settle?")).toEqual(["the"]);
    expect(doubledWords("above about 1% between about Oct 4 and Oct 5")).toEqual(["about"]);
    expect(doubledWords("above roughly 1% between about Oct 4 and Oct 5")).toEqual([]);
  });

  // Every template, with and without a chain clock, and the Perpl ones with and without a funding rate.
  const spikeParams = encodePerplFundingSpikeParams({
    perpId: 64n,
    startBlock: START,
    endBlock: END,
    threshold: 135n,
    expectedScalingExp: 2,
  });
  const spike = (over: Parameters<typeof makeMarket>[0] = {}) =>
    makeMarket({
      templateId: TemplateId.PerplFundingSpike,
      params: spikeParams,
      decoded: decodeMarketParams(TemplateId.PerplFundingSpike, spikeParams),
      description: null,
      ...over,
    });
  const spikeRule = `YES if any single funding event on Perpl (MON Perp, perp 64) after block ${START} and at or before block ${END} charges MON longs more than $0.00000135 per MON; NO if nobody proves one by block ${END + 216_000n}, about 24 hours after the window.`;
  const touchRule =
    "YES if Chainlink's BTC/USD feed reports a price at or above $86,000 in any round updated from 2026-10-04 13:36:39 UTC to 2026-10-07 13:06:39 UTC; NO if nobody proves that by 2026-10-08 13:06:39 UTC, the end of a 24-hour challenge period.";
  const atTimeRule =
    "Will BTC/USD be at or above $83,500 at 2026-10-12 07:00:00 UTC (unix time 1791788400), per Chainlink's BTC/USD feed?";
  const rangeRule =
    "YES if Chainlink's BTC/USD feed puts BTC/USD at or above $80,000 and below $90,000 at 2027-01-16 08:00:00 UTC (unix time 1800086400); NO otherwise.";
  const cases: [string, Parameters<typeof marketTitle>[0]][] = [
    ["1, the resolver's sentence", makeMarket({ templateId: TemplateId.PerplFunding, description: RULE_1 })],
    [
      "1, as a rate",
      perplMarket({ perpId: 64n, threshold: -31n, scalingExp: 2, intervals: 2, funding: MON_SCALE }),
    ],
    [
      "1, a long window as a rate",
      perplMarket({ perpId: 16n, threshold: 10_800n, scalingExp: 0, intervals: 536, funding: BTC_SCALE }),
    ],
    ["1, from the params", makeMarket({ templateId: TemplateId.PerplFunding, description: null })],
    ["2, price at a time", makeMarket({ templateId: TemplateId.PriceAtTime, description: atTimeRule })],
    ["2, from the params", makeMarket({ templateId: TemplateId.PriceAtTime, description: null })],
    ["3, touch", makeMarket({ templateId: TemplateId.ChainlinkTouch, description: touchRule })],
    ["4, the resolver's sentence", spike({ description: spikeRule })],
    ["4, as a rate", spike({ funding: MON_SCALE })],
    ["4, from the params", spike()],
    ["5, price range", makeMarket({ templateId: TemplateId.PriceRange, description: rangeRule })],
    ["6, parlay", makeMarket({ templateId: TemplateId.Parlay, description: PARLAY_RULE })],
    ["7, snapshot", makeMarket({ templateId: TemplateId.Snapshot, description: SNAPSHOT_RULE })],
    ["7, open interest", makeMarket({ templateId: TemplateId.Snapshot, description: OI_RULE })],
  ];

  it.each(cases)("template %s", (_name, m) => {
    for (const at of [clock, null]) {
      const title = marketTitle(m, testnet, at);
      expect(title.length).toBeGreaterThan(0);
      expect({ title, doubled: doubledWords(title) }).toEqual({ title, doubled: [] });
    }
  });

  it("covers every template the protocol has", () => {
    const covered = new Set(cases.map(([, m]) => m.templateId));
    expect([...covered].sort()).toEqual(Object.values(TemplateId).sort());
  });
});

import {
  decodeChainlinkTouchParams,
  decodeParlayParams,
  decodePerplFundingParams,
  decodePerplFundingSpikeParams,
  decodePriceAtTimeParams,
  decodePriceRangeParams,
  deployments,
  hunchBookFactoryAbi,
  marketKey,
  Outcome,
  Phase,
  PriceSource,
  TemplateId,
  TouchDirection,
} from "@hunch-book/shared";
import {
  type Address,
  ContractFunctionRevertedError,
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  type Hex,
  keccak256,
  type Log,
  zeroAddress,
  zeroHash,
} from "viem";
import { describe, expect, it } from "vitest";
import { resolverErrorsAbi } from "../src/lib/create/abis";
import {
  buildParlayParams,
  buildPerplParams,
  buildPriceParams,
  buildTouchParams,
  defaultParlayTimes,
  defaultPerplDraft,
  defaultPriceDraft,
  defaultTouchDraft,
  issueFor,
  legClose,
  legEarliestLock,
  type ParlayLeg,
  type PerplContext,
  type PerplDraft,
  type PriceDraft,
  type TouchDraft,
} from "../src/lib/create/build";
import {
  blockAt,
  formatPlusMinus,
  fromLocalInput,
  type Head,
  MIN_DRIFT,
  NOMINAL_DRIFT,
  type Pace,
  paceFrom,
  timeAt,
  toLocalInput,
  uncertaintySeconds,
} from "../src/lib/create/clock";
import { describeCreateError, describeCreateRevert } from "../src/lib/create/errors";
import { parlayCandidates, searchCandidates } from "../src/lib/create/parlay";
import {
  balancedThreshold,
  eventsInWindow,
  formatFundingUsd,
  formatPercent,
  fundingDecimals,
  fundingDeltas,
  gridAnchor,
  gridAtOrAfter,
  historicalHits,
  isLopsided,
  median,
  type PerpInfo,
  percentOfPrice,
  rollingMax,
  rollingSums,
  snapWindow,
  suggestThreshold,
} from "../src/lib/create/perpl";
import { capLines, FEE_LINES, ruleLines, voidLines, windowPoints } from "../src/lib/create/preview";
import {
  chainlinkOption,
  DAY,
  defaultPriceTimes,
  HOUR,
  MIN_LEAD_SECONDS,
  nextNoonUtc,
  pythOption,
  pythToE8,
  rangeAround,
  toE8,
  touchLevel,
} from "../src/lib/create/price";
import { maxFirstStake, nextCreateStep, validateFirstStake } from "../src/lib/create/stake";
import {
  availableTemplates,
  CREATE_TEMPLATES,
  networkCaveat,
  parseTemplateParam,
  TEMPLATE_IDS,
} from "../src/lib/create/templates";
import { parseFixed, roundSignificant, toInputString } from "../src/lib/create/units";
import { marketFromLogs } from "../src/lib/create/useCreateMarket";
import { makeMarket, USDC } from "./fixtures";

// The create flow's pure logic: units, the block clock, Perpl's grid and history, defaults, every
// parameter builder, validation messages and the canonical market key.

const INTERVAL = 8_571n;
const HEAD: Head = { number: 68_036_598n, timestamp: 1_791_090_000 };
const PACE: Pace = { msPerBlock: 300, drift: MIN_DRIFT, measured: true };
/** A minute-aligned "now", a little after the head. */
const NOW = 1_791_090_000;
const deploymentStub = deployments["monad-testnet"];

const MON: PerpInfo = {
  perpId: 64n,
  name: "MON Perp",
  symbol: "MON",
  priceDecimals: 5,
  scalingExp: 3,
  status: 4,
  fundingStartBlock: 12_179_391n,
  markPrice: 3_468n,
};

const perplCtx = (over: Partial<PerplContext> = {}): PerplContext => ({
  perpId: 64n,
  info: MON,
  interval: INTERVAL,
  anchor: 0n,
  head: HEAD,
  pace: PACE,
  now: NOW,
  rule: "window",
  ...over,
});

const perplDraft = (over: Partial<PerplDraft> = {}): PerplDraft => ({
  asset: "MON",
  start: toLocalInput(NOW + DAY),
  end: toLocalInput(NOW + 2 * DAY),
  threshold: "0.0000142",
  snap: true,
  ...over,
});

describe("parseFixed and friends", () => {
  it("parses dollars, commas and signs exactly", () => {
    expect(parseFixed("1,234.5", 6)).toEqual({ ok: true, value: 1_234_500_000n });
    expect(parseFixed("$0.0000014", 8)).toEqual({ ok: true, value: 140n });
    expect(parseFixed("-2.5", 1, { allowNegative: true })).toEqual({ ok: true, value: -25n });
    expect(parseFixed("  7 ", 0)).toEqual({ ok: true, value: 7n });
  });

  it("returns null for empty input and plain errors for the rest", () => {
    expect(parseFixed("", 8)).toBeNull();
    expect(parseFixed("   ", 8)).toBeNull();
    expect(parseFixed("abc", 8)).toEqual({ ok: false, error: "Enter a plain number, like 1.25." });
    expect(parseFixed("1e5", 8)).toMatchObject({ ok: false });
    expect(parseFixed("-1", 8)).toEqual({ ok: false, error: "Enter a number above zero." });
    expect(parseFixed("1.5", 0, { unitName: "BTC funding" })).toEqual({
      ok: false,
      error: "Use a whole number: BTC funding has no decimal places.",
    });
    expect(parseFixed("0.123", 2, { unitName: "it" })).toEqual({
      ok: false,
      error: "Use at most 2 decimal places: that is the smallest step it records.",
    });
  });

  it("never rounds: a value the unit cannot hold is refused, not moved", () => {
    expect(parseFixed("0.000014215", 8)).toMatchObject({ ok: false });
  });

  it("writes values back for inputs with no grouping and no trailing zeros", () => {
    expect(toInputString(1_421n, 8)).toBe("0.00001421");
    expect(toInputString(-25n, 1)).toBe("-2.5");
    expect(toInputString(8_470_000_000_000n, 8)).toBe("84700");
    expect(toInputString(0n, 8)).toBe("0");
    for (const v of [1n, 123_456_789n, -42n, 10n ** 12n]) {
      expect(parseFixed(toInputString(v, 8), 8, { allowNegative: true })).toEqual({ ok: true, value: v });
    }
  });

  it("rounds a default to three significant figures, half up", () => {
    expect(roundSignificant(8_472_106_882_025n, 3)).toBe(8_470_000_000_000n);
    expect(roundSignificant(12_079_575_301n, 3)).toBe(12_100_000_000n);
    expect(roundSignificant(3_468_000n, 3)).toBe(3_470_000n);
    expect(roundSignificant(42n, 3)).toBe(42n);
    expect(roundSignificant(0n, 3)).toBe(0n);
  });
});

describe("the block clock", () => {
  it("measures the pace and never claims less than the minimum drift", () => {
    expect(paceFrom(302, 301, 400)).toEqual({ msPerBlock: 302, drift: MIN_DRIFT, measured: true });
    const drifting = paceFrom(300, 360, 400);
    expect(drifting.drift).toBeCloseTo(0.2);
    expect(paceFrom(null, 300, 400)).toEqual({ msPerBlock: 400, drift: NOMINAL_DRIFT, measured: false });
  });

  it("converts clock times to the first block expected at or after them", () => {
    expect(blockAt(HEAD.timestamp + HOUR, HEAD, 300)).toBe(HEAD.number + 12_000n);
    expect(blockAt(HEAD.timestamp + 1, HEAD, 300)).toBe(HEAD.number + 4n);
    expect(blockAt(HEAD.timestamp - 60, HEAD, 300)).toBe(HEAD.number);
    expect(timeAt(HEAD.number + 12_000n, HEAD, 300)).toBe(HEAD.timestamp + HOUR);
  });

  it("states how far an estimate can be off", () => {
    expect(uncertaintySeconds(HEAD.number + 12_000n, HEAD, PACE)).toBe(72);
    expect(formatPlusMinus(30)).toBe("give or take under a minute");
    expect(formatPlusMinus(72)).toBe("give or take 1 minute");
    expect(formatPlusMinus(600)).toBe("give or take 10 minutes");
    expect(formatPlusMinus(7_200)).toBe("give or take 2 hours");
  });

  it("round-trips datetime-local values in the browser's zone", () => {
    const at = 1_791_201_600; // a whole minute
    expect(fromLocalInput(toLocalInput(at))).toBe(at);
    expect(fromLocalInput(toLocalInput(at + 59))).toBe(at);
    expect(fromLocalInput("2026-10-05T12:00:30")).toBe((fromLocalInput("2026-10-05T12:00") as number) + 30);
    expect(fromLocalInput("tomorrow")).toBeNull();
    expect(fromLocalInput("")).toBeNull();
  });
});

describe("Perpl units and the funding grid", () => {
  it("reads funding in USD per unit with priceDecimals + fundingSumScalingExp", () => {
    expect(fundingDecimals(MON)).toBe(8);
    expect(formatFundingUsd(1_421n, 8)).toBe("$0.00001421");
    expect(formatFundingUsd(-16n, 1)).toBe("-$1.6");
    expect(formatFundingUsd(0n, 8)).toBe("$0");
  });

  it("sets a threshold against the price for scale", () => {
    const pct = percentOfPrice(1_421n, 8, MON);
    expect(pct).toBeCloseTo(0.04097, 4);
    expect(formatPercent(pct as number)).toBe("0.041%");
    expect(formatPercent(0.5)).toBe("0.50%");
    expect(formatPercent(12)).toBe("12.00%");
    expect(percentOfPrice(1n, 8, { ...MON, markPrice: 0n })).toBeNull();
  });

  it("finds the grid from any funding event and snaps forward to it", () => {
    expect(gridAnchor(68_036_598n, INTERVAL)).toBe(0n);
    expect(gridAnchor(68_036_603n, INTERVAL)).toBe(5n);
    expect(gridAtOrAfter(68_036_598n, INTERVAL, 0n)).toBe(68_036_598n);
    expect(gridAtOrAfter(68_036_599n, INTERVAL, 0n)).toBe(68_045_169n);
    expect(gridAtOrAfter(68_036_599n, INTERVAL, 5n)).toBe(68_036_603n);
  });

  it("snaps a window to a whole number of funding events, at least one", () => {
    const snapped = snapWindow({
      startBlock: 68_036_600n,
      endBlock: 68_036_600n + 3n * INTERVAL + 100n,
      interval: INTERVAL,
      anchor: 0n,
    });
    // The start moves forward to the next event; the end goes to the grid point nearest the asked end.
    expect(snapped.startBlock).toBe(68_045_169n);
    expect(snapped.intervals).toBe(2n);
    expect(snapped.endBlock).toBe(68_062_311n);
    const longer = snapWindow({
      startBlock: 68_036_598n,
      endBlock: 68_036_598n + 3n * INTERVAL + 100n,
      interval: INTERVAL,
      anchor: 0n,
    });
    expect(longer).toEqual({ startBlock: 68_036_598n, endBlock: 68_036_598n + 3n * INTERVAL, intervals: 3n });
    const tiny = snapWindow({ startBlock: 100n, endBlock: 120n, interval: INTERVAL, anchor: 0n });
    expect(tiny.intervals).toBe(1n);
    expect(tiny.endBlock - tiny.startBlock).toBe(INTERVAL);
  });

  it("counts the funding events a window holds: start < event <= end", () => {
    expect(eventsInWindow(68_036_598n, 68_036_598n + 3n * INTERVAL, INTERVAL, 0n)).toBe(3n);
    expect(eventsInWindow(68_036_599n, 68_036_598n + 3n * INTERVAL, INTERVAL, 0n)).toBe(3n);
    expect(eventsInWindow(68_036_598n, 68_036_598n + INTERVAL - 1n, INTERVAL, 0n)).toBe(0n);
    expect(eventsInWindow(10n, 5n, INTERVAL, 0n)).toBe(0n);
  });
});

describe("funding history", () => {
  const samples = [100n, 110n, 115n, 135n, 136n, 156n].map((sum, i) => ({
    block: 68_000_000n + BigInt(i) * INTERVAL,
    sum,
  }));
  const deltas = fundingDeltas(samples);

  it("turns the cumulative sum into what each event charged", () => {
    expect(deltas).toEqual([10n, 5n, 20n, 1n, 20n]);
    expect(rollingSums(deltas, 2)).toEqual([15n, 25n, 21n, 21n]);
    expect(rollingMax(deltas, 2)).toEqual([10n, 20n, 20n, 20n]);
    expect(rollingSums(deltas, 9)).toEqual([]);
    expect(median([3n, 1n, 2n])).toBe(2n);
    expect(median([4n, 1n, 2n, 3n])).toBe(2n);
    expect(median([])).toBeNull();
  });

  it("suggests a threshold that splits past windows about half and half", () => {
    expect(balancedThreshold([1n, 2n, 3n, 4n])).toBe(2n);
    expect(balancedThreshold([])).toBeNull();
    // Windows of two paid 15, 25, 21 and 21: "more than 15" is YES in 3 of 4, as close to half as
    // any threshold gets ("more than 21" is 1 of 4).
    const window = suggestThreshold(deltas, 2, "window");
    expect(window).toBe(15n);
    expect(historicalHits(deltas, 2, window as bigint, "window")).toEqual({ hits: 3, total: 4 });
    // The spike rule looks at each window's largest single event.
    const spike = suggestThreshold(deltas, 2, "spike");
    expect(spike).toBe(10n);
    expect(historicalHits(deltas, 2, spike as bigint, "spike")).toEqual({ hits: 3, total: 4 });
  });

  it("flags thresholds that past windows almost always or almost never beat", () => {
    expect(isLopsided({ hits: 0, total: 300 })).toBe(true);
    expect(isLopsided({ hits: 295, total: 300 })).toBe(true);
    expect(isLopsided({ hits: 150, total: 300 })).toBe(false);
    expect(isLopsided(null)).toBe(false);
  });
});

describe("price defaults and scaling", () => {
  it("closes at the next 12:00 UTC that leaves the lock 24 hours earlier still ahead", () => {
    const tenUtc = Date.UTC(2026, 9, 4, 10, 0) / 1000;
    expect(defaultPriceTimes(tenUtc)).toEqual({
      close: Date.UTC(2026, 9, 5, 12, 0) / 1000,
      lock: Date.UTC(2026, 9, 4, 12, 0) / 1000,
    });
    const onePm = Date.UTC(2026, 9, 4, 13, 0) / 1000;
    const late = defaultPriceTimes(onePm);
    expect(late.close).toBe(Date.UTC(2026, 9, 6, 12, 0) / 1000);
    expect(late.lock).toBeGreaterThan(onePm + MIN_LEAD_SECONDS);
    expect(nextNoonUtc(Date.UTC(2026, 9, 4, 12, 0) / 1000)).toBe(Date.UTC(2026, 9, 5, 12, 0) / 1000);
  });

  it("scales Chainlink and Pyth prices to 8 decimals", () => {
    expect(toE8(8_472_106_882_025n, 8)).toBe(8_472_106_882_025n);
    expect(toE8(2_687_185_571_820_000_000_000n, 18)).toBe(268_718_557_182n);
    expect(toE8(12_345n, 2)).toBe(12_345_000_000n);
    expect(pythToE8(12_079_575_301n, -8)).toBe(12_079_575_301n);
    expect(pythToE8(120_795_753_010n, -9)).toBe(12_079_575_301n);
    expect(pythToE8(12n, 2)).toBe(120_000_000_000n);
  });

  it("starts ranges and touch levels a sensible distance from the price", () => {
    expect(rangeAround(8_472_106_882_025n)).toEqual({ lower: 8_300_000_000_000n, upper: 8_640_000_000_000n });
    expect(touchLevel(8_472_106_882_025n, "above")).toBe(8_900_000_000_000n);
    expect(touchLevel(8_472_106_882_025n, "below")).toBe(8_050_000_000_000n);
  });

  it("builds feed options for both sources", () => {
    const feed = "0x12C0F44368a02081ce58a936d1C1F606BB301715" as Address;
    expect(chainlinkOption("BTC / USD", feed)).toEqual({
      key: `chainlink:${feed.toLowerCase()}`,
      label: "BTC/USD",
      asset: "BTC",
      source: PriceSource.Chainlink,
      feed,
      pythId: zeroHash,
    });
    const id = "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d" as Hex;
    expect(pythOption("SOL/USD", id)).toMatchObject({
      asset: "SOL",
      source: PriceSource.Pyth,
      feed: zeroAddress,
    });
  });
});

describe("template 1 and 4 parameters (Perpl)", () => {
  it("defaults to a day-long window starting a day ahead, snapped", () => {
    const d = defaultPerplDraft(NOW, "MON");
    const start = fromLocalInput(d.start) as number;
    expect(start).toBeGreaterThanOrEqual(NOW + DAY);
    expect(start % HOUR).toBe(0);
    expect((fromLocalInput(d.end) as number) - start).toBe(DAY);
    expect(d.snap).toBe(true);
    expect(d.threshold).toBe("");
  });

  it("builds canonical params on the funding grid", () => {
    const b = buildPerplParams(perplDraft(), perplCtx());
    expect(b.issues).toEqual([]);
    expect(b.params).not.toBeNull();
    const p = decodePerplFundingParams(b.params as Hex);
    expect(p.perpId).toBe(64n);
    expect(p.expectedScalingExp).toBe(3);
    expect(p.threshold).toBe(1_420n);
    expect(p.startBlock % INTERVAL).toBe(0n);
    expect((p.endBlock - p.startBlock) % INTERVAL).toBe(0n);
    expect(p.startBlock).toBeGreaterThanOrEqual(blockAt(NOW + DAY, HEAD, 300));
    expect(b.intervals).toBe((p.endBlock - p.startBlock) / INTERVAL);
  });

  it("keeps exact blocks when snapping is off", () => {
    const b = buildPerplParams(perplDraft({ snap: false }), perplCtx());
    const start = fromLocalInput(perplDraft().start) as number;
    expect(b.startBlock).toBe(blockAt(start, HEAD, 300));
  });

  it("explains every problem against its field", () => {
    const past = buildPerplParams(perplDraft({ start: toLocalInput(NOW - HOUR) }), perplCtx());
    expect(issueFor(past.issues, "start")).toMatch(/at least 5 minutes from now/);
    const backwards = buildPerplParams(perplDraft({ end: toLocalInput(NOW + DAY - HOUR) }), perplCtx());
    expect(issueFor(backwards.issues, "end")).toBe("The window must end after it starts.");
    const short = buildPerplParams(
      perplDraft({ snap: false, end: toLocalInput(NOW + DAY + 20 * 60) }),
      perplCtx(),
    );
    expect(issueFor(short.issues, "end")).toMatch(
      /at least one funding interval: 8,571 blocks, about 43 minutes/,
    );
    const fine = buildPerplParams(perplDraft({ threshold: "0.000000001" }), perplCtx());
    expect(issueFor(fine.issues, "threshold")).toMatch(/at most 8 decimal places/);
    const empty = buildPerplParams(perplDraft({ threshold: "" }), perplCtx());
    expect(issueFor(empty.issues, "threshold")).toMatch(/0 means longs pay shorts on net/);
    const paused = buildPerplParams(perplDraft(), perplCtx({ info: { ...MON, status: 0 } }));
    expect(issueFor(paused.issues, "asset")).toMatch(/paused/);
    const late = buildPerplParams(
      perplDraft(),
      perplCtx({ info: { ...MON, fundingStartBlock: 99_000_000n } }),
    );
    expect(issueFor(late.issues, "start")).toMatch(/Funding on this perp starts after/);
    for (const b of [past, backwards, short, fine, empty, paused, late]) expect(b.params).toBeNull();
  });

  it("accepts a negative threshold and 0 for 'longs pay on net'", () => {
    expect(buildPerplParams(perplDraft({ threshold: "0" }), perplCtx()).threshold).toBe(0n);
    expect(buildPerplParams(perplDraft({ threshold: "-0.00001" }), perplCtx()).threshold).toBe(-1_000n);
  });

  it("encodes template 4 with the spike struct and enforces its 31-day limit", () => {
    const b = buildPerplParams(perplDraft(), perplCtx({ rule: "spike", maxWindowBlocks: 31n * 288_000n }));
    expect(b.issues).toEqual([]);
    const p = decodePerplFundingSpikeParams(b.params as Hex);
    expect(p.threshold).toBe(1_420n);
    const long = buildPerplParams(
      perplDraft({ end: toLocalInput(NOW + 40 * DAY) }),
      perplCtx({ rule: "spike", maxWindowBlocks: 31n * 288_000n }),
    );
    expect(issueFor(long.issues, "end")).toMatch(/about 31 days/);
    const empty = buildPerplParams(perplDraft({ threshold: "" }), perplCtx({ rule: "spike" }));
    expect(issueFor(empty.issues, "threshold")).toMatch(/for one funding event/);
  });
});

describe("template 2 and 5 parameters (price)", () => {
  const btc = chainlinkOption("BTC/USD", "0x12C0F44368a02081ce58a936d1C1F606BB301715");
  const sol = pythOption("SOL/USD", "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d");
  const options = [btc, sol];
  const close = Date.UTC(2026, 9, 6, 12, 0) / 1000;
  const draft = (over: Partial<PriceDraft> = {}): PriceDraft => ({
    ...defaultPriceDraft(NOW, options),
    strike: "85000",
    lower: "83000",
    upper: "86400",
    close: toLocalInput(close),
    ...over,
  });

  it("defaults to the first feed, a daily lock and an empty strike", () => {
    const d = defaultPriceDraft(NOW, options);
    expect(d.feed).toBe(btc.key);
    expect(d.lockLead).toBe("day");
    expect(d.strike).toBe("");
  });

  it("builds canonical Chainlink and Pyth params", () => {
    const b = buildPriceParams(draft(), { options, now: NOW });
    expect(b.issues).toEqual([]);
    const p = decodePriceAtTimeParams(b.params as Hex);
    expect(p).toMatchObject({
      source: PriceSource.Chainlink,
      feed: btc.feed,
      pythId: zeroHash,
      strikeE8: 8_500_000_000_000n,
      lockTime: BigInt(close - DAY),
      closeTime: BigInt(close),
    });
    const pyth = decodePriceAtTimeParams(
      buildPriceParams(draft({ feed: sol.key, lockLead: "hour" }), { options, now: NOW }).params as Hex,
    );
    expect(pyth).toMatchObject({
      source: PriceSource.Pyth,
      feed: zeroAddress,
      lockTime: BigInt(close - HOUR),
    });
  });

  it("refuses a lock that is too soon, a lock after the close and a zero strike", () => {
    const soon = buildPriceParams(draft({ close: toLocalInput(NOW + 2 * HOUR) }), { options, now: NOW });
    expect(issueFor(soon.issues, "close")).toMatch(/at least 5 minutes from now/);
    const after = buildPriceParams(draft({ lockLead: "custom", lock: toLocalInput(close + HOUR) }), {
      options,
      now: NOW,
    });
    expect(issueFor(after.issues, "lock")).toBe("The lock must be at or before the close.");
    expect(issueFor(buildPriceParams(draft({ strike: "0" }), { options, now: NOW }).issues, "strike")).toBe(
      "The price must be above zero.",
    );
    expect(issueFor(buildPriceParams(draft({ feed: "nope" }), { options, now: NOW }).issues, "feed")).toBe(
      "Pick a price feed.",
    );
  });

  it("builds template 5 ranges and refuses an empty one", () => {
    const b = buildPriceParams(draft(), { options, now: NOW, rule: "range" });
    expect(b.issues).toEqual([]);
    expect(decodePriceRangeParams(b.params as Hex)).toMatchObject({
      lowerE8: 8_300_000_000_000n,
      upperE8: 8_640_000_000_000n,
    });
    const empty = buildPriceParams(draft({ upper: "83000" }), { options, now: NOW, rule: "range" });
    expect(issueFor(empty.issues, "upper")).toBe("The top of the range must be above the bottom.");
  });
});

describe("template 3 parameters (touch)", () => {
  const btc = chainlinkOption("BTC/USD", "0x12C0F44368a02081ce58a936d1C1F606BB301715");
  const draft = (over: Partial<TouchDraft> = {}): TouchDraft => ({
    ...defaultTouchDraft(NOW, [btc]),
    strike: "89000",
    ...over,
  });

  it("defaults to a week-long window a day ahead, locked at its start", () => {
    const d = defaultTouchDraft(NOW, [btc]);
    expect((fromLocalInput(d.end) as number) - (fromLocalInput(d.start) as number)).toBe(7 * DAY);
    expect(d.lockAtStart).toBe(true);
  });

  it("builds canonical params in both directions", () => {
    const up = buildTouchParams(draft(), { options: [btc], now: NOW });
    expect(up.issues).toEqual([]);
    const p = decodeChainlinkTouchParams(up.params as Hex);
    expect(p.direction).toBe(TouchDirection.AtOrAbove);
    expect(p.lockTime).toBe(p.startTime);
    expect(p.strikeE8).toBe(8_900_000_000_000n);
    const down = buildTouchParams(draft({ direction: "below" }), { options: [btc], now: NOW });
    expect(decodeChainlinkTouchParams(down.params as Hex).direction).toBe(TouchDirection.AtOrBelow);
  });

  it("refuses a window over 31 days and a lock after the start", () => {
    const start = fromLocalInput(draft().start) as number;
    const long = buildTouchParams(draft({ end: toLocalInput(start + 32 * DAY) }), {
      options: [btc],
      now: NOW,
    });
    expect(issueFor(long.issues, "end")).toBe("A touch window can be at most 31 days long.");
    const late = buildTouchParams(draft({ lockAtStart: false, lock: toLocalInput(start + HOUR) }), {
      options: [btc],
      now: NOW,
    });
    expect(issueFor(late.issues, "lock")).toBe("Staking must stop at or before the window starts.");
  });
});

describe("template 6 parameters (parlay)", () => {
  const legA: ParlayLeg = {
    address: "0x00000000000000000000000000000000000000c2",
    marketId: 2n,
    label: "Leg A",
    window: {
      blockClock: false,
      lock: BigInt(NOW + 2 * DAY),
      close: BigInt(NOW + 3 * DAY),
      settleDeadline: 0n,
    },
  };
  const legB: ParlayLeg = {
    address: "0x00000000000000000000000000000000000000a1",
    marketId: 1n,
    label: "Leg B",
    window: {
      blockClock: true,
      lock: HEAD.number + 288_000n,
      close: HEAD.number + 576_000n,
      settleDeadline: 0n,
    },
  };
  const ctx = { legs: [legA, legB], head: HEAD, pace: PACE, now: NOW, fastBlockTimeMs: 200 };

  it("estimates a block-clock leg's lock early, exactly as the resolver does", () => {
    // 288,000 blocks at 200 ms = 57,600 s.
    expect(legEarliestLock(legB.window, HEAD, 200)).toBe(HEAD.timestamp + 57_600);
    expect(legEarliestLock(legA.window, HEAD, 200)).toBe(NOW + 2 * DAY);
    expect(legEarliestLock({ ...legB.window, lock: HEAD.number - 1n }, HEAD, 200)).toBe(HEAD.timestamp);
    expect(legClose(legB.window, HEAD, PACE)).toBe(HEAD.timestamp + 172_800);
  });

  it("defaults the lock to just before the first leg can lock and the close to the last leg's", () => {
    const t = defaultParlayTimes(ctx);
    expect(t?.lock).toBeLessThanOrEqual(HEAD.timestamp + 57_600 - 60);
    expect(t?.close).toBe(NOW + 3 * DAY);
    expect(defaultParlayTimes({ ...ctx, legs: [] })).toBeNull();
  });

  it("builds canonical params with the legs sorted", () => {
    const t = defaultParlayTimes(ctx) as { lock: number; close: number };
    const b = buildParlayParams(
      { legs: [legA.address, legB.address], lock: toLocalInput(t.lock), close: toLocalInput(t.close) },
      ctx,
    );
    expect(b.issues).toEqual([]);
    const p = decodeParlayParams(b.params as Hex);
    expect(p.legs.map((l) => l.toLowerCase())).toEqual([legB.address, legA.address]);
    expect(b.firstLock?.leg.marketId).toBe(1n);
  });

  it("refuses too few legs and a lock after a leg can lock", () => {
    const one = buildParlayParams(
      { legs: [legA.address], lock: toLocalInput(NOW + HOUR), close: toLocalInput(NOW + DAY) },
      ctx,
    );
    expect(issueFor(one.issues, "legs")).toBe("Pick 2 to 5 markets.");
    const late = buildParlayParams(
      {
        legs: [legA.address, legB.address],
        lock: toLocalInput(NOW + DAY),
        close: toLocalInput(NOW + 3 * DAY),
      },
      ctx,
    );
    expect(issueFor(late.issues, "lock")).toMatch(/Market #1 can lock as early as/);
    expect(late.params).toBeNull();
  });

  it("offers only open markets that lock far enough ahead, soonest first, and searches them", () => {
    const open = makeMarket({ address: "0x00000000000000000000000000000000000000a5", marketId: 5n });
    const locked = makeMarket({
      address: "0x00000000000000000000000000000000000000a6",
      phase: Phase.PoolLocked,
    });
    const settled = makeMarket({
      address: "0x00000000000000000000000000000000000000a7",
      phase: Phase.Settled,
      outcome: Outcome.Yes,
    });
    const soon = makeMarket({
      address: "0x00000000000000000000000000000000000000a8",
      window: { blockClock: false, lock: BigInt(NOW + 60), close: BigInt(NOW + DAY), settleDeadline: 0n },
    });
    const later = makeMarket({
      address: "0x00000000000000000000000000000000000000a9",
      marketId: 9n,
      description: "Will ETH/USD be at or above $3,000?",
      window: { blockClock: false, lock: BigInt(NOW + HOUR), close: BigInt(NOW + DAY), settleDeadline: 0n },
    });
    const list = parlayCandidates([open, locked, settled, soon, later], deploymentStub, {
      head: HEAD,
      pace: PACE,
      now: NOW,
      fastBlockTimeMs: 200,
    });
    expect(list.map((c) => c.marketId)).toEqual([9n, 5n]);
    expect(searchCandidates(list, "eth").map((c) => c.marketId)).toEqual([9n]);
    expect(searchCandidates(list, "#5").map((c) => c.marketId)).toEqual([5n]);
    expect(searchCandidates(list, " ")).toHaveLength(2);
  });
});

describe("the first stake", () => {
  const caps = { poolCap: USDC(5_000), walletCap: USDC(1_000), minStake: USDC(1), creatorMinStake: USDC(5) };

  it("checks the creator minimum, the wallet cap and the balance", () => {
    const check = (input: string, amount: bigint | null, balance: bigint | null = USDC(100)) =>
      validateFirstStake({ input, amount, caps, balance });
    expect(check("", null)).toBeNull();
    expect(check("abc", null)).toBe("Enter an amount in USDC, like 25 or 25.50.");
    expect(check("4", USDC(4))).toBe("The first stake must be at least 5.00 USDC.");
    expect(check("1001", USDC(1_001), USDC(5_000))).toBe(
      "One wallet can stake at most 1,000.00 USDC in a market.",
    );
    expect(check("200", USDC(200))).toBe("Your wallet holds 100.00 USDC. Enter less, or get more first.");
    expect(check("25", USDC(25))).toBeNull();
    expect(maxFirstStake({ ...caps, poolCap: USDC(500) })).toBe(USDC(500));
  });

  it("names one next step at a time", () => {
    const base = {
      connected: true,
      wrongNetwork: false,
      ready: true,
      paused: false,
      paramsOk: true,
      exists: false,
      amountOk: true,
      allowance: USDC(10),
      amount: USDC(25),
    };
    expect(nextCreateStep({ ...base, paused: true })).toBe("paused");
    expect(nextCreateStep({ ...base, exists: true })).toBe("exists");
    expect(nextCreateStep({ ...base, connected: false })).toBe("connect");
    expect(nextCreateStep({ ...base, wrongNetwork: true })).toBe("switch");
    expect(nextCreateStep({ ...base, ready: false })).toBe("loading");
    expect(nextCreateStep({ ...base, paramsOk: false })).toBe("fix-params");
    expect(nextCreateStep({ ...base, amountOk: false })).toBe("enter-amount");
    expect(nextCreateStep(base)).toBe("approve");
    expect(nextCreateStep({ ...base, allowance: USDC(25) })).toBe("create");
  });
});

describe("plain-word errors", () => {
  it("covers the factory and every resolver's validate", () => {
    expect(describeCreateRevert("CreationIsPaused")).toMatch(/paused/);
    expect(describeCreateRevert("UnknownTemplate")).toMatch(/not registered/);
    expect(describeCreateRevert("MarketExists")).toMatch(/already exists/);
    expect(describeCreateRevert("BadWindow")).toMatch(/window is not valid/);
    expect(describeCreateRevert("FirstStakeTooSmall")).toMatch(/below the minimum/);
    expect(describeCreateRevert("ExchangeVersionChanged", [7n, 6n, 0n])).toMatch(/now v1\.7\.6\.0/);
    expect(describeCreateRevert("PerpNotListed", [99n])).toBe("Perpl does not list perp 99 on this network.");
    expect(describeCreateRevert("FundingNotStarted", [64n, 70_000_000n, 1n])).toMatch(/block 70,000,000/);
    expect(describeCreateRevert("StartBlockNotInFuture", [10n, 20n])).toMatch(/block 10\).*block 20/);
    expect(describeCreateRevert("WindowTooShort", [1n, 2n, 8_571n])).toMatch(/8,571 blocks/);
    expect(describeCreateRevert("WindowTooLong", [1n, 2n])).toMatch(/touch window/);
    expect(describeCreateRevert("WindowTooLong", [1n, 2n, 3n])).toMatch(/spike window/);
    expect(describeCreateRevert("FeedNotAllowed")).toMatch(/does not accept that Chainlink feed/);
    expect(describeCreateRevert("LockNotInFuture")).toMatch(/already passed/);
    expect(describeCreateRevert("EmptyRange")).toMatch(/top of the range/);
    expect(describeCreateRevert("LockAfterLeg")).toMatch(/every leg/);
    expect(describeCreateRevert("LegFinished")).toMatch(/settled or voided/);
    expect(describeCreateRevert("InsufficientAllowance")).toMatch(/Approve first/);
    expect(describeCreateRevert("SomethingElse")).toBeNull();
  });

  it("decodes a real revert from viem", () => {
    const data = encodeErrorResult({
      abi: resolverErrorsAbi,
      errorName: "StartBlockNotInFuture",
      args: [10n, 20n],
    });
    const error = new ContractFunctionRevertedError({
      abi: resolverErrorsAbi,
      data,
      functionName: "validate",
    });
    expect(describeCreateError(error)).toBe(
      "The window start (block 10) has already passed: the chain is at block 20. Pick a later start.",
    );
    expect(describeCreateError(new Error("boom"))).toBe("boom");
  });
});

describe("the canonical market key", () => {
  // Market #1 on Monad testnet, read from the chain: factory.marketKey(1, params) and marketOf(key).
  const params =
    "0x000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000040e7cbd000000000000000000000000000000000000000000000000000000000411a04500000000000000000000000000000000000000000000000000000000000005dc0000000000000000000000000000000000000000000000000000000000000003" as Hex;

  it("matches the factory's keccak256(abi.encode(templateId, params))", () => {
    expect(marketKey(1, params)).toBe("0x306f22ab64e0f9fd35eae199a64c97ac194e1beec2b52fa40fc14b8fd15f683f");
    expect(marketKey(1, params)).toBe(
      keccak256(encodeAbiParameters([{ type: "uint32" }, { type: "bytes" }], [1, params])),
    );
    expect(marketKey(2, params)).not.toBe(marketKey(1, params));
  });

  it("is the same for the same question built twice", () => {
    const a = buildPerplParams(perplDraft(), perplCtx()).params as Hex;
    const b = buildPerplParams(perplDraft(), perplCtx()).params as Hex;
    expect(marketKey(TemplateId.PerplFunding, a)).toBe(marketKey(TemplateId.PerplFunding, b));
  });

  it("reads the new market from the factory's MarketCreated event", () => {
    const factory = "0x2c30da53F8C384D6eD6603E3138a98fd15E4928A" as Address;
    const market = "0x2A44B99014cF73065BFb89197a08DE09D18d3982" as Address;
    const topics = encodeEventTopics({
      abi: hunchBookFactoryAbi,
      eventName: "MarketCreated",
      args: { market, templateId: 1, key: marketKey(1, params) },
    });
    const log = {
      address: factory,
      topics,
      data: encodeAbiParameters([{ type: "address" }, { type: "bytes" }], [factory, params]),
      blockHash: zeroHash,
      blockNumber: 1n,
      logIndex: 0,
      transactionHash: zeroHash,
      transactionIndex: 0,
      removed: false,
    } as unknown as Log;
    expect(marketFromLogs([log], factory)).toBe(market);
    expect(marketFromLogs([log], zeroAddress)).toBeNull();
    expect(marketFromLogs([], factory)).toBeNull();
  });
});

describe("the preview", () => {
  it("estimates block-clock points and adds the challenge period for touch markets", () => {
    const window = {
      blockClock: true,
      lock: HEAD.number + 12_000n,
      close: HEAD.number + 24_000n,
      settleDeadline: 1_791_900_000n,
    };
    const points = windowPoints(
      window,
      { head: HEAD, pace: PACE },
      { block: HEAD.number + 36_000n, unix: HEAD.timestamp + 10_800 },
    );
    expect(points.map((p) => p.key)).toEqual(["lock", "close", "challenge", "deadline"]);
    expect(points[0]).toMatchObject({
      block: HEAD.number + 12_000n,
      unix: HEAD.timestamp + HOUR,
      estimated: true,
      plusMinus: 72,
    });
    expect(points[3]).toMatchObject({ unix: 1_791_900_000, estimated: false });
    const timed = windowPoints({ blockClock: false, lock: 10n, close: 20n, settleDeadline: 30n }, null);
    expect(timed.map((p) => p.unix)).toEqual([10, 20, 30]);
  });

  it("says the rule, limits, fees and void terms in plain words", () => {
    expect(ruleLines({ minPool: USDC(500), minStakers: 10, minChanceBps: 300, maxChanceBps: 9_700 })).toEqual(
      [
        "A pool of at least 500.00 USDC",
        "At least 10 different wallets staking",
        "Stakes on both YES and NO",
        "A pool chance of YES between 3% and 97%",
      ],
    );
    expect(
      capLines({
        poolCap: USDC(5_000),
        walletCap: USDC(1_000),
        minStake: USDC(1),
        creatorMinStake: USDC(5),
      })[3],
    ).toEqual({
      label: "Smallest first stake (yours)",
      value: "5.00 USDC",
    });
    expect(FEE_LINES.join(" ")).toMatch(/2% of their winnings.*25% of every fee/);
    const w = { blockClock: false, lock: 1n, close: 2n, settleDeadline: 1_791_900_000n };
    expect(voidLines("perpl-funding", w)[0]).toMatch(/Perpl upgrades its Exchange/);
    expect(voidLines("price-at-time", w, PriceSource.Pyth)[0]).toMatch(/Pyth update/);
    expect(voidLines("price-touch", w)[0]).toMatch(/one honest prover/);
    expect(voidLines("parlay", w)[0]).toMatch(/a leg voids/);
    expect(voidLines("price-range", w).join(" ")).toMatch(/refunds every stake in full/);
  });
});

describe("the template catalog", () => {
  it("covers ids 1 to 6 and shows only registered ones, in catalog order", () => {
    expect([...TEMPLATE_IDS]).toEqual([1, 2, 3, 4, 5, 6]);
    expect(CREATE_TEMPLATES.map((t) => t.id).sort()).toEqual([1, 2, 3, 4, 5, 6]);
    expect(availableTemplates([2, 1]).map((t) => t.id)).toEqual([1, 2]);
    expect(availableTemplates([6, 4, 9]).map((t) => t.kind)).toEqual(["perpl-spike", "parlay"]);
    expect(availableTemplates([])).toEqual([]);
  });

  it("reads ?template= and warns where testnet feeds are slow", () => {
    expect(parseTemplateParam("4")).toBe(4);
    expect(parseTemplateParam(["2", "1"])).toBe(2);
    expect(parseTemplateParam("9")).toBeNull();
    expect(parseTemplateParam("one")).toBeNull();
    expect(parseTemplateParam(undefined)).toBeNull();
    expect(networkCaveat("price-at-time", "monad-testnet")).toMatch(/once a day/);
    expect(networkCaveat("price-touch", "monad-testnet")).toMatch(/rarely YES/);
    expect(networkCaveat("perpl-funding", "monad-testnet")).toBeNull();
    expect(networkCaveat("price-at-time", "monad-mainnet")).toBeNull();
  });
});

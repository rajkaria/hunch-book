import {
  type Deployment,
  decodePerplFundingParams,
  decodePerplFundingSpikeParams,
  type PerplFundingParams,
  TemplateId,
} from "@hunch-book/shared";
import type { Hex } from "viem";
import { formatInt, formatShortUtc } from "../format";
import { fallbackHeadline, perpName } from "./params";
import type { DecodedParams, FundingScale } from "./types";

// A market's title: the question as people read it in lists, headers and share cards.
//
// Most resolvers' `describe()` text is already a good title. Perpl markets are defined in blocks, so
// their resolver text names raw block numbers ("between block 68058301 and block 68264005"), which
// nobody can read as a time. Their titles swap the blocks for estimated clock times, from the chain
// head and the measured block time. Their thresholds are USD per unit of the asset ("$0.00000031 per
// MON"), which nobody can read as a funding rate either; with the perp's mark price and funding interval
// (MarketView.funding) the title states the rate instead. Snapshot, parlay and price touch resolvers
// state a rule ("YES if ...; NO otherwise"); their titles ask it as a question. The resolver's own
// sentence stays the rule of record: the market page shows it under "Exact rule".

/** What the title needs from the chain clock: the head block, its time, and the pace. */
export interface TitleClock {
  blockNumber: bigint;
  /** Unix seconds of the head block. */
  timestamp: number;
  msPerBlock: number;
}

/** Estimated times are rounded to this many seconds, since they are only "about" right anyway. */
export const TITLE_ROUNDING_SECONDS = 300;

/** The estimated unix time of `block`, rounded to five minutes. */
export function roundedBlockTime(block: bigint, clock: TitleClock): number {
  const t = clock.timestamp + (Number(block - clock.blockNumber) * clock.msPerBlock) / 1000;
  return Math.round(t / TITLE_ROUNDING_SECONDS) * TITLE_ROUNDING_SECONDS;
}

/**
 * "between about Oct 4, 06:10 and Oct 5, 01:00 UTC" from two blocks. Without a clock (still loading,
 * or no chain read), the block numbers, grouped so they can at least be read.
 */
export function blockWindowWords(start: bigint, end: bigint, clock: TitleClock | null): string {
  if (!clock || !(clock.msPerBlock > 0)) {
    return `between block ${formatInt(start)} and block ${formatInt(end)}`;
  }
  const from = formatShortUtc(roundedBlockTime(start, clock));
  const to = formatShortUtc(roundedBlockTime(end, clock));
  return `between about ${from} and ${to} UTC`;
}

// ---------- funding thresholds as rates ----------

/** Seconds in a year of 365.25 days. */
export const SECONDS_PER_YEAR = 31_557_600;

/**
 * A funding threshold as a rate. Perpl pays funding once per interval, and its rate is the payment as a
 * percent of the mark price (Perpl's own `fundingRatePct100k`; lib/hedge/math.ts `ratePercent`). The
 * threshold is USD per unit of the asset: threshold / 10^(priceDecimals + scaling exponent). Template 1's
 * threshold is the total over the window, so it is spread over the window's `events`; template 4's is one
 * event (`events` = 1). `perYear` is that rate over a year of intervals, from the measured block time.
 * Null when the scale cannot give a rate. Approximate by nature: it uses the mark price when the market
 * was read, while each event pays at the price of its own block.
 */
export function fundingThresholdRate(args: {
  threshold: bigint;
  scalingExp: number;
  scale: FundingScale;
  events: number;
  msPerBlock: number | null;
}): { perInterval: number; perYear: number | null } | null {
  const { scale, events } = args;
  if (!(scale.markUsd > 0) || !(scale.intervalBlocks > 0) || !(events > 0)) return null;
  const usdPerUnit = Number(args.threshold) / 10 ** (scale.priceDecimals + args.scalingExp);
  const perInterval = (usdPerUnit / events / scale.markUsd) * 100;
  if (!Number.isFinite(perInterval)) return null;
  const msPerBlock = args.msPerBlock ?? 0;
  const secondsPerInterval = msPerBlock > 0 ? (scale.intervalBlocks * msPerBlock) / 1000 : 0;
  return {
    perInterval,
    perYear: secondsPerInterval > 0 ? perInterval * (SECONDS_PER_YEAR / secondsPerInterval) : null,
  };
}

/** "0.0024%", "-0.00062%", "7.6%", "30%", "150%": two significant digits, never rounded to zero. */
export function ratePercentText(value: number): string {
  if (value === 0 || !Number.isFinite(value)) return "0%";
  const rounded = Number(value.toPrecision(2));
  const places = Math.max(0, 1 - Math.floor(Math.log10(Math.abs(rounded))));
  return `${rounded.toFixed(places)}%`;
}

/**
 * The title of a Perpl funding market with a non-zero threshold, as a rate: "Will MON's funding rate on
 * Perpl average above about -0.00062% per interval (-7.6% a year) between about Oct 4, 06:10 and Oct 4,
 * 06:20 UTC?". Null when the market has no funding scale, its params do not decode, or the threshold is
 * zero (a net-funding question reads well as it is).
 */
function perplRateTitle(m: TitleSource, deployment: Deployment, clock: TitleClock | null): string | null {
  const scale = m.funding;
  if (!scale) return null;
  const spike = m.templateId === TemplateId.PerplFundingSpike;
  let p: PerplFundingParams;
  try {
    p = spike ? decodePerplFundingSpikeParams(m.params) : decodePerplFundingParams(m.params);
  } catch {
    return null;
  }
  if (p.threshold === 0n) return null;
  const events = spike ? 1 : Number(p.endBlock - p.startBlock) / scale.intervalBlocks;
  const rate = fundingThresholdRate({
    threshold: p.threshold,
    scalingExp: p.expectedScalingExp,
    scale,
    events,
    msPerBlock: clock?.msPerBlock ?? null,
  });
  if (!rate) return null;
  const symbol = perpName(deployment, p.perpId) ?? `perp ${p.perpId.toString()}`;
  const window = blockWindowWords(p.startBlock, p.endBlock, clock);
  const yearly = rate.perYear === null ? "" : ` (${ratePercentText(rate.perYear)} a year)`;
  const pct = ratePercentText(rate.perInterval);
  if (spike) {
    return `Will any single ${symbol} funding event on Perpl charge longs more than about ${pct} of the price${yearly} ${window}?`;
  }
  return `Will ${symbol}'s funding rate on Perpl average above about ${pct} per interval${yearly} ${window}?`;
}

/** " (MON Perp, perp 64)": the venue detail Perpl resolvers add after "on Perpl". */
const PERPL_VENUE = / \([^()]*, perp \d+\)/;

/** Template 1's window in its resolver's words. */
const BLOCK_WINDOW = /between block (\d+) and block (\d+)/;

/**
 * The spike resolver (template 4) states its rule as "YES if any single funding event on Perpl (BTC
 * Perp, perp 16) after block A and at or before block B charges BTC longs more than $2 per BTC; NO if
 * ...". The title asks it as a question instead.
 */
const SPIKE_RULE =
  /^YES if any single funding event on Perpl(?: \([^()]*, perp \d+\)| perp \d+) after block (\d+) and at or before block (\d+) charges (?:(\S+) )?longs more than (.+?)(?: per (\S+?)| raw funding units); NO if/;

/**
 * The snapshot resolver (template 7): "YES if Perpl's MON mark price (perp 64) is at or above $0.025 in
 * the first snapshot taken from 2026-10-12 16:00:00 UTC to 2026-10-12 16:30:00 UTC; NO otherwise. ..."
 * The title asks it at the time the snapshot window opens.
 */
const SNAPSHOT_RULE =
  /^YES if (.+?) is (above|at or above|below|at or below) (.+?) in the first snapshot taken from (\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) UTC to /;

/** The parlay resolver (template 6): "YES if all 2 of these Hunch Book markets settle YES: #12 (0x...), #13 (0x...); NO if ..." */
const PARLAY_RULE = /^YES if all (\d+) of these Hunch Book markets settle YES: (.+?); NO if/;

/** A time as the resolvers write it: "2026-10-04 13:36:39" (UTC). */
const RESOLVER_TIME = "(\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2})";

/**
 * The touch resolver (template 3): "YES if Chainlink's BTC/USD feed reports a price at or above $86,000 in
 * any round updated from 2026-10-04 13:36:39 UTC to 2026-10-07 13:06:39 UTC; NO if nobody proves that by
 * ...".
 */
const TOUCH_RULE = new RegExp(
  `^YES if (Chainlink's \\S+ feed) reports a price (at or above|at or below) (\\S+) in any round updated from ${RESOLVER_TIME} UTC to ${RESOLVER_TIME} UTC;`,
);

/** The price-at-time resolver (template 2): "Will BTC/USD be at or above $120,000 at 2027-01-16 08:00:00 UTC (unix time 1800086400), per Chainlink's BTC/USD feed?" */
const PRICE_AT_TIME_RULE = new RegExp(
  `^Will (\\S+) be at or above (\\S+) at ${RESOLVER_TIME} UTC \\(unix time \\d+\\), per (Chainlink|Pyth)'s \\S+ feed\\?$`,
);

/** The price range resolver (template 5): "YES if Chainlink's BTC/USD feed puts BTC/USD at or above $1 and below $2 at 2027-01-16 08:00:00 UTC (unix time 1800086400); NO otherwise." */
const PRICE_RANGE_RULE = new RegExp(
  `^YES if (Chainlink|Pyth)'s \\S+ feed puts (\\S+) at or above (\\S+) and below (\\S+) at ${RESOLVER_TIME} UTC \\(unix time \\d+\\); NO otherwise\\.$`,
);

/** Unix seconds of a resolver time ("2026-10-04 13:36:39", UTC). */
function resolverTime(text: string): number {
  const [date = "", time = ""] = text.split(" ");
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi, s] = time.split(":").map(Number);
  return Date.UTC(y ?? 0, (mo ?? 1) - 1, d ?? 1, h ?? 0, mi ?? 0, s ?? 0) / 1000;
}

/** A parlay leg as the resolver labels it, "#12 (0xAbC...)" or a bare address, shortened to "#12" or "0xAbCd...1234". */
function legName(label: string): string {
  const id = /^#(\d+) \(/.exec(label);
  if (id) return `#${id[1]}`;
  const address = label.trim();
  return /^0x[0-9a-fA-F]{40}$/.test(address) ? `${address.slice(0, 6)}...${address.slice(-4)}` : address;
}

/** "#1", "#1 and #2", "#1, #2 and #3". */
function listWords(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/**
 * A resolver's sentence as a question people read at a glance: a Perpl window's block numbers turned
 * into estimated clock times, a snapshot or parlay rule asked as a question. Works on the text alone, so
 * it serves rows that only have the question (from the indexer) as well as full market reads. Text it
 * does not recognise comes back unchanged.
 */
export function friendlyQuestion(description: string, clock: TitleClock | null): string {
  const snapshot = SNAPSHOT_RULE.exec(description);
  if (snapshot) {
    const [, label = "", comparator = "", threshold = "", y, mo, d, h, mi, sec] = snapshot;
    const at = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(sec)) / 1000;
    const what = label.replace(/ \(perp \d+\)/, "");
    return `Will ${what} be ${comparator} ${threshold} at ${formatShortUtc(at)} UTC?`;
  }
  const parlay = PARLAY_RULE.exec(description);
  if (parlay) {
    const [, count = "0", list = ""] = parlay;
    const legs = list.split(", ").map(legName);
    const all = Number(count) === 2 ? "both" : "all";
    return `Will markets ${listWords(legs)} ${all} settle YES?`;
  }
  const touch = TOUCH_RULE.exec(description);
  if (touch) {
    const [, source = "", comparator = "", level = "", from = "", to = ""] = touch;
    const window = `between ${formatShortUtc(resolverTime(from))} and ${formatShortUtc(resolverTime(to))} UTC`;
    return `Will ${source} report a price ${comparator} ${level} ${window}?`;
  }
  const atTime = PRICE_AT_TIME_RULE.exec(description);
  if (atTime) {
    const [, pair = "", strike = "", at = "", source = ""] = atTime;
    return `Will ${pair} be at or above ${strike} at ${formatShortUtc(resolverTime(at))} UTC, per ${source}?`;
  }
  const range = PRICE_RANGE_RULE.exec(description);
  if (range) {
    const [, source = "", pair = "", lower = "", upper = "", at = ""] = range;
    return `Will ${pair} be at or above ${lower} and below ${upper} at ${formatShortUtc(resolverTime(at))} UTC, per ${source}?`;
  }
  const spike = SPIKE_RULE.exec(description);
  if (spike) {
    const [, start = "0", end = "0", symbol, amount, unit] = spike;
    const window = blockWindowWords(BigInt(start), BigInt(end), clock);
    const who = symbol ? `${symbol} ` : "";
    const per = unit ? ` per ${unit}` : " raw funding units";
    return `Will any single ${who}funding event on Perpl charge longs more than ${amount}${per} ${window}?`;
  }
  const window = BLOCK_WINDOW.exec(description);
  if (!window) return description;
  const [whole, start = "0", end = "0"] = window;
  return description
    .replace(whole, blockWindowWords(BigInt(start), BigInt(end), clock))
    .replace(PERPL_VENUE, "");
}

/** The title from the params alone, for a Perpl market whose resolver did not answer `describe`. */
function perplTitleFromParams(
  templateId: number,
  p: PerplFundingParams,
  deployment: Deployment,
  clock: TitleClock | null,
): string {
  const window = blockWindowWords(p.startBlock, p.endBlock, clock);
  const perp = perpName(deployment, p.perpId) ?? `perp ${p.perpId.toString()}`;
  if (templateId === TemplateId.PerplFundingSpike) {
    return `Will any single ${perp} funding event on Perpl charge longs more than ${p.threshold.toString()} (raw Perpl units) ${window}?`;
  }
  const what =
    p.threshold === 0n
      ? `${perp} longs pay shorts on net`
      : `${perp} longs pay more than ${p.threshold.toString()} (raw Perpl units) in funding`;
  return `Will ${what} on Perpl ${window}?`;
}

/** What the title reads from a market. MarketView has all of it. */
export interface TitleSource {
  templateId: number;
  params: Hex;
  description: string | null;
  decoded: DecodedParams;
  /** Perpl funding markets: the perp's mark price and funding interval, for a rate in the title. */
  funding?: FundingScale;
}

/**
 * The market's title. Perpl templates (1 and 4) get estimated clock times in place of block numbers and,
 * once their perp's mark price is known, their threshold as a funding rate; snapshot, parlay and price
 * rules are asked as questions; every other template uses the resolver's own sentence; without one, a
 * title built from the params.
 */
export function marketTitle(m: TitleSource, deployment: Deployment, clock: TitleClock | null): string {
  const perpl = m.templateId === TemplateId.PerplFunding || m.templateId === TemplateId.PerplFundingSpike;
  if (perpl) {
    const rate = perplRateTitle(m, deployment, clock);
    if (rate) return rate;
  }
  if (m.description !== null) return friendlyQuestion(m.description, clock);
  if (perpl) {
    try {
      const p =
        m.templateId === TemplateId.PerplFunding
          ? decodePerplFundingParams(m.params)
          : decodePerplFundingSpikeParams(m.params);
      return perplTitleFromParams(m.templateId, p, deployment, clock);
    } catch {
      // Bad bytes: fall through.
    }
  }
  return m.description ?? fallbackHeadline(deployment, m.decoded);
}

/** True when the title is not the resolver's sentence word for word, so the page should show both. */
export function titleDiffersFromRule(m: Pick<TitleSource, "description">, title: string): boolean {
  return m.description !== null && m.description !== title;
}

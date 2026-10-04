import type { Enum } from "envio";
import { decodeAbiParameters, encodeAbiParameters, type Hex, keccak256 } from "viem";
import type { NetworkConstants } from "./network.js";

// Market parameters, decoded with the structs in contracts/src/interfaces/ITemplates.sol (templates
// 1 and 2), ITemplatesV2.sol (templates 3 to 6) and ITemplatesV3.sol (template 7). test/params.test.ts
// checks these shapes against the ABIs generated from the contracts.

export const TEMPLATE_PERPL_FUNDING = 1n;
export const TEMPLATE_PRICE_AT_TIME = 2n;
export const TEMPLATE_CHAINLINK_TOUCH = 3n;
export const TEMPLATE_PERPL_FUNDING_SPIKE = 4n;
export const TEMPLATE_PRICE_RANGE = 5n;
export const TEMPLATE_PARLAY = 6n;
export const TEMPLATE_SNAPSHOT = 7n;
/** Every resolver allows settlement up to 7 days after its window (PROTOCOL.md section 2). */
export const SETTLEMENT_WINDOW_SECONDS = 7n * 24n * 60n * 60n;
/** ChainlinkTouchResolver.CHALLENGE_PERIOD: NO can settle this long after a touch window ends. */
export const TOUCH_CHALLENGE_SECONDS = 24n * 60n * 60n;

export const perplFundingParamsAbi = [
  {
    type: "tuple",
    components: [
      { name: "perpId", type: "uint256" },
      { name: "startBlock", type: "uint64" },
      { name: "endBlock", type: "uint64" },
      { name: "threshold", type: "int256" },
      { name: "expectedScalingExp", type: "uint8" },
    ],
  },
] as const;

export const priceAtTimeParamsAbi = [
  {
    type: "tuple",
    components: [
      { name: "source", type: "uint8" },
      { name: "feed", type: "address" },
      { name: "pythId", type: "bytes32" },
      { name: "strikeE8", type: "int256" },
      { name: "lockTime", type: "uint64" },
      { name: "closeTime", type: "uint64" },
    ],
  },
] as const;

export const chainlinkTouchParamsAbi = [
  {
    type: "tuple",
    components: [
      { name: "feed", type: "address" },
      { name: "strikeE8", type: "int256" },
      { name: "direction", type: "uint8" },
      { name: "lockTime", type: "uint64" },
      { name: "startTime", type: "uint64" },
      { name: "endTime", type: "uint64" },
    ],
  },
] as const;

export const perplFundingSpikeParamsAbi = perplFundingParamsAbi;

export const priceRangeParamsAbi = [
  {
    type: "tuple",
    components: [
      { name: "source", type: "uint8" },
      { name: "feed", type: "address" },
      { name: "pythId", type: "bytes32" },
      { name: "lowerE8", type: "int256" },
      { name: "upperE8", type: "int256" },
      { name: "lockTime", type: "uint64" },
      { name: "closeTime", type: "uint64" },
    ],
  },
] as const;

export const parlayParamsAbi = [
  {
    type: "tuple",
    components: [
      { name: "legs", type: "address[]" },
      { name: "lockTime", type: "uint64" },
      { name: "closeTime", type: "uint64" },
    ],
  },
] as const;

export const snapshotParamsAbi = [
  {
    type: "tuple",
    components: [
      { name: "sourceId", type: "uint16" },
      { name: "threshold", type: "int256" },
      { name: "comparator", type: "uint8" },
      { name: "lockTime", type: "uint64" },
      { name: "closeTime", type: "uint64" },
      { name: "snapshotWindow", type: "uint32" },
    ],
  },
] as const;

/** What the indexer stores about a market's parameters. Unknown templates leave everything unset. */
export interface MarketTerms {
  question?: string;
  asset?: string;
  perpId?: bigint;
  threshold?: bigint;
  priceSource?: string;
  feed?: string;
  pythId?: string;
  strikeE8?: bigint;
  lowerE8?: bigint;
  upperE8?: bigint;
  blockClock?: boolean;
  windowStart?: bigint;
  lockAt?: bigint;
  closeAt?: bigint;
  settleDeadline?: bigint;
  legs?: string[];
  snapshotKey?: string;
  snapshotSourceId?: number;
  snapshotWindow?: number;
  comparator?: Enum<"SnapshotComparator">;
}

const COMPARATORS = [
  "Above",
  "AtOrAbove",
  "Below",
  "AtOrBelow",
] as const satisfies readonly Enum<"SnapshotComparator">[];

const COMPARATOR_TEXT: Record<Enum<"SnapshotComparator">, string> = {
  Above: "above",
  AtOrAbove: "at or above",
  Below: "below",
  AtOrBelow: "at or below",
};

/** SnapshotResolver's comparator ordinal (0 above, 1 at or above, 2 below, 3 at or below). */
export function comparatorOf(ordinal: number): Enum<"SnapshotComparator"> {
  const c = COMPARATORS[ordinal];
  if (!c) throw new Error(`unknown comparator ${ordinal}`);
  return c;
}

/** ChainlinkTouchResolver's direction (0 at or above the strike, 1 at or below), as a comparator. */
export function touchDirectionOf(ordinal: number): Enum<"SnapshotComparator"> {
  if (ordinal === 0) return "AtOrAbove";
  if (ordinal === 1) return "AtOrBelow";
  throw new Error(`unknown touch direction ${ordinal}`);
}

/**
 * SnapshotStore.snapshotKey: keccak256(abi.encode(uint16 sourceId, uint64 closeTime, uint32 snapshotWindow)).
 * Every market on one source, close time and window answers from the snapshot stored under this key.
 */
export function snapshotKey(sourceId: number, closeTime: bigint, snapshotWindow: number): string {
  return keccak256(
    encodeAbiParameters(
      [{ type: "uint16" }, { type: "uint64" }, { type: "uint32" }],
      [sourceId, closeTime, snapshotWindow],
    ),
  );
}

/** The Snapshot entity's id: snapshot keys are per resolver, so the resolver is part of it. */
export function snapshotId(resolver: string, key: string): string {
  return `${resolver.toLowerCase()}-${key.toLowerCase()}`;
}

/** "1,234,567". */
function group(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** value / 10^decimals written out exactly, like ResolverText.decimal: "84,696.5", "0.25", "-36,874". */
export function formatDecimal(value: bigint, decimals: number): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const frac = decimals > 0 ? digits.slice(digits.length - decimals).replace(/0+$/, "") : "";
  return `${negative ? "-" : ""}${group(whole)}${frac ? `.${frac}` : ""}`;
}

/** "$84,696.5", "-$0.25". */
export function formatUsd(value: bigint, decimals: number): string {
  return value < 0n ? `-$${formatDecimal(-value, decimals)}` : `$${formatDecimal(value, decimals)}`;
}

/** "2026-10-04 12:00:00 UTC". */
export function formatUtc(timestamp: bigint): string {
  const iso = new Date(Number(timestamp) * 1000).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;
}

/** A Perpl perp: its asset when the deployments file names it, and the venue's words. */
function perpOf(perpId: bigint, network: NetworkConstants) {
  const symbol = network.perps[perpId.toString()];
  return { symbol, longs: symbol ? `${symbol} longs` : "longs", venue: `on Perpl (perp ${perpId})` };
}

function perplTerms(params: Hex, network: NetworkConstants): MarketTerms {
  const [p] = decodeAbiParameters(perplFundingParamsAbi, params);
  const perp = perpOf(p.perpId, network);
  const window = `between block ${p.startBlock} and block ${p.endBlock}?`;
  const question =
    p.threshold === 0n
      ? `Will ${perp.longs} pay shorts on net in funding ${perp.venue} ${window}`
      : `Will ${perp.longs} pay more than ${formatDecimal(p.threshold, 0)} raw funding units ${perp.venue} ${window}`;
  return {
    question,
    asset: perp.symbol,
    perpId: p.perpId,
    threshold: p.threshold,
    blockClock: true,
    lockAt: p.startBlock,
    closeAt: p.endBlock,
  };
}

/** A price source (0 Chainlink, 1 Pyth) and how to name it: the pair when the deployments file knows the feed. */
function priceSourceOf(source: number, feedAddress: string, pythIdValue: string, network: NetworkConstants) {
  const chainlink = source === 0;
  const feed = feedAddress.toLowerCase();
  const pythId = pythIdValue.toLowerCase();
  const pair = chainlink ? network.chainlinkFeeds[feed] : network.pythIds[pythId];
  const label = pair ?? (chainlink ? feed : pythId);
  return {
    pair,
    label,
    text: `${chainlink ? "Chainlink's" : "Pyth's"} ${label} feed`,
    terms: {
      asset: pair,
      priceSource: chainlink ? "Chainlink" : "Pyth",
      feed: chainlink ? feed : undefined,
      pythId: chainlink ? undefined : pythId,
    },
  };
}

function priceTerms(params: Hex, network: NetworkConstants): MarketTerms {
  const [p] = decodeAbiParameters(priceAtTimeParamsAbi, params);
  const s = priceSourceOf(p.source, p.feed, p.pythId, network);
  return {
    question: `Will ${s.label} be at or above ${formatUsd(p.strikeE8, 8)} at ${formatUtc(p.closeTime)} (unix time ${p.closeTime}), per ${s.text}?`,
    ...s.terms,
    strikeE8: p.strikeE8,
    blockClock: false,
    lockAt: p.lockTime,
    closeAt: p.closeTime,
    settleDeadline: p.closeTime + SETTLEMENT_WINDOW_SECONDS,
  };
}

/** Template 3: YES is proved early by a round that touches the strike; NO waits out a 24-hour challenge. */
function touchTerms(params: Hex, network: NetworkConstants): MarketTerms {
  const [p] = decodeAbiParameters(chainlinkTouchParamsAbi, params);
  const s = priceSourceOf(0, p.feed, `0x${"0".repeat(64)}`, network);
  const comparator = touchDirectionOf(p.direction);
  return {
    question: `Will ${s.text} report a price ${COMPARATOR_TEXT[comparator]} ${formatUsd(p.strikeE8, 8)} in any round updated from ${formatUtc(p.startTime)} to ${formatUtc(p.endTime)}?`,
    ...s.terms,
    strikeE8: p.strikeE8,
    comparator,
    blockClock: false,
    windowStart: p.startTime,
    lockAt: p.lockTime,
    closeAt: p.endTime,
    settleDeadline: p.endTime + TOUCH_CHALLENGE_SECONDS + SETTLEMENT_WINDOW_SECONDS,
  };
}

/**
 * Template 4: YES is proved early by one funding event above the threshold. Its challenge period is in
 * blocks, fixed per resolver, so the deadline (a time) is left to Market.window(), as for template 1.
 */
function spikeTerms(params: Hex, network: NetworkConstants): MarketTerms {
  const [p] = decodeAbiParameters(perplFundingSpikeParamsAbi, params);
  const perp = perpOf(p.perpId, network);
  return {
    question: `Will any single funding event ${perp.venue} after block ${p.startBlock} and at or before block ${p.endBlock} charge ${perp.longs} more than ${formatDecimal(p.threshold, 0)} raw funding units?`,
    asset: perp.symbol,
    perpId: p.perpId,
    threshold: p.threshold,
    blockClock: true,
    windowStart: p.startBlock,
    lockAt: p.startBlock,
    closeAt: p.endBlock,
  };
}

/** Template 5: read like template 2; the lower bound counts, the upper one does not. */
function rangeTerms(params: Hex, network: NetworkConstants): MarketTerms {
  const [p] = decodeAbiParameters(priceRangeParamsAbi, params);
  const s = priceSourceOf(p.source, p.feed, p.pythId, network);
  return {
    question: `Will ${s.label} be at or above ${formatUsd(p.lowerE8, 8)} and below ${formatUsd(p.upperE8, 8)} at ${formatUtc(p.closeTime)} (unix time ${p.closeTime}), per ${s.text}?`,
    ...s.terms,
    lowerE8: p.lowerE8,
    upperE8: p.upperE8,
    blockClock: false,
    lockAt: p.lockTime,
    closeAt: p.closeTime,
    settleDeadline: p.closeTime + SETTLEMENT_WINDOW_SECONDS,
  };
}

/** Template 6. The question and deadline need the legs' markets: the factory's handler fills them in. */
function parlayTerms(params: Hex): MarketTerms {
  const [p] = decodeAbiParameters(parlayParamsAbi, params);
  const legs = p.legs.map((leg) => leg.toLowerCase());
  return {
    ...parlayDetails(
      legs.map((id) => ({ id })),
      p.closeTime,
    ),
    legs,
    blockClock: false,
    lockAt: p.lockTime,
    closeAt: p.closeTime,
  };
}

/**
 * A parlay's question and deadline from what the indexer knows about its legs. The resolver's deadline is
 * the latest of the parlay's close and its legs' deadlines, plus 7 days; it is left unset when a leg's
 * deadline is unknown (a block-clock leg, or a leg the indexer has not seen).
 */
export function parlayDetails(
  legs: { id: string; number?: number; settleDeadline?: bigint }[],
  closeTime: bigint,
): { question: string; settleDeadline?: bigint } {
  const names = legs.map((leg) => (leg.number ? `#${leg.number}` : leg.id)).join(", ");
  const known = legs.every((leg) => leg.settleDeadline !== undefined);
  const latest = legs.reduce((max, leg) => {
    const deadline = leg.settleDeadline ?? 0n;
    return deadline > max ? deadline : max;
  }, closeTime);
  return {
    question: `Will all ${legs.length} of these Hunch Book markets settle YES: ${names}?`,
    settleDeadline: known ? latest + SETTLEMENT_WINDOW_SECONDS : undefined,
  };
}

/**
 * Template 7. The resolver keeps each source's label, unit and decimals, which the deployments file does
 * not carry, so the summary names the source by its id and the threshold in raw units; the resolver's
 * describe() words the exact rule.
 */
function snapshotTerms(params: Hex): MarketTerms {
  const [p] = decodeAbiParameters(snapshotParamsAbi, params);
  const comparator = comparatorOf(p.comparator);
  const windowEnd = p.closeTime + BigInt(p.snapshotWindow);
  return {
    question: `Will snapshot source ${p.sourceId} read ${COMPARATOR_TEXT[comparator]} ${formatDecimal(p.threshold, 0)} (raw units) in the first snapshot taken from ${formatUtc(p.closeTime)} to ${formatUtc(windowEnd)}?`,
    threshold: p.threshold,
    blockClock: false,
    lockAt: p.lockTime,
    closeAt: p.closeTime,
    settleDeadline: windowEnd + SETTLEMENT_WINDOW_SECONDS,
    snapshotKey: snapshotKey(p.sourceId, p.closeTime, p.snapshotWindow),
    snapshotSourceId: p.sourceId,
    snapshotWindow: p.snapshotWindow,
    comparator,
  };
}

/** Decodes a market's parameters. Never throws: unknown templates or malformed bytes give no terms. */
export function marketTerms(templateId: bigint, params: string, network: NetworkConstants): MarketTerms {
  try {
    const hex = params as Hex;
    if (templateId === TEMPLATE_PERPL_FUNDING) return perplTerms(hex, network);
    if (templateId === TEMPLATE_PRICE_AT_TIME) return priceTerms(hex, network);
    if (templateId === TEMPLATE_CHAINLINK_TOUCH) return touchTerms(hex, network);
    if (templateId === TEMPLATE_PERPL_FUNDING_SPIKE) return spikeTerms(hex, network);
    if (templateId === TEMPLATE_PRICE_RANGE) return rangeTerms(hex, network);
    if (templateId === TEMPLATE_PARLAY) return parlayTerms(hex);
    if (templateId === TEMPLATE_SNAPSHOT) return snapshotTerms(hex);
  } catch {
    // Malformed parameters cannot pass the resolver's validate(), so this only guards the indexer.
  }
  return {};
}

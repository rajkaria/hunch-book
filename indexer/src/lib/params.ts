import type { Enum } from "envio";
import { decodeAbiParameters, encodeAbiParameters, type Hex, keccak256 } from "viem";
import type { NetworkConstants } from "./network.js";

// Market parameters, decoded with the structs in contracts/src/interfaces/ITemplates.sol (templates
// 1 and 2) and ITemplatesV3.sol (template 7). test/params.test.ts checks these shapes against the ABIs
// generated from the contracts.

export const TEMPLATE_PERPL_FUNDING = 1n;
export const TEMPLATE_PRICE_AT_TIME = 2n;
export const TEMPLATE_SNAPSHOT = 7n;
/** Every resolver allows settlement up to 7 days after its window (PROTOCOL.md section 2). */
export const SETTLEMENT_WINDOW_SECONDS = 7n * 24n * 60n * 60n;

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
  blockClock?: boolean;
  lockAt?: bigint;
  closeAt?: bigint;
  settleDeadline?: bigint;
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

function perplTerms(params: Hex, network: NetworkConstants): MarketTerms {
  const [p] = decodeAbiParameters(perplFundingParamsAbi, params);
  const symbol = network.perps[p.perpId.toString()];
  const who = symbol ? `${symbol} longs` : "longs";
  const venue = `on Perpl (perp ${p.perpId})`;
  const window = `between block ${p.startBlock} and block ${p.endBlock}?`;
  const question =
    p.threshold === 0n
      ? `Will ${who} pay shorts on net in funding ${venue} ${window}`
      : `Will ${who} pay more than ${formatDecimal(p.threshold, 0)} raw funding units ${venue} ${window}`;
  return {
    question,
    asset: symbol,
    perpId: p.perpId,
    threshold: p.threshold,
    blockClock: true,
    lockAt: p.startBlock,
    closeAt: p.endBlock,
  };
}

function priceTerms(params: Hex, network: NetworkConstants): MarketTerms {
  const [p] = decodeAbiParameters(priceAtTimeParamsAbi, params);
  const chainlink = p.source === 0;
  const feed = p.feed.toLowerCase();
  const pythId = p.pythId.toLowerCase();
  const pair = chainlink ? network.chainlinkFeeds[feed] : network.pythIds[pythId];
  const label = pair ?? (chainlink ? feed : pythId);
  const source = `${chainlink ? "Chainlink's" : "Pyth's"} ${label} feed`;
  return {
    question: `Will ${label} be at or above ${formatUsd(p.strikeE8, 8)} at ${formatUtc(p.closeTime)} (unix time ${p.closeTime}), per ${source}?`,
    asset: pair,
    priceSource: chainlink ? "Chainlink" : "Pyth",
    feed: chainlink ? feed : undefined,
    pythId: chainlink ? undefined : pythId,
    strikeE8: p.strikeE8,
    blockClock: false,
    lockAt: p.lockTime,
    closeAt: p.closeTime,
    settleDeadline: p.closeTime + SETTLEMENT_WINDOW_SECONDS,
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
    if (templateId === TEMPLATE_PERPL_FUNDING) return perplTerms(params as Hex, network);
    if (templateId === TEMPLATE_PRICE_AT_TIME) return priceTerms(params as Hex, network);
    if (templateId === TEMPLATE_SNAPSHOT) return snapshotTerms(params as Hex);
  } catch {
    // Malformed parameters cannot pass the resolver's validate(), so this only guards the indexer.
  }
  return {};
}

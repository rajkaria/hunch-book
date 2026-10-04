import { decodeAbiParameters, type Hex } from "viem";
import type { NetworkConstants } from "./network.js";

// Market parameters, decoded with the structs in contracts/src/interfaces/ITemplates.sol.
// test/params.test.ts checks these shapes against the ABI generated from the contracts.

export const TEMPLATE_PERPL_FUNDING = 1n;
export const TEMPLATE_PRICE_AT_TIME = 2n;
/** Both v0 resolvers allow settlement up to close + 7 days (PROTOCOL.md section 2). */
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

/** Decodes a market's parameters. Never throws: unknown templates or malformed bytes give no terms. */
export function marketTerms(templateId: bigint, params: string, network: NetworkConstants): MarketTerms {
  try {
    if (templateId === TEMPLATE_PERPL_FUNDING) return perplTerms(params as Hex, network);
    if (templateId === TEMPLATE_PRICE_AT_TIME) return priceTerms(params as Hex, network);
  } catch {
    // Malformed parameters cannot pass the resolver's validate(), so this only guards the indexer.
  }
  return {};
}

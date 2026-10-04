import { PriceSource } from "@hunch-book/shared";
import { type Address, type Hex, zeroAddress, zeroHash } from "viem";
import { roundSignificant } from "./units";

// Price templates: which feeds the resolver accepts, default times, and price scaling
// (docs/PROTOCOL.md §6.2).

export const MINUTE = 60;
export const HOUR = 3_600;
export const DAY = 86_400;

/**
 * Lock must be at least this far ahead when the form is filled, so the transaction lands before it.
 * The resolver itself only needs lock > the block's timestamp.
 */
export const MIN_LEAD_SECONDS = 5 * MINUTE;

/** One feed the price resolver accepts. Chainlink by default; Pyth only where no Chainlink feed exists. */
export interface PriceFeedOption {
  /** Stable id for inputs: "chainlink:<address>" or "pyth:<id>". */
  key: string;
  /** "BTC/USD". */
  label: string;
  /** "BTC". */
  asset: string;
  source: PriceSource;
  feed: Address;
  pythId: Hex;
}

/** "BTC" from "BTC/USD" or "BTC / USD". */
export function assetOf(pair: string): string {
  return pair.split("/")[0]?.trim() ?? pair;
}

export function chainlinkOption(label: string, feed: Address): PriceFeedOption {
  const pair = label.replace(/\s+/g, "");
  return {
    key: `chainlink:${feed.toLowerCase()}`,
    label: pair,
    asset: assetOf(pair),
    source: PriceSource.Chainlink,
    feed,
    pythId: zeroHash,
  };
}

export function pythOption(label: string, pythId: Hex): PriceFeedOption {
  const pair = label.replace(/\s+/g, "");
  return {
    key: `pyth:${pythId.toLowerCase()}`,
    label: pair,
    asset: assetOf(pair),
    source: PriceSource.Pyth,
    feed: zeroAddress,
    pythId,
  };
}

/** "Chainlink" or "Pyth". */
export function sourceName(source: PriceSource): string {
  return source === PriceSource.Pyth ? "Pyth" : "Chainlink";
}

/** The first 12:00 UTC strictly after `unix`. */
export function nextNoonUtc(unix: number): number {
  const dayStart = Math.floor(unix / DAY) * DAY;
  const noon = dayStart + 12 * HOUR;
  return noon > unix ? noon : noon + DAY;
}

/** How long before close staking stops: 24 hours for daily markets, 1 hour for intraday (§6.2). */
export type LockLead = "day" | "hour" | "custom";

export const LOCK_LEAD_SECONDS: Record<Exclude<LockLead, "custom">, number> = { day: DAY, hour: HOUR };

/**
 * Defaults for a daily price market: close at the next 12:00 UTC that leaves the lock (close minus
 * 24 hours) at least MIN_LEAD_SECONDS in the future, and lock 24 hours before it.
 */
export function defaultPriceTimes(now: number, lead: number = DAY): { lock: number; close: number } {
  const close = nextNoonUtc(now + lead + MIN_LEAD_SECONDS);
  return { lock: close - lead, close };
}

/**
 * A default range around a price: 2% either side, each bound rounded to three significant figures,
 * and never empty.
 */
export function rangeAround(priceE8: bigint): { lower: bigint; upper: bigint } {
  const lower = roundSignificant((priceE8 * 98n) / 100n, 3);
  let upper = roundSignificant((priceE8 * 102n) / 100n, 3);
  if (upper <= lower) upper = lower + 1n;
  return { lower, upper };
}

/** A default touch level: 5% above the price for "reaches", 5% below for "falls to". */
export function touchLevel(priceE8: bigint, direction: "above" | "below"): bigint {
  return roundSignificant((priceE8 * (direction === "above" ? 105n : 95n)) / 100n, 3);
}

/** Scales a price with `decimals` to 8 decimals, rounding toward zero. */
export function toE8(value: bigint, decimals: number): bigint {
  if (decimals === 8) return value;
  if (decimals < 8) return value * 10n ** BigInt(8 - decimals);
  return value / 10n ** BigInt(decimals - 8);
}

/** Scales a Pyth price (`price * 10^expo`) to 8 decimals. */
export function pythToE8(price: bigint, expo: number): bigint {
  return toE8(price, -expo);
}

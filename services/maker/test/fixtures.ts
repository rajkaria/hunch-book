import { readFileSync } from "node:fs";
import type { FundingSample } from "../src/pricing/perplFunding.js";
import type { PriceRound } from "../src/pricing/priceAtTime.js";

// Loaders for the fixtures in test/fixtures, which scripts/capture-fixtures.ts recorded from Monad
// mainnet. They are never edited by hand.

const read = (name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

export interface FundingFixture {
  source: { block: number; contract: string };
  perpId: number;
  perp: { symbol: string; priceDecimals: number; fundingSumScalingExp: number; fundingStartBlock: number };
  interval: number;
  lastEvent: number;
  samples: FundingSample[];
}

export function fundingFixture(asset: "btc" | "mon"): FundingFixture {
  return read(`perpl-funding-${asset}.json`);
}

export interface ChainlinkFixture {
  source: { block: number; blockTimestamp: number; contract: string };
  decimals: number;
  description: string;
  rounds: { roundId: string; answer: string; updatedAt: number }[];
}

export function chainlinkFixture(pair: "btc-usd" | "eth-usd" | "mon-usd" | "sol-usd"): ChainlinkFixture {
  return read(`chainlink-${pair}.json`);
}

export interface TradesFixture {
  source: { block: number; fromBlock: string; toBlock: string; contract: string };
  /** The book at bookAt, just before the first block of trades. */
  bookAt: string;
  l2: `0x${string}`;
  bestBidAsk: [string, string];
  pricePrecision: number;
  sizePrecision: string;
  baseDecimals: number;
  quoteDecimals: number;
  tickSize: number;
  minSize: string;
  trades: {
    block: string;
    logIndex: number;
    tx: string;
    takerBuysYes: boolean;
    priceE18: string;
    filledSize: string;
  }[];
}

/** Kuru's MON-USDC Trade events recorded from Monad mainnet, oldest first. */
export function tradesFixture(): TradesFixture {
  return read("kuru-trades-mon-usdc.json");
}

export function priceRounds(fixture: ChainlinkFixture): PriceRound[] {
  return fixture.rounds.map((r) => ({
    roundId: BigInt(r.roundId),
    answer: Number(r.answer),
    updatedAt: r.updatedAt,
  }));
}

export interface L2Fixture {
  source: { block: number };
  l2: `0x${string}`;
  bestBidAsk: [string, string];
  pricePrecision: number;
  sizePrecision: string;
  tickSize: number;
}

export function l2Fixture(): L2Fixture {
  return read("kuru-l2-mon-usdc.json");
}

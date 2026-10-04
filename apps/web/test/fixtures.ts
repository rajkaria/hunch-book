import {
  deployments,
  encodePerplFundingParams,
  encodePriceAtTimeParams,
  HUNCH_BOOK_PARAMS,
  type L2Level,
  Outcome,
  Phase,
  PriceSource,
  TemplateId,
} from "@hunch-book/shared";
import type { Address } from "viem";
import { type BookSnapshot, BookState } from "../src/lib/chain/kuru";
import type { WalletBalances } from "../src/lib/chain/reads";
import { decodeMarketParams } from "../src/lib/market/params";
import type { ChainClock, MarketView, PortfolioEntry } from "../src/lib/market/types";

export const USDC = (n: number): bigint => BigInt(Math.round(n * 1_000_000));

export const MARKET = "0x00000000000000000000000000000000000000a1" as Address;
export const FACTORY = "0x00000000000000000000000000000000000000f1" as Address;
export const RESOLVER = "0x00000000000000000000000000000000000000e1" as Address;
export const USER = "0x00000000000000000000000000000000000000b0" as Address;

export const btcFeed = deployments["monad-mainnet"].external.chainlink["BTC/USD"] as Address;

export const priceParams = encodePriceAtTimeParams({
  source: PriceSource.Chainlink,
  feed: btcFeed,
  pythId: `0x${"00".repeat(32)}`,
  strikeE8: 120_000_00000000n,
  lockTime: 1_800_000_000n,
  closeTime: 1_800_086_400n,
});

export const perplParams = encodePerplFundingParams({
  perpId: 16n,
  startBlock: 1_000_000n,
  endBlock: 1_002_000n,
  threshold: 0n,
  expectedScalingExp: 0,
});

export function makeMarket(overrides: Partial<MarketView> = {}): MarketView {
  const templateId = overrides.templateId ?? TemplateId.PriceAtTime;
  const params = overrides.params ?? (templateId === TemplateId.PerplFunding ? perplParams : priceParams);
  const yes = overrides.pool?.yes ?? USDC(300);
  const no = overrides.pool?.no ?? USDC(100);
  return {
    address: MARKET,
    marketId: 7n,
    templateId,
    phase: Phase.Pool,
    outcome: Outcome.Unresolved,
    graduated: false,
    window: {
      blockClock: templateId === TemplateId.PerplFunding,
      lock: templateId === TemplateId.PerplFunding ? 1_000_000n : 1_800_000_000n,
      close: templateId === TemplateId.PerplFunding ? 1_002_000n : 1_800_086_400n,
      settleDeadline: 1_800_691_200n,
    },
    tokens: {
      yes: "0x00000000000000000000000000000000000000c1",
      no: "0x00000000000000000000000000000000000000c2",
    },
    book: null,
    resolver: RESOLVER,
    creator: "0x00000000000000000000000000000000000000d1",
    decoded: decodeMarketParams(templateId, params),
    rule: { minPool: USDC(500), minStakers: 10, minChanceBps: 300, maxChanceBps: 9_700 },
    caps: { poolCap: USDC(5_000), walletCap: USDC(1_000), minStake: USDC(1), creatorMinStake: USDC(5) },
    evidenceHash: `0x${"00".repeat(32)}`,
    description: "Will BTC/USD be at or above $120,000 at 08:00 UTC on 16 Jan 2027?",
    quote: null,
    ruleMet: false,
    ...overrides,
    params,
    pool: { yes, no, total: yes + no, stakers: overrides.pool?.stakers ?? 4 },
  };
}

export const clock: ChainClock = {
  blockNumber: 999_000n,
  timestamp: 1_799_000_000,
  msPerBlock: 400,
  measured: true,
};

export function makeEntry(overrides: Partial<PortfolioEntry> = {}): PortfolioEntry {
  return {
    market: makeMarket(),
    stake: { yes: USDC(25), no: 0n },
    claimableTokens: { yes: 0n, no: 0n },
    claimablePool: { paid: 0n, fee: 0n },
    balances: { yes: 0n, no: 0n },
    ...overrides,
  };
}

// A Hunch book like the fork suite's: asks 100 YES at 0.40 and 200 at 0.45, bids 100 at 0.35 and 300 at 0.30.
const lvl = (price: number, size: bigint): L2Level => ({ price: BigInt(price), size });

export function makeBook(overrides: Partial<BookSnapshot> = {}): BookSnapshot {
  return {
    address: "0x00000000000000000000000000000000000000bb",
    block: 68_000_000n,
    readAt: 1_799_000_000_000,
    asks: [lvl(400_000, USDC(100)), lvl(450_000, USDC(200))],
    bids: [lvl(350_000, USDC(100)), lvl(300_000, USDC(300))],
    params: {
      ...HUNCH_BOOK_PARAMS,
      tickSize: 1_000n,
      minSize: USDC(1),
      maxSize: USDC(5_000),
      base: "0x00000000000000000000000000000000000000c1",
      quote: "0x00000000000000000000000000000000000000ab",
    },
    state: BookState.Active,
    owned: null,
    ...overrides,
  };
}

export function makeBalances(overrides: Partial<WalletBalances> = {}): WalletBalances {
  return {
    usdc: USDC(1_000),
    yes: USDC(50),
    no: USDC(80),
    allowance: { usdcToRouter: 0n, usdcToVault: 0n, yesToRouter: 0n, noToRouter: 0n },
    ...overrides,
  };
}

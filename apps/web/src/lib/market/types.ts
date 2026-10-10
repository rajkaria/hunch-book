import type {
  GraduationRule,
  MarketCaps,
  Outcome,
  PerplFundingParams,
  Phase,
  PriceAtTimeParams,
  SnapshotParams,
  Venue,
  Window,
} from "@hunch-book/shared";
import type { Address, Hex } from "viem";

/** A market's params, decoded with the shared template decoders. */
export type DecodedParams =
  | { kind: "perpl-funding"; params: PerplFundingParams }
  | { kind: "price-at-time"; params: PriceAtTimeParams }
  | { kind: "snapshot"; params: SnapshotParams }
  | { kind: "unknown"; raw: Hex };

/**
 * The best bid and ask of the market's YES/USDC book (Kuru's or Hunch Book's own, both read through Kuru
 * v1's `bestBidAsk()`), in 1e18 price units. Null means that side is empty.
 */
export interface BookQuote {
  bid: bigint | null;
  ask: bigint | null;
}

/** Everything the app reads about one market in a single pass. */
export interface MarketView {
  address: Address;
  marketId: bigint;
  templateId: number;
  phase: Phase;
  outcome: Outcome;
  graduated: boolean;
  pool: { yes: bigint; no: bigint; total: bigint; stakers: number };
  window: Window;
  tokens: { yes: Address; no: Address };
  /** The YES/USDC book on the market's venue (`venue`), or null before one is set. */
  book: Address | null;
  resolver: Address;
  creator: Address;
  params: Hex;
  decoded: DecodedParams;
  rule: GraduationRule;
  caps: MarketCaps;
  evidenceHash: Hex;
  /** The resolver's own sentence for the rule, or null if the call failed. */
  description: string | null;
  /** The book's best bid/ask once graduated and a book is set. */
  quote: BookQuote | null;
  /** IMarket.graduationRuleMet(), ignoring book readiness and pauses. */
  ruleMet: boolean | null;
  /**
   * The deployment stack the market belongs to ("primary" or a name under `stacks`) and the Kuru
   * interface its book speaks. Absent means the primary stack on Kuru v1. The stack gives the market's
   * vault, router and periphery (lib/stacks.ts).
   */
  stack?: string;
  kuruVersion?: 1 | 2;
  /**
   * Where the book is: "hunch" for Hunch Book's own onchain order book (which speaks Kuru v1's
   * interface, so `kuruVersion` is 1), "kuru" for Kuru's. Absent means Kuru. lib/stacks.ts names it.
   */
  venue?: Venue;
  /**
   * Kuru v2 pools: whether GraduatorV2 has this market's book registered yet (only Kuru creates v2
   * books, so a pool can meet its rule before it can graduate). Absent elsewhere.
   */
  bookReady?: boolean;
}

/** The chain head, used for block-clock estimates and countdowns. */
export interface ChainClock {
  blockNumber: bigint;
  /** Unix seconds of the latest block. */
  timestamp: number;
  /** Average milliseconds per block, measured over recent blocks. */
  msPerBlock: number;
  /** True when msPerBlock was measured on chain, false when it is the chain's nominal block time. */
  measured: boolean;
}

export type ReadResult<T> = { status: "not-deployed" } | { status: "not-market" } | { status: "ok"; data: T };

/** One row of the connected wallet's portfolio. */
export interface PortfolioEntry {
  market: MarketView;
  stake: { yes: bigint; no: bigint };
  claimableTokens: { yes: bigint; no: bigint };
  claimablePool: { paid: bigint; fee: bigint };
  balances: { yes: bigint; no: bigint };
}

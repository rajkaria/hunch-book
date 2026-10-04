import type {
  GraduationRule,
  MarketCaps,
  Outcome,
  PerplFundingParams,
  Phase,
  PriceAtTimeParams,
  SnapshotParams,
  Window,
} from "@hunch-book/shared";
import type { Address, Hex } from "viem";

/** A market's params, decoded with the shared template decoders. */
export type DecodedParams =
  | { kind: "perpl-funding"; params: PerplFundingParams }
  | { kind: "price-at-time"; params: PriceAtTimeParams }
  | { kind: "snapshot"; params: SnapshotParams }
  | { kind: "unknown"; raw: Hex };

/** Kuru's best bid and ask for the YES/USDC book, in 1e18 price units. Null means that side is empty. */
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
  /** Kuru YES/USDC book, or null before one is set. */
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
  /** Kuru best bid/ask once graduated and a book is set. */
  quote: BookQuote | null;
  /** IMarket.graduationRuleMet(), ignoring book readiness and pauses. */
  ruleMet: boolean | null;
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

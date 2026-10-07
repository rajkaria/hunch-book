import { Outcome, Phase } from "@hunch-book/shared";
import type { Address, Hex } from "viem";
import { address, big, bigOrNull, hash } from "../indexer/parse";
import type { ProofResult } from "../indexer/queries";
import type { MarketView } from "../market/types";

// The proof page's figures (docs/ROADMAP.md, How we measure progress): one model, filled from the
// indexer when it is live, or from what the chain answers directly. A figure the chain alone cannot
// give (distinct wallets, all-time fills, timings across every market) is null, and the page says it
// needs the indexer instead of guessing.

export interface MarketCounts {
  /** factory.marketCount, or ProtocolStats.marketsCreated. */
  created: number;
  /** Markets that ever graduated. */
  graduated: number;
  settled: number;
  voided: number;
  /** Now: pools taking stakes or locked. */
  pools: number;
  /** Now: books trading or closed, waiting to settle. */
  trading: number;
  /** Markets the counts cover: all of them from the indexer, the newest ones from the chain. */
  covered: number;
}

export interface WalletCounts {
  total: number;
  ours: number;
  external: number;
  stakers: number;
  traders: number;
}

export interface TradeCounts {
  fills: number;
  fillsOurMaker: number;
  fillsOurTrader: number;
  fillsBetweenOthers: number;
  /** Kuru v2 swaps: they do not name their makers, so they count neither as ours nor as others'. */
  fillsMakerUnknown: number;
  volume: bigint;
  volumeOurMaker: bigint;
  volumeBetweenOthers: bigint;
  volumeMakerUnknown: bigint;
  /** Our maker's share of fills and of volume, basis points, among fills whose maker is known. */
  ourMakerShareBps: number;
  ourMakerVolumeShareBps: number;
  routerTrades: number;
  routerVolume: bigint;
}

export interface Timing {
  /** Window end to settlement, price markets, seconds. */
  avgSettleSeconds: bigint | null;
  settlementsTimed: number;
  /** Window end to settlement, Perpl markets, blocks. */
  avgSettleBlocks: bigint | null;
  settlementsBlockClock: number;
  earlySettlements: number;
  /** Settlement to first redemption, seconds. */
  avgFirstRedemptionSeconds: bigint | null;
  marketsRedeemed: number;
}

export interface SettlementTiming {
  market: Address;
  number: number | null;
  question: string | null;
  voided: boolean;
  outcome: "Yes" | "No" | null;
  early: boolean;
  /** Settlement minus close, in the market's clock: seconds or blocks. */
  latency: bigint | null;
  latencyUnit: "seconds" | "blocks";
  settledAt: number;
  block: bigint;
  tx: Hex;
  /** First redemption (or pool claim) minus settlement, seconds; null until someone redeems. */
  toFirstRedemption: bigint | null;
}

export interface MarketSolvency {
  market: Address;
  number: number | null;
  question: string | null;
  stage: string;
  /** What the vault still owes for this market: its pool plus its sets. */
  owed: bigint;
  pool: bigint;
  sets: bigint;
  /** Indexer only: USDC in and out of the vault for this market, and its fees. */
  collateralIn: bigint | null;
  collateralOut: bigint | null;
  fees: bigint | null;
  /** Indexer only: in − out − owed − fees. Zero when every event is accounted for. */
  margin: bigint | null;
  /** Chain only: YES and NO supply. */
  yesSupply: bigint | null;
  noSupply: bigint | null;
  /**
   * Chain only: for a graduated market before settlement, sets = YES supply = NO supply. Null where
   * that check does not apply (pools, settled markets).
   */
  backed: boolean | null;
}

export interface VaultBalance {
  /** USDC the vault holds. */
  balance: bigint;
  /** Pools, sets and fees not yet withdrawn. */
  obligations: bigint;
  /** balance − obligations. Never negative (PROTOCOL.md §5.1). */
  margin: bigint;
}

export interface DayRow {
  date: string;
  marketsCreated: number;
  stakes: number;
  fills: number;
  fillsOurMaker: number;
  fillsBetweenOthers: number;
  volume: bigint;
  activeWallets: number;
  activeOurWallets: number;
  newWallets: number;
}

export interface ProofData {
  markets: MarketCounts;
  /** Null: needs the indexer. */
  wallets: WalletCounts | null;
  trades: TradeCounts | null;
  timing: Timing | null;
  settlements: SettlementTiming[];
  /** The vault's books as the indexer replayed them, or as the chain answers now. */
  vault: VaultBalance | null;
  perMarket: MarketSolvency[];
  daily: DayRow[];
  /** Markets with a negative margin. Should always be empty. */
  negative: MarketSolvency[];
}

/** part / whole in basis points, rounded down; 0 with no whole. */
export function shareBps(part: bigint | number, whole: bigint | number): number {
  const p = BigInt(part);
  const w = BigInt(whole);
  return w === 0n ? 0 : Number((p * 10_000n) / w);
}

export function vaultBalance(balance: bigint, obligations: bigint): VaultBalance {
  return { balance, obligations, margin: balance - obligations };
}

const STAGE_LABEL: Record<string, string> = {
  Pool: "Pool",
  Graduated: "Trading",
  Settled: "Settled",
  Voided: "Voided",
};

/** Builds the page from the indexer's answer. */
export function proofFromIndexer(r: ProofResult): ProofData {
  const s = r.ProtocolStats_by_pk;
  const perMarket: MarketSolvency[] = r.Market.map((m) => ({
    market: address(m.id),
    number: m.number,
    question: m.question,
    stage: STAGE_LABEL[m.stage] ?? m.stage,
    owed: big(m.vaultPool) + big(m.vaultSets),
    pool: big(m.vaultPool),
    sets: big(m.vaultSets),
    collateralIn: big(m.collateralIn),
    collateralOut: big(m.collateralOut),
    fees: big(m.feesAccrued),
    margin: big(m.solvencyMargin),
    yesSupply: null,
    noSupply: null,
    backed: null,
  }));
  const settlements: SettlementTiming[] = r.Settlement.map((x) => {
    const blockClock = Boolean(x.market.blockClock);
    const firstRedemption = bigOrNull(x.market.firstRedemptionAt);
    return {
      market: address(x.market.id),
      number: x.market.number,
      question: x.market.question,
      voided: x.voided,
      outcome: x.voided ? null : x.outcome === "Yes" ? "Yes" : x.outcome === "No" ? "No" : null,
      early: x.early,
      latency: blockClock ? bigOrNull(x.latencyBlocks) : bigOrNull(x.latencySeconds),
      latencyUnit: blockClock ? "blocks" : "seconds",
      settledAt: Number(big(x.timestamp)),
      block: big(x.block),
      tx: hash(x.tx),
      toFirstRedemption: firstRedemption === null ? null : firstRedemption - big(x.timestamp),
    };
  });
  const daily: DayRow[] = r.DailyStats.map((d) => ({
    date: d.date,
    marketsCreated: d.marketsCreated,
    stakes: d.stakeCount,
    fills: d.fillCount,
    fillsOurMaker: d.fillCountOurMaker,
    fillsBetweenOthers: d.fillCountBetweenOthers,
    volume: big(d.volume),
    activeWallets: d.activeWallets,
    activeOurWallets: d.activeOurWallets,
    newWallets: d.newWallets,
  }));
  const base = {
    settlements,
    perMarket,
    daily,
    negative: perMarket.filter((m) => (m.margin ?? 0n) < 0n),
  };
  if (!s) {
    return {
      ...base,
      markets: { created: 0, graduated: 0, settled: 0, voided: 0, pools: 0, trading: 0, covered: 0 },
      wallets: null,
      trades: null,
      timing: null,
      vault: null,
    };
  }
  return {
    ...base,
    markets: {
      created: s.marketsCreated,
      graduated: s.marketsGraduatedTotal,
      settled: s.marketsSettled,
      voided: s.marketsVoided,
      pools: s.marketsPool,
      trading: s.marketsGraduated,
      covered: s.marketsCreated,
    },
    wallets: {
      total: s.wallets,
      ours: s.ourWallets,
      external: s.externalWallets,
      stakers: s.stakerWallets,
      traders: s.traderWallets,
    },
    trades: {
      fills: s.fillCount,
      fillsOurMaker: s.fillCountOurMaker,
      fillsOurTrader: s.fillCountOurTrader,
      fillsBetweenOthers: s.fillCountBetweenOthers,
      fillsMakerUnknown: s.fillCountMakerUnknown ?? 0,
      volume: big(s.volume),
      volumeOurMaker: big(s.volumeOurMaker),
      volumeBetweenOthers: big(s.volumeBetweenOthers),
      volumeMakerUnknown: big(s.volumeMakerUnknown ?? "0"),
      ourMakerShareBps: s.ourMakerShareBps,
      ourMakerVolumeShareBps: s.ourMakerVolumeShareBps,
      routerTrades: s.routerTradeCount,
      routerVolume: big(s.routerVolume),
    },
    timing: {
      avgSettleSeconds: bigOrNull(s.avgSettlementLatencySeconds),
      settlementsTimed: s.settlementsTimed,
      avgSettleBlocks: bigOrNull(s.avgSettlementLatencyBlocks),
      settlementsBlockClock: s.settlementsBlockClock,
      earlySettlements: s.earlySettlements,
      avgFirstRedemptionSeconds: bigOrNull(s.avgSecondsToFirstRedemption),
      marketsRedeemed: s.marketsRedeemed,
    },
    vault: vaultBalance(big(s.vaultUsdcBalance), big(s.vaultObligations)),
  };
}

/** Counts by phase over the markets the chain listed. */
export function countMarkets(total: number, markets: readonly MarketView[]): MarketCounts {
  let graduated = 0;
  let settled = 0;
  let voided = 0;
  let pools = 0;
  let trading = 0;
  for (const m of markets) {
    if (m.graduated) graduated++;
    if (m.phase === Phase.Settled) settled++;
    if (m.phase === Phase.Voided) voided++;
    if (m.phase === Phase.Pool || m.phase === Phase.PoolLocked) pools++;
    if (m.phase === Phase.Graduated || m.phase === Phase.Closed) trading++;
  }
  return { created: total, graduated, settled, voided, pools, trading, covered: markets.length };
}

export interface LedgerRead {
  pool: bigint;
  sets: bigint;
}

const PHASE_STAGE: Record<number, string> = {
  [Phase.Pool]: "Pool",
  [Phase.PoolLocked]: "Pool locked",
  [Phase.Graduated]: "Trading",
  [Phase.Closed]: "Closed",
  [Phase.Settled]: "Settled",
  [Phase.Voided]: "Voided",
};

/**
 * One market's backing from chain reads: what the vault owes it, and for a graduated market that has
 * not settled, whether its sets equal both token supplies (each set is one YES, one NO and one USDC).
 */
export function marketBacking(
  m: Pick<MarketView, "address" | "marketId" | "description" | "phase" | "graduated" | "outcome">,
  ledger: LedgerRead | null,
  supply: { yes: bigint; no: bigint } | null,
): MarketSolvency {
  const pool = ledger?.pool ?? 0n;
  const sets = ledger?.sets ?? 0n;
  const open = m.phase === Phase.Graduated || m.phase === Phase.Closed;
  const stage =
    m.phase === Phase.Settled
      ? m.outcome === Outcome.No
        ? "Settled NO"
        : "Settled YES"
      : (PHASE_STAGE[m.phase] ?? "Unknown");
  return {
    market: m.address,
    number: Number(m.marketId),
    question: m.description,
    stage,
    owed: pool + sets,
    pool,
    sets,
    collateralIn: null,
    collateralOut: null,
    fees: null,
    margin: null,
    yesSupply: supply?.yes ?? null,
    noSupply: supply?.no ?? null,
    backed:
      m.graduated && open && ledger && supply
        ? ledger.sets === supply.yes && ledger.sets === supply.no
        : null,
  };
}

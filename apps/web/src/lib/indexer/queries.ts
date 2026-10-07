// The app's GraphQL queries against the indexer (indexer/schema.graphql; Hasura over Envio). They follow
// the examples in indexer/queries/, and a test checks that each one selects and filters only fields the
// schema has. Hasura returns BigInt fields as strings and Int fields as numbers; ids are lowercase.

/** A BigInt field as Hasura returns it. */
export type BigIntString = string;

// ---------- proof page ----------

export const PROOF_QUERY = /* GraphQL */ `
  query Proof($chainId: String!, $chain: Int!, $days: Int!, $markets: Int!, $settlements: Int!) {
    ProtocolStats_by_pk(id: $chainId) {
      marketsCreated
      marketsPool
      marketsGraduated
      marketsSettled
      marketsVoided
      marketsGraduatedTotal
      wallets
      ourWallets
      externalWallets
      stakerWallets
      traderWallets
      stakeCount
      stakedUsdc
      stakeCountOurs
      stakedUsdcOurs
      fillCount
      fillCountOurMaker
      fillCountOurTrader
      fillCountBetweenOthers
      fillCountMakerUnknown
      volume
      volumeOurMaker
      volumeBetweenOthers
      volumeMakerUnknown
      ourMakerShareBps
      ourMakerVolumeShareBps
      routerTradeCount
      routerVolume
      settlementsTimed
      avgSettlementLatencySeconds
      settlementsBlockClock
      avgSettlementLatencyBlocks
      earlySettlements
      redemptionCount
      redeemedUsdc
      marketsRedeemed
      avgSecondsToFirstRedemption
      vaultObligations
      vaultUsdcBalance
      solvencyMargin
      updatedAt
      updatedAtBlock
    }
    DailyStats(where: { chainId: { _eq: $chain } }, order_by: { date: desc }, limit: $days) {
      date
      marketsCreated
      stakeCount
      fillCount
      fillCountOurMaker
      fillCountBetweenOthers
      volume
      volumeOurMaker
      activeWallets
      activeOurWallets
      newWallets
    }
    Market(order_by: { number: desc }, limit: $markets) {
      id
      number
      question
      stage
      outcome
      graduated
      creatorIsOurs
      collateralIn
      collateralOut
      vaultPool
      vaultSets
      feesAccrued
      solvencyMargin
      fillCount
      fillCountOurMaker
      volume
      createdTx
    }
    Settlement(order_by: { block: desc }, limit: $settlements) {
      id
      voided
      outcome
      early
      graduated
      latencySeconds
      latencyBlocks
      settlerIsOurs
      block
      timestamp
      tx
      market {
        id
        number
        question
        blockClock
        closeAt
        firstRedemptionAt
        redemptionCount
      }
    }
  }
`;

export interface ProofStatsRow {
  marketsCreated: number;
  marketsPool: number;
  marketsGraduated: number;
  marketsSettled: number;
  marketsVoided: number;
  marketsGraduatedTotal: number;
  wallets: number;
  ourWallets: number;
  externalWallets: number;
  stakerWallets: number;
  traderWallets: number;
  stakeCount: number;
  stakedUsdc: BigIntString;
  stakeCountOurs: number;
  stakedUsdcOurs: BigIntString;
  fillCount: number;
  fillCountOurMaker: number;
  fillCountOurTrader: number;
  fillCountBetweenOthers: number;
  /** Kuru v2 swaps, whose makers are unknown. */
  fillCountMakerUnknown: number;
  volume: BigIntString;
  volumeOurMaker: BigIntString;
  volumeBetweenOthers: BigIntString;
  volumeMakerUnknown: BigIntString;
  /** Among fills whose maker is known. */
  ourMakerShareBps: number;
  ourMakerVolumeShareBps: number;
  routerTradeCount: number;
  routerVolume: BigIntString;
  settlementsTimed: number;
  avgSettlementLatencySeconds: BigIntString | null;
  settlementsBlockClock: number;
  avgSettlementLatencyBlocks: BigIntString | null;
  earlySettlements: number;
  redemptionCount: number;
  redeemedUsdc: BigIntString;
  marketsRedeemed: number;
  avgSecondsToFirstRedemption: BigIntString | null;
  vaultObligations: BigIntString;
  vaultUsdcBalance: BigIntString;
  solvencyMargin: BigIntString;
  updatedAt: BigIntString;
  updatedAtBlock: BigIntString;
}

export interface DailyStatsRow {
  date: string;
  marketsCreated: number;
  stakeCount: number;
  fillCount: number;
  fillCountOurMaker: number;
  fillCountBetweenOthers: number;
  volume: BigIntString;
  volumeOurMaker: BigIntString;
  activeWallets: number;
  activeOurWallets: number;
  newWallets: number;
}

export interface ProofMarketRow {
  id: string;
  number: number;
  question: string | null;
  stage: "Pool" | "Graduated" | "Settled" | "Voided";
  outcome: "Unresolved" | "Yes" | "No";
  graduated: boolean;
  creatorIsOurs: boolean;
  collateralIn: BigIntString;
  collateralOut: BigIntString;
  vaultPool: BigIntString;
  vaultSets: BigIntString;
  feesAccrued: BigIntString;
  solvencyMargin: BigIntString;
  fillCount: number;
  fillCountOurMaker: number;
  volume: BigIntString;
  createdTx: string;
}

export interface SettlementRow {
  id: string;
  voided: boolean;
  outcome: "Unresolved" | "Yes" | "No";
  early: boolean;
  graduated: boolean;
  latencySeconds: BigIntString | null;
  latencyBlocks: BigIntString | null;
  settlerIsOurs: boolean;
  block: BigIntString;
  timestamp: BigIntString;
  tx: string;
  market: {
    id: string;
    number: number;
    question: string | null;
    blockClock: boolean | null;
    closeAt: BigIntString | null;
    firstRedemptionAt: BigIntString | null;
    redemptionCount: number;
  };
}

export interface ProofResult {
  ProtocolStats_by_pk: ProofStatsRow | null;
  DailyStats: DailyStatsRow[];
  Market: ProofMarketRow[];
  Settlement: SettlementRow[];
}

// ---------- trade tape ----------

export const TAPE_QUERY = /* GraphQL */ `
  query Tape($where: Trade_bool_exp!, $limit: Int!) {
    Trade(where: $where, order_by: [{ block: desc }, { logIndex: desc }], limit: $limit) {
      id
      block
      timestamp
      tx
      logIndex
      priceE6
      size
      notional
      takerBuysYes
      maker
      makerKnown
      taker
      trader
      viaRouter
      isOurMaker
      makerIsOurs
      traderIsOurs
      betweenOthers
      book {
        id
      }
      market {
        id
        number
        question
      }
    }
  }
`;

export interface TradeRow {
  id: string;
  block: BigIntString;
  timestamp: BigIntString;
  tx: string;
  logIndex: number;
  priceE6: BigIntString;
  size: BigIntString;
  notional: BigIntString;
  takerBuysYes: boolean;
  maker: string;
  /** False on Kuru v2 swaps (maker is then the zero address). Absent from indexers older than the field. */
  makerKnown?: boolean;
  taker: string;
  trader: string;
  viaRouter: boolean;
  isOurMaker: boolean;
  makerIsOurs: boolean;
  traderIsOurs: boolean;
  betweenOthers: boolean;
  book: { id: string };
  market: { id: string; number: number; question: string | null };
}

// ---------- portfolio history ----------

/** One entity of a wallet's history: its root field, filter and selection. */
export interface HistoryEntity {
  key: HistoryKey;
  root: string;
  /** The `where` literal, with $wallet for the lowercase address. */
  where: string;
  fields: string;
}

export type HistoryKey =
  | "stakes"
  | "claims"
  | "payouts"
  | "routerTrades"
  | "setFlows"
  | "redemptions"
  | "makerFills"
  | "takerFills";

const MARKET_REF = "market { id }";

export const HISTORY_ENTITIES: readonly HistoryEntity[] = [
  {
    key: "stakes",
    root: "Stake",
    where: "{ wallet_id: { _eq: $wallet } }",
    fields: `id side amount block timestamp tx ${MARKET_REF}`,
  },
  {
    key: "claims",
    root: "TokenClaim",
    where: "{ wallet_id: { _eq: $wallet } }",
    fields: `id side amount block timestamp tx ${MARKET_REF}`,
  },
  {
    key: "payouts",
    root: "PoolPayout",
    where: "{ wallet_id: { _eq: $wallet } }",
    fields: `id kind paid fee block timestamp tx ${MARKET_REF}`,
  },
  {
    key: "routerTrades",
    root: "RouterTrade",
    where: "{ user_id: { _eq: $wallet } }",
    fields: `id kind usdc tokens priceE6 block timestamp tx ${MARKET_REF}`,
  },
  {
    key: "setFlows",
    root: "SetFlow",
    where: "{ account: { _eq: $wallet }, viaRouter: { _eq: false } }",
    fields: `id kind amount block timestamp tx ${MARKET_REF}`,
  },
  {
    key: "redemptions",
    root: "Redemption",
    where: "{ wallet_id: { _eq: $wallet } }",
    fields: `id side amount paid fee voided block timestamp tx ${MARKET_REF}`,
  },
  {
    key: "makerFills",
    root: "Trade",
    where: "{ maker: { _eq: $wallet } }",
    fields: `id takerBuysYes size notional priceE6 block timestamp tx ${MARKET_REF}`,
  },
  {
    key: "takerFills",
    root: "Trade",
    where: "{ trader: { _eq: $wallet }, viaRouter: { _eq: false } }",
    fields: `id takerBuysYes size notional priceE6 block timestamp tx ${MARKET_REF}`,
  },
];

/** Rows per entity per request. */
export const HISTORY_PAGE = 1000;

/** One query for every history entity at once (aliased by key), or for one entity from an offset. */
export function historyQuery(entities: readonly HistoryEntity[] = HISTORY_ENTITIES): string {
  const parts = entities.map(
    (e) =>
      `${e.key}: ${e.root}(where: ${e.where}, order_by: { block: asc }, limit: $limit, offset: $offset) { ${e.fields} }`,
  );
  return `query History($wallet: String!, $limit: Int!, $offset: Int!) { ${parts.join(" ")} }`;
}

export const POSITIONS_QUERY = /* GraphQL */ `
  query Positions($wallet: String!) {
    Position(where: { wallet_id: { _eq: $wallet } }) {
      id
      yesBalance
      noBalance
      market {
        id
      }
    }
  }
`;

interface Base {
  id: string;
  block: BigIntString;
  timestamp: BigIntString;
  tx: string;
  market: { id: string };
}

export interface StakeRow extends Base {
  side: "Yes" | "No";
  amount: BigIntString;
}
export interface ClaimRow extends Base {
  side: "Yes" | "No";
  amount: BigIntString;
}
export interface PayoutRow extends Base {
  kind: "Winnings" | "Refund" | "Dust";
  paid: BigIntString;
  fee: BigIntString;
}
export interface RouterTradeRow extends Base {
  kind: "BuyYes" | "SellYes" | "BuyNo" | "SellNo";
  usdc: BigIntString;
  tokens: BigIntString;
  priceE6: BigIntString;
}
export interface SetFlowRow extends Base {
  kind: "Mint" | "Merge";
  amount: BigIntString;
}
export interface RedemptionRow extends Base {
  side: "Yes" | "No";
  amount: BigIntString;
  paid: BigIntString;
  fee: BigIntString;
  voided: boolean;
}
export interface FillRow extends Base {
  takerBuysYes: boolean;
  size: BigIntString;
  notional: BigIntString;
  priceE6: BigIntString;
}

export interface HistoryResult {
  stakes: StakeRow[];
  claims: ClaimRow[];
  payouts: PayoutRow[];
  routerTrades: RouterTradeRow[];
  setFlows: SetFlowRow[];
  redemptions: RedemptionRow[];
  makerFills: FillRow[];
  takerFills: FillRow[];
}

export interface PositionRow {
  id: string;
  yesBalance: BigIntString;
  noBalance: BigIntString;
  market: { id: string };
}

// ---------- creator page ----------

export const CREATOR_QUERY = /* GraphQL */ `
  query Creator($id: String!, $limit: Int!) {
    Creator_by_pk(id: $id) {
      id
      isOurs
      marketCount
      feesAccrued
      feesWithdrawn
      feesOwed
    }
    Market(where: { creator_id: { _eq: $id } }, order_by: { number: desc }, limit: $limit) {
      id
      number
      question
      stage
      outcome
      graduated
      poolTotal
      stakerCount
      volume
      fillCount
      routerVolume
      createdAt
      createdTx
    }
    withdrawals: VaultEvent(
      where: { kind: { _eq: "CreatorFeeWithdrawal" }, account: { _eq: $id } }
      order_by: { block: desc }
      limit: $limit
    ) {
      id
      amount
      block
      timestamp
      tx
    }
    accruals: VaultEvent(
      where: { kind: { _eq: "FeeAccrual" }, account: { _eq: $id } }
      order_by: { block: desc }
      limit: $limit
    ) {
      id
      amount
      block
      timestamp
      tx
      market {
        id
        number
      }
    }
  }
`;

export interface CreatorRow {
  id: string;
  isOurs: boolean;
  marketCount: number;
  feesAccrued: BigIntString;
  feesWithdrawn: BigIntString;
  feesOwed: BigIntString;
}

export interface CreatorMarketRow {
  id: string;
  number: number;
  question: string | null;
  stage: "Pool" | "Graduated" | "Settled" | "Voided";
  outcome: "Unresolved" | "Yes" | "No";
  graduated: boolean;
  poolTotal: BigIntString;
  stakerCount: number;
  volume: BigIntString;
  fillCount: number;
  routerVolume: BigIntString;
  createdAt: BigIntString;
  createdTx: string;
}

export interface VaultEventRow {
  id: string;
  amount: BigIntString;
  block: BigIntString;
  timestamp: BigIntString;
  tx: string;
  market?: { id: string; number: number } | null;
}

export interface CreatorResult {
  Creator_by_pk: CreatorRow | null;
  Market: CreatorMarketRow[];
  withdrawals: VaultEventRow[];
  accruals: VaultEventRow[];
}

/** Every query the app sends, for the schema test. */
export const ALL_QUERIES: Record<string, string> = {
  proof: PROOF_QUERY,
  tape: TAPE_QUERY,
  history: historyQuery(),
  historyOne: historyQuery([HISTORY_ENTITIES[0] as HistoryEntity]),
  positions: POSITIONS_QUERY,
  creator: CREATOR_QUERY,
};

/** The file these queries live in, linked as the source of every figure that comes from the indexer. */
export const QUERIES_PATH = "apps/web/src/lib/indexer/queries.ts";

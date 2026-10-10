import type {
  Book,
  Creator,
  DailyStats,
  Entity,
  EntityName,
  Enum,
  EvmOnEventContext,
  Market,
  Position,
  ProtocolStats,
  RewardEpoch,
  RewardToken,
  Stack,
  Staker,
  Wallet,
} from "envio";
import { average, impliedChanceBps, marketSolvencyMargin, shareBps, utcDay } from "./math.js";
import { addr, type StackConstants, stackNamed, stackOfContract, staticRoleOf, venueOf } from "./network.js";

/** Entities read from the context are frozen; handlers work on mutable copies and write them once. */
export type Mut<T> = { -readonly [K in keyof T]: T[K] };

type Row = { id: string };
type EntityOps = { get(id: string): Promise<Row | undefined>; set(row: Row): void };

/** The parts of an Envio event every handler reads. */
export interface EventLike {
  chainId: number;
  logIndex: number;
  srcAddress: string;
  block: { number: number; timestamp: number };
  transaction: { hash: string; from: string | undefined };
}

/** Where and when an event happened, in the units the schema stores. */
export interface EventMeta {
  /** "<block>-<logIndex>": unique per chain, the id of every per-event record. */
  id: string;
  chainId: number;
  block: bigint;
  timestamp: bigint;
  tx: string;
  /** The transaction sender. */
  from: string;
  logIndex: number;
  src: string;
  date: string;
  dayStart: bigint;
}

export function metaOf(event: EventLike): EventMeta {
  const timestamp = BigInt(event.block.timestamp);
  const { date, dayStart } = utcDay(timestamp);
  return {
    id: `${event.block.number}-${event.logIndex}`,
    chainId: event.chainId,
    block: BigInt(event.block.number),
    timestamp,
    tx: event.transaction.hash,
    from: addr(event.transaction.from ?? "0x"),
    logIndex: event.logIndex,
    src: addr(event.srcAddress),
    date,
    dayStart,
  };
}

export const pairId = (market: string, wallet: string): string => `${addr(market)}-${addr(wallet)}`;

/**
 * One handler run: loads each entity at most once, hands out mutable copies, and writes every
 * loaded or created entity back in `flush()`. Derived fields (shares, averages, solvency) are
 * recomputed on flush, so handlers only move raw counters.
 */
export class Unit {
  readonly m: EventMeta;
  private readonly rows = new Map<string, { name: EntityName; row: Row }>();

  constructor(
    private readonly context: EvmOnEventContext,
    event: EventLike,
  ) {
    this.m = metaOf(event);
  }

  /**
   * A Unit for this event, or undefined if `record` already holds an entity with this event's id:
   * the event was processed before, so the handler must not count it again.
   */
  static async start(
    context: EvmOnEventContext,
    event: EventLike,
    record: EntityName,
  ): Promise<Unit | undefined> {
    const u = new Unit(context, event);
    return (await u.exists(record, u.m.id)) ? undefined : u;
  }

  get log() {
    return this.context.log;
  }

  private ops(name: EntityName): EntityOps {
    return (this.context as unknown as Record<string, EntityOps>)[name] as EntityOps;
  }

  /** The entity if it exists (from this run's cache first). */
  async find<N extends EntityName>(name: N, id: string): Promise<Mut<Entity<N>> | undefined> {
    const key = `${name}:${id}`;
    const cached = this.rows.get(key);
    if (cached) return cached.row as unknown as Mut<Entity<N>>;
    const stored = await this.ops(name).get(id);
    if (!stored) return undefined;
    const row = { ...stored };
    this.rows.set(key, { name, row });
    return row as unknown as Mut<Entity<N>>;
  }

  /** True if a record with this id exists: the guard that makes every handler idempotent. */
  async exists(name: EntityName, id: string): Promise<boolean> {
    return (await this.ops(name).get(id)) !== undefined;
  }

  /** The entity, or a new one built by `make` (written on flush). */
  async load<N extends EntityName>(name: N, id: string, make: () => Entity<N>): Promise<Mut<Entity<N>>> {
    const found = await this.find(name, id);
    if (found) return found;
    return this.create(name, make());
  }

  create<N extends EntityName>(name: N, entity: Entity<N>): Mut<Entity<N>> {
    const row = { ...(entity as unknown as Row) };
    this.rows.set(`${name}:${row.id}`, { name, row });
    return row as unknown as Mut<Entity<N>>;
  }

  /**
   * The nearest earlier record of `name` in this transaction, looking back at most `logs` log indexes,
   * that `match` accepts. Per-event records are keyed "<block>-<logIndex>", so this finds the record a
   * contract call left just before the event being handled (the vault's Redeemed before AutoRedeemed,
   * the router's Trade before OrderExecuted).
   */
  async findBack<N extends EntityName>(
    name: N,
    logs: number,
    match: (row: Mut<Entity<N>>) => boolean,
  ): Promise<Mut<Entity<N>> | undefined> {
    for (let i = this.m.logIndex - 1; i >= Math.max(0, this.m.logIndex - logs); i--) {
      const row = await this.find(name, `${this.m.block}-${i}`);
      if (row && (row as unknown as { tx: string }).tx === this.m.tx && match(row)) return row;
    }
    return undefined;
  }

  // ---- well-known entities ----

  stats(): Promise<Mut<ProtocolStats>> {
    return this.load("ProtocolStats", String(this.m.chainId), () => emptyStats(this.m));
  }

  daily(): Promise<Mut<DailyStats>> {
    return this.load("DailyStats", `${this.m.chainId}-${this.m.date}`, () => emptyDaily(this.m));
  }

  wallet(address: string): Promise<Mut<Wallet>> {
    const id = addr(address);
    return this.load("Wallet", id, () => emptyWallet(id, this.m));
  }

  market(id: string): Promise<Mut<Market> | undefined> {
    return this.find("Market", addr(id));
  }

  /** The stack this event's contract belongs to (the primary one for any other contract). */
  stackConstants(): StackConstants {
    return stackOfContract(this.m.chainId, this.m.src) ?? stackNamed(this.m.chainId, "primary");
  }

  /** The Stack record of the stack called `name`, created at its first use. */
  stack(name: string): Promise<Mut<Stack>> {
    const c = stackNamed(this.m.chainId, name);
    return this.load("Stack", `${this.m.chainId}-${c.name}`, () => ({
      id: `${this.m.chainId}-${c.name}`,
      chainId: this.m.chainId,
      name: c.name,
      primary: c.primary,
      kuruVersion: c.kuruVersion,
      venue: venueOf(c),
      factory: c.factory ?? "",
      marketsCreated: 0,
    }));
  }

  async position(market: string, wallet: string): Promise<Mut<Position>> {
    await this.wallet(wallet);
    return this.load("Position", pairId(market, wallet), () => emptyPosition(market, wallet, this.m));
  }

  async staker(market: string, wallet: string): Promise<Mut<Staker>> {
    await this.wallet(wallet);
    return this.load("Staker", pairId(market, wallet), () => emptyStaker(market, wallet, this.m));
  }

  creator(address: string): Promise<Mut<Creator>> {
    const id = addr(address);
    return this.load("Creator", id, () => ({
      id,
      isOurs: staticRoleOf(this.m.chainId, id) !== "None",
      marketCount: 0,
      feesAccrued: 0n,
      feesWithdrawn: 0n,
      feesOwed: 0n,
    }));
  }

  /** Whether an address is one of ours, without creating a Wallet for it. */
  async isOurs(address: string): Promise<boolean> {
    const wallet = await this.find("Wallet", addr(address));
    return wallet ? wallet.isOurs : staticRoleOf(this.m.chainId, address) !== "None";
  }

  // ---- counting wallets ----

  /** Records that a wallet staked or traded now: distinct-wallet counts, overall and per day. */
  async participate(wallet: Mut<Wallet>, kind: "stake" | "trade"): Promise<void> {
    const s = await this.stats();
    const d = await this.daily();
    if (!wallet.participant) {
      wallet.participant = true;
      wallet.firstActiveAt = this.m.timestamp;
      s.wallets += 1;
      if (wallet.isOurs) s.ourWallets += 1;
      d.newWallets += 1;
    }
    if (kind === "stake" && !wallet.staked) {
      wallet.staked = true;
      s.stakerWallets += 1;
    }
    if (kind === "trade" && !wallet.traded) {
      wallet.traded = true;
      s.traderWallets += 1;
    }
    wallet.lastActiveAt = this.m.timestamp;
    const dayId = `${this.m.date}-${wallet.id}`;
    if (!(await this.find("WalletDay", dayId))) {
      this.create("WalletDay", { id: dayId, date: this.m.date, wallet: wallet.id });
      d.activeWallets += 1;
      if (wallet.isOurs) d.activeOurWallets += 1;
    }
  }

  /** Labels a wallet as ours (a seeded wallet) and moves it between the counts. */
  async markOurs(wallet: Mut<Wallet>, role: Enum<"OurRole">): Promise<void> {
    if (wallet.isOurs) return;
    wallet.ourRole = role;
    wallet.isOurs = true;
    if (wallet.participant) (await this.stats()).ourWallets += 1;
    if (await this.find("WalletDay", `${this.m.date}-${wallet.id}`))
      (await this.daily()).activeOurWallets += 1;
  }

  /** Moves a market to a new stage and keeps the per-stage counts in step. */
  async setStage(market: Mut<Market>, stage: Enum<"MarketStage">): Promise<void> {
    if (market.stage === stage) return;
    const s = await this.stats();
    const counter = {
      Pool: "marketsPool",
      Graduated: "marketsGraduated",
      Settled: "marketsSettled",
      Voided: "marketsVoided",
    } as const;
    s[counter[market.stage]] -= 1;
    s[counter[stage]] += 1;
    market.stage = stage;
  }

  /** Writes every entity this run touched, after recomputing derived fields. */
  flush(): void {
    for (const { name, row } of this.rows.values()) {
      if (name === "ProtocolStats") refreshStats(row as unknown as Mut<ProtocolStats>, this.m);
      if (name === "Market") refreshMarket(row as unknown as Mut<Market>);
      if (name === "Creator") {
        const c = row as unknown as Mut<Creator>;
        c.feesOwed = c.feesAccrued - c.feesWithdrawn;
      }
      if (name === "RewardEpoch") {
        const e = row as unknown as Mut<RewardEpoch>;
        e.outstanding = e.total - e.claimed - e.sweptAmount;
      }
      if (name === "RewardToken") {
        const t = row as unknown as Mut<RewardToken>;
        t.outstanding = t.funded - t.claimed - t.swept;
      }
      this.ops(name).set({ ...row });
    }
    this.rows.clear();
  }
}

// ---- derived fields ----

export function refreshStats(s: Mut<ProtocolStats>, m: Pick<EventMeta, "timestamp" | "block">): void {
  s.externalWallets = s.wallets - s.ourWallets;
  // Among fills whose maker is known: a Kuru v2 swap does not name its makers.
  s.ourMakerShareBps = shareBps(BigInt(s.fillCountOurMaker), BigInt(s.fillCount - s.fillCountMakerUnknown));
  s.ourMakerVolumeShareBps = shareBps(s.volumeOurMaker, s.volume - s.volumeMakerUnknown);
  s.avgSettlementLatencySeconds = average(s.settlementLatencySecondsTotal, s.settlementsTimed);
  s.avgSettlementLatencyBlocks = average(s.settlementLatencyBlocksTotal, s.settlementsBlockClock);
  s.avgSecondsToFirstRedemption = average(s.firstRedemptionLatencySecondsTotal, s.marketsRedeemed);
  s.vaultFeesOwed =
    s.protocolFeesAccrued + s.creatorFeesAccrued - s.protocolFeesWithdrawn - s.creatorFeesWithdrawn;
  s.vaultObligations = s.vaultPool + s.vaultSets + s.vaultFeesOwed;
  s.vaultUsdcBalance = s.vaultUsdcIn - s.vaultUsdcOut;
  s.solvencyMargin = s.vaultUsdcBalance - s.vaultObligations;
  s.updatedAt = m.timestamp;
  s.updatedAtBlock = m.block;
}

export function refreshMarket(market: Mut<Market>): void {
  market.poolTotal = market.yesTotal + market.noTotal;
  market.impliedChanceBps = impliedChanceBps(market.yesTotal, market.noTotal);
  market.solvencyMargin = marketSolvencyMargin(market);
}

// ---- empty entities ----

export function emptyStats(m: Pick<EventMeta, "chainId" | "timestamp" | "block">): ProtocolStats {
  return {
    id: String(m.chainId),
    chainId: m.chainId,
    marketsCreated: 0,
    marketsPool: 0,
    marketsGraduated: 0,
    marketsSettled: 0,
    marketsVoided: 0,
    marketsGraduatedTotal: 0,
    wallets: 0,
    ourWallets: 0,
    externalWallets: 0,
    stakerWallets: 0,
    traderWallets: 0,
    stakeCount: 0,
    stakedUsdc: 0n,
    stakeCountOurs: 0,
    stakedUsdcOurs: 0n,
    fillCount: 0,
    fillCountOurMaker: 0,
    fillCountOurTrader: 0,
    fillCountBetweenOthers: 0,
    fillCountMakerUnknown: 0,
    volume: 0n,
    volumeOurMaker: 0n,
    volumeBetweenOthers: 0n,
    volumeMakerUnknown: 0n,
    ourMakerShareBps: 0,
    ourMakerVolumeShareBps: 0,
    routerTradeCount: 0,
    routerVolume: 0n,
    orderCount: 0,
    orderCountOurMaker: 0,
    settlementsTimed: 0,
    settlementLatencySecondsTotal: 0n,
    avgSettlementLatencySeconds: undefined,
    settlementsBlockClock: 0,
    settlementLatencyBlocksTotal: 0n,
    avgSettlementLatencyBlocks: undefined,
    earlySettlements: 0,
    redemptionCount: 0,
    redeemedTokens: 0n,
    redeemedUsdc: 0n,
    redemptionFees: 0n,
    marketsRedeemed: 0,
    firstRedemptionLatencySecondsTotal: 0n,
    avgSecondsToFirstRedemption: undefined,
    poolPayoutCount: 0,
    poolPaidOut: 0n,
    poolFees: 0n,
    setsMinted: 0n,
    setsMerged: 0n,
    flashLoanCount: 0,
    flashLoanVolume: 0n,
    protocolFeesAccrued: 0n,
    protocolFeesWithdrawn: 0n,
    creatorFeesAccrued: 0n,
    creatorFeesWithdrawn: 0n,
    vaultPool: 0n,
    vaultSets: 0n,
    vaultFeesOwed: 0n,
    vaultObligations: 0n,
    vaultUsdcIn: 0n,
    vaultUsdcOut: 0n,
    vaultUsdcBalance: 0n,
    solvencyMargin: 0n,
    snapshotsTaken: 0,
    snapshotsTakenOurs: 0,
    autoRedeemHolders: 0,
    autoRedemptionCount: 0,
    autoRedeemedUsdc: 0n,
    autoRedemptionCountOurCaller: 0,
    autoRedeemFailures: 0,
    conditionalOrdersPlaced: 0,
    conditionalOrdersOpen: 0,
    conditionalOrdersExecuted: 0,
    conditionalOrdersCancelled: 0,
    conditionalOrdersExecutedByUs: 0,
    referralBindings: 0,
    referralBindingsRelayedByUs: 0,
    referrers: 0,
    referredFeeCount: 0,
    referredFees: 0n,
    referredProtocolShare: 0n,
    rewardEpochs: 0,
    rewardClaimCount: 0,
    oraclePokes: 0,
    oraclePokesOurs: 0,
    oracleCheckpoints: 0,
    priceAdapters: 0,
    timelockQueued: 0,
    timelockExecuted: 0,
    timelockCancelled: 0,
    timelockPending: 0,
    updatedAt: m.timestamp,
    updatedAtBlock: m.block,
  };
}

export function emptyDaily(m: Pick<EventMeta, "chainId" | "date" | "dayStart">): DailyStats {
  return {
    id: `${m.chainId}-${m.date}`,
    chainId: m.chainId,
    date: m.date,
    dayStart: m.dayStart,
    marketsCreated: 0,
    marketsGraduated: 0,
    marketsSettled: 0,
    marketsVoided: 0,
    stakeCount: 0,
    stakedUsdc: 0n,
    fillCount: 0,
    fillCountOurMaker: 0,
    fillCountBetweenOthers: 0,
    fillCountMakerUnknown: 0,
    volume: 0n,
    volumeOurMaker: 0n,
    routerTradeCount: 0,
    routerVolume: 0n,
    redemptionCount: 0,
    redeemedUsdc: 0n,
    activeWallets: 0,
    activeOurWallets: 0,
    newWallets: 0,
    vaultUsdcIn: 0n,
    vaultUsdcOut: 0n,
    snapshotsTaken: 0,
    autoRedemptionCount: 0,
    autoRedeemedUsdc: 0n,
    conditionalOrdersPlaced: 0,
    conditionalOrdersExecuted: 0,
    conditionalOrdersCancelled: 0,
    referralBindings: 0,
    referredFeeCount: 0,
    referredProtocolShare: 0n,
    rewardClaimCount: 0,
    oraclePokes: 0,
    oraclePokesOurs: 0,
  };
}

export function emptyWallet(id: string, m: Pick<EventMeta, "chainId" | "timestamp" | "block">): Wallet {
  const ourRole = staticRoleOf(m.chainId, id);
  return {
    id,
    ourRole,
    isOurs: ourRole !== "None",
    participant: false,
    staked: false,
    traded: false,
    firstSeenAt: m.timestamp,
    firstSeenAtBlock: m.block,
    firstActiveAt: undefined,
    lastActiveAt: undefined,
    stakeCount: 0,
    stakedUsdc: 0n,
    fillCount: 0,
    fillVolume: 0n,
    routerTradeCount: 0,
    routerVolume: 0n,
    marketsCreated: 0,
    redemptionCount: 0,
    redeemedUsdc: 0n,
    referral_id: undefined,
  };
}

export function emptyPosition(market: string, wallet: string, m: Pick<EventMeta, "timestamp">): Position {
  return {
    id: pairId(market, wallet),
    market_id: addr(market),
    wallet_id: addr(wallet),
    yesBalance: 0n,
    noBalance: 0n,
    yesStaked: 0n,
    noStaked: 0n,
    yesClaimed: 0n,
    noClaimed: 0n,
    poolPaid: 0n,
    poolFee: 0n,
    redeemedYes: 0n,
    redeemedNo: 0n,
    redeemedUsdc: 0n,
    redemptionFees: 0n,
    setsMinted: 0n,
    setsMerged: 0n,
    usdcSpent: 0n,
    usdcReceived: 0n,
    updatedAt: m.timestamp,
  };
}

export function emptyStaker(market: string, wallet: string, m: Pick<EventMeta, "timestamp">): Staker {
  return {
    id: pairId(market, wallet),
    market_id: addr(market),
    wallet_id: addr(wallet),
    yesStake: 0n,
    noStake: 0n,
    stakeCount: 0,
    firstStakeAt: m.timestamp,
    tokensClaimed: false,
    yesClaimed: 0n,
    noClaimed: 0n,
    poolClaimed: false,
    poolPaid: 0n,
    poolFee: 0n,
  };
}

/** A market skeleton. MarketRegistered (vault) creates it; MarketCreated (factory) fills in the terms. */
/** A book's record, from the Graduator's event (or the market's Graduated, if that never came). */
export function emptyBook(
  id: string,
  market: string,
  b: {
    source: Enum<"BookSource">;
    registrar: string | undefined;
    kuruVersion: number;
    venue: Enum<"Venue">;
  },
  m: Pick<EventMeta, "timestamp" | "block" | "tx">,
): Book {
  return {
    id: addr(id),
    market_id: addr(market),
    source: b.source,
    registrar: b.registrar ? addr(b.registrar) : undefined,
    kuruVersion: b.kuruVersion,
    venue: b.venue,
    fillCount: 0,
    fillCountOurMaker: 0,
    fillCountMakerUnknown: 0,
    volume: 0n,
    volumeOurMaker: 0n,
    lastPriceE6: undefined,
    orderCount: 0,
    orderCountOurMaker: 0,
    block: m.block,
    timestamp: m.timestamp,
    tx: m.tx,
  };
}

/** A market's skeleton, on the stack of the contract that emitted `m` (its vault or its factory). */
export function emptyMarket(
  id: string,
  tokens: { yes: string; no: string; creator: string },
  m: Pick<EventMeta, "chainId" | "timestamp" | "block" | "tx" | "src">,
): Market {
  const stack = stackOfContract(m.chainId, m.src) ?? stackNamed(m.chainId, "primary");
  return {
    id: addr(id),
    number: 0,
    stack: stack.name,
    kuruVersion: stack.kuruVersion,
    venue: venueOf(stack),
    template_id: "",
    templateId: 0n,
    key: "",
    params: "0x",
    question: undefined,
    asset: undefined,
    perpId: undefined,
    threshold: undefined,
    priceSource: undefined,
    feed: undefined,
    pythId: undefined,
    strikeE8: undefined,
    lowerE8: undefined,
    upperE8: undefined,
    legs: undefined,
    blockClock: undefined,
    windowStart: undefined,
    lockAt: undefined,
    closeAt: undefined,
    settleDeadline: undefined,
    snapshot_id: undefined,
    snapshotKey: undefined,
    snapshotSourceId: undefined,
    snapshotWindow: undefined,
    comparator: undefined,
    creator_id: addr(tokens.creator),
    creatorIsOurs: staticRoleOf(m.chainId, tokens.creator) !== "None",
    yesToken: addr(tokens.yes),
    noToken: addr(tokens.no),
    stage: "Pool",
    yesTotal: 0n,
    noTotal: 0n,
    poolTotal: 0n,
    impliedChanceBps: 0,
    stakeCount: 0,
    stakerCount: 0,
    yesStakerCount: 0,
    noStakerCount: 0,
    lastStakeId: undefined,
    book_id: undefined,
    graduated: false,
    graduatedAt: undefined,
    graduatedAtBlock: undefined,
    openingPriceE6: undefined,
    redeemFeeYesE6: undefined,
    redeemFeeNoE6: undefined,
    redemptionFeeNumerator: undefined,
    redemptionFeeDenominator: undefined,
    fillCount: 0,
    fillCountOurMaker: 0,
    fillCountMakerUnknown: 0,
    volume: 0n,
    volumeOurMaker: 0n,
    lastPriceE6: undefined,
    lastFillAt: undefined,
    routerTradeCount: 0,
    routerVolume: 0n,
    setsMinted: 0n,
    setsMerged: 0n,
    outcome: "Unresolved",
    evidenceHash: undefined,
    settler: undefined,
    settledAt: undefined,
    settledAtBlock: undefined,
    settleTx: undefined,
    voidedAt: undefined,
    firstRedemptionAt: undefined,
    redemptionCount: 0,
    redeemedTokens: 0n,
    redeemedUsdc: 0n,
    redemptionFees: 0n,
    poolPaidOut: 0n,
    poolFees: 0n,
    vaultPool: 0n,
    vaultSets: 0n,
    collateralIn: 0n,
    collateralOut: 0n,
    feesAccrued: 0n,
    solvencyMargin: 0n,
    createdAt: m.timestamp,
    createdAtBlock: m.block,
    createdTx: m.tx,
    conditionalOrderCount: 0,
    conditionalOrdersOpen: 0,
    conditionalOrdersExecuted: 0,
    autoRedemptionCount: 0,
    autoRedeemedUsdc: 0n,
    oracle_id: undefined,
  };
}

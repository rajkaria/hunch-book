// Test helpers: a small event-level model of Hunch Book that emits the same logs, in the same order,
// as the contracts do (checked against Monad testnet receipts), and feeds them to Envio's test indexer.
import { createTestIndexer, type TestIndexer } from "envio";
import { encodeAbiParameters } from "viem";
import { networkOf } from "../src/lib/network.js";
import { perplFundingParamsAbi, priceAtTimeParamsAbi } from "../src/lib/params.js";

export const CHAIN = 10143;
const n = networkOf(CHAIN);
const must = (a: string | null): string => {
  if (!a) throw new Error("missing testnet address");
  return a;
};

/** Testnet addresses from deployments/monad-testnet.json (through the generated networks file). */
export const ADDR = {
  factory: must(n.contracts.factory),
  vault: must(n.contracts.vault),
  router: must(n.contracts.router),
  graduator: must(n.contracts.graduator),
  usdc: must(n.contracts.usdc),
  maker: n.ours.maker,
  keeper: n.ours.keeper,
  guardian: must(n.ours.guardian),
  marginAccount: n.kuru.marginAccount,
  zero: "0x0000000000000000000000000000000000000000",
};

/** The market seeded on Monad testnet (contracts/script/SeedTestnetMarket.s.sol) and its book. */
export const SEED = {
  market: "0x2a44b99014cf73065bfb89197a08de09d18d3982",
  yes: "0x9d6c40f96fd7d7ad7b16a4a53bb4707f693d270e",
  no: "0x522ce8eba8c2df6f8df2fe090b5df511579344f3",
  book: "0xdfd060ac7d3b129261eab2e3ddd6f76a877d104a",
  key: "0x306f22ab64e0f9fd35eae199a64c97ac194e1beec2b52fa40fc14b8fd15f683f",
  params:
    "0x000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000040e7cbd000000000000000000000000000000000000000000000000000000000411a04500000000000000000000000000000000000000000000000000000000000005dc0000000000000000000000000000000000000000000000000000000000000003",
  /** Addresses derived from the deployer key, staked for by the deployer. */
  stakers: [
    "0x5d6f5e4ee2f10922b67595e5d8a649611264e381",
    "0x0964d6e9f76a069e7772264b276c136d498fb564",
    "0xed6c09d8e5af355b0856fcb4817c6b22279a739b",
    "0xdb471a68e61ac42a63f637837522bc94d6f0ed48",
    "0x970770b48d95e21f3111fa4764effe5a9516b806",
    "0xa3206e9419538a33733bd70cb85437f4cde1a8f8",
    "0x847a62dbdd298294294e8faf79dcc5d3c9642dc8",
    "0x02ad84f629fae47d78902d25b6f3db02624fa63f",
    "0xdfa8af80272f0bb4f913f7318c6b7e51f611c54f",
    "0x36b89896700b9af0f47839d9388ffcc3ce99cc9c",
  ],
};

/** Outside wallets: nobody in the deployments file. */
export const ALICE = "0xa11ce00000000000000000000000000000000001";
export const BOB = "0xb0b0000000000000000000000000000000000002";
export const CAROL = "0xca201000000000000000000000000000000000003";

export const USDC = (whole: number): bigint => BigInt(Math.round(whole * 1_000_000));
export const E18 = (price: number): bigint => BigInt(Math.round(price * 1_000_000)) * 10n ** 12n;

export const Side = { Yes: 0n, No: 1n } as const;
export const Outcome = { Yes: 1n, No: 2n } as const;
export const Kind = { BuyYes: 0n, SellYes: 1n, BuyNo: 2n, SellNo: 3n } as const;

export function perplParams(p: {
  perpId: bigint;
  startBlock: bigint;
  endBlock: bigint;
  threshold: bigint;
}): string {
  return encodeAbiParameters(perplFundingParamsAbi, [{ ...p, expectedScalingExp: 3 }]);
}

export function priceParams(p: {
  feed: string;
  strikeE8: bigint;
  lockTime: bigint;
  closeTime: bigint;
}): string {
  return encodeAbiParameters(priceAtTimeParamsAbi, [
    {
      source: 0,
      feed: p.feed as `0x${string}`,
      pythId: `0x${"0".repeat(64)}`,
      strikeE8: p.strikeE8,
      lockTime: p.lockTime,
      closeTime: p.closeTime,
    },
  ]);
}

export type Item = Record<string, unknown>;

/** Feeds simulated logs to a test indexer. */
export function deliver(indexer: TestIndexer, simulate: Item[]) {
  return indexer.process({ chains: { [CHAIN]: { simulate } } } as unknown as Parameters<
    TestIndexer["process"]
  >[0]);
}

/** Builds simulated logs block by block, transaction by transaction, with increasing log indexes. */
export class Script {
  block: number;
  timestamp: number;
  private logIndex = 0;
  private txCount = 0;
  private hash = "";
  private from: string = ADDR.guardian;
  private items: Item[] = [];

  constructor(block = 67_858_400, timestamp = 1_791_039_000) {
    this.block = block;
    this.timestamp = timestamp;
    this.tx();
  }

  /** Moves to a later block and starts a transaction there. */
  next(opts: { blocks?: number; seconds?: number; from?: string } = {}): this {
    this.block += opts.blocks ?? 1;
    this.timestamp += opts.seconds ?? 1;
    this.logIndex = 0;
    return this.tx(opts.from);
  }

  /** Starts another transaction in the current block. */
  tx(from: string = ADDR.guardian): this {
    this.txCount += 1;
    this.hash = `0x${this.block.toString(16).padStart(16, "0")}${this.txCount.toString(16).padStart(48, "0")}`;
    this.from = from;
    return this;
  }

  get txHash(): string {
    return this.hash;
  }

  /** The id the indexer gives the next log. */
  get nextId(): string {
    return `${this.block}-${this.logIndex}`;
  }

  emit(contract: string, event: string, params: Record<string, unknown>, srcAddress?: string): string {
    const id = this.nextId;
    this.items.push({
      contract,
      event,
      params,
      ...(srcAddress ? { srcAddress } : {}),
      block: { number: this.block, timestamp: this.timestamp },
      transaction: { hash: this.hash, from: this.from },
      logIndex: this.logIndex,
    });
    this.logIndex += 1;
    return id;
  }

  /** The logs not yet delivered. */
  pending(): Item[] {
    return this.items.map((item) => ({ ...item }));
  }

  async run(indexer: TestIndexer) {
    const simulate = this.items;
    this.items = [];
    return deliver(indexer, simulate);
  }
}

interface MarketState {
  yes: string;
  no: string;
  yesTotal: bigint;
  noTotal: bigint;
  stakes: Map<string, { yes: bigint; no: bigint }>;
}

/** Emits the logs the contracts emit for each protocol action, keeping the totals the events carry. */
export class Protocol {
  readonly s: Script;
  readonly indexer: TestIndexer;
  private readonly markets = new Map<string, MarketState>();

  constructor(script = new Script()) {
    this.s = script;
    this.indexer = createTestIndexer();
  }

  run() {
    return this.s.run(this.indexer);
  }

  private usdc(from: string, to: string, value: bigint): void {
    this.s.emit("Usdc", "Transfer", { from, to, value }, ADDR.usdc);
  }

  private token(token: string, from: string, to: string, value: bigint): void {
    this.s.emit("OutcomeToken", "Transfer", { from, to, value }, token);
  }

  state(market: string): MarketState {
    const m = this.markets.get(market);
    if (!m) throw new Error(`unknown market ${market}`);
    return m;
  }

  addTemplates(): void {
    const rule = { minPool: USDC(500), minStakers: 10n, minChanceBps: 300n, maxChanceBps: 9700n };
    this.s.emit("HunchBookFactory", "TemplateAdded", {
      templateId: 1n,
      resolver: ADDR.zero.replace(/0$/, "1"),
      rule,
    });
    this.s.emit("HunchBookFactory", "TemplateAdded", {
      templateId: 2n,
      resolver: ADDR.zero.replace(/0$/, "2"),
      rule,
    });
  }

  /** HunchBookFactory.createMarket: register (vault), first stake (market + vault), MarketCreated. */
  createMarket(p: {
    market: string;
    yes: string;
    no: string;
    creator: string;
    templateId?: bigint;
    params?: string;
    key?: string;
    side?: bigint;
    amount?: bigint;
  }): void {
    const side = p.side ?? Side.Yes;
    const amount = p.amount ?? USDC(50);
    this.markets.set(p.market, { yes: p.yes, no: p.no, yesTotal: 0n, noTotal: 0n, stakes: new Map() });
    this.s.emit(
      "CollateralVault",
      "MarketRegistered",
      { market: p.market, yes: p.yes, no: p.no, creator: p.creator },
      ADDR.vault,
    );
    this.stakeLogs(p.market, p.creator, side, amount, p.creator);
    this.s.emit(
      "HunchBookFactory",
      "MarketCreated",
      {
        market: p.market,
        templateId: p.templateId ?? 1n,
        key: p.key ?? `0x${p.market.slice(2).padStart(64, "0")}`,
        creator: p.creator,
        params: p.params ?? SEED.params,
      },
      ADDR.factory,
    );
  }

  /** Market.stake / stakeFor (payer pays) or stakeWithAuthorization (relayed: the market forwards the user's USDC). */
  stake(p: {
    market: string;
    user: string;
    side: bigint;
    amount: bigint;
    payer?: string;
    relayed?: boolean;
  }): void {
    if (p.relayed) {
      this.recordStake(p.market, p.user, p.side, p.amount);
      this.s.emit("Usdc", "Transfer", { from: p.user, to: p.market, value: p.amount }, ADDR.usdc);
      this.usdc(p.market, ADDR.vault, p.amount);
      this.s.emit(
        "CollateralVault",
        "PoolDeposited",
        { market: p.market, from: p.market, amount: p.amount },
        ADDR.vault,
      );
      return;
    }
    this.stakeLogs(p.market, p.user, p.side, p.amount, p.payer ?? p.user);
  }

  private recordStake(market: string, user: string, side: bigint, amount: bigint): void {
    const m = this.state(market);
    const pos = m.stakes.get(user) ?? { yes: 0n, no: 0n };
    if (side === Side.Yes) {
      pos.yes += amount;
      m.yesTotal += amount;
    } else {
      pos.no += amount;
      m.noTotal += amount;
    }
    m.stakes.set(user, pos);
    this.s.emit("Market", "Staked", { user, side, amount, yesTotal: m.yesTotal, noTotal: m.noTotal }, market);
  }

  private stakeLogs(market: string, user: string, side: bigint, amount: bigint, payer: string): void {
    this.recordStake(market, user, side, amount);
    this.usdc(payer, ADDR.vault, amount);
    this.s.emit("CollateralVault", "PoolDeposited", { market, from: payer, amount }, ADDR.vault);
  }

  /** Market.graduate on testnet: the Graduator creates the book, the vault mints T sets to the market. */
  graduate(p: { market: string; book: string; registered?: boolean }): void {
    const m = this.state(p.market);
    const total = m.yesTotal + m.noTotal;
    if (!p.registered)
      this.s.emit("Graduator", "BookCreated", { market: p.market, book: p.book }, ADDR.graduator);
    this.token(m.yes, ADDR.zero, p.market, total);
    this.token(m.no, ADDR.zero, p.market, total);
    this.s.emit("CollateralVault", "PoolGraduated", { market: p.market, sets: total }, ADDR.vault);
    this.s.emit(
      "Market",
      "Graduated",
      {
        total,
        yesTotal: m.yesTotal,
        noTotal: m.noTotal,
        openingPriceE6: (m.yesTotal * 1_000_000n) / total,
        book: p.book,
      },
      p.market,
    );
  }

  registerBook(p: { market: string; book: string; registrar: string }): void {
    this.s.emit("Graduator", "BookRegistered", p, ADDR.graduator);
  }

  /** Market.claimTokensFor(users): ⌊T · s / sideTotal⌋ per side; dust to the fee recipient after the last claim. */
  claimTokens(p: { market: string; users: string[] }): void {
    const m = this.state(p.market);
    const total = m.yesTotal + m.noTotal;
    const claimed = { yes: 0n, no: 0n };
    const remaining = { yes: [...m.stakes.values()].filter((s) => s.yes > 0n).length, no: 0 };
    remaining.no = [...m.stakes.values()].filter((s) => s.no > 0n).length;
    for (const user of p.users) {
      const pos = m.stakes.get(user);
      if (!pos) continue;
      for (const [side, stake, sideTotal, token, key] of [
        [Side.Yes, pos.yes, m.yesTotal, m.yes, "yes"],
        [Side.No, pos.no, m.noTotal, m.no, "no"],
      ] as const) {
        if (stake === 0n) continue;
        const amount = (stake * total) / sideTotal;
        this.token(token, p.market, user, amount);
        this.s.emit("Market", "TokensClaimed", { user, side, amount }, p.market);
        claimed[key] += amount;
        remaining[key] -= 1;
        if (remaining[key] === 0 && total > claimed[key]) {
          this.token(token, p.market, ADDR.guardian, total - claimed[key]);
          this.s.emit(
            "Market",
            "DustSwept",
            { side, amount: total - claimed[key], to: ADDR.guardian },
            p.market,
          );
        }
      }
    }
  }

  orderCreated(p: {
    book: string;
    orderId: bigint;
    owner: string;
    size: bigint;
    priceE6: bigint;
    isBuy: boolean;
  }): void {
    this.s.emit(
      "KuruOrderBook",
      "OrderCreated",
      { orderId: p.orderId, owner: p.owner, size: p.size, price: p.priceE6, isBuy: p.isBuy },
      p.book,
    );
  }

  fill(p: {
    book: string;
    orderId: bigint;
    maker: string;
    taker: string;
    txOrigin?: string;
    takerBuysYes: boolean;
    price: bigint;
    size: bigint;
    remaining: bigint;
  }): void {
    this.s.emit(
      "KuruOrderBook",
      "Trade",
      {
        orderId: p.orderId,
        makerAddress: p.maker,
        isBuy: p.takerBuysYes,
        price: p.price,
        updatedSize: p.remaining,
        takerAddress: p.taker,
        txOrigin: p.txOrigin ?? p.taker,
        filledSize: p.size,
      },
      p.book,
    );
  }

  /** HunchRouter.buyYes / sellYes with one fill against `maker`'s order. */
  routerYes(p: {
    market: string;
    book: string;
    user: string;
    buy: boolean;
    orderId: bigint;
    maker: string;
    price: bigint;
    size: bigint;
    remaining: bigint;
    /** The USDC the router reports (Kuru rounds); defaults to size times price. */
    usdc?: bigint;
  }): void {
    const m = this.state(p.market);
    const usdc = p.usdc ?? (p.size * p.price) / 10n ** 18n;
    this.fill({ ...p, taker: ADDR.router, txOrigin: p.user, takerBuysYes: p.buy });
    if (p.buy) {
      this.token(m.yes, ADDR.marginAccount, ADDR.router, p.size);
      this.token(m.yes, ADDR.router, p.user, p.size);
    } else {
      this.token(m.yes, p.user, ADDR.router, p.size);
      this.token(m.yes, ADDR.router, ADDR.marginAccount, p.size);
    }
    this.s.emit(
      "HunchRouter",
      "Trade",
      {
        market: p.market,
        user: p.user,
        kind: p.buy ? Kind.BuyYes : Kind.SellYes,
        amountIn: p.buy ? usdc : p.size,
        amountOut: p.buy ? p.size : usdc,
        book: p.book,
      },
      ADDR.router,
    );
  }

  mintSets(p: { market: string; payer: string; to: string; amount: bigint }): void {
    const m = this.state(p.market);
    this.usdc(p.payer, ADDR.vault, p.amount);
    this.token(m.yes, ADDR.zero, p.to, p.amount);
    this.token(m.no, ADDR.zero, p.to, p.amount);
    this.s.emit("CollateralVault", "SetsMinted", p, ADDR.vault);
  }

  mergeSets(p: { market: string; holder: string; to: string; amount: bigint }): void {
    const m = this.state(p.market);
    this.token(m.yes, p.holder, ADDR.zero, p.amount);
    this.token(m.no, p.holder, ADDR.zero, p.amount);
    this.usdc(ADDR.vault, p.to, p.amount);
    this.s.emit("CollateralVault", "SetsMerged", p, ADDR.vault);
  }

  /** Market.settle on a graduated market: the vault finalizes with the fee, then the market emits Settled. */
  settleGraduated(p: { market: string; outcome: bigint; settler?: string }): void {
    const m = this.state(p.market);
    const losing = p.outcome === Outcome.Yes ? m.noTotal : m.yesTotal;
    const total = m.yesTotal + m.noTotal;
    this.s.emit(
      "CollateralVault",
      "Finalized",
      { market: p.market, outcome: p.outcome, feeNumerator: 200n * losing, feeDenominator: 10_000n * total },
      ADDR.vault,
    );
    this.s.emit(
      "Market",
      "Settled",
      { outcome: p.outcome, evidenceHash: `0x${"ab".repeat(32)}`, settler: p.settler ?? ADDR.keeper },
      p.market,
    );
  }

  /** Market.settle on a pool-only market. */
  settlePool(p: { market: string; outcome: bigint; settler?: string }): void {
    this.s.emit(
      "CollateralVault",
      "Finalized",
      { market: p.market, outcome: p.outcome, feeNumerator: 0n, feeDenominator: 1n },
      ADDR.vault,
    );
    this.s.emit(
      "Market",
      "Settled",
      { outcome: p.outcome, evidenceHash: `0x${"cd".repeat(32)}`, settler: p.settler ?? ADDR.keeper },
      p.market,
    );
  }

  voidMarket(p: { market: string }): void {
    this.s.emit("CollateralVault", "MarketVoided", { market: p.market }, ADDR.vault);
    this.s.emit("Market", "Voided", {}, p.market);
  }

  /** CollateralVault.redeem: burn, accrue the fee (75/25), emit Redeemed, pay. */
  redeem(p: {
    market: string;
    holder: string;
    side: bigint;
    amount: bigint;
    paid: bigint;
    fee: bigint;
    creator: string;
  }): void {
    const m = this.state(p.market);
    this.token(p.side === Side.Yes ? m.yes : m.no, p.holder, ADDR.zero, p.amount);
    if (p.fee > 0n) this.feesAccrued(p.market, p.fee, p.creator);
    this.s.emit(
      "CollateralVault",
      "Redeemed",
      {
        market: p.market,
        holder: p.holder,
        to: p.holder,
        side: p.side,
        amount: p.amount,
        paid: p.paid,
        fee: p.fee,
      },
      ADDR.vault,
    );
    if (p.paid > 0n) this.usdc(ADDR.vault, p.holder, p.paid);
  }

  feesAccrued(market: string, fee: bigint, creator: string): void {
    const creatorShare = (fee * 2_500n) / 10_000n;
    this.s.emit(
      "CollateralVault",
      "FeesAccrued",
      { market, protocolShare: fee - creatorShare, creator, creatorShare },
      ADDR.vault,
    );
  }

  /** Market.claimPool: vault pays (fee accrued first), then the market's PoolClaimed. */
  claimPool(p: { market: string; user: string; paid: bigint; fee: bigint; creator: string }): void {
    if (p.fee > 0n) this.feesAccrued(p.market, p.fee, p.creator);
    this.usdc(ADDR.vault, p.user, p.paid);
    this.s.emit(
      "CollateralVault",
      "PoolPaid",
      { market: p.market, to: p.user, paid: p.paid, fee: p.fee },
      ADDR.vault,
    );
    this.s.emit("Market", "PoolClaimed", { user: p.user, paid: p.paid, fee: p.fee }, p.market);
  }

  /** The last winner's claim moves the leftover pool to the fee balances: payPool(address(0), 0, dust). */
  poolDust(p: { market: string; dust: bigint; creator: string }): void {
    this.feesAccrued(p.market, p.dust, p.creator);
    this.s.emit(
      "CollateralVault",
      "PoolPaid",
      { market: p.market, to: ADDR.zero, paid: 0n, fee: p.dust },
      ADDR.vault,
    );
  }

  flashLoan(p: { receiver: string; amount: bigint }): void {
    this.usdc(ADDR.vault, p.receiver, p.amount);
    this.usdc(p.receiver, ADDR.vault, p.amount);
    this.s.emit(
      "CollateralVault",
      "FlashLoan",
      { receiver: p.receiver, initiator: p.receiver, amount: p.amount },
      ADDR.vault,
    );
  }
}

/** Seeds the testnet market exactly as SeedTestnetMarket.s.sol did: 50 + 6 × 60 YES, 4 × 70 NO, graduate, claim. */
export function seedTestnetMarket(p: Protocol): void {
  p.addTemplates();
  p.s.next();
  p.createMarket({ market: SEED.market, yes: SEED.yes, no: SEED.no, creator: ADDR.guardian, key: SEED.key });
  SEED.stakers.forEach((user, i) => {
    p.s.next({ blocks: 3, seconds: 1 });
    p.stake({
      market: SEED.market,
      user,
      side: i < 6 ? Side.Yes : Side.No,
      amount: i < 6 ? USDC(60) : USDC(70),
      payer: ADDR.guardian,
    });
  });
  p.s.next({ blocks: 3, seconds: 1 });
  p.graduate({ market: SEED.market, book: SEED.book });
  p.s.next({ blocks: 3, seconds: 1 });
  p.claimTokens({ market: SEED.market, users: [ADDR.guardian, ...SEED.stakers] });
}

export const json = (value: unknown): unknown =>
  JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));

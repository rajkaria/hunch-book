import {
  type Deployment,
  hunchRouterAbi,
  kuruOrderBookAbi,
  kuruV2OrderBookAbi,
  stacksOf,
} from "@hunch-book/shared";
import { type Address, getAbiItem, getAddress, type Hex, isAddressEqual, type PublicClient } from "viem";
import { ourAddresses } from "../chain/landing";
import { address, big, hash } from "../indexer/parse";
import type { TradeRow } from "../indexer/queries";

const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

// Fills on Hunch Book's Kuru books, for the trade tape. Two sources: the indexer's Trade entity, or
// Kuru's events read straight from recent blocks. Kuru v1's Trade event (as the indexer reads it,
// indexer/src/handlers/kuru.ts): isBuy is the taker's side (true when the taker bought YES from a
// resting ask), price has 18 decimals, filledSize is YES base units, takerAddress is our router for
// router trades (txOrigin is then the trader). Kuru v2 books emit one SpotSwap per taker swap (amount
// in used and amount out, after the fee, no maker): a v2 fill is that whole swap at its average price,
// and for a router trade the trader comes from the router's own Trade event in the same transaction.

export interface Fill {
  /** "<block>-<logIndex>". */
  id: string;
  book: Address;
  market: Address | null;
  marketNumber: number | null;
  question: string | null;
  block: bigint;
  logIndex: number;
  /** Unix seconds, once known. */
  time: number | null;
  tx: Hex;
  /** USDC base units per whole YES token. */
  priceE6: bigint;
  /** YES base units filled. */
  size: bigint;
  /** USDC base units: size times price, rounded down, before any Kuru fee (v2: the swap's USDC side). */
  notional: bigint;
  /** The taker bought YES (lifted an ask); false when the taker sold YES (hit a bid). */
  takerBuysYes: boolean;
  /** The zero address when the maker is unknown. */
  maker: Address;
  /** False for a Kuru v2 swap: it does not name its makers, so it is never counted as ours or as others'. */
  makerKnown: boolean;
  /** The wallet on the taking side: the transaction's sender for router trades. */
  trader: Address;
  viaRouter: boolean;
  /** The maker is Hunch Book's maker bot (deployments wallets.maker). */
  makerIsOurMaker: boolean;
  makerIsOurs: boolean;
  traderIsOurs: boolean;
}

/** A graduated market's book, for naming fills read from logs. */
export interface BookInfo {
  book: Address;
  market: Address;
  marketNumber: number | null;
  question: string | null;
  /** The book's Kuru version (absent = 1). */
  kuruVersion?: 1 | 2;
}

const PRICE_E18_TO_E6 = 10n ** 12n;
const PRICE_SCALE = 10n ** 18n;

export const kuruTradeEvent = getAbiItem({ abi: kuruOrderBookAbi, name: "Trade" });
export const kuruSwapEvent = getAbiItem({ abi: kuruV2OrderBookAbi, name: "SpotSwap" });
export const routerTradeEvent = getAbiItem({ abi: hunchRouterAbi, name: "Trade" });

/** Every stack's router (a taker that is one of them traded through Hunch Book's router). */
export function routersOf(deployment: Deployment): Address[] {
  return stacksOf(deployment).flatMap((s) => (s.contracts.router ? [s.contracts.router] : []));
}

const isRouter = (deployment: Deployment, a: Address) =>
  routersOf(deployment).some((r) => isAddressEqual(r, a));

export interface KuruSwapArgs {
  userId: number;
  executor: Address;
  isBuy: boolean;
  amountInUsed: bigint;
  amountOut: bigint;
  minAmountOut: bigint;
}

export interface SwapLog {
  address: Address;
  blockNumber: bigint | null;
  logIndex: number | null;
  transactionHash: Hex | null;
  args: Partial<KuruSwapArgs>;
}

/**
 * A fill from one Kuru v2 SpotSwap log: the whole swap at its average price, after Kuru's fee. `traders`
 * maps a transaction hash to the trader named by the router's Trade event in it. A v2 swap does not name
 * the makers it filled against, so the maker is unknown (zero address) and never counted as ours.
 */
export function fillFromSwapLog(
  log: SwapLog,
  deployment: Deployment,
  books: ReadonlyMap<string, BookInfo>,
  traders: ReadonlyMap<string, Address>,
): Fill | null {
  const a = log.args;
  if (
    log.blockNumber === null ||
    log.logIndex === null ||
    !log.transactionHash ||
    a.executor === undefined ||
    a.isBuy === undefined ||
    a.amountInUsed === undefined ||
    a.amountOut === undefined
  ) {
    return null;
  }
  const size = a.isBuy ? a.amountOut : a.amountInUsed;
  const notional = a.isBuy ? a.amountInUsed : a.amountOut;
  if (size === 0n) return null;
  const viaRouter = isRouter(deployment, a.executor);
  const trader = viaRouter ? (traders.get(log.transactionHash.toLowerCase()) ?? a.executor) : a.executor;
  const ours = ourAddresses(deployment);
  const info = books.get(log.address.toLowerCase());
  return {
    id: `${log.blockNumber.toString()}-${log.logIndex}`,
    book: getAddress(log.address),
    market: info?.market ?? null,
    marketNumber: info?.marketNumber ?? null,
    question: info?.question ?? null,
    block: log.blockNumber,
    logIndex: log.logIndex,
    time: null,
    tx: log.transactionHash,
    priceE6: (notional * 1_000_000n) / size,
    size,
    notional,
    takerBuysYes: a.isBuy,
    maker: ZERO_ADDRESS,
    makerKnown: false,
    trader: getAddress(trader),
    viaRouter,
    makerIsOurMaker: false,
    makerIsOurs: false,
    traderIsOurs: ours.some((o) => isAddressEqual(o, trader)),
  };
}

/** Neither side is one of our wallets. Never true when the maker is unknown (Kuru v2 swaps). */
export const isBetweenOthers = (f: Pick<Fill, "makerKnown" | "makerIsOurs" | "traderIsOurs">): boolean =>
  f.makerKnown && !f.makerIsOurs && !f.traderIsOurs;

export function fillFromRow(row: TradeRow): Fill {
  return {
    id: row.id,
    book: address(row.book?.id),
    market: row.market ? address(row.market.id) : null,
    marketNumber: row.market?.number ?? null,
    question: row.market?.question ?? null,
    block: big(row.block),
    logIndex: row.logIndex,
    time: Number(big(row.timestamp)),
    tx: hash(row.tx),
    priceE6: big(row.priceE6),
    size: big(row.size),
    notional: big(row.notional),
    takerBuysYes: row.takerBuysYes,
    maker: address(row.maker),
    makerKnown: row.makerKnown ?? !isAddressEqual(address(row.maker), ZERO_ADDRESS),
    trader: address(row.trader),
    viaRouter: row.viaRouter,
    makerIsOurMaker: row.isOurMaker,
    makerIsOurs: row.makerIsOurs,
    traderIsOurs: row.traderIsOurs,
  };
}

export interface KuruTradeArgs {
  orderId: number | bigint;
  makerAddress: Address;
  isBuy: boolean;
  price: bigint;
  updatedSize: bigint;
  takerAddress: Address;
  txOrigin: Address;
  filledSize: bigint;
}

export interface TradeLog {
  address: Address;
  blockNumber: bigint | null;
  logIndex: number | null;
  transactionHash: Hex | null;
  args: Partial<KuruTradeArgs>;
}

/** A fill from one Kuru Trade log, labelled the way the indexer labels it. Null for a malformed log. */
export function fillFromLog(
  log: TradeLog,
  deployment: Deployment,
  books: ReadonlyMap<string, BookInfo>,
): Fill | null {
  const a = log.args;
  if (
    log.blockNumber === null ||
    log.logIndex === null ||
    !log.transactionHash ||
    a.makerAddress === undefined ||
    a.takerAddress === undefined ||
    a.txOrigin === undefined ||
    a.price === undefined ||
    a.filledSize === undefined ||
    a.isBuy === undefined
  ) {
    return null;
  }
  const viaRouter = isRouter(deployment, a.takerAddress);
  const trader = viaRouter ? a.txOrigin : a.takerAddress;
  const ours = ourAddresses(deployment);
  const isOurs = (x: Address) => ours.some((o) => isAddressEqual(o, x));
  const info = books.get(log.address.toLowerCase());
  return {
    id: `${log.blockNumber.toString()}-${log.logIndex}`,
    book: getAddress(log.address),
    market: info?.market ?? null,
    marketNumber: info?.marketNumber ?? null,
    question: info?.question ?? null,
    block: log.blockNumber,
    logIndex: log.logIndex,
    time: null,
    tx: log.transactionHash,
    priceE6: a.price / PRICE_E18_TO_E6,
    size: a.filledSize,
    notional: (a.filledSize * a.price) / PRICE_SCALE,
    takerBuysYes: a.isBuy,
    maker: getAddress(a.makerAddress),
    makerKnown: true,
    trader: getAddress(trader),
    viaRouter,
    makerIsOurMaker: isAddressEqual(a.makerAddress, deployment.wallets.maker),
    makerIsOurs: isOurs(a.makerAddress),
    traderIsOurs: isOurs(trader),
  };
}

/** Newest first: by block, then by position in the block. */
export function byNewest(a: Fill, b: Fill): number {
  if (a.block !== b.block) return a.block > b.block ? -1 : 1;
  return b.logIndex - a.logIndex;
}

/** Inclusive block ranges of at most `size` blocks covering [from, to], newest first. */
export function blockRanges(from: bigint, to: bigint, size = LOG_RANGE): { from: bigint; to: bigint }[] {
  const out: { from: bigint; to: bigint }[] = [];
  for (let hi = to; hi >= from; hi -= size) {
    const lo = hi - size + 1n > from ? hi - size + 1n : from;
    out.push({ from: lo, to: hi });
  }
  return out;
}

/** Public Monad RPCs answer eth_getLogs for at most 100 blocks per request. */
export const LOG_RANGE = 100n;
/** Blocks the chain tape reads when it starts: about seven minutes of Monad testnet. */
export const TAPE_BACKFILL_BLOCKS = 1_000n;
/** Blocks each "look further back" adds. */
export const TAPE_EXTEND_BLOCKS = 2_000n;
/** Fills the chain tape keeps. */
export const TAPE_KEEP = 200;
/** getLogs requests in flight at once. */
const CONCURRENCY = 4;

export type TapeClient = Pick<PublicClient, "getBlockNumber" | "getLogs" | "getBlock">;

export interface TapeSnapshot {
  fills: Fill[];
  /** Oldest block read, inclusive. */
  from: bigint | null;
  /** Newest block read, inclusive. */
  to: bigint | null;
  books: number;
}

async function inBatches<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  }
  return out;
}

/**
 * Reads fills on a set of books from recent blocks, 100 blocks per request. The first poll reads the
 * last TAPE_BACKFILL_BLOCKS; each later poll reads only the blocks since; `extend` reads further back.
 */
export class TapeScanner {
  private fills: Fill[] = [];
  private from: bigint | null = null;
  private to: bigint | null = null;
  private readonly bookMap: Map<string, BookInfo>;
  private readonly times = new Map<string, number>();
  private busy: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly client: TapeClient,
    private readonly deployment: Deployment,
    books: readonly BookInfo[],
    private readonly opts: { backfill?: bigint; keep?: number } = {},
  ) {
    this.bookMap = new Map(books.map((b) => [b.book.toLowerCase(), b]));
  }

  snapshot(): TapeSnapshot {
    return { fills: this.fills, from: this.from, to: this.to, books: this.bookMap.size };
  }

  /** Reads every block since the last poll (or the backfill on the first one). */
  poll(): Promise<TapeSnapshot> {
    return this.serial(async () => {
      if (this.bookMap.size === 0) return this.snapshot();
      const head = await this.client.getBlockNumber();
      if (this.to === null) {
        const back = this.opts.backfill ?? TAPE_BACKFILL_BLOCKS;
        const from = head > back ? head - back + 1n : 0n;
        await this.read(from, head);
        this.from = from;
        this.to = head;
      } else if (head > this.to) {
        await this.read(this.to + 1n, head);
        this.to = head;
      }
      return this.snapshot();
    });
  }

  /** Reads `blocks` more blocks before the oldest one read so far. */
  extend(blocks: bigint = TAPE_EXTEND_BLOCKS): Promise<TapeSnapshot> {
    return this.serial(async () => {
      if (this.from === null || this.from === 0n || this.bookMap.size === 0) return this.snapshot();
      const to = this.from - 1n;
      const from = to + 1n > blocks ? to - blocks + 1n : 0n;
      await this.read(from, to);
      this.from = from;
      return this.snapshot();
    });
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.busy.then(work, work);
    this.busy = next.catch(() => undefined);
    return next;
  }

  private async read(from: bigint, to: bigint): Promise<void> {
    const all = [...this.bookMap.values()];
    const v1 = all.filter((b) => b.kuruVersion !== 2).map((b) => b.book);
    const v2 = all.filter((b) => b.kuruVersion === 2).map((b) => b.book);
    const ranges = blockRanges(from, to);
    const found: Fill[] = [];
    if (v1.length > 0) {
      const logs = (
        await inBatches(ranges, CONCURRENCY, (r) =>
          this.client.getLogs({ address: v1, event: kuruTradeEvent, fromBlock: r.from, toBlock: r.to }),
        )
      ).flat() as unknown as TradeLog[];
      for (const log of logs) {
        const fill = fillFromLog(log, this.deployment, this.bookMap);
        if (fill) found.push(fill);
      }
    }
    if (v2.length > 0) {
      const routers = routersOf(this.deployment);
      const [swaps, trades] = await Promise.all([
        inBatches(ranges, CONCURRENCY, (r) =>
          this.client.getLogs({ address: v2, event: kuruSwapEvent, fromBlock: r.from, toBlock: r.to }),
        ),
        routers.length === 0
          ? Promise.resolve([])
          : inBatches(ranges, CONCURRENCY, (r) =>
              this.client.getLogs({
                address: routers,
                event: routerTradeEvent,
                fromBlock: r.from,
                toBlock: r.to,
              }),
            ),
      ]);
      const traders = new Map<string, Address>();
      for (const t of trades.flat() as unknown as {
        transactionHash: Hex | null;
        args: { user?: Address };
      }[]) {
        if (t.transactionHash && t.args.user) traders.set(t.transactionHash.toLowerCase(), t.args.user);
      }
      for (const log of swaps.flat() as unknown as SwapLog[]) {
        const fill = fillFromSwapLog(log, this.deployment, this.bookMap, traders);
        if (fill) found.push(fill);
      }
    }
    if (found.length === 0) return;
    // One entry per log, even if an RPC answers overlapping ranges.
    const byId = new Map(this.fills.map((f) => [f.id, f]));
    for (const f of found) if (!byId.has(f.id)) byId.set(f.id, f);
    const merged = [...byId.values()].sort(byNewest);
    this.fills = merged.slice(0, this.opts.keep ?? TAPE_KEEP);
    await this.stampTimes();
  }

  /** Block timestamps for the kept fills, one getBlock per block not read yet. */
  private async stampTimes(): Promise<void> {
    const missing = [...new Set(this.fills.filter((f) => f.time === null).map((f) => f.block))].filter(
      (b) => !this.times.has(b.toString()),
    );
    await inBatches(missing, CONCURRENCY, async (blockNumber) => {
      try {
        const block = await this.client.getBlock({ blockNumber });
        this.times.set(blockNumber.toString(), Number(block.timestamp));
      } catch {
        // The time stays unknown; the block number still links to the explorer.
      }
    });
    this.fills = this.fills.map((f) =>
      f.time === null ? { ...f, time: this.times.get(f.block.toString()) ?? null } : f,
    );
  }
}

export interface TapeStats {
  fills: number;
  ourMakerFills: number;
  betweenOthers: number;
  /** Kuru v2 swaps, whose makers are unknown. */
  makerUnknown: number;
  volume: bigint;
  ourMakerVolume: bigint;
  /** Our maker's share of the fills whose maker is known, basis points; null with none. */
  ourMakerShareBps: number | null;
}

/** Counts over a set of fills: how many, how much, and how many our maker took. */
export function tapeStats(fills: readonly Fill[]): TapeStats {
  let ourMakerFills = 0;
  let betweenOthers = 0;
  let makerUnknown = 0;
  let volume = 0n;
  let ourMakerVolume = 0n;
  for (const f of fills) {
    volume += f.notional;
    if (f.makerIsOurMaker) {
      ourMakerFills++;
      ourMakerVolume += f.notional;
    }
    if (isBetweenOthers(f)) betweenOthers++;
    if (!f.makerKnown) makerUnknown++;
  }
  const known = fills.length - makerUnknown;
  return {
    fills: fills.length,
    ourMakerFills,
    betweenOthers,
    makerUnknown,
    volume,
    ourMakerVolume,
    ourMakerShareBps: known === 0 ? null : Math.floor((ourMakerFills * 10_000) / known),
  };
}

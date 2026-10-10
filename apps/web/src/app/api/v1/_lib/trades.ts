import { formatUsdc, type MarketInfo } from "@hunch-book/sdk";
import { kuruOrderBookAbi, type Venue } from "@hunch-book/shared";
import { type Address, getAbiItem, type Hex, isAddressEqual } from "viem";
import { kuruSwapEvent, routersOf, routerTradeEvent } from "@/lib/tape/fills";
import { cached } from "./cache";
import type { ApiDeps } from "./deps";
import { isOurs, stackVenue } from "./markets";

/** Whose logs the fills come from, in a note. */
const logsOf = (venue: Venue): string => (venue === "hunch" ? "the order book's Trade logs" : "Kuru's logs");

// Fills on a market's book (Kuru's, or Hunch Book's own). From the indexer when one is configured
// (complete history); else from the book's Trade logs over the last blocks, read in 100-block windows
// because public Monad RPCs answer eth_getLogs for at most 100 blocks. Kuru v1's Trade event, which
// Hunch Book's own books emit too: isBuy is the taker's side (true when the taker bought YES), price has
// 18 decimals, filledSize is in YES base units (docs/INDEXER.md).

export interface ApiTrade {
  block: string;
  time: string | null;
  tx: Hex;
  logIndex: number;
  /** "buy" when the taker bought YES from a resting ask, "sell" when the taker sold YES into a bid. */
  takerSide: "buy" | "sell";
  /** USDC per YES token. */
  price: string;
  sizeYes: string;
  notionalUsdc: string;
  maker: Address;
  /** The maker is Hunch Book's own maker bot (deployments `wallets.maker`). */
  makerIsHunchMaker: boolean;
  taker: Address;
  /** The wallet on the taking side: the transaction sender when the taker is the router. */
  trader: Address;
  viaRouter: boolean;
  traderIsHunch: boolean;
}

export interface TradesResult {
  source: "indexer" | "logs";
  trades: ApiTrade[];
  fromBlock: string | null;
  toBlock: string | null;
  note: string | null;
}

const LOG_WINDOW = 100n;
export const DEFAULT_LOOKBACK = 1_000n;
export const MAX_LOOKBACK = 5_000n;
const CONCURRENCY = 5;

const tradeEvent = getAbiItem({ abi: kuruOrderBookAbi, name: "Trade" });
const PRICE_SCALE = 10n ** 18n;

function shape(
  deps: ApiDeps,
  t: {
    block: bigint;
    time: number | null;
    tx: Hex;
    logIndex: number;
    isBuy: boolean;
    priceE18: bigint;
    size: bigint;
    maker: Address;
    taker: Address;
    txOrigin: Address;
  },
): ApiTrade {
  const viaRouter = routersOf(deps.deployment).some((r) => isAddressEqual(t.taker, r));
  const trader = viaRouter ? t.txOrigin : t.taker;
  return {
    block: t.block.toString(),
    time: t.time === null ? null : new Date(t.time * 1000).toISOString(),
    tx: t.tx,
    logIndex: t.logIndex,
    takerSide: t.isBuy ? "buy" : "sell",
    price: formatUsdc(t.priceE18 / 10n ** 12n),
    sizeYes: formatUsdc(t.size),
    notionalUsdc: formatUsdc((t.size * t.priceE18) / PRICE_SCALE),
    maker: t.maker,
    makerIsHunchMaker: isAddressEqual(t.maker, deps.deployment.wallets.maker),
    taker: t.taker,
    trader,
    viaRouter,
    traderIsHunch: isOurs(deps, trader),
  };
}

async function inBatches<T, R>(items: T[], size: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size)
    out.push(...(await Promise.all(items.slice(i, i + size).map(run))));
  return out;
}

/** Which blocks to read: the last `blocks`, or `blocks` from `fromBlock` on. */
export interface BlockRange {
  blocks: bigint;
  fromBlock: bigint | null;
}

/**
 * Fills from a Kuru v2 book's SpotSwap logs: one per taker swap, at its average price after the fee. A v2
 * swap names no maker (zero address here); for a router trade the trader is the `user` of the router's
 * Trade event in the same transaction.
 */
async function swapsFromLogs(
  deps: ApiDeps,
  book: Address,
  windows: { fromBlock: bigint; toBlock: bigint }[],
): Promise<
  {
    block: bigint;
    logIndex: number;
    tx: Hex;
    isBuy: boolean;
    priceE18: bigint;
    size: bigint;
    taker: Address;
    txOrigin: Address;
  }[]
> {
  const client = deps.sdk.context.publicClient;
  const routers = routersOf(deps.deployment);
  const [swaps, trades] = await Promise.all([
    inBatches(windows, CONCURRENCY, (w) =>
      client.getLogs({ address: book, event: kuruSwapEvent, fromBlock: w.fromBlock, toBlock: w.toBlock }),
    ),
    routers.length === 0
      ? Promise.resolve([])
      : inBatches(windows, CONCURRENCY, (w) =>
          client.getLogs({
            address: routers,
            event: routerTradeEvent,
            fromBlock: w.fromBlock,
            toBlock: w.toBlock,
          }),
        ),
  ]);
  const traders = new Map<string, Address>();
  for (const t of trades.flat()) {
    const user = (t.args as { user?: Address }).user;
    if (t.transactionHash && user) traders.set(t.transactionHash.toLowerCase(), user);
  }
  return swaps.flat().flatMap((l) => {
    const a = l.args;
    if (a.isBuy === undefined || a.amountInUsed === undefined || a.amountOut === undefined || !a.executor)
      return [];
    const size = a.isBuy ? a.amountOut : a.amountInUsed;
    const notional = a.isBuy ? a.amountInUsed : a.amountOut;
    if (size === 0n || l.blockNumber === null || !l.transactionHash) return [];
    return [
      {
        block: l.blockNumber,
        logIndex: l.logIndex ?? 0,
        tx: l.transactionHash,
        isBuy: a.isBuy,
        priceE18: (notional * 10n ** 18n) / size,
        size,
        taker: a.executor,
        txOrigin: traders.get(l.transactionHash.toLowerCase()) ?? a.executor,
      },
    ];
  });
}

/**
 * Fills from the book's logs over a range of blocks (at most MAX_LOOKBACK), newest first. `kuruVersion`
 * and `venue` are the market's: a Kuru v2 book logs swaps, a v1 book (Kuru's or Hunch Book's own) logs
 * Trade events.
 */
export async function tradesFromLogs(
  deps: ApiDeps,
  book: Address,
  range: BlockRange,
  limit: number,
  kuruVersion: 1 | 2 = 1,
  venue: Venue = "kuru",
): Promise<TradesResult> {
  const client = deps.sdk.context.publicClient;
  const head = await client.getBlockNumber();
  const from =
    range.fromBlock !== null ? range.fromBlock : head > range.blocks ? head - range.blocks + 1n : 0n;
  const lastWanted = from + range.blocks - 1n;
  const to = lastWanted < head ? lastWanted : head;
  const windows: { fromBlock: bigint; toBlock: bigint }[] = [];
  for (let start = from; start <= to; start += LOG_WINDOW) {
    const end = start + LOG_WINDOW - 1n;
    windows.push({ fromBlock: start, toBlock: end > to ? to : end });
  }
  if (kuruVersion === 2) {
    const fills = (await swapsFromLogs(deps, book, windows)).sort(
      (a, b) => Number(b.block - a.block) || b.logIndex - a.logIndex,
    );
    const kept = fills.slice(0, limit);
    const times = new Map<bigint, number>();
    await inBatches([...new Set(kept.map((f) => f.block))], CONCURRENCY, async (b) => {
      times.set(b, Number((await client.getBlock({ blockNumber: b })).timestamp));
    });
    return {
      source: "logs",
      fromBlock: from.toString(),
      toBlock: to.toString(),
      note: `Swaps from Kuru v2's SpotSwap logs over blocks ${from} to ${to}: one row per swap at its average price after the fee; v2 swaps do not name their makers.`,
      trades: kept.map((f) =>
        shape(deps, {
          ...f,
          time: times.get(f.block) ?? null,
          maker: "0x0000000000000000000000000000000000000000",
        }),
      ),
    };
  }
  const logs = (
    await inBatches(windows, CONCURRENCY, (w) =>
      client.getLogs({ address: book, event: tradeEvent, fromBlock: w.fromBlock, toBlock: w.toBlock }),
    )
  ).flat();
  logs.sort(
    (a, b) => Number((b.blockNumber ?? 0n) - (a.blockNumber ?? 0n)) || (b.logIndex ?? 0) - (a.logIndex ?? 0),
  );
  const kept = logs.slice(0, limit);
  const blocks = [...new Set(kept.map((l) => l.blockNumber as bigint))];
  const times = new Map<bigint, number>();
  await inBatches(blocks, CONCURRENCY, async (b) => {
    const block = await client.getBlock({ blockNumber: b });
    times.set(b, Number(block.timestamp));
  });
  return {
    source: "logs",
    fromBlock: from.toString(),
    toBlock: to.toString(),
    note:
      range.fromBlock === null
        ? `Fills from ${logsOf(venue)} over the last ${range.blocks} blocks. Set INDEXER_URL for the full history.`
        : `Fills from ${logsOf(venue)} in blocks ${from} to ${to}.`,
    trades: kept.map((l) =>
      shape(deps, {
        block: l.blockNumber as bigint,
        time: times.get(l.blockNumber as bigint) ?? null,
        tx: l.transactionHash as Hex,
        logIndex: l.logIndex ?? 0,
        isBuy: l.args.isBuy as boolean,
        priceE18: l.args.price as bigint,
        size: BigInt(l.args.filledSize as bigint),
        maker: l.args.makerAddress as Address,
        taker: l.args.takerAddress as Address,
        txOrigin: l.args.txOrigin as Address,
      }),
    ),
  };
}

const TRADES_QUERY = `query Trades($market: String!, $limit: Int!) {
  Trade(where: { market_id: { _eq: $market } }, order_by: [{ block: desc }, { logIndex: desc }], limit: $limit) {
    block timestamp tx logIndex priceE6 size takerBuysYes maker taker trader viaRouter txOrigin
  }
}`;

interface IndexerTrade {
  block: string;
  timestamp: string;
  tx: Hex;
  logIndex: number;
  priceE6: string;
  size: string;
  takerBuysYes: boolean;
  maker: Address;
  taker: Address;
  txOrigin: Address;
}

/** Fills from the Envio indexer (docs/INDEXER.md), newest first. */
export async function tradesFromIndexer(
  deps: ApiDeps,
  market: Address,
  limit: number,
): Promise<TradesResult> {
  const res = await deps.fetch(deps.indexerUrl as string, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: TRADES_QUERY, variables: { market: market.toLowerCase(), limit } }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`The indexer answered HTTP ${res.status}.`);
  const body = (await res.json()) as { data?: { Trade?: IndexerTrade[] }; errors?: { message: string }[] };
  if (body.errors?.length || !body.data?.Trade)
    throw new Error(body.errors?.[0]?.message ?? "The indexer returned no trades.");
  return {
    source: "indexer",
    fromBlock: null,
    toBlock: null,
    note: null,
    trades: body.data.Trade.map((t) =>
      shape(deps, {
        block: BigInt(t.block),
        time: Number(t.timestamp),
        tx: t.tx,
        logIndex: t.logIndex,
        isBuy: t.takerBuysYes,
        priceE18: BigInt(t.priceE6) * 10n ** 12n,
        size: BigInt(t.size),
        maker: t.maker,
        taker: t.taker,
        txOrigin: t.txOrigin,
      }),
    ),
  };
}

/**
 * The market's fills: the indexer's latest when one is configured, else (or when it fails) the book's
 * logs over the range. An explicit `fromBlock` always reads that range from the logs. Cached for 15 seconds.
 */
export async function marketTrades(
  deps: ApiDeps,
  m: MarketInfo,
  range: BlockRange,
  limit: number,
): Promise<TradesResult> {
  if (!m.book)
    return {
      source: "logs",
      trades: [],
      fromBlock: null,
      toBlock: null,
      note: "This market has no book yet.",
    };
  const book = m.book;
  const { venue } = stackVenue(m, deps);
  return cached(
    `trades:${deps.network}:${m.address}:${range.blocks}:${range.fromBlock ?? "head"}:${limit}`,
    15_000,
    async () => {
      if (deps.indexerUrl && range.fromBlock === null) {
        try {
          return await tradesFromIndexer(deps, m.address, limit);
        } catch (e) {
          const fallback = await tradesFromLogs(deps, book, range, limit, m.kuruVersion ?? 1, venue);
          return {
            ...fallback,
            note: `The indexer failed (${e instanceof Error ? e.message : "unknown error"}); ${fallback.note}`,
          };
        }
      }
      return tradesFromLogs(deps, book, range, limit, m.kuruVersion ?? 1, venue);
    },
    deps.now(),
  );
}

export const TRADE_CSV_COLUMNS = [
  "block",
  "time",
  "tx",
  "logIndex",
  "takerSide",
  "price",
  "sizeYes",
  "notionalUsdc",
  "maker",
  "makerIsHunchMaker",
  "taker",
  "trader",
  "viaRouter",
  "traderIsHunch",
] as const;

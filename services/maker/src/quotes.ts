import type { L2Book } from "@hunch-book/shared";

// Pure quote construction. Prices are integers in the book's pricePrecision units (1e6 = 1 USDC);
// sizes are bigints in its sizePrecision units (1e6 = 1 YES). Nothing here touches the chain.

/** The Kuru book's fixed parameters, read once from getMarketParams(). */
export interface BookSpec {
  pricePrecision: number;
  sizePrecision: bigint;
  tickSize: number;
  minSize: bigint;
  maxSize: bigint;
  baseDecimals: number;
  quoteDecimals: number;
  /** Kuru v2: the smallest and largest order, in quote (pricePrecision units times size / sizePrecision). */
  minQuoteNotional?: bigint;
  maxQuoteNotional?: bigint;
}

const ceilDiv = (a: bigint, b: bigint) => (a === 0n ? 0n : (a - 1n) / b + 1n);

/** The smallest size the book accepts at `price`: v1 minSize, v2 the size whose notional reaches the minimum. */
export function minSizeAt(price: number, book: BookSpec): bigint {
  if (book.minQuoteNotional === undefined || price <= 0) return book.minSize;
  const byNotional = ceilDiv(book.minQuoteNotional * book.sizePrecision, BigInt(price));
  return byNotional > book.minSize ? byNotional : book.minSize;
}

/** The largest size the book accepts at `price`: v1 maxSize, v2 the size whose notional stays under the maximum. */
export function maxSizeAt(price: number, book: BookSpec): bigint {
  if (book.maxQuoteNotional === undefined || price <= 0) return book.maxSize;
  const byNotional = (book.maxQuoteNotional * book.sizePrecision) / BigInt(price);
  return byNotional < book.maxSize ? byNotional : book.maxSize;
}

export interface QuoteParams {
  /** Half the spread around the reservation price, before widening (0.015 = 1.5 cents). */
  halfSpread: number;
  /** The narrowest total spread ever quoted (0.02 = 2 cents). */
  minSpread: number;
  /** How far quotes move when inventory sits at the cap (0.02 = 2 cents). */
  skew: number;
  levels: number;
  /** Distance between levels on the same side. */
  levelStep: number;
  /** Tokens per level. */
  orderSize: number;
  /** The most net YES (or NO) the bot will hold in one market, in tokens. */
  inventoryCap: number;
  minPrice: number;
  maxPrice: number;
}

export interface Order {
  price: number;
  size: bigint;
}

export interface Quotes {
  bids: Order[];
  asks: Order[];
}

export interface Ladder {
  /** Best first. */
  bids: number[];
  /** Best first. */
  asks: number[];
  reservation: number;
  halfSpread: number;
}

const EPS = 1e-9;
const floorTick = (units: number, tick: number) => Math.floor(units / tick + EPS) * tick;
const ceilTick = (units: number, tick: number) => Math.ceil(units / tick - EPS) * tick;
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** 1 at `widenSeconds` or more before close, rising linearly to `widenMax` at close. */
export function widenFactor(secondsToClose: number, widenSeconds: number, widenMax: number): number {
  if (widenSeconds <= 0) return 1;
  return 1 + (widenMax - 1) * clamp(1 - secondsToClose / widenSeconds, 0, 1);
}

/**
 * Bid and ask prices: fair ± half-spread around a reservation price skewed by inventory, snapped to the
 * tick (bids down, asks up), clamped to [minPrice, maxPrice], never narrower than minSpread, and never
 * crossing someone else's resting order (the bot only posts; it never takes).
 */
export function priceLadder(input: {
  fair: number;
  /** Net YES held, in tokens (negative = net NO). */
  position: number;
  widen: number;
  params: QuoteParams;
  book: BookSpec;
  /** Best bid and ask of other traders, in price units; null when that side is empty. */
  external: { bestBid: number | null; bestAsk: number | null };
}): Ladder {
  const { fair, position, widen, params, book, external } = input;
  const pp = book.pricePrecision;
  const tick = book.tickSize;
  const halfSpread = Math.max(params.halfSpread * widen, params.minSpread / 2);
  const inventory = params.inventoryCap > 0 ? clamp(position / params.inventoryCap, -1, 1) : 0;
  const reservation = fair - params.skew * inventory;

  const lo = ceilTick(params.minPrice * pp, tick);
  const hi = floorTick(params.maxPrice * pp, tick);
  const minSpread = ceilTick(params.minSpread * pp, tick);
  let bid = clamp(floorTick((reservation - halfSpread) * pp, tick), lo, hi);
  let ask = clamp(ceilTick((reservation + halfSpread) * pp, tick), lo, hi);
  if (ask - bid < minSpread) {
    if (ask >= hi) bid = ask - minSpread;
    else ask = bid + minSpread;
  }
  if (external.bestAsk !== null && bid >= external.bestAsk) bid = external.bestAsk - tick;
  if (external.bestBid !== null && ask <= external.bestBid) ask = external.bestBid + tick;

  const step = Math.max(tick, ceilTick(params.levelStep * pp, tick));
  const bids: number[] = [];
  const asks: number[] = [];
  for (let i = 0; i < params.levels; i++) {
    const b = bid - i * step;
    const a = ask + i * step;
    if (b >= lo && b <= hi) bids.push(b);
    if (a >= lo && a <= hi) asks.push(a);
  }
  return { bids, asks, reservation, halfSpread };
}

/** USDC (base units) Kuru debits from the margin account to place a buy: rounded up, as OrderBook does. */
export function quoteCostToPlace(price: number, size: bigint, book: BookSpec): bigint {
  const raw = BigInt(price) * size;
  const ceil = (raw + book.sizePrecision - 1n) / book.sizePrecision;
  return (ceil * 10n ** BigInt(book.quoteDecimals)) / BigInt(book.pricePrecision);
}

/** USDC (base units) Kuru credits back when a resting buy is cancelled: rounded down. */
export function quoteRefundOnCancel(price: number, size: bigint, book: BookSpec): bigint {
  const floor = (BigInt(price) * size) / book.sizePrecision;
  return (floor * 10n ** BigInt(book.quoteDecimals)) / BigInt(book.pricePrecision);
}

/** Base-token units behind a size (for a sell, or what a filled buy delivers). */
export function baseAmount(size: bigint, book: BookSpec): bigint {
  return (size * 10n ** BigInt(book.baseDecimals)) / book.sizePrecision;
}

/** The largest size whose placement cost fits in `budget` USDC base units. */
export function affordableSize(budget: bigint, price: number, book: BookSpec): bigint {
  if (budget <= 0n || price <= 0) return 0n;
  let size =
    (budget * BigInt(book.pricePrecision) * book.sizePrecision) /
    (10n ** BigInt(book.quoteDecimals) * BigInt(price));
  while (size > 0n && quoteCostToPlace(price, size, book) > budget) size -= 1n;
  return size;
}

const tokensToSize = (tokens: number, book: BookSpec) =>
  tokens <= 0 ? 0n : BigInt(Math.floor(tokens * Number(book.sizePrecision)));
const minBig = (...xs: bigint[]) => xs.reduce((m, x) => (x < m ? x : m));

/**
 * Sizes for each price level. Asks are limited by how far the bot may go short YES (cap + position) and
 * by YES it holds or can mint from USDC; bids by how far it may go long (cap − position) and by the USDC
 * left after minting. Levels below the book's minimum (size on v1, notional on v2) are dropped, and no
 * level exceeds its maximum.
 */
export function sizeQuotes(input: {
  ladder: Ladder;
  params: QuoteParams;
  book: BookSpec;
  position: number;
  /** YES the bot holds anywhere (wallet, margin account, its resting asks), base units. */
  yesAvailable: bigint;
  /** USDC the bot can use (wallet, margin account, its resting bids), base units. */
  usdcAvailable: bigint;
}): Quotes & { mint: bigint } {
  const { ladder, params, book, position, yesAvailable, usdcAvailable } = input;
  const perLevel = minBig(tokensToSize(params.orderSize, book), book.maxSize);
  const asks: Order[] = [];
  const bids: Order[] = [];

  // A YES costs one USDC to mint (both have the same decimals), so asks can draw on USDC too.
  let askRoom = tokensToSize(params.inventoryCap + position, book);
  let askFunds = yesAvailable + usdcAvailable;
  for (const price of ladder.asks) {
    const fundable = (askFunds * book.sizePrecision) / 10n ** BigInt(book.baseDecimals);
    const size = minBig(perLevel, askRoom, fundable, maxSizeAt(price, book));
    if (size < minSizeAt(price, book) || size <= 0n) break;
    asks.push({ price, size });
    askRoom -= size;
    askFunds -= baseAmount(size, book);
  }
  const askBase = asks.reduce((sum, o) => sum + baseAmount(o.size, book), 0n);
  const mint = askBase > yesAvailable ? askBase - yesAvailable : 0n;

  let bidRoom = tokensToSize(params.inventoryCap - position, book);
  let budget = usdcAvailable - mint;
  for (const price of ladder.bids) {
    const size = minBig(perLevel, bidRoom, affordableSize(budget, price, book), maxSizeAt(price, book));
    if (size < minSizeAt(price, book) || size <= 0n) break;
    bids.push({ price, size });
    bidRoom -= size;
    budget -= quoteCostToPlace(price, size, book);
  }
  return { bids, asks, mint };
}

export interface FundingPlan {
  /** Complete sets to mint on the vault first (USDC → YES + NO). */
  mint: bigint;
  /** YES to move from the wallet into Kuru's margin account before the batch. */
  depositYes: bigint;
  /** USDC to move from the wallet into the margin account before the batch. */
  depositUsdc: bigint;
}

/**
 * What must happen before one batchUpdate can place `quotes`. The batch cancels first, so the bot's
 * resting orders refund into the margin account before the new ones draw on it.
 */
export function planFunding(input: {
  quotes: Quotes;
  book: BookSpec;
  marginYes: bigint;
  marginUsdc: bigint;
  /** Refunded into the margin account by this batch's cancels. */
  lockedYes: bigint;
  lockedUsdc: bigint;
  walletYes: bigint;
  walletUsdc: bigint;
}): FundingPlan {
  const { quotes, book } = input;
  const needYes = quotes.asks.reduce((s, o) => s + baseAmount(o.size, book), 0n);
  const needUsdc = quotes.bids.reduce((s, o) => s + quoteCostToPlace(o.price, o.size, book), 0n);
  const shortYes = needYes - input.marginYes - input.lockedYes;
  const depositYes = shortYes > 0n ? shortYes : 0n;
  const mint = depositYes > input.walletYes ? depositYes - input.walletYes : 0n;
  const shortUsdc = needUsdc - input.marginUsdc - input.lockedUsdc;
  const depositUsdc = shortUsdc > 0n ? shortUsdc : 0n;
  if (mint + depositUsdc > input.walletUsdc) {
    throw new Error(`plan needs ${mint + depositUsdc} USDC from the wallet, which holds ${input.walletUsdc}`);
  }
  return { mint, depositYes, depositUsdc };
}

/**
 * Best bid and ask of everyone but the bot: the L2 book with the bot's own resting sizes removed.
 * `own` holds the bot's remaining sizes by price.
 */
export function externalTopOfBook(
  book: L2Book,
  own: { bids: Map<number, bigint>; asks: Map<number, bigint> },
): { bestBid: number | null; bestAsk: number | null } {
  const first = (levels: L2Book["bids"], mine: Map<number, bigint>) => {
    for (const level of levels) {
      const price = Number(level.price);
      if (level.size > (mine.get(price) ?? 0n)) return price;
    }
    return null;
  };
  return { bestBid: first(book.bids, own.bids), bestAsk: first(book.asks, own.asks) };
}

const sortOrders = (orders: Order[]) =>
  [...orders].sort((a, b) => a.price - b.price || (a.size < b.size ? -1 : a.size > b.size ? 1 : 0));

/** True when two order sets rest at the same prices with the same sizes. */
export function sameQuotes(a: Quotes, b: Quotes): boolean {
  const eq = (x: Order[], y: Order[]) => {
    if (x.length !== y.length) return false;
    const xs = sortOrders(x);
    const ys = sortOrders(y);
    return xs.every((o, i) => o.price === ys[i]?.price && o.size === ys[i]?.size);
  };
  return eq(a.bids, b.bids) && eq(a.asks, b.asks);
}

export type RequoteReason = "no-orders" | "pull" | "fill" | "fair-moved" | "quotes-moved" | "heartbeat";

/**
 * Whether to cancel and replace now. The bot requotes when it has nothing resting, after fills, when
 * fair value or its best prices moved by at least `threshold`, and otherwise at most once per heartbeat.
 */
export function decideRequote(input: {
  live: Quotes;
  desired: Quotes;
  fair: number;
  lastFair: number | null;
  filled: boolean;
  now: number;
  lastQuoteAt: number | null;
  heartbeatSeconds: number;
  threshold: number;
  pricePrecision: number;
}): RequoteReason | null {
  const { live, desired } = input;
  if (sameQuotes(live, desired)) return null;
  const liveEmpty = live.bids.length + live.asks.length === 0;
  const desiredEmpty = desired.bids.length + desired.asks.length === 0;
  if (liveEmpty) return "no-orders";
  if (desiredEmpty) return "pull";
  if (input.filled) return "fill";
  if (input.lastFair === null || Math.abs(input.fair - input.lastFair) >= input.threshold)
    return "fair-moved";
  const moved = (x: Order[], y: Order[], best: (p: number[]) => number) => {
    if (x.length === 0 || y.length === 0) return x.length !== y.length;
    const gap = Math.abs(best(x.map((o) => o.price)) - best(y.map((o) => o.price)));
    return gap >= input.threshold * input.pricePrecision;
  };
  const max = (p: number[]) => Math.max(...p);
  const min = (p: number[]) => Math.min(...p);
  if (moved(live.bids, desired.bids, max) || moved(live.asks, desired.asks, min)) return "quotes-moved";
  if (input.lastQuoteAt === null || input.now - input.lastQuoteAt >= input.heartbeatSeconds)
    return "heartbeat";
  return null;
}

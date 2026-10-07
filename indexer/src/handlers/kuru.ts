// Kuru order books of graduated markets (registered from the Graduator's events in graduator.ts).
//
// Kuru v1's Trade event, as read on Monad testnet (contracts/script/TradeTestnet.s.sol):
// - isBuy is the taker's side: true when the taker bought YES from a resting ask.
// - price has 18 decimals; filledSize is in the book's size precision, 10^6 for Hunch Book books,
//   which is the YES token's base unit.
// - takerAddress is our router for router trades; txOrigin is then the trader.
// - updatedSize is the maker order's size left after the fill.
//
// Kuru v2's SpotSwap event (docs/PROTOCOL.md section 8.1): one per taker swap, with the amount in used
// and the amount out after Kuru's fee, and no makers. isBuy is true when the taker bought YES with USDC;
// executor is our router for router trades, and the transaction sender is then the trader. A v2 fill is
// the whole swap at its average price, with the maker unknown: it never counts as our maker's or as a
// fill between others (ProtocolStats.fillCountMakerUnknown).
import { type Book, indexer } from "envio";
import { averagePriceE6, kuruNotional, kuruPriceE6 } from "../lib/math.js";
import { addr, isOurMaker, isRouter, ZERO_ADDRESS } from "../lib/network.js";
import { type Mut, Unit } from "../lib/store.js";

const orderId = (book: string, id: bigint): string => `${addr(book)}-${id}`;

/** One fill, from either Kuru version. */
interface Fill {
  kuruVersion: number;
  orderId: bigint | undefined;
  /** Undefined when the event does not name the maker (Kuru v2). */
  maker: string | undefined;
  taker: string;
  txOrigin: string;
  takerBuysYes: boolean;
  priceE18: bigint | undefined;
  priceE6: bigint;
  size: bigint;
  notional: bigint;
  makerRemaining: bigint | undefined;
}

/** The book an event came from, or undefined (logged) if the indexer never registered it. */
async function bookOf(u: Unit) {
  const book = await u.find("Book", u.m.src);
  if (!book) u.log.warn("fill on a book the indexer has not registered", { book: u.m.src, event: u.m.id });
  return book;
}

/** Records one fill: the Trade, both sides' wallets and USDC, the market, the book and the totals. */
async function recordFill(u: Unit, book: Mut<Book>, f: Fill): Promise<void> {
  const marketId = book.market_id;
  const viaRouter = isRouter(u.m.chainId, f.taker);
  const trader = viaRouter ? f.txOrigin : f.taker;
  const makerKnown = f.maker !== undefined;
  const maker = f.maker ?? ZERO_ADDRESS;
  const ourMaker = makerKnown && isOurMaker(u.m.chainId, maker);

  const makerWallet = makerKnown ? await u.wallet(maker) : undefined;
  const traderWallet = await u.wallet(trader);
  const makerIsOurs = makerWallet?.isOurs ?? false;
  const traderIsOurs = traderWallet.isOurs;
  const betweenOthers = makerKnown && !makerIsOurs && !traderIsOurs;

  u.create("Trade", {
    id: u.m.id,
    market_id: marketId,
    book_id: book.id,
    kuruVersion: f.kuruVersion,
    orderId: f.orderId,
    maker,
    makerKnown,
    taker: f.taker,
    txOrigin: f.txOrigin,
    trader,
    viaRouter,
    takerBuysYes: f.takerBuysYes,
    priceE18: f.priceE18,
    priceE6: f.priceE6,
    size: f.size,
    notional: f.notional,
    makerRemaining: f.makerRemaining,
    isOurMaker: ourMaker,
    makerIsOurs,
    traderIsOurs,
    betweenOthers,
    block: u.m.block,
    timestamp: u.m.timestamp,
    tx: u.m.tx,
    logIndex: u.m.logIndex,
  });

  // Both sides traded. A self-trade counts once for the wallet.
  for (const wallet of new Set([makerWallet, traderWallet])) {
    if (!wallet) continue;
    wallet.fillCount += 1;
    wallet.fillVolume += f.notional;
    await u.participate(wallet, "trade");
  }

  // USDC flows. The maker's when it is known; the taker's only when it traded the book directly,
  // because a router trade's USDC is recorded once, from the router's own event.
  if (makerKnown) {
    const makerPosition = await u.position(marketId, maker);
    if (f.takerBuysYes) makerPosition.usdcReceived += f.notional;
    else makerPosition.usdcSpent += f.notional;
    makerPosition.updatedAt = u.m.timestamp;
  }
  if (!viaRouter) {
    const traderPosition = await u.position(marketId, trader);
    if (f.takerBuysYes) traderPosition.usdcSpent += f.notional;
    else traderPosition.usdcReceived += f.notional;
    traderPosition.updatedAt = u.m.timestamp;
  }

  const market = await u.market(marketId);
  for (const target of [market, book]) {
    if (!target) continue;
    target.fillCount += 1;
    target.volume += f.notional;
    target.lastPriceE6 = f.priceE6;
    if (ourMaker) {
      target.fillCountOurMaker += 1;
      target.volumeOurMaker += f.notional;
    }
    if (!makerKnown) target.fillCountMakerUnknown += 1;
  }
  if (market) market.lastFillAt = u.m.timestamp;

  const s = await u.stats();
  const d = await u.daily();
  s.fillCount += 1;
  s.volume += f.notional;
  d.fillCount += 1;
  d.volume += f.notional;
  if (ourMaker) {
    s.fillCountOurMaker += 1;
    s.volumeOurMaker += f.notional;
    d.fillCountOurMaker += 1;
    d.volumeOurMaker += f.notional;
  }
  if (!makerKnown) {
    s.fillCountMakerUnknown += 1;
    s.volumeMakerUnknown += f.notional;
    d.fillCountMakerUnknown += 1;
  }
  if (traderIsOurs) s.fillCountOurTrader += 1;
  if (betweenOthers) {
    s.fillCountBetweenOthers += 1;
    s.volumeBetweenOthers += f.notional;
    d.fillCountBetweenOthers += 1;
  }
}

indexer.onEvent({ contract: "KuruOrderBook", event: "Trade" }, async ({ event, context }) => {
  const u = await Unit.start(context, event, "Trade");
  if (!u) return;
  const book = await bookOf(u);
  if (!book) return;
  const p = event.params;
  await recordFill(u, book, {
    kuruVersion: 1,
    orderId: p.orderId,
    maker: addr(p.makerAddress),
    taker: addr(p.takerAddress),
    txOrigin: addr(p.txOrigin),
    takerBuysYes: p.isBuy,
    priceE18: p.price,
    priceE6: kuruPriceE6(p.price),
    size: p.filledSize,
    notional: kuruNotional(p.filledSize, p.price),
    makerRemaining: p.updatedSize,
  });

  const order = await u.find("BookOrder", orderId(book.id, p.orderId));
  if (order) {
    order.remaining = p.updatedSize;
    if (p.updatedSize === 0n) order.status = "Filled";
    order.updatedAt = u.m.timestamp;
  }
  u.flush();
});

indexer.onEvent({ contract: "KuruSpotBook", event: "SpotSwap" }, async ({ event, context }) => {
  const u = await Unit.start(context, event, "Trade");
  if (!u) return;
  const book = await bookOf(u);
  if (!book) return;
  const p = event.params;
  // A buy pays USDC in and gets YES out; a sell pays YES in and gets USDC out.
  const size = p.isBuy ? p.amountOut : p.amountInUsed;
  const notional = p.isBuy ? p.amountInUsed : p.amountOut;
  if (size === 0n) {
    u.log.warn("swap with no YES moved", { book: u.m.src, event: u.m.id });
    return;
  }
  await recordFill(u, book, {
    kuruVersion: 2,
    orderId: undefined,
    maker: undefined,
    taker: addr(p.executor),
    txOrigin: u.m.from,
    takerBuysYes: p.isBuy,
    priceE18: undefined,
    priceE6: averagePriceE6(notional, size),
    size,
    notional,
    makerRemaining: undefined,
  });
  u.flush();
});

indexer.onEvent({ contract: "KuruOrderBook", event: "OrderCreated" }, async ({ event, context }) => {
  const u = new Unit(context, event);
  const p = event.params;
  const id = orderId(u.m.src, p.orderId);
  if (await u.exists("BookOrder", id)) return;
  const book = await u.find("Book", u.m.src);
  if (!book) {
    u.log.warn("order on a book the indexer has not registered", { book: u.m.src, event: u.m.id });
    return;
  }
  const ourMaker = isOurMaker(u.m.chainId, p.owner);
  u.create("BookOrder", {
    id,
    book_id: book.id,
    market_id: book.market_id,
    orderId: p.orderId,
    owner: addr(p.owner),
    isBuy: p.isBuy,
    // Hunch Book books use price precision 10^6: Kuru's order price is already USDC base units per YES.
    priceE6: p.price,
    size: p.size,
    remaining: p.size,
    status: "Open",
    isOurMaker: ourMaker,
    createdAt: u.m.timestamp,
    createdAtBlock: u.m.block,
    updatedAt: u.m.timestamp,
    tx: u.m.tx,
  });
  book.orderCount += 1;
  const s = await u.stats();
  s.orderCount += 1;
  if (ourMaker) {
    book.orderCountOurMaker += 1;
    s.orderCountOurMaker += 1;
  }
  u.flush();
});

async function cancel(u: Unit, ids: readonly bigint[]): Promise<void> {
  for (const id of ids) {
    const order = await u.find("BookOrder", orderId(u.m.src, id));
    if (order?.status !== "Open") continue;
    order.status = "Cancelled";
    order.updatedAt = u.m.timestamp;
  }
  u.flush();
}

indexer.onEvent({ contract: "KuruOrderBook", event: "OrderCanceled" }, async ({ event, context }) => {
  await cancel(new Unit(context, event), [event.params.orderId]);
});

indexer.onEvent({ contract: "KuruOrderBook", event: "OrdersCanceled" }, async ({ event, context }) => {
  await cancel(new Unit(context, event), event.params.orderId);
});

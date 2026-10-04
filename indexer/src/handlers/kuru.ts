// Kuru order books of graduated markets (registered from the Graduator's events in graduator.ts).
//
// Kuru's Trade event, as read on Monad testnet (contracts/script/TradeTestnet.s.sol):
// - isBuy is the taker's side: true when the taker bought YES from a resting ask.
// - price has 18 decimals; filledSize is in the book's size precision, 10^6 for Hunch Book books,
//   which is the YES token's base unit.
// - takerAddress is our router for router trades; txOrigin is then the trader.
// - updatedSize is the maker order's size left after the fill.
import { indexer } from "envio";
import { kuruNotional, kuruPriceE6 } from "../lib/math.js";
import { addr, isOurMaker, networkOf } from "../lib/network.js";
import { Unit } from "../lib/store.js";

const orderId = (book: string, id: bigint): string => `${addr(book)}-${id}`;

indexer.onEvent({ contract: "KuruOrderBook", event: "Trade" }, async ({ event, context }) => {
  const u = await Unit.start(context, event, "Trade");
  if (!u) return;
  const book = await u.find("Book", u.m.src);
  if (!book) {
    u.log.warn("fill on a book the indexer has not registered", { book: u.m.src, event: u.m.id });
    return;
  }
  const marketId = book.market_id;
  const p = event.params;
  const maker = addr(p.makerAddress);
  const taker = addr(p.takerAddress);
  const txOrigin = addr(p.txOrigin);
  const viaRouter = taker === networkOf(u.m.chainId).contracts.router;
  const trader = viaRouter ? txOrigin : taker;
  const size = p.filledSize;
  const notional = kuruNotional(size, p.price);
  const priceE6 = kuruPriceE6(p.price);
  const takerBuysYes = p.isBuy;
  const ourMaker = isOurMaker(u.m.chainId, maker);

  const makerWallet = await u.wallet(maker);
  const traderWallet = await u.wallet(trader);
  const makerIsOurs = makerWallet.isOurs;
  const traderIsOurs = traderWallet.isOurs;
  const betweenOthers = !makerIsOurs && !traderIsOurs;

  u.create("Trade", {
    id: u.m.id,
    market_id: marketId,
    book_id: book.id,
    orderId: p.orderId,
    maker,
    taker,
    txOrigin,
    trader,
    viaRouter,
    takerBuysYes,
    priceE18: p.price,
    priceE6,
    size,
    notional,
    makerRemaining: p.updatedSize,
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
    wallet.fillCount += 1;
    wallet.fillVolume += notional;
    await u.participate(wallet, "trade");
  }

  // USDC flows. The maker's always; the taker's only when it traded the book directly, because a
  // router trade's USDC is recorded once, from the router's own event.
  const makerPosition = await u.position(marketId, maker);
  if (takerBuysYes) makerPosition.usdcReceived += notional;
  else makerPosition.usdcSpent += notional;
  makerPosition.updatedAt = u.m.timestamp;
  if (!viaRouter) {
    const traderPosition = await u.position(marketId, trader);
    if (takerBuysYes) traderPosition.usdcSpent += notional;
    else traderPosition.usdcReceived += notional;
    traderPosition.updatedAt = u.m.timestamp;
  }

  const market = await u.market(marketId);
  for (const target of [market, book]) {
    if (!target) continue;
    target.fillCount += 1;
    target.volume += notional;
    target.lastPriceE6 = priceE6;
    if (ourMaker) {
      target.fillCountOurMaker += 1;
      target.volumeOurMaker += notional;
    }
  }
  if (market) market.lastFillAt = u.m.timestamp;

  const s = await u.stats();
  const d = await u.daily();
  s.fillCount += 1;
  s.volume += notional;
  d.fillCount += 1;
  d.volume += notional;
  if (ourMaker) {
    s.fillCountOurMaker += 1;
    s.volumeOurMaker += notional;
    d.fillCountOurMaker += 1;
    d.volumeOurMaker += notional;
  }
  if (traderIsOurs) s.fillCountOurTrader += 1;
  if (betweenOthers) {
    s.fillCountBetweenOthers += 1;
    s.volumeBetweenOthers += notional;
    d.fillCountBetweenOthers += 1;
  }

  const order = await u.find("BookOrder", orderId(book.id, p.orderId));
  if (order) {
    order.remaining = p.updatedSize;
    if (p.updatedSize === 0n) order.status = "Filled";
    order.updatedAt = u.m.timestamp;
  }
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

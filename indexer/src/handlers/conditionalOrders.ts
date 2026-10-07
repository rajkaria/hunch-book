// ConditionalOrders (docs/PERIPHERY.md): take-profit, stop-loss and limit orders, from placement to
// execution or cancellation. An execution trades through the router with the contract as the router's
// user; OrderExecuted, the transaction's last event, hands that trade and its USDC to the order's owner.
import { indexer } from "envio";
import { conditionOf, isBuyKind, routerKindOf } from "../lib/enums.js";
import { addr, scopedId } from "../lib/network.js";
import { Unit } from "../lib/store.js";

/**
 * How far back OrderExecuted looks for its router Trade. Between the two, ConditionalOrders only resets
 * one approval and makes at most four transfers (output, tip, two refunds).
 */
const ROUTER_TRADE_LOOKBACK = 16;

indexer.onEvent({ contract: "ConditionalOrders", event: "OrderPlaced" }, async ({ event, context }) => {
  const u = new Unit(context, event);
  const p = event.params;
  // Each stack's ConditionalOrders numbers its own orders.
  const id = scopedId(u.m.chainId, u.m.src, p.orderId.toString());
  if (await u.exists("ConditionalOrder", id)) return;
  const owner = await u.wallet(p.owner);
  const marketId = addr(p.market);
  u.create("ConditionalOrder", {
    id,
    orderId: p.orderId,
    stack: u.stackConstants().name,
    owner_id: owner.id,
    ownerIsOurs: owner.isOurs,
    market_id: marketId,
    kind: routerKindOf(p.kind),
    condition: conditionOf(p.condition),
    triggerPriceE6: p.triggerPriceE6,
    expiry: p.expiry,
    executorTipBps: Number(p.executorTipBps),
    amountIn: p.amountIn,
    limit: p.limit,
    status: "Open",
    placedAt: u.m.timestamp,
    placedAtBlock: u.m.block,
    placedTx: u.m.tx,
    executor: undefined,
    executorIsOurs: undefined,
    executedPriceE6: undefined,
    spent: undefined,
    received: undefined,
    tip: undefined,
    routerTrade_id: undefined,
    executedAt: undefined,
    executedAtBlock: undefined,
    executeTx: undefined,
    cancelledAt: undefined,
    cancelTx: undefined,
    updatedAt: u.m.timestamp,
  });
  const market = await u.market(marketId);
  if (market) {
    market.conditionalOrderCount += 1;
    market.conditionalOrdersOpen += 1;
  }
  const s = await u.stats();
  s.conditionalOrdersPlaced += 1;
  s.conditionalOrdersOpen += 1;
  (await u.daily()).conditionalOrdersPlaced += 1;
  u.flush();
});

/** The open order an event closes, or undefined if it is unknown or was closed before (seen already). */
async function openOrder(u: Unit, orderId: bigint) {
  const order = await u.find("ConditionalOrder", scopedId(u.m.chainId, u.m.src, orderId.toString()));
  if (!order) {
    u.log.warn("event for an order the indexer has not seen", { order: orderId.toString(), event: u.m.id });
    return undefined;
  }
  return order.status === "Open" ? order : undefined;
}

indexer.onEvent({ contract: "ConditionalOrders", event: "OrderCancelled" }, async ({ event, context }) => {
  const u = new Unit(context, event);
  const order = await openOrder(u, event.params.orderId);
  if (!order) return;
  order.status = "Cancelled";
  order.cancelledAt = u.m.timestamp;
  order.cancelTx = u.m.tx;
  order.updatedAt = u.m.timestamp;
  const market = await u.market(order.market_id);
  if (market) market.conditionalOrdersOpen -= 1;
  const s = await u.stats();
  s.conditionalOrdersOpen -= 1;
  s.conditionalOrdersCancelled += 1;
  (await u.daily()).conditionalOrdersCancelled += 1;
  u.flush();
});

indexer.onEvent({ contract: "ConditionalOrders", event: "OrderExecuted" }, async ({ event, context }) => {
  const u = new Unit(context, event);
  const order = await openOrder(u, event.params.orderId);
  if (!order) return;
  const { priceE6, spent, received, tip } = event.params;
  const executor = addr(event.params.executor);
  const executorIsOurs = await u.isOurs(executor);
  order.status = "Executed";
  order.executor = executor;
  order.executorIsOurs = executorIsOurs;
  order.executedPriceE6 = priceE6;
  order.spent = spent;
  order.received = received;
  order.tip = tip;
  order.executedAt = u.m.timestamp;
  order.executedAtBlock = u.m.block;
  order.executeTx = u.m.tx;
  order.updatedAt = u.m.timestamp;

  // The owner traded: the router trade moves to the owner, who counts as a trader.
  const owner = await u.wallet(order.owner_id);
  // The router's user was this ConditionalOrders contract.
  const contract = u.m.src;
  const trade = await u.findBack(
    "RouterTrade",
    ROUTER_TRADE_LOOKBACK,
    (t) =>
      t.user_id === contract &&
      t.conditionalOrder_id === undefined &&
      t.market_id === order.market_id &&
      t.kind === order.kind,
  );
  if (trade) {
    trade.user_id = owner.id;
    trade.userIsOurs = owner.isOurs;
    trade.conditionalOrder_id = order.id;
    order.routerTrade_id = trade.id;
    owner.routerTradeCount += 1;
    owner.routerVolume += trade.usdc;
  } else {
    u.log.warn("no router trade found for an executed order", { order: order.id, event: u.m.id });
  }
  await u.participate(owner, "trade");
  // The owner's USDC: what was spent on a buy, what arrived after the tip on a sell.
  const position = await u.position(order.market_id, owner.id);
  if (isBuyKind(order.kind)) position.usdcSpent += spent;
  else position.usdcReceived += received;
  position.updatedAt = u.m.timestamp;

  const market = await u.market(order.market_id);
  if (market) {
    market.conditionalOrdersOpen -= 1;
    market.conditionalOrdersExecuted += 1;
  }
  const s = await u.stats();
  s.conditionalOrdersOpen -= 1;
  s.conditionalOrdersExecuted += 1;
  if (executorIsOurs) s.conditionalOrdersExecutedByUs += 1;
  (await u.daily()).conditionalOrdersExecuted += 1;
  u.flush();
});

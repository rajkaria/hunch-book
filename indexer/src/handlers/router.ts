// HunchRouter: buy and sell YES or NO in one transaction. Each router trade also fills on the
// market's Kuru book (kuru.ts records those fills); this keeps the user's side of it.
import { indexer } from "envio";
import { isBuyKind, routerKindOf } from "../lib/enums.js";
import { averagePriceE6 } from "../lib/math.js";
import { addr, isConditionalOrders } from "../lib/network.js";
import { Unit } from "../lib/store.js";

indexer.onEvent({ contract: "HunchRouter", event: "Trade" }, async ({ event, context }) => {
  const u = await Unit.start(context, event, "RouterTrade");
  if (!u) return;
  const { user, amountIn, amountOut } = event.params;
  const marketId = addr(event.params.market);
  const kind = routerKindOf(event.params.kind);
  const buy = isBuyKind(kind);
  const usdc = buy ? amountIn : amountOut;
  const tokens = buy ? amountOut : amountIn;
  // ConditionalOrders trades for an order's owner. Its OrderExecuted, later in this transaction, moves
  // this trade to the owner (conditionalOrders.ts); the contract itself never counts as a trader.
  const forOrder = isConditionalOrders(u.m.chainId, user);

  const wallet = await u.wallet(user);
  if (!forOrder) {
    wallet.routerTradeCount += 1;
    wallet.routerVolume += usdc;
    await u.participate(wallet, "trade");
  }

  u.create("RouterTrade", {
    id: u.m.id,
    market_id: marketId,
    user_id: wallet.id,
    kind,
    amountIn,
    amountOut,
    usdc,
    tokens,
    priceE6: averagePriceE6(usdc, tokens),
    book: addr(event.params.book),
    conditionalOrder_id: undefined,
    userIsOurs: wallet.isOurs,
    block: u.m.block,
    timestamp: u.m.timestamp,
    tx: u.m.tx,
  });

  const market = await u.market(marketId);
  if (market) {
    market.routerTradeCount += 1;
    market.routerVolume += usdc;
  } else {
    u.log.warn("router trade on a market the indexer has not seen", { market: marketId, event: u.m.id });
  }
  if (!forOrder) {
    const position = await u.position(marketId, user);
    if (buy) position.usdcSpent += usdc;
    else position.usdcReceived += usdc;
    position.updatedAt = u.m.timestamp;
  }

  const s = await u.stats();
  s.routerTradeCount += 1;
  s.routerVolume += usdc;
  const d = await u.daily();
  d.routerTradeCount += 1;
  d.routerVolume += usdc;
  u.flush();
});

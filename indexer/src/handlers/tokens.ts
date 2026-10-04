// YES and NO outcome tokens (registered from the vault's MarketRegistered): balances per wallet and market.
import { indexer } from "envio";
import { addr, isPlumbing } from "../lib/network.js";
import { Unit } from "../lib/store.js";

indexer.onEvent({ contract: "OutcomeToken", event: "Transfer" }, async ({ event, context }) => {
  const u = await Unit.start(context, event, "TokenTransfer");
  if (!u) return;
  const token = await u.find("OutcomeToken", u.m.src);
  if (!token) {
    u.log.warn("transfer of a token the indexer has not registered", { token: u.m.src, event: u.m.id });
    return;
  }
  const marketId = token.market_id;
  const { value } = event.params;
  const from = addr(event.params.from);
  const to = addr(event.params.to);
  u.create("TokenTransfer", {
    id: u.m.id,
    market_id: marketId,
    side: token.side,
    from,
    to,
    amount: value,
    block: u.m.block,
    timestamp: u.m.timestamp,
    tx: u.m.tx,
  });
  // Mints and burns (the zero address) and the market, vault and router passing tokens through get no Position.
  for (const [holder, delta] of [
    [from, -value],
    [to, value],
  ] as const) {
    if (isPlumbing(u.m.chainId, holder, marketId)) continue;
    const position = await u.position(marketId, holder);
    if (token.side === "Yes") position.yesBalance += delta;
    else position.noBalance += delta;
    position.updatedAt = u.m.timestamp;
  }
  u.flush();
});

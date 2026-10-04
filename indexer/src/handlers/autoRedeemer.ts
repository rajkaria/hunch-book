// AutoRedeemer (docs/PERIPHERY.md): holders opt in and out, and anyone (the keeper, in practice)
// redeems their winning tokens for them. The vault's own Redeemed, earlier in the same transaction,
// already counts the redemption for the holder (vault.ts); this keeps who opted in and what the
// AutoRedeemer did.
import { type Enum, indexer } from "envio";
import { sideOf } from "../lib/enums.js";
import { addr } from "../lib/network.js";
import { pairId, Unit } from "../lib/store.js";

/** The holder's setting, created at its first event. */
async function optInOf(u: Unit, holder: string) {
  const wallet = await u.wallet(holder);
  return u.load("AutoRedeemOptIn", wallet.id, () => ({
    id: wallet.id,
    holder_id: wallet.id,
    holderIsOurs: wallet.isOurs,
    optedIn: false,
    optInCount: 0,
    firstOptedInAt: undefined,
    marketsOptedOut: 0,
    redemptionCount: 0,
    redeemedUsdc: 0n,
    failureCount: 0,
    updatedAt: u.m.timestamp,
    updatedAtBlock: u.m.block,
    updatedTx: u.m.tx,
  }));
}

function logChange(u: Unit, holder: string, kind: Enum<"AutoRedeemSettingKind">, market?: string): void {
  u.create("AutoRedeemSettingChange", {
    id: u.m.id,
    holder: addr(holder),
    kind,
    market_id: market ? addr(market) : undefined,
    block: u.m.block,
    timestamp: u.m.timestamp,
    tx: u.m.tx,
  });
}

indexer.onEvent({ contract: "AutoRedeemer", event: "OptInSet" }, async ({ event, context }) => {
  const u = await Unit.start(context, event, "AutoRedeemSettingChange");
  if (!u) return;
  const { holder, optedIn } = event.params;
  const row = await optInOf(u, holder);
  const s = await u.stats();
  if (optedIn && !row.optedIn) {
    s.autoRedeemHolders += 1;
    row.optInCount += 1;
    row.firstOptedInAt ??= u.m.timestamp;
  }
  if (!optedIn && row.optedIn) s.autoRedeemHolders -= 1;
  row.optedIn = optedIn;
  row.updatedAt = u.m.timestamp;
  row.updatedAtBlock = u.m.block;
  row.updatedTx = u.m.tx;
  logChange(u, holder, optedIn ? "OptIn" : "OptOut");
  u.flush();
});

indexer.onEvent({ contract: "AutoRedeemer", event: "MarketOptOutSet" }, async ({ event, context }) => {
  const u = await Unit.start(context, event, "AutoRedeemSettingChange");
  if (!u) return;
  const { holder, market, optedOut } = event.params;
  const row = await optInOf(u, holder);
  const id = pairId(market, holder);
  const optOut = await u.load("AutoRedeemMarketOptOut", id, () => ({
    id,
    optIn_id: row.id,
    holder: row.id,
    market_id: addr(market),
    optedOut: false,
    updatedAt: u.m.timestamp,
    updatedTx: u.m.tx,
  }));
  if (optedOut && !optOut.optedOut) row.marketsOptedOut += 1;
  if (!optedOut && optOut.optedOut) row.marketsOptedOut -= 1;
  optOut.optedOut = optedOut;
  optOut.updatedAt = u.m.timestamp;
  optOut.updatedTx = u.m.tx;
  row.updatedAt = u.m.timestamp;
  row.updatedAtBlock = u.m.block;
  row.updatedTx = u.m.tx;
  logChange(u, holder, optedOut ? "MarketOptOut" : "MarketOptIn", market);
  u.flush();
});

indexer.onEvent({ contract: "AutoRedeemer", event: "AutoRedeemed" }, async ({ event, context }) => {
  const u = await Unit.start(context, event, "AutoRedemption");
  if (!u) return;
  const { amount, paid } = event.params;
  const marketId = addr(event.params.market);
  const holder = addr(event.params.holder);
  const caller = addr(event.params.caller);
  const side = sideOf(event.params.side);
  // vault.redeem emitted Redeemed (then paid the holder) just before this event.
  const redemption = await u.findBack(
    "Redemption",
    8,
    (r) =>
      r.viaAutoRedeemer &&
      r.market_id === marketId &&
      r.wallet_id === holder &&
      r.side === side &&
      r.amount === amount,
  );
  const row = await optInOf(u, holder);
  const callerIsOurs = await u.isOurs(caller);
  u.create("AutoRedemption", {
    id: u.m.id,
    market_id: marketId,
    holder_id: holder,
    holderIsOurs: row.holderIsOurs,
    side,
    amount,
    paid,
    caller,
    callerIsOurs,
    redemption_id: redemption?.id,
    block: u.m.block,
    timestamp: u.m.timestamp,
    tx: u.m.tx,
  });
  row.redemptionCount += 1;
  row.redeemedUsdc += paid;
  const market = await u.market(marketId);
  if (market) {
    market.autoRedemptionCount += 1;
    market.autoRedeemedUsdc += paid;
  }
  const s = await u.stats();
  s.autoRedemptionCount += 1;
  s.autoRedeemedUsdc += paid;
  if (callerIsOurs) s.autoRedemptionCountOurCaller += 1;
  const d = await u.daily();
  d.autoRedemptionCount += 1;
  d.autoRedeemedUsdc += paid;
  u.flush();
});

indexer.onEvent({ contract: "AutoRedeemer", event: "RedeemFailed" }, async ({ event, context }) => {
  const u = await Unit.start(context, event, "AutoRedeemFailure");
  if (!u) return;
  const holder = addr(event.params.holder);
  u.create("AutoRedeemFailure", {
    id: u.m.id,
    market_id: addr(event.params.market),
    holder,
    reason: event.params.reason,
    caller: u.m.from,
    callerIsOurs: await u.isOurs(u.m.from),
    block: u.m.block,
    timestamp: u.m.timestamp,
    tx: u.m.tx,
  });
  (await optInOf(u, holder)).failureCount += 1;
  (await u.stats()).autoRedeemFailures += 1;
  u.flush();
});

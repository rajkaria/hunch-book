// ReferralRegistry (docs/PERIPHERY.md): who referred whom, for how long. The credit each binding earns
// is counted from the fee events while it is active (lib/referrals.ts, called from vault.ts and market.ts),
// and only from the markets of the registry's own stack.
import { indexer } from "envio";
import { addr } from "../lib/network.js";
import { Unit } from "../lib/store.js";

indexer.onEvent({ contract: "ReferralRegistry", event: "Bound" }, async ({ event, context }) => {
  const u = await Unit.start(context, event, "Referral");
  if (!u) return;
  const { boundAt, expiresAt } = event.params;
  const user = await u.wallet(event.params.user);
  const referrerId = addr(event.params.referrer);
  const relayer = addr(event.params.relayer);
  const relayed = relayer !== user.id;
  const relayerIsOurs = await u.isOurs(relayer);
  const referrerIsOurs = await u.isOurs(referrerId);
  const s = await u.stats();

  let referrer = await u.find("Referrer", referrerId);
  if (!referrer) {
    s.referrers += 1;
    referrer = u.create("Referrer", {
      id: referrerId,
      isOurs: referrerIsOurs,
      bindingCount: 0,
      userCount: 0,
      firstBoundAt: boundAt,
      lastBoundAt: boundAt,
      activeUntil: expiresAt,
      feeCount: 0,
      fees: 0n,
      protocolShare: 0n,
    });
  }
  referrer.bindingCount += 1;
  referrer.lastBoundAt = boundAt;
  if (expiresAt > referrer.activeUntil) referrer.activeUntil = expiresAt;

  const pairId = `${referrerId}-${user.id}`;
  let pair = await u.find("ReferredUser", pairId);
  if (!pair) {
    referrer.userCount += 1;
    pair = u.create("ReferredUser", {
      id: pairId,
      referrer_id: referrerId,
      user: user.id,
      bindingCount: 0,
      firstBoundAt: boundAt,
      expiresAt,
      feeCount: 0,
      fees: 0n,
      protocolShare: 0n,
    });
  }
  pair.bindingCount += 1;
  pair.expiresAt = expiresAt;

  const stack = u.stackConstants().name;
  u.create("Referral", {
    id: u.m.id,
    stack,
    user_id: user.id,
    userIsOurs: user.isOurs,
    referrer_id: referrerId,
    boundAt,
    expiresAt,
    relayer,
    relayed,
    relayerIsOurs,
    feeCount: 0,
    fees: 0n,
    protocolShare: 0n,
    block: u.m.block,
    timestamp: u.m.timestamp,
    tx: u.m.tx,
  });
  user.referral_id = u.m.id;
  const linkId = `${stack}-${user.id}`;
  const link = await u.load("ReferralLink", linkId, () => ({
    id: linkId,
    stack,
    user: user.id,
    referral_id: u.m.id,
  }));
  link.referral_id = u.m.id;

  s.referralBindings += 1;
  if (relayed && relayerIsOurs) s.referralBindingsRelayedByUs += 1;
  (await u.daily()).referralBindings += 1;
  u.flush();
});

// SnapshotResolver (template 7): the snapshots it takes. Each is written once onchain and every market
// on the same observation answers from it; markets link to it from their parameters (factory.ts).
import { indexer } from "envio";
import { addr } from "../lib/network.js";
import { snapshotId } from "../lib/params.js";
import { Unit } from "../lib/store.js";

indexer.onEvent({ contract: "SnapshotResolver", event: "SnapshotTaken" }, async ({ event, context }) => {
  const u = new Unit(context, event);
  const p = event.params;
  const id = snapshotId(u.m.src, p.key);
  if (await u.exists("Snapshot", id)) return;
  const taker = addr(p.caller);
  // Inside settle() the market calls the resolver, so the caller is a market.
  const takenInSettle = (await u.market(taker)) !== undefined;
  const senderIsOurs = await u.isOurs(u.m.from);
  u.create("Snapshot", {
    id,
    key: p.key.toLowerCase(),
    resolver: u.m.src,
    sourceId: Number(p.sourceId),
    closeTime: p.closeTime,
    snapshotWindow: Number(p.snapshotWindow),
    value: p.value,
    block: p.blockNumber,
    timestamp: p.timestamp,
    secondsAfterClose: p.timestamp - p.closeTime,
    taker,
    takenInSettle,
    sender: u.m.from,
    senderIsOurs,
    tx: u.m.tx,
  });
  const s = await u.stats();
  s.snapshotsTaken += 1;
  if (senderIsOurs) s.snapshotsTakenOurs += 1;
  (await u.daily()).snapshotsTaken += 1;
  u.flush();
});

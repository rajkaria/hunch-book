// ImpliedProbabilityOracle and OutcomeTokenPriceAdapterFactory (docs/PERIPHERY.md): each market's
// chance of YES as poked onchain, its checkpoint history, and the price adapters made for its tokens.
import { indexer } from "envio";
import { sideOf } from "../lib/enums.js";
import { addr, isKuruFeedFactory } from "../lib/network.js";
import { Unit } from "../lib/store.js";

indexer.onEvent({ contract: "ImpliedProbabilityOracle", event: "Poked" }, async ({ event, context }) => {
  const u = new Unit(context, event);
  const { chanceE6, spreadE6, stale, checkpoint } = event.params;
  const marketId = addr(event.params.market);
  const known = await u.find("OracleFeed", marketId);
  // The oracle takes at most one poke per market per block, so the block is this event's guard.
  if (known && known.lastPokedAtBlock >= u.m.block) return;
  const ours = await u.isOurs(u.m.from);
  const feed =
    known ??
    u.create("OracleFeed", {
      id: marketId,
      market_id: marketId,
      chanceE6: 0,
      spreadE6: 0,
      stale: false,
      pokeCount: 0,
      pokeCountOurs: 0,
      checkpointCount: 0,
      firstPokedAt: u.m.timestamp,
      lastPokedAt: u.m.timestamp,
      lastPokedAtBlock: u.m.block,
      lastPoker: u.m.from,
      lastPokeTx: u.m.tx,
    });
  feed.chanceE6 = Number(chanceE6);
  feed.spreadE6 = Number(spreadE6);
  feed.stale = stale;
  feed.pokeCount += 1;
  if (ours) feed.pokeCountOurs += 1;
  feed.lastPokedAt = u.m.timestamp;
  feed.lastPokedAtBlock = u.m.block;
  feed.lastPoker = u.m.from;
  feed.lastPokeTx = u.m.tx;

  const s = await u.stats();
  const d = await u.daily();
  if (checkpoint) {
    u.create("OracleCheckpoint", {
      id: `${marketId}-${u.m.block}`,
      feed_id: marketId,
      market_id: marketId,
      chanceE6: Number(chanceE6),
      spreadE6: Number(spreadE6),
      stale,
      pokerIsOurs: ours,
      block: u.m.block,
      timestamp: u.m.timestamp,
      tx: u.m.tx,
    });
    feed.checkpointCount += 1;
    s.oracleCheckpoints += 1;
  }
  const market = await u.market(marketId);
  if (market && market.oracle_id === undefined) market.oracle_id = marketId;
  s.oraclePokes += 1;
  d.oraclePokes += 1;
  if (ours) {
    s.oraclePokesOurs += 1;
    d.oraclePokesOurs += 1;
  }
  u.flush();
});

indexer.onEvent({ contract: "PriceAdapterFactory", event: "AdapterCreated" }, async ({ event, context }) => {
  const u = new Unit(context, event);
  const id = addr(event.params.adapter);
  if (await u.exists("PriceAdapter", id)) return; // one adapter per market and side, onchain
  u.create("PriceAdapter", {
    id,
    factory: u.m.src,
    kuruFeed: isKuruFeedFactory(u.m.chainId, u.m.src),
    market_id: addr(event.params.market),
    side: sideOf(event.params.side),
    creator: u.m.from,
    creatorIsOurs: await u.isOurs(u.m.from),
    block: u.m.block,
    timestamp: u.m.timestamp,
    tx: u.m.tx,
  });
  (await u.stats()).priceAdapters += 1;
  u.flush();
});

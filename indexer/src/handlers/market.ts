// Market clones: stakes, graduation, token claims, settlement, void and pool payouts.
// Markets are registered dynamically (factory.ts, vault.ts), so `event.srcAddress` is the market.
import { indexer } from "envio";
import { outcomeOf, sideOf } from "../lib/enums.js";
import { redeemFeePerTokenE6 } from "../lib/math.js";
import { addr } from "../lib/network.js";
import { pairId, Unit } from "../lib/store.js";

indexer.onEvent({ contract: "Market", event: "Staked" }, async ({ event, context }) => {
  const u = await Unit.start(context, event, "Stake");
  if (!u) return;
  const { user, amount, yesTotal, noTotal } = event.params;
  const side = sideOf(event.params.side);
  const market = await u.market(u.m.src);
  if (!market) {
    u.log.warn("stake on a market the indexer has not seen", { market: u.m.src, event: u.m.id });
    return;
  }

  // Distinct stakers, counted the way the contract counts them.
  const staker = await u.staker(market.id, user);
  if (staker.yesStake === 0n && staker.noStake === 0n) market.stakerCount += 1;
  if (side === "Yes") {
    if (staker.yesStake === 0n) market.yesStakerCount += 1;
    staker.yesStake += amount;
  } else {
    if (staker.noStake === 0n) market.noStakerCount += 1;
    staker.noStake += amount;
  }
  staker.stakeCount += 1;

  market.yesTotal = yesTotal;
  market.noTotal = noTotal;
  market.stakeCount += 1;
  market.lastStakeId = u.m.id;

  u.create("Stake", {
    id: u.m.id,
    market_id: market.id,
    wallet_id: addr(user),
    staker_id: pairId(market.id, user),
    side,
    amount,
    yesTotalAfter: yesTotal,
    noTotalAfter: noTotal,
    payer: undefined, // set by the vault's PoolDeposited, later in this transaction
    relayed: false,
    paidByUs: false,
    block: u.m.block,
    timestamp: u.m.timestamp,
    tx: u.m.tx,
    logIndex: u.m.logIndex,
  });

  const position = await u.position(market.id, user);
  if (side === "Yes") position.yesStaked += amount;
  else position.noStaked += amount;
  position.updatedAt = u.m.timestamp;

  const wallet = await u.wallet(user);
  wallet.stakeCount += 1;
  wallet.stakedUsdc += amount;
  await u.participate(wallet, "stake");

  const s = await u.stats();
  s.stakeCount += 1;
  s.stakedUsdc += amount;
  const d = await u.daily();
  d.stakeCount += 1;
  d.stakedUsdc += amount;
  u.flush();
});

indexer.onEvent({ contract: "Market", event: "Graduated" }, async ({ event, context }) => {
  const u = new Unit(context, event);
  if (await u.exists("Graduation", u.m.src)) return;
  const { total, yesTotal, noTotal, openingPriceE6 } = event.params;
  const book = addr(event.params.book);
  const market = await u.market(u.m.src);
  if (!market) {
    u.log.warn("graduation of a market the indexer has not seen", { market: u.m.src, event: u.m.id });
    return;
  }

  market.graduated = true;
  market.graduatedAt = u.m.timestamp;
  market.graduatedAtBlock = u.m.block;
  market.openingPriceE6 = openingPriceE6;
  market.book_id = book;
  market.redeemFeeYesE6 = redeemFeePerTokenE6(noTotal, total);
  market.redeemFeeNoE6 = redeemFeePerTokenE6(yesTotal, total);
  await u.setStage(market, "Graduated");
  (await u.stats()).marketsGraduatedTotal += 1;
  (await u.daily()).marketsGraduated += 1;

  // The Graduator's BookCreated or BookRegistered came first; this only covers a book we never saw.
  await u.load("Book", book, () => ({
    id: book,
    market_id: market.id,
    source: "Created",
    registrar: undefined,
    fillCount: 0,
    fillCountOurMaker: 0,
    volume: 0n,
    volumeOurMaker: 0n,
    lastPriceE6: undefined,
    orderCount: 0,
    orderCountOurMaker: 0,
    block: u.m.block,
    timestamp: u.m.timestamp,
    tx: u.m.tx,
  }));

  u.create("Graduation", {
    id: market.id,
    market_id: market.id,
    total,
    yesTotal,
    noTotal,
    openingPriceE6,
    book,
    stakerCount: market.stakerCount,
    caller: u.m.from,
    callerIsOurs: await u.isOurs(u.m.from),
    block: u.m.block,
    timestamp: u.m.timestamp,
    tx: u.m.tx,
  });
  u.flush();
});

indexer.onEvent({ contract: "Market", event: "TokensClaimed" }, async ({ event, context }) => {
  const u = await Unit.start(context, event, "TokenClaim");
  if (!u) return;
  const { user, amount } = event.params;
  const side = sideOf(event.params.side);
  const marketId = u.m.src;

  const staker = await u.staker(marketId, user);
  staker.tokensClaimed = true;
  const position = await u.position(marketId, user);
  if (side === "Yes") {
    staker.yesClaimed += amount;
    position.yesClaimed += amount;
  } else {
    staker.noClaimed += amount;
    position.noClaimed += amount;
  }
  position.updatedAt = u.m.timestamp;

  u.create("TokenClaim", {
    id: u.m.id,
    market_id: marketId,
    wallet_id: addr(user),
    side,
    amount,
    caller: u.m.from,
    pushedByUs: u.m.from !== addr(user) && (await u.isOurs(u.m.from)),
    block: u.m.block,
    timestamp: u.m.timestamp,
    tx: u.m.tx,
  });
  u.flush();
});

indexer.onEvent({ contract: "Market", event: "DustSwept" }, async ({ event, context }) => {
  const u = await Unit.start(context, event, "DustSweep");
  if (!u) return;
  u.create("DustSweep", {
    id: u.m.id,
    market_id: u.m.src,
    side: sideOf(event.params.side),
    amount: event.params.amount,
    to: addr(event.params.to),
    block: u.m.block,
    timestamp: u.m.timestamp,
    tx: u.m.tx,
  });
  u.flush();
});

indexer.onEvent({ contract: "Market", event: "Settled" }, async ({ event, context }) => {
  const u = new Unit(context, event);
  if (await u.exists("Settlement", u.m.src)) return;
  const market = await u.market(u.m.src);
  if (!market) {
    u.log.warn("settlement of a market the indexer has not seen", { market: u.m.src, event: u.m.id });
    return;
  }
  const outcome = outcomeOf(event.params.outcome);
  const settler = addr(event.params.settler);
  market.outcome = outcome;
  market.evidenceHash = event.params.evidenceHash;
  market.settler = settler;
  market.settledAt = u.m.timestamp;
  market.settledAtBlock = u.m.block;
  market.settleTx = u.m.tx;
  await u.setStage(market, "Settled");
  (await u.daily()).marketsSettled += 1;

  // Latency: settlement minus close, in the market's own clock. A touch market proved YES before
  // close settles "early" and is left out of the averages.
  const s = await u.stats();
  let latencySeconds: bigint | undefined;
  let latencyBlocks: bigint | undefined;
  let early = false;
  if (market.closeAt !== undefined && market.blockClock !== undefined) {
    const latency = (market.blockClock ? u.m.block : u.m.timestamp) - market.closeAt;
    early = latency < 0n;
    if (early) {
      s.earlySettlements += 1;
    } else if (market.blockClock) {
      latencyBlocks = latency;
      s.settlementsBlockClock += 1;
      s.settlementLatencyBlocksTotal += latency;
    } else {
      latencySeconds = latency;
      s.settlementsTimed += 1;
      s.settlementLatencySecondsTotal += latency;
    }
  }

  u.create("Settlement", {
    id: market.id,
    market_id: market.id,
    voided: false,
    outcome,
    evidenceHash: event.params.evidenceHash,
    settler,
    settlerIsOurs: await u.isOurs(settler),
    caller: u.m.from,
    graduated: market.graduated,
    early,
    latencySeconds,
    latencyBlocks,
    redemptionFeeNumerator: market.redemptionFeeNumerator,
    redemptionFeeDenominator: market.redemptionFeeDenominator,
    block: u.m.block,
    timestamp: u.m.timestamp,
    tx: u.m.tx,
  });
  u.flush();
});

indexer.onEvent({ contract: "Market", event: "Voided" }, async ({ event, context }) => {
  const u = new Unit(context, event);
  if (await u.exists("Settlement", u.m.src)) return;
  const market = await u.market(u.m.src);
  if (!market) {
    u.log.warn("void of a market the indexer has not seen", { market: u.m.src, event: u.m.id });
    return;
  }
  market.voidedAt = u.m.timestamp;
  market.settleTx = u.m.tx;
  await u.setStage(market, "Voided");
  (await u.daily()).marketsVoided += 1;
  u.create("Settlement", {
    id: market.id,
    market_id: market.id,
    voided: true,
    outcome: "Unresolved",
    evidenceHash: undefined,
    settler: undefined,
    settlerIsOurs: false,
    caller: u.m.from,
    graduated: market.graduated,
    early: false,
    latencySeconds: undefined,
    latencyBlocks: undefined,
    redemptionFeeNumerator: undefined,
    redemptionFeeDenominator: undefined,
    block: u.m.block,
    timestamp: u.m.timestamp,
    tx: u.m.tx,
  });
  u.flush();
});

indexer.onEvent({ contract: "Market", event: "PoolClaimed" }, async ({ event, context }) => {
  const u = await Unit.start(context, event, "PoolPayout");
  if (!u) return;
  const { user, paid, fee } = event.params;
  const market = await u.market(u.m.src);
  if (!market) {
    u.log.warn("pool claim on a market the indexer has not seen", { market: u.m.src, event: u.m.id });
    return;
  }
  // Refund mode: voided, or only one side staked (PROTOCOL.md section 5.2).
  const refund = market.stage === "Voided" || market.yesTotal === 0n || market.noTotal === 0n;
  u.create("PoolPayout", {
    id: u.m.id,
    market_id: market.id,
    wallet_id: addr(user),
    kind: refund ? "Refund" : "Winnings",
    paid,
    fee,
    block: u.m.block,
    timestamp: u.m.timestamp,
    tx: u.m.tx,
  });
  const staker = await u.staker(market.id, user);
  staker.poolClaimed = true;
  staker.poolPaid += paid;
  staker.poolFee += fee;
  const position = await u.position(market.id, user);
  position.poolPaid += paid;
  position.poolFee += fee;
  position.usdcReceived += paid;
  position.updatedAt = u.m.timestamp;
  market.poolPaidOut += paid;
  market.poolFees += fee;
  const s = await u.stats();
  s.poolPayoutCount += 1;
  s.poolPaidOut += paid;
  s.poolFees += fee;
  u.flush();
});

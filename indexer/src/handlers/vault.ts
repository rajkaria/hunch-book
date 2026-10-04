// CollateralVault: the per-market ledger (pool, sets, fees), redemptions, fee withdrawals and flash loans.
// Each event is also kept as a VaultEvent, whose id guards the handler against running twice.
import { type Enum, indexer } from "envio";
import { sideOf } from "../lib/enums.js";
import { addr, isAutoRedeemer, isPlumbing, ZERO_ADDRESS } from "../lib/network.js";
import { creditReferral } from "../lib/referrals.js";
import { emptyMarket, Unit } from "../lib/store.js";

interface VaultRecord {
  market?: string;
  account?: string;
  amount: bigint;
  fee?: bigint;
}

function recordVaultEvent(u: Unit, kind: Enum<"VaultEventKind">, r: VaultRecord): void {
  u.create("VaultEvent", {
    id: u.m.id,
    kind,
    market_id: r.market ? addr(r.market) : undefined,
    account: r.account ? addr(r.account) : undefined,
    amount: r.amount,
    fee: r.fee ?? 0n,
    block: u.m.block,
    timestamp: u.m.timestamp,
    tx: u.m.tx,
  });
}

async function marketOrWarn(u: Unit, id: string) {
  const market = await u.market(id);
  if (!market) u.log.warn("vault event for a market the indexer has not seen", { market: id, event: u.m.id });
  return market;
}

indexer.contractRegister(
  { contract: "CollateralVault", event: "MarketRegistered" },
  async ({ event, context }) => {
    context.chain.Market.add(event.params.market);
    context.chain.OutcomeToken.add(event.params.yes);
    context.chain.OutcomeToken.add(event.params.no);
  },
);

indexer.onEvent({ contract: "CollateralVault", event: "MarketRegistered" }, async ({ event, context }) => {
  const u = new Unit(context, event);
  const { market, yes, no, creator } = event.params;
  if (await u.exists("Market", addr(market))) return;
  u.create("Market", emptyMarket(market, { yes, no, creator }, u.m));
  u.create("OutcomeToken", { id: addr(yes), market_id: addr(market), side: "Yes" });
  u.create("OutcomeToken", { id: addr(no), market_id: addr(market), side: "No" });
  u.flush();
});

indexer.onEvent({ contract: "CollateralVault", event: "PoolDeposited" }, async ({ event, context }) => {
  const u = await Unit.start(context, event, "VaultEvent");
  if (!u) return;
  const { market: marketId, from, amount } = event.params;
  recordVaultEvent(u, "PoolDeposit", { market: marketId, account: from, amount });
  const s = await u.stats();
  s.vaultPool += amount;
  const market = await marketOrWarn(u, marketId);
  if (market) {
    market.vaultPool += amount;
    market.collateralIn += amount;
    await attachPayer(u, market, addr(from), amount);
  }
  u.flush();
});

/**
 * Staked (market) is followed in the same transaction by PoolDeposited (vault), which names who paid:
 * the staker, a third party (stakeFor), or the market itself for a relayed EIP-3009 stake (the staker's
 * own signed USDC). A stake paid by one of our wallets for someone else marks that wallet as ours (Seeded).
 */
async function attachPayer(
  u: Unit,
  market: { id: string; lastStakeId: string | undefined },
  from: string,
  amount: bigint,
): Promise<void> {
  if (!market.lastStakeId) return;
  const stake = await u.find("Stake", market.lastStakeId);
  if (!stake || stake.tx !== u.m.tx || stake.payer !== undefined || stake.amount !== amount) return;
  const user = stake.wallet_id;
  const relayed = from === market.id;
  const payer = relayed ? user : from;
  stake.payer = payer;
  stake.relayed = relayed;
  const payerWallet = await u.wallet(payer);
  const userWallet = await u.wallet(user);
  if (payer !== user && payerWallet.isOurs) await u.markOurs(userWallet, "Seeded");
  stake.paidByUs = payerWallet.isOurs;
  if (userWallet.isOurs) {
    const s = await u.stats();
    s.stakeCountOurs += 1;
    s.stakedUsdcOurs += amount;
  }
  if (payer === user) (await u.position(market.id, user)).usdcSpent += amount;
}

indexer.onEvent({ contract: "CollateralVault", event: "PoolGraduated" }, async ({ event, context }) => {
  const u = await Unit.start(context, event, "VaultEvent");
  if (!u) return;
  const { market: marketId, sets } = event.params;
  recordVaultEvent(u, "PoolGraduate", { market: marketId, amount: sets });
  const s = await u.stats();
  s.vaultPool -= sets;
  s.vaultSets += sets;
  const market = await marketOrWarn(u, marketId);
  if (market) {
    market.vaultPool -= sets;
    market.vaultSets += sets;
  }
  u.flush();
});

indexer.onEvent({ contract: "CollateralVault", event: "PoolPaid" }, async ({ event, context }) => {
  const u = await Unit.start(context, event, "VaultEvent");
  if (!u) return;
  const { market: marketId, to, paid, fee } = event.params;
  recordVaultEvent(u, "PoolPay", { market: marketId, account: to, amount: paid, fee });
  const s = await u.stats();
  s.vaultPool -= paid + fee;
  const market = await marketOrWarn(u, marketId);
  if (market) {
    market.vaultPool -= paid + fee;
    market.collateralOut += paid;
  }
  // Rounding dust after the last winner's claim: no PoolClaimed follows, so the payout is recorded here.
  if (addr(to) === ZERO_ADDRESS) {
    u.create("PoolPayout", {
      id: u.m.id,
      market_id: addr(marketId),
      wallet_id: undefined,
      kind: "Dust",
      paid,
      fee,
      block: u.m.block,
      timestamp: u.m.timestamp,
      tx: u.m.tx,
    });
    s.poolFees += fee;
    if (market) market.poolFees += fee;
  }
  u.flush();
});

indexer.onEvent({ contract: "CollateralVault", event: "SetsMinted" }, async ({ event, context }) => {
  const u = await Unit.start(context, event, "VaultEvent");
  if (!u) return;
  const { market: marketId, payer, to, amount } = event.params;
  recordVaultEvent(u, "Mint", { market: marketId, account: payer, amount });
  const s = await u.stats();
  s.vaultSets += amount;
  s.setsMinted += amount;
  const market = await marketOrWarn(u, marketId);
  if (market) {
    market.vaultSets += amount;
    market.collateralIn += amount;
    market.setsMinted += amount;
  }
  const viaRouter = isPlumbing(u.m.chainId, payer, marketId);
  u.create("SetFlow", {
    id: u.m.id,
    market_id: addr(marketId),
    kind: "Mint",
    account: addr(payer),
    to: addr(to),
    amount,
    viaRouter,
    block: u.m.block,
    timestamp: u.m.timestamp,
    tx: u.m.tx,
  });
  // Mints inside a router trade are the router's plumbing; RouterTrade carries the user's flows.
  if (!isPlumbing(u.m.chainId, to, marketId)) (await u.position(marketId, to)).setsMinted += amount;
  if (!viaRouter) (await u.position(marketId, payer)).usdcSpent += amount;
  u.flush();
});

indexer.onEvent({ contract: "CollateralVault", event: "SetsMerged" }, async ({ event, context }) => {
  const u = await Unit.start(context, event, "VaultEvent");
  if (!u) return;
  const { market: marketId, holder, to, amount } = event.params;
  recordVaultEvent(u, "Merge", { market: marketId, account: holder, amount });
  const s = await u.stats();
  s.vaultSets -= amount;
  s.setsMerged += amount;
  const market = await marketOrWarn(u, marketId);
  if (market) {
    market.vaultSets -= amount;
    market.collateralOut += amount;
    market.setsMerged += amount;
  }
  u.create("SetFlow", {
    id: u.m.id,
    market_id: addr(marketId),
    kind: "Merge",
    account: addr(holder),
    to: addr(to),
    amount,
    viaRouter: isPlumbing(u.m.chainId, holder, marketId),
    block: u.m.block,
    timestamp: u.m.timestamp,
    tx: u.m.tx,
  });
  if (!isPlumbing(u.m.chainId, holder, marketId)) (await u.position(marketId, holder)).setsMerged += amount;
  if (!isPlumbing(u.m.chainId, to, marketId)) (await u.position(marketId, to)).usdcReceived += amount;
  u.flush();
});

indexer.onEvent({ contract: "CollateralVault", event: "Finalized" }, async ({ event, context }) => {
  const u = await Unit.start(context, event, "VaultEvent");
  if (!u) return;
  const { market: marketId, feeNumerator, feeDenominator } = event.params;
  recordVaultEvent(u, "Finalize", { market: marketId, amount: 0n });
  const market = await marketOrWarn(u, marketId);
  if (market) {
    market.redemptionFeeNumerator = feeNumerator;
    market.redemptionFeeDenominator = feeDenominator;
  }
  u.flush();
});

indexer.onEvent({ contract: "CollateralVault", event: "MarketVoided" }, async ({ event, context }) => {
  const u = await Unit.start(context, event, "VaultEvent");
  if (!u) return;
  recordVaultEvent(u, "Void", { market: event.params.market, amount: 0n });
  u.flush();
});

indexer.onEvent({ contract: "CollateralVault", event: "Redeemed" }, async ({ event, context }) => {
  const u = await Unit.start(context, event, "VaultEvent");
  if (!u) return;
  const { market: marketId, to, side: sideOrdinal, amount, paid, fee } = event.params;
  const side = sideOf(sideOrdinal);
  // The AutoRedeemer redeems tokens it pulled from a holder a moment earlier and has the vault pay that
  // holder (`to`), so the holder, not the AutoRedeemer, is the one who redeemed.
  const viaAutoRedeemer = isAutoRedeemer(u.m.chainId, event.params.holder);
  const holder = addr(viaAutoRedeemer ? to : event.params.holder);
  recordVaultEvent(u, "Redeem", { market: marketId, account: holder, amount: paid, fee });
  const s = await u.stats();
  const d = await u.daily();
  const market = await marketOrWarn(u, marketId);
  if (!market) {
    u.flush();
    return;
  }
  // After a void each token pays 0.50 and the ledger drops by what was paid; after settlement it
  // drops by the tokens burned (the fee stays owed, to the fee balances).
  const voided = market.stage === "Voided";
  const setsDrop = voided ? paid : amount;
  market.vaultSets -= setsDrop;
  s.vaultSets -= setsDrop;
  market.collateralOut += paid;

  const resolvedAt = market.settledAt ?? market.voidedAt;
  const secondsAfter = resolvedAt === undefined ? undefined : u.m.timestamp - resolvedAt;
  if (market.firstRedemptionAt === undefined) {
    market.firstRedemptionAt = u.m.timestamp;
    if (secondsAfter !== undefined) {
      s.marketsRedeemed += 1;
      s.firstRedemptionLatencySecondsTotal += secondsAfter;
    }
  }
  market.redemptionCount += 1;
  market.redeemedTokens += amount;
  market.redeemedUsdc += paid;
  market.redemptionFees += fee;

  u.create("Redemption", {
    id: u.m.id,
    market_id: market.id,
    wallet_id: holder,
    to: addr(to),
    viaAutoRedeemer,
    side,
    amount,
    paid,
    fee,
    voided,
    secondsAfterSettlement: secondsAfter,
    block: u.m.block,
    timestamp: u.m.timestamp,
    tx: u.m.tx,
  });
  const position = await u.position(market.id, holder);
  if (side === "Yes") position.redeemedYes += amount;
  else position.redeemedNo += amount;
  position.redeemedUsdc += paid;
  position.redemptionFees += fee;
  position.usdcReceived += paid;
  position.updatedAt = u.m.timestamp;
  const wallet = await u.wallet(holder);
  wallet.redemptionCount += 1;
  wallet.redeemedUsdc += paid;

  s.redemptionCount += 1;
  s.redeemedTokens += amount;
  s.redeemedUsdc += paid;
  s.redemptionFees += fee;
  d.redemptionCount += 1;
  d.redeemedUsdc += paid;
  // Referral credit: the fee counts for the address that received the USDC (docs/PERIPHERY.md).
  await creditReferral(u, { user: to, market: market.id, kind: "Redemption", fee });
  u.flush();
});

indexer.onEvent({ contract: "CollateralVault", event: "FeesAccrued" }, async ({ event, context }) => {
  const u = await Unit.start(context, event, "VaultEvent");
  if (!u) return;
  const { market: marketId, protocolShare, creator, creatorShare } = event.params;
  const total = protocolShare + creatorShare;
  recordVaultEvent(u, "FeeAccrual", { market: marketId, account: creator, amount: total });
  const s = await u.stats();
  s.protocolFeesAccrued += protocolShare;
  s.creatorFeesAccrued += creatorShare;
  const market = await marketOrWarn(u, marketId);
  if (market) market.feesAccrued += total;
  (await u.creator(creator)).feesAccrued += creatorShare;
  u.flush();
});

indexer.onEvent(
  { contract: "CollateralVault", event: "ProtocolFeesWithdrawn" },
  async ({ event, context }) => {
    const u = await Unit.start(context, event, "VaultEvent");
    if (!u) return;
    recordVaultEvent(u, "ProtocolFeeWithdrawal", { account: event.params.to, amount: event.params.amount });
    (await u.stats()).protocolFeesWithdrawn += event.params.amount;
    u.flush();
  },
);

indexer.onEvent(
  { contract: "CollateralVault", event: "CreatorFeesWithdrawn" },
  async ({ event, context }) => {
    const u = await Unit.start(context, event, "VaultEvent");
    if (!u) return;
    const { creator, amount } = event.params;
    recordVaultEvent(u, "CreatorFeeWithdrawal", { account: creator, amount });
    (await u.stats()).creatorFeesWithdrawn += amount;
    (await u.creator(creator)).feesWithdrawn += amount;
    u.flush();
  },
);

indexer.onEvent({ contract: "CollateralVault", event: "FlashLoan" }, async ({ event, context }) => {
  const u = await Unit.start(context, event, "VaultEvent");
  if (!u) return;
  recordVaultEvent(u, "FlashLoan", { account: event.params.receiver, amount: event.params.amount });
  const s = await u.stats();
  s.flashLoanCount += 1;
  s.flashLoanVolume += event.params.amount;
  u.flush();
});

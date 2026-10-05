import { addressUrl, type TradeKind, txUrl } from "@hunch-book/shared";
import type { Address, Hex } from "viem";
import * as actions from "./actions.js";
import * as batch from "./batch.js";
import { getOrderBook } from "./book.js";
import { accountAddress, type ContextOptions, createContext, type HunchContext } from "./context.js";
import * as markets from "./markets.js";
import * as periphery from "./periphery.js";
import { maxAmount, quote } from "./quotes.js";
import { planSettlement } from "./settlement/evidence.js";
import { findSettlementTx, verifySettlement } from "./settlement/verify.js";
import { approve, type ContractCall, type SendOptions } from "./tx.js";

// One object with every SDK function bound to one context. The same functions are exported on their
// own (taking the context first) for callers that want only a few of them in their bundle.

export type HunchClientOptions = ContextOptions;

/**
 * Creates a Hunch Book client. Without a wallet client the client is read-only: reads, quotes,
 * settlement plans and verification all work; actions throw.
 *
 * ```ts
 * const hunch = createHunchClient({ network: "monad-testnet" });
 * const { markets } = await hunch.markets.list({ limit: 10 });
 * ```
 */
export function createHunchClient(options: HunchClientOptions = {}) {
  const ctx = createContext(options);
  return {
    context: ctx,
    network: ctx.network,
    deployment: ctx.deployment,
    /** The address that signs, or undefined in read-only mode. */
    account: accountAddress(ctx),
    explorer: {
      tx: (hash: Hex) => txUrl(ctx.deployment, hash),
      address: (address: Address) => addressUrl(ctx.deployment, address),
    },
    markets: {
      count: () => markets.marketCount(ctx),
      list: (o?: markets.ListOptions) => markets.listMarkets(ctx, o),
      all: () => markets.listAllMarkets(ctx),
      get: (address: Address) => markets.getMarket(ctx, address),
      book: (market: Address | markets.MarketInfo) => getOrderBook(ctx, market),
      position: (market: Address | markets.MarketInfo, user: Address) =>
        markets.getPosition(ctx, market, user),
      portfolio: (user: Address) => markets.getPortfolio(ctx, user),
    },
    quotes: {
      quote: (
        market: Address | markets.MarketInfo,
        kind: TradeKind,
        amount: bigint,
        o?: { slippageBps?: bigint },
      ) => quote(ctx, market, kind, amount, o),
      buyYes: (market: Address | markets.MarketInfo, usdcIn: bigint, o?: { slippageBps?: bigint }) =>
        quote(ctx, market, "buyYes", usdcIn, o),
      sellYes: (market: Address | markets.MarketInfo, yesIn: bigint, o?: { slippageBps?: bigint }) =>
        quote(ctx, market, "sellYes", yesIn, o),
      buyNo: (market: Address | markets.MarketInfo, noOut: bigint, o?: { slippageBps?: bigint }) =>
        quote(ctx, market, "buyNo", noOut, o),
      sellNo: (market: Address | markets.MarketInfo, noIn: bigint, o?: { slippageBps?: bigint }) =>
        quote(ctx, market, "sellNo", noIn, o),
      maxAmount,
    },
    actions: {
      approve: (token: Address, spender: Address, amount: bigint, o?: SendOptions) =>
        approve(ctx, token, spender, amount, o),
      createMarket: (input: actions.CreateMarketInput, o?: Parameters<typeof actions.createMarket>[2]) =>
        actions.createMarket(ctx, input, o),
      stake: (
        market: Address,
        side: actions.SideInput,
        amount: bigint,
        o?: Parameters<typeof actions.stake>[4],
      ) => actions.stake(ctx, market, side, amount, o),
      buildStakeAuthorization: (input: Parameters<typeof actions.buildStakeAuthorization>[1]) =>
        actions.buildStakeAuthorization(ctx, input),
      signStakeAuthorization: (auth: actions.StakeAuthorization) => actions.signStakeAuthorization(ctx, auth),
      stakeWithAuthorization: (signed: actions.StakeAuthorization & { signature: Hex }, o?: SendOptions) =>
        actions.stakeWithAuthorization(ctx, signed, o),
      graduate: (market: Address, o?: SendOptions) => actions.graduate(ctx, market, o),
      claimTokens: (market: Address, o?: SendOptions) => actions.claimTokens(ctx, market, o),
      claimTokensFor: (market: Address, users: readonly Address[], o?: SendOptions) =>
        actions.claimTokensFor(ctx, market, users, o),
      trade: (
        market: Address | markets.MarketInfo,
        kind: TradeKind,
        amount: bigint,
        o?: actions.TradeOptions,
      ) => actions.trade(ctx, market, kind, amount, o),
      mintSets: (market: Address, amount: bigint, o?: Parameters<typeof actions.mintSets>[3]) =>
        actions.mintSets(ctx, market, amount, o),
      mergeSets: (market: Address, amount: bigint, o?: Parameters<typeof actions.mergeSets>[3]) =>
        actions.mergeSets(ctx, market, amount, o),
      settle: (market: Address | markets.MarketInfo, o?: Parameters<typeof actions.settle>[2]) =>
        actions.settle(ctx, market, o),
      proveYes: (market: Address | markets.MarketInfo, o?: Parameters<typeof actions.proveYes>[2]) =>
        actions.proveYes(ctx, market, o),
      takeSnapshot: (market: Address | markets.MarketInfo, o?: SendOptions) =>
        actions.takeSnapshot(ctx, market, o),
      voidIfExpired: (market: Address, o?: SendOptions) => actions.voidIfExpired(ctx, market, o),
      redeem: (
        market: Address | markets.MarketInfo,
        side: actions.SideInput,
        o?: Parameters<typeof actions.redeem>[3],
      ) => actions.redeem(ctx, market, side, o),
      claimPool: (market: Address, o?: SendOptions) => actions.claimPool(ctx, market, o),
      collect: (market: Address | markets.MarketInfo, o?: SendOptions) => actions.collect(ctx, market, o),
      collectAll: (list: readonly (Address | markets.MarketInfo)[], o?: batch.SendCallsOptions) =>
        batch.collectAll(ctx, list, o),
      planCollect: (list: readonly (Address | markets.MarketInfo)[], owner?: Address) =>
        batch.planCollect(ctx, list, owner),
      sendCalls: (calls: readonly ContractCall[], o?: batch.SendCallsOptions) =>
        batch.sendCalls(ctx, calls, o),
      canBatchAtomically: () => batch.canBatchAtomically(ctx),
      withdrawCreatorFees: (o?: Parameters<typeof actions.withdrawCreatorFees>[1]) =>
        actions.withdrawCreatorFees(ctx, o),
      mintTestUsdc: (amount: bigint, o?: Parameters<typeof actions.mintTestUsdc>[2]) =>
        actions.mintTestUsdc(ctx, amount, o),
    },
    settlement: {
      plan: (market: Address | markets.MarketInfo) => planSettlement(ctx, market),
      verify: (market: Address | markets.MarketInfo, o?: { settlementBlock?: bigint }) =>
        verifySettlement(ctx, market, o),
      findTransaction: (market: Address, o?: Parameters<typeof findSettlementTx>[2]) =>
        findSettlementTx(ctx, { address: market }, o),
    },
    periphery: {
      autoRedeem: {
        set: (optedIn: boolean, o?: SendOptions) => periphery.setAutoRedeem(ctx, optedIn, o),
        setMarketOptOut: (market: Address, optedOut: boolean, o?: SendOptions) =>
          periphery.setAutoRedeemMarketOptOut(ctx, market, optedOut, o),
        approve: (token: Address, amount: bigint, o?: SendOptions) =>
          periphery.approveAutoRedeem(ctx, token, amount, o),
        optInWithPermit: (
          input: Parameters<typeof periphery.optInAutoRedeemWithPermit>[1],
          o?: SendOptions,
        ) => periphery.optInAutoRedeemWithPermit(ctx, input, o),
        redeemable: (market: Address, holder: Address) => periphery.autoRedeemable(ctx, market, holder),
      },
      orders: {
        place: (input: periphery.OrderInput, o?: Parameters<typeof periphery.placeOrder>[2]) =>
          periphery.placeOrder(ctx, input, o),
        cancel: (orderId: bigint, o?: SendOptions) => periphery.cancelOrder(ctx, orderId, o),
        execute: (orderId: bigint, o?: SendOptions) => periphery.executeOrder(ctx, orderId, o),
        get: (orderId: bigint) => periphery.getOrder(ctx, orderId),
      },
      referrals: {
        bind: (referrer: Address, o?: SendOptions) => periphery.bindReferrer(ctx, referrer, o),
        build: (input: Parameters<typeof periphery.buildReferralBinding>[1]) =>
          periphery.buildReferralBinding(ctx, input),
        sign: (binding: periphery.ReferralBinding) => periphery.signReferralBinding(ctx, binding),
        bindFor: (signed: periphery.ReferralBinding & { signature: Hex }, o?: SendOptions) =>
          periphery.bindReferrerFor(ctx, signed, o),
        of: (user: Address) => periphery.referralOf(ctx, user),
      },
      rewards: {
        claim: (claim: periphery.RewardClaimInput, o?: SendOptions) => periphery.claimReward(ctx, claim, o),
        claimMany: (claims: readonly periphery.RewardClaimInput[], o?: SendOptions) =>
          periphery.claimRewards(ctx, claims, o),
        epoch: (epoch: bigint) => periphery.rewardEpoch(ctx, epoch),
        isClaimed: (epoch: bigint, account: Address) => periphery.isRewardClaimed(ctx, epoch, account),
        nextEpoch: () => periphery.nextRewardEpoch(ctx),
      },
      oracle: {
        chance: (market: Address) => periphery.oracleChance(ctx, market),
        twap: (market: Address, secondsAgo: bigint) => periphery.oracleTwap(ctx, market, secondsAgo),
        poke: (market: Address, o?: SendOptions) => periphery.pokeOracle(ctx, market, o),
      },
    },
  };
}

export type HunchClient = ReturnType<typeof createHunchClient>;

export type { HunchContext };

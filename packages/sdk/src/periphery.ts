import {
  autoRedeemerAbi,
  conditionalOrdersAbi,
  impliedProbabilityOracleAbi,
  merkleDistributorAbi,
  type PeripheryContracts,
  referralRegistryAbi,
} from "@hunch-book/shared";
import { type Address, type Hex, hexToSignature, isAddressEqual, parseAbi } from "viem";
import { usdcAddress } from "./actions.js";
import { type HunchContext, requireWallet } from "./context.js";
import { HunchError } from "./errors.js";
import { type MarketInfo, requireMarket } from "./markets.js";
import { chainNow } from "./settlement/evidence.js";
import { type ApprovalMode, approve, ensureAllowance, type SendOptions, send, type TxResult } from "./tx.js";

// The optional contracts around the core (docs/PERIPHERY.md): auto-redeem, conditional orders,
// referral bindings, the Merkle distributor that pays rewards, and the implied-probability oracle.
// None of them can set an outcome or move funds anywhere their owner did not choose.

function periphery<K extends keyof PeripheryContracts>(
  ctx: HunchContext,
  key: K,
): NonNullable<PeripheryContracts[K]> {
  const value = ctx.deployment.hunchBook.periphery?.[key];
  if (value === undefined || value === null) {
    throw new HunchError(`${String(key)} is not deployed on ${ctx.deployment.network}.`);
  }
  return value as NonNullable<PeripheryContracts[K]>;
}

// ---------------------------------------------------------------- auto-redeem

/** Turns auto-redeem on or off for the wallet, across every market. */
export async function setAutoRedeem(
  ctx: HunchContext,
  optedIn: boolean,
  options: SendOptions = {},
): Promise<TxResult> {
  return send(
    ctx,
    {
      address: periphery(ctx, "autoRedeemer"),
      abi: autoRedeemerAbi,
      functionName: "setOptIn",
      args: [optedIn],
    },
    options,
  );
}

/** Leaves one market out of auto-redeem (or puts it back) while staying opted in elsewhere. */
export async function setAutoRedeemMarketOptOut(
  ctx: HunchContext,
  market: Address,
  optedOut: boolean,
  options: SendOptions = {},
): Promise<TxResult> {
  return send(
    ctx,
    {
      address: periphery(ctx, "autoRedeemer"),
      abi: autoRedeemerAbi,
      functionName: "setMarketOptOut",
      args: [market, optedOut],
    },
    options,
  );
}

/** Approves the AutoRedeemer for an outcome token: how much of it may be redeemed for the wallet. */
export async function approveAutoRedeem(
  ctx: HunchContext,
  token: Address,
  amount: bigint,
  options: SendOptions = {},
): Promise<TxResult<boolean>> {
  return approve(ctx, token, periphery(ctx, "autoRedeemer"), amount, options);
}

const permitAbi = parseAbi([
  "function name() view returns (string)",
  "function nonces(address owner) view returns (uint256)",
]);

export const PERMIT_TYPES = {
  Permit: [
    { name: "owner", type: "address" },
    { name: "spender", type: "address" },
    { name: "value", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

/**
 * Opts in to auto-redeem and approves an outcome token in one transaction: signs an EIP-2612 permit on
 * the token (domain version "1", as Hunch Book's outcome tokens use) and submits `optInWithPermit`.
 */
export async function optInAutoRedeemWithPermit(
  ctx: HunchContext,
  input: { token: Address; value: bigint; deadline?: bigint },
  options: SendOptions = {},
): Promise<TxResult> {
  const wallet = requireWallet(ctx);
  const spender = periphery(ctx, "autoRedeemer");
  const owner = wallet.account.address;
  const [name, nonce, now] = await Promise.all([
    ctx.publicClient.readContract({ address: input.token, abi: permitAbi, functionName: "name" }),
    ctx.publicClient.readContract({
      address: input.token,
      abi: permitAbi,
      functionName: "nonces",
      args: [owner],
    }),
    chainNow(ctx),
  ]);
  const deadline = input.deadline ?? now.timestamp + 3_600n;
  const signature = await wallet.signTypedData({
    account: wallet.account,
    domain: { name, version: "1", chainId: ctx.deployment.chainId, verifyingContract: input.token },
    types: PERMIT_TYPES,
    primaryType: "Permit",
    message: { owner, spender, value: input.value, nonce, deadline },
  });
  const { v, r, s } = hexToSignature(signature);
  return send(
    ctx,
    {
      address: spender,
      abi: autoRedeemerAbi,
      functionName: "optInWithPermit",
      args: [input.token, input.value, deadline, Number(v), r, s],
    },
    options,
  );
}

/** What auto-redeem would redeem and pay for `holder` in `market` right now. */
export async function autoRedeemable(
  ctx: HunchContext,
  market: Address,
  holder: Address,
): Promise<{ yes: bigint; no: bigint; paid: bigint; active: boolean }> {
  const address = periphery(ctx, "autoRedeemer");
  const [[yes, no, paid], active] = await Promise.all([
    ctx.publicClient.readContract({
      address,
      abi: autoRedeemerAbi,
      functionName: "redeemable",
      args: [market, holder],
    }),
    ctx.publicClient.readContract({
      address,
      abi: autoRedeemerAbi,
      functionName: "isActive",
      args: [holder, market],
    }),
  ]);
  return { yes, no, paid, active };
}

// ---------------------------------------------------------------- conditional orders

/** IHunchRouter.Kind order. */
export const ORDER_KIND = { buyYes: 0, sellYes: 1, buyNo: 2, sellNo: 3 } as const;
export type OrderKind = keyof typeof ORDER_KIND;
/** IConditionalOrders.Condition order. */
export const ORDER_CONDITION = { atOrAbove: 0, atOrBelow: 1 } as const;
export type OrderCondition = keyof typeof ORDER_CONDITION;

/** take-profit = a sell at or above; stop-loss = a sell at or below; limit buy = a buy at or below. */
export type OrderStyle = "take-profit" | "stop-loss" | "limit-buy" | "breakout-buy";

export function conditionFor(style: OrderStyle): OrderCondition {
  return style === "take-profit" || style === "breakout-buy" ? "atOrAbove" : "atOrBelow";
}

export interface OrderInput {
  market: Address;
  kind: OrderKind;
  condition: OrderCondition;
  /** Trigger price on the traded side's own book price, E6 (0 to 1,000,000). */
  triggerPriceE6: number;
  /** Unix seconds, inclusive. */
  expiry: bigint;
  /** 0 to 50 basis points of the output, paid to whoever executes. */
  executorTipBps: number;
  /** USDC to spend (buyYes), YES to sell, NO to buy exactly (buyNo), or NO to sell. */
  amountIn: bigint;
  /** Minimum received (buyYes, sellYes, sellNo) or maximum USDC paid (buyNo), after the tip. */
  limit: bigint;
}

/** Places an order (moves no funds) after approving the contract for what the order will pull. */
export async function placeOrder(
  ctx: HunchContext,
  input: OrderInput,
  options: { approval?: ApprovalMode } & SendOptions = {},
): Promise<TxResult<bigint> & { orderId: bigint }> {
  const address = periphery(ctx, "conditionalOrders");
  const m = await requireMarket(ctx, input.market);
  const pull =
    input.kind === "buyYes"
      ? { token: usdcAddress(ctx), amount: input.amountIn }
      : input.kind === "buyNo"
        ? { token: usdcAddress(ctx), amount: input.limit }
        : { token: input.kind === "sellYes" ? m.tokens.yes : m.tokens.no, amount: input.amountIn };
  await ensureAllowance(ctx, pull.token, address, pull.amount, options);
  const tx = await send<bigint>(
    ctx,
    {
      address,
      abi: conditionalOrdersAbi,
      functionName: "place",
      args: [
        {
          market: m.address,
          kind: ORDER_KIND[input.kind],
          condition: ORDER_CONDITION[input.condition],
          triggerPriceE6: input.triggerPriceE6,
          expiry: input.expiry,
          executorTipBps: input.executorTipBps,
          amountIn: input.amountIn,
          limit: input.limit,
        },
      ],
    },
    options,
  );
  return { ...tx, orderId: tx.result };
}

export async function cancelOrder(
  ctx: HunchContext,
  orderId: bigint,
  options: SendOptions = {},
): Promise<TxResult> {
  return send(
    ctx,
    {
      address: periphery(ctx, "conditionalOrders"),
      abi: conditionalOrdersAbi,
      functionName: "cancel",
      args: [orderId],
    },
    options,
  );
}

/** Executes a triggered order; the caller earns its tip. */
export async function executeOrder(
  ctx: HunchContext,
  orderId: bigint,
  options: SendOptions = {},
): Promise<TxResult<bigint>> {
  return send<bigint>(
    ctx,
    {
      address: periphery(ctx, "conditionalOrders"),
      abi: conditionalOrdersAbi,
      functionName: "execute",
      args: [orderId],
    },
    options,
  );
}

export async function getOrder(ctx: HunchContext, orderId: bigint) {
  const address = periphery(ctx, "conditionalOrders");
  const [order, triggered] = await Promise.all([
    ctx.publicClient.readContract({
      address,
      abi: conditionalOrdersAbi,
      functionName: "getOrder",
      args: [orderId],
    }),
    ctx.publicClient.readContract({
      address,
      abi: conditionalOrdersAbi,
      functionName: "isTriggered",
      args: [orderId],
    }),
  ]);
  return { ...order, id: orderId, triggered };
}

// ---------------------------------------------------------------- referrals

/** Binds the wallet to `referrer` for the registry's duration (180 days on the deployed registry). */
export async function bindReferrer(
  ctx: HunchContext,
  referrer: Address,
  options: SendOptions = {},
): Promise<TxResult> {
  return send(
    ctx,
    {
      address: periphery(ctx, "referralRegistry"),
      abi: referralRegistryAbi,
      functionName: "bind",
      args: [referrer],
    },
    options,
  );
}

export const BIND_TYPES = {
  Bind: [
    { name: "user", type: "address" },
    { name: "referrer", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export interface ReferralBinding {
  user: Address;
  referrer: Address;
  nonce: bigint;
  deadline: bigint;
  typedData: {
    domain: { name: "Hunch Book Referrals"; version: "1"; chainId: number; verifyingContract: Address };
    types: typeof BIND_TYPES;
    primaryType: "Bind";
    message: { user: Address; referrer: Address; nonce: bigint; deadline: bigint };
  };
}

/** The EIP-712 message a user signs so a relayer can bind them (`bindFor`). */
export async function buildReferralBinding(
  ctx: HunchContext,
  input: { user: Address; referrer: Address; deadline?: bigint },
): Promise<ReferralBinding> {
  const registry = periphery(ctx, "referralRegistry");
  const [nonce, now] = await Promise.all([
    ctx.publicClient.readContract({
      address: registry,
      abi: referralRegistryAbi,
      functionName: "nonces",
      args: [input.user],
    }),
    chainNow(ctx),
  ]);
  const deadline = input.deadline ?? now.timestamp + 86_400n;
  return {
    user: input.user,
    referrer: input.referrer,
    nonce,
    deadline,
    typedData: {
      domain: {
        name: "Hunch Book Referrals",
        version: "1",
        chainId: ctx.deployment.chainId,
        verifyingContract: registry,
      },
      types: BIND_TYPES,
      primaryType: "Bind",
      message: { user: input.user, referrer: input.referrer, nonce, deadline },
    },
  };
}

export async function signReferralBinding(
  ctx: HunchContext,
  binding: ReferralBinding,
): Promise<ReferralBinding & { signature: Hex }> {
  const wallet = requireWallet(ctx);
  if (!isAddressEqual(wallet.account.address, binding.user))
    throw new HunchError("Only the user can sign their binding.");
  return {
    ...binding,
    signature: await wallet.signTypedData({ account: wallet.account, ...binding.typedData }),
  };
}

/** Submits a signed binding; the wallet is the relayer and pays the gas. */
export async function bindReferrerFor(
  ctx: HunchContext,
  signed: ReferralBinding & { signature: Hex },
  options: SendOptions = {},
): Promise<TxResult> {
  return send(
    ctx,
    {
      address: periphery(ctx, "referralRegistry"),
      abi: referralRegistryAbi,
      functionName: "bindFor",
      args: [signed.user, signed.referrer, signed.deadline, signed.signature],
    },
    options,
  );
}

export async function referralOf(
  ctx: HunchContext,
  user: Address,
  options: { blockNumber?: bigint } = {},
): Promise<{ referrer: Address; boundAt: bigint; expiresAt: bigint; active: boolean }> {
  const [referrer, boundAt, expiresAt, active] = await ctx.publicClient.readContract({
    address: periphery(ctx, "referralRegistry"),
    abi: referralRegistryAbi,
    functionName: "bindingOf",
    args: [user],
    ...(options.blockNumber === undefined ? {} : { blockNumber: options.blockNumber }),
  });
  return { referrer, boundAt: BigInt(boundAt), expiresAt: BigInt(expiresAt), active };
}

// ---------------------------------------------------------------- rewards (MerkleDistributor)

export interface RewardClaimInput {
  epoch: bigint;
  account: Address;
  amount: bigint;
  proof: readonly Hex[];
}

/** Claims one reward; the USDC goes to `account`, whoever sends it. */
export async function claimReward(
  ctx: HunchContext,
  claim: RewardClaimInput,
  options: SendOptions = {},
): Promise<TxResult> {
  return send(
    ctx,
    {
      address: periphery(ctx, "merkleDistributor"),
      abi: merkleDistributorAbi,
      functionName: "claim",
      args: [claim.epoch, claim.account, claim.amount, claim.proof],
    },
    options,
  );
}

/** Several claims in one transaction; all or nothing. */
export async function claimRewards(
  ctx: HunchContext,
  claims: readonly RewardClaimInput[],
  options: SendOptions = {},
): Promise<TxResult> {
  return send(
    ctx,
    {
      address: periphery(ctx, "merkleDistributor"),
      abi: merkleDistributorAbi,
      functionName: "claimMany",
      args: [claims],
    },
    options,
  );
}

export async function rewardEpoch(ctx: HunchContext, epoch: bigint) {
  return ctx.publicClient.readContract({
    address: periphery(ctx, "merkleDistributor"),
    abi: merkleDistributorAbi,
    functionName: "epochs",
    args: [epoch],
  });
}

export async function isRewardClaimed(ctx: HunchContext, epoch: bigint, account: Address): Promise<boolean> {
  return ctx.publicClient.readContract({
    address: periphery(ctx, "merkleDistributor"),
    abi: merkleDistributorAbi,
    functionName: "isClaimed",
    args: [epoch, account],
  });
}

/** The id the next `createEpoch` will use: build the tree with it. */
export async function nextRewardEpoch(ctx: HunchContext): Promise<bigint> {
  return ctx.publicClient.readContract({
    address: periphery(ctx, "merkleDistributor"),
    abi: merkleDistributorAbi,
    functionName: "nextEpoch",
  });
}

// ---------------------------------------------------------------- implied-probability oracle

/** The oracle's spot chance of YES (E6) and whether it is stale (an empty book read the last observation). */
export async function oracleChance(
  ctx: HunchContext,
  market: Address | MarketInfo,
): Promise<{ chanceE6: bigint; stale: boolean }> {
  const m = typeof market === "string" ? market : market.address;
  const [chanceE6, stale] = await ctx.publicClient.readContract({
    address: periphery(ctx, "impliedProbabilityOracle"),
    abi: impliedProbabilityOracleAbi,
    functionName: "chanceE6",
    args: [m],
  });
  return { chanceE6, stale };
}

/** Time-weighted average chance and spread over the last `secondsAgo` seconds, and the latest poke's time. */
export async function oracleTwap(
  ctx: HunchContext,
  market: Address,
  secondsAgo: bigint,
): Promise<{ chanceE6: bigint; spreadE6: bigint; updatedAt: bigint }> {
  const [chanceE6, spreadE6, updatedAt] = await ctx.publicClient.readContract({
    address: periphery(ctx, "impliedProbabilityOracle"),
    abi: impliedProbabilityOracleAbi,
    functionName: "consultFull",
    args: [market, secondsAgo],
  });
  return { chanceE6, spreadE6, updatedAt };
}

/** Records the market's spot chance in the oracle (anyone, at most once per block per market). */
export async function pokeOracle(
  ctx: HunchContext,
  market: Address,
  options: SendOptions = {},
): Promise<TxResult<boolean>> {
  return send<boolean>(
    ctx,
    {
      address: periphery(ctx, "impliedProbabilityOracle"),
      abi: impliedProbabilityOracleAbi,
      functionName: "poke",
      args: [market],
    },
    options,
  );
}

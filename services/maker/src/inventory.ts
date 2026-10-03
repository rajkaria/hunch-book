import { collateralVaultAbi, kuruMarginAccountAbi } from "@hunch-book/shared";
import { type Address, encodeFunctionData, erc20Abi, type PublicClient } from "viem";
import { accountAddress, sendTx, type TxContext } from "./tx.js";

// The bot's inventory: tokens in its wallet, balances in Kuru's margin account, and complete sets
// minted and merged on Hunch Book's vault (1 USDC ⇄ 1 YES + 1 NO).

export interface Balances {
  walletYes: bigint;
  walletNo: bigint;
  walletUsdc: bigint;
  marginYes: bigint;
  marginUsdc: bigint;
}

export async function readBalances(
  client: PublicClient,
  me: Address,
  tokens: { yes: Address; no: Address; usdc: Address },
  marginAccount: Address,
): Promise<Balances> {
  const [walletYes, walletNo, walletUsdc, marginYes, marginUsdc] = await client.multicall({
    allowFailure: false,
    contracts: [
      { address: tokens.yes, abi: erc20Abi, functionName: "balanceOf", args: [me] },
      { address: tokens.no, abi: erc20Abi, functionName: "balanceOf", args: [me] },
      { address: tokens.usdc, abi: erc20Abi, functionName: "balanceOf", args: [me] },
      {
        address: marginAccount,
        abi: kuruMarginAccountAbi,
        functionName: "getBalance",
        args: [me, tokens.yes],
      },
      {
        address: marginAccount,
        abi: kuruMarginAccountAbi,
        functionName: "getBalance",
        args: [me, tokens.usdc],
      },
    ],
  });
  return { walletYes, walletNo, walletUsdc, marginYes, marginUsdc };
}

/** Mints and merges complete sets. The vault in production; a stub where the vault is not deployed. */
export interface SetOps {
  mint(amount: bigint): Promise<boolean>;
  merge(amount: bigint): Promise<boolean>;
}

/**
 * Approves `spender` for at least `amount` of `token` when the allowance is short. It approves
 * `max(amount, ceiling)`, so the bot's exposure to any spender stays bounded by its inventory cap.
 */
export async function ensureAllowance(
  ctx: TxContext,
  token: Address,
  spender: Address,
  amount: bigint,
  ceiling: bigint,
  fields: Record<string, unknown> = {},
): Promise<boolean> {
  if (!ctx.enabled) return true;
  const allowance = await ctx.publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "allowance",
    args: [accountAddress(ctx), spender],
  });
  if (allowance >= amount) return true;
  const value = amount > ceiling ? amount : ceiling;
  const result = await sendTx(ctx, {
    to: token,
    data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, value] }),
    abi: erc20Abi,
    action: "approve",
    fields: { ...fields, token, spender, amount: value },
  });
  return result.status === "success";
}

/** Complete sets on Hunch Book's CollateralVault: mint pulls USDC (approved to the vault), merge burns. */
export function vaultSetOps(
  ctx: TxContext,
  vault: Address,
  market: Address,
  usdc: Address,
  approvalCeiling: bigint,
): SetOps {
  const me = accountAddress(ctx);
  return {
    async mint(amount) {
      if (!(await ensureAllowance(ctx, usdc, vault, amount, approvalCeiling, { market }))) return false;
      const result = await sendTx(ctx, {
        to: vault,
        data: encodeFunctionData({
          abi: collateralVaultAbi,
          functionName: "mintSets",
          args: [market, amount, me],
        }),
        abi: collateralVaultAbi,
        action: "mintSets",
        fields: { market, amount },
      });
      return result.status === "success" || result.status === "dry-run";
    },
    async merge(amount) {
      const result = await sendTx(ctx, {
        to: vault,
        data: encodeFunctionData({
          abi: collateralVaultAbi,
          functionName: "mergeSets",
          args: [market, amount, me],
        }),
        abi: collateralVaultAbi,
        action: "mergeSets",
        fields: { market, amount },
      });
      return result.status === "success" || result.status === "dry-run";
    },
  };
}

export async function depositToMargin(
  ctx: TxContext,
  marginAccount: Address,
  token: Address,
  amount: bigint,
  approvalCeiling: bigint,
  fields: Record<string, unknown> = {},
): Promise<boolean> {
  if (!(await ensureAllowance(ctx, token, marginAccount, amount, approvalCeiling, fields))) return false;
  const result = await sendTx(ctx, {
    to: marginAccount,
    data: encodeFunctionData({
      abi: kuruMarginAccountAbi,
      functionName: "deposit",
      args: [accountAddress(ctx), token, amount],
    }),
    abi: kuruMarginAccountAbi,
    action: "marginDeposit",
    fields: { ...fields, token, amount },
  });
  return result.status === "success" || result.status === "dry-run";
}

export async function withdrawFromMargin(
  ctx: TxContext,
  marginAccount: Address,
  token: Address,
  amount: bigint,
  fields: Record<string, unknown> = {},
): Promise<boolean> {
  const result = await sendTx(ctx, {
    to: marginAccount,
    data: encodeFunctionData({ abi: kuruMarginAccountAbi, functionName: "withdraw", args: [amount, token] }),
    abi: kuruMarginAccountAbi,
    action: "marginWithdraw",
    fields: { ...fields, token, amount },
  });
  return result.status === "success" || result.status === "dry-run";
}

/** Withdraws the whole margin balance of each token in one transaction. */
export async function withdrawAllFromMargin(
  ctx: TxContext,
  marginAccount: Address,
  tokens: Address[],
  fields: Record<string, unknown> = {},
): Promise<boolean> {
  const result = await sendTx(ctx, {
    to: marginAccount,
    data: encodeFunctionData({
      abi: kuruMarginAccountAbi,
      functionName: "batchWithdrawMaxTokens",
      args: [tokens],
    }),
    abi: kuruMarginAccountAbi,
    action: "marginWithdrawAll",
    fields: { ...fields, tokens },
  });
  return result.status === "success" || result.status === "dry-run";
}

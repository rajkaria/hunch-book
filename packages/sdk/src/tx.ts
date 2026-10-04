import { txUrl } from "@hunch-book/shared";
import { type Abi, type Address, erc20Abi, type Hex, maxUint256, type TransactionReceipt } from "viem";
import { type HunchContext, requireWallet } from "./context.js";
import { HunchError, withKnownErrors } from "./errors.js";

// Every write goes through `send`: simulate with every known error attached (so a revert comes back
// in plain words before anything is signed), sign and send with the wallet client, wait for the
// receipt, and return the hash with its explorer link.

export interface TxResult<T = unknown> {
  hash: Hex;
  /** The transaction on the network's explorer. */
  url: string;
  /** "pending" when called with `wait: false`. */
  status: "success" | "pending";
  blockNumber: bigint | null;
  /** The function's return value, from the simulation. */
  result: T;
  receipt: TransactionReceipt | null;
}

export interface SendOptions {
  /** Wait for the receipt (the default). With false, returns as soon as the transaction is sent. */
  wait?: boolean;
}

export interface ContractCall {
  address: Address;
  abi: Abi | readonly unknown[];
  functionName: string;
  args?: readonly unknown[];
  value?: bigint;
}

export async function send<T = unknown>(
  ctx: HunchContext,
  call: ContractCall,
  options: SendOptions = {},
): Promise<TxResult<T>> {
  const wallet = requireWallet(ctx);
  let request: unknown;
  let result: unknown;
  try {
    const simulated = await ctx.publicClient.simulateContract({
      address: call.address,
      abi: withKnownErrors(call.abi as Abi),
      functionName: call.functionName,
      args: call.args ?? [],
      account: wallet.account,
      ...(call.value ? { value: call.value } : {}),
    } as never);
    request = simulated.request;
    result = simulated.result;
  } catch (e) {
    throw HunchError.from(e);
  }
  let hash: Hex;
  try {
    hash = await wallet.writeContract({
      ...(request as object),
      account: wallet.account,
      chain: ctx.chain,
    } as never);
  } catch (e) {
    throw HunchError.from(e);
  }
  const url = txUrl(ctx.deployment, hash);
  if (options.wait === false) {
    return { hash, url, status: "pending", blockNumber: null, result: result as T, receipt: null };
  }
  const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    throw new HunchError(`The transaction reverted onchain: ${url}`, { code: "Reverted" });
  }
  return { hash, url, status: "success", blockNumber: receipt.blockNumber, result: result as T, receipt };
}

export type ApprovalMode = "exact" | "unlimited";

export async function approve(
  ctx: HunchContext,
  token: Address,
  spender: Address,
  amount: bigint,
  options: SendOptions = {},
): Promise<TxResult<boolean>> {
  return send<boolean>(
    ctx,
    { address: token, abi: erc20Abi, functionName: "approve", args: [spender, amount] },
    options,
  );
}

export async function allowanceOf(
  ctx: HunchContext,
  token: Address,
  owner: Address,
  spender: Address,
): Promise<bigint> {
  return ctx.publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "allowance",
    args: [owner, spender],
  });
}

export async function balanceOf(ctx: HunchContext, token: Address, owner: Address): Promise<bigint> {
  return ctx.publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [owner],
  });
}

/** Approves `spender` for `amount` (or without limit) only if the current allowance is below `amount`. */
export async function ensureAllowance(
  ctx: HunchContext,
  token: Address,
  spender: Address,
  amount: bigint,
  options: { approval?: ApprovalMode } & SendOptions = {},
): Promise<TxResult<boolean> | null> {
  const owner = requireWallet(ctx).account.address;
  const current = await allowanceOf(ctx, token, owner, spender);
  if (current >= amount) return null;
  return approve(ctx, token, spender, options.approval === "unlimited" ? maxUint256 : amount, { wait: true });
}

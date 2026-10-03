import { type Deployment, txUrl } from "@hunch-book/shared";
import {
  type Abi,
  type Account,
  type Address,
  BaseError,
  type Chain,
  decodeErrorResult,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
  type WalletClient,
} from "viem";
import { errorMessage, log } from "./log.js";

// Every transaction the bot sends goes through sendTx:
// - with the kill switch off it only logs what it would send;
// - it simulates first (estimateGas), so a call that would revert costs nothing;
// - it sets an explicit gas limit (Monad charges the limit, not the gas used): the estimate plus 10%,
//   never above MAKER_MAX_GAS_PER_TX;
// - it refuses to send while the base fee is above MAKER_MAX_GAS_PRICE_GWEI, and never bids above it;
// - it logs one JSON line per transaction with the hash and the explorer link.

export interface TxContext {
  publicClient: PublicClient;
  walletClient: WalletClient | undefined;
  account: Account | Address;
  chain: Chain;
  deployment: Deployment;
  enabled: boolean;
  maxGasPriceWei: bigint;
  maxGasPerTx: bigint;
  receiptTimeoutMs?: number;
}

export interface TxRequest {
  to: Address;
  data: Hex;
  /** For decoding a revert reason. */
  abi: Abi;
  /** Short name for the log line, such as "batchUpdate" or "mintSets". */
  action: string;
  fields?: Record<string, unknown>;
}

export type TxResult =
  | { status: "dry-run" }
  | { status: "skipped"; reason: string }
  | { status: "unknown"; hash: Hex; reason: string }
  | { status: "success" | "reverted"; hash: Hex; receipt: TransactionReceipt; gasLimit: bigint };

const GAS_BUFFER_PCT = 110n;

export function accountAddress(ctx: { account: Account | Address }): Address {
  return typeof ctx.account === "string" ? ctx.account : ctx.account.address;
}

/** The custom error name behind a failed call, when the ABI knows it. */
export function revertReason(error: unknown, abi: Abi): string {
  if (error instanceof BaseError) {
    const raw = error.walk((e) => typeof (e as { data?: unknown }).data === "string") as {
      data?: Hex;
    } | null;
    if (raw?.data && raw.data.length >= 10) {
      try {
        return decodeErrorResult({ abi, data: raw.data }).errorName;
      } catch {
        // fall through to the message
      }
    }
  }
  return errorMessage(error);
}

export async function sendTx(ctx: TxContext, request: TxRequest): Promise<TxResult> {
  const fields = { action: request.action, to: request.to, ...request.fields };
  if (!ctx.enabled || !ctx.walletClient) {
    log("dry-run", { ...fields, note: "MAKER_ENABLED is off; nothing sent" });
    return { status: "dry-run" };
  }
  const from = accountAddress(ctx);

  const block = await ctx.publicClient.getBlock();
  const baseFee = block.baseFeePerGas ?? 0n;
  if (baseFee > ctx.maxGasPriceWei) {
    const reason = `base fee ${baseFee} wei is above MAKER_MAX_GAS_PRICE_GWEI`;
    log("tx-skipped", { ...fields, reason }, "warn");
    return { status: "skipped", reason };
  }
  let priority = 0n;
  try {
    priority = await ctx.publicClient.estimateMaxPriorityFeePerGas({ chain: ctx.chain });
  } catch {
    priority = 0n;
  }
  const headroom = ctx.maxGasPriceWei - baseFee;
  const maxPriorityFeePerGas = priority < headroom ? priority : headroom;

  let estimate: bigint;
  try {
    estimate = await ctx.publicClient.estimateGas({ account: from, to: request.to, data: request.data });
  } catch (error) {
    const reason = revertReason(error, request.abi);
    log("tx-skipped", { ...fields, reason: `simulation failed: ${reason}` }, "warn");
    return { status: "skipped", reason };
  }
  if (estimate > ctx.maxGasPerTx) {
    const reason = `needs ${estimate} gas, above MAKER_MAX_GAS_PER_TX ${ctx.maxGasPerTx}`;
    log("tx-skipped", { ...fields, reason }, "warn");
    return { status: "skipped", reason };
  }
  const buffered = (estimate * GAS_BUFFER_PCT + 99n) / 100n;
  const gasLimit = buffered < ctx.maxGasPerTx ? buffered : ctx.maxGasPerTx;

  let hash: Hex;
  try {
    hash = await ctx.walletClient.sendTransaction({
      account: ctx.account,
      chain: ctx.chain,
      to: request.to,
      data: request.data,
      gas: gasLimit,
      maxFeePerGas: ctx.maxGasPriceWei,
      maxPriorityFeePerGas,
    });
  } catch (error) {
    const reason = errorMessage(error);
    log("tx-skipped", { ...fields, reason: `send failed: ${reason}` }, "error");
    return { status: "skipped", reason };
  }
  const url = txUrl(ctx.deployment, hash);
  try {
    const receipt = await ctx.publicClient.waitForTransactionReceipt({
      hash,
      timeout: ctx.receiptTimeoutMs ?? 60_000,
    });
    const status = receipt.status === "success" ? "success" : "reverted";
    log(
      "tx",
      { ...fields, status, hash, url, block: receipt.blockNumber, gasLimit, gasUsed: receipt.gasUsed },
      status === "success" ? "info" : "error",
    );
    return { status, hash, receipt, gasLimit };
  } catch (error) {
    const reason = errorMessage(error);
    log("tx-unknown", { ...fields, hash, url, reason }, "error");
    return { status: "unknown", hash, reason };
  }
}

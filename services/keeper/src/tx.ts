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

// Every transaction the keeper sends goes through sendTx:
// - it simulates first (estimateGas from the keeper's address), so a call that would revert costs
//   nothing; with the kill switch off it stops there and logs what it would have sent;
// - it sets an explicit gas limit (Monad charges the limit, not the gas used): the estimate plus 10%,
//   never above KEEPER_MAX_GAS_PER_TX;
// - it refuses to send while the base fee is above KEEPER_MAX_GAS_PRICE_GWEI, and never bids above it;
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
  /** Native MON sent with the call (the Pyth update fee). */
  value?: bigint;
  /** For decoding a revert reason. */
  abi: Abi | readonly unknown[];
  /** Short name for the log line, such as "graduate" or "claimTokensFor". */
  action: string;
  fields?: Record<string, unknown>;
  /**
   * The least gas limit to send with, when the estimate is known to be too low: a call that catches
   * an inner call's failure (AutoRedeemer.redeemManyFor) still succeeds with too little gas, so an
   * estimate can starve the inner call. Never above KEEPER_MAX_GAS_PER_TX.
   */
  minGas?: bigint;
}

export type Simulation = { ok: true; gas: bigint } | { ok: false; reason: string };

export type TxResult =
  | { status: "dry-run"; simulation: Simulation }
  | { status: "skipped"; reason: string; simulation?: Simulation }
  | { status: "unknown"; hash: Hex; reason: string }
  | { status: "success" | "reverted"; hash: Hex; receipt: TransactionReceipt; gasLimit: bigint };

const GAS_BUFFER_PCT = 110n;

export function accountAddress(ctx: { account: Account | Address }): Address {
  return typeof ctx.account === "string" ? ctx.account : ctx.account.address;
}

/** The custom error name behind a failed call, when the ABI knows it. */
export function revertReason(error: unknown, abi: Abi | readonly unknown[]): string {
  if (error instanceof BaseError) {
    const raw = error.walk((e) => typeof (e as { data?: unknown }).data === "string") as {
      data?: Hex;
    } | null;
    if (raw?.data && raw.data.length >= 10) {
      try {
        const decoded = decodeErrorResult({ abi: abi as Abi, data: raw.data });
        const args = decoded.args?.length ? `(${decoded.args.map(String).join(", ")})` : "";
        return `${decoded.errorName}${args}`;
      } catch {
        // fall through to the message
      }
    }
  }
  return errorMessage(error);
}

/** An estimate plus the 10% buffer, rounded up. */
export function bufferedGas(estimate: bigint): bigint {
  return (estimate * GAS_BUFFER_PCT + 99n) / 100n;
}

/** The gas limit sendTx sets for an estimate: +10%, capped. */
export function gasLimitFor(estimate: bigint, cap: bigint): bigint {
  const buffered = bufferedGas(estimate);
  return buffered < cap ? buffered : cap;
}

/** estimateGas from the keeper's address: does the call go through right now, and for how much gas? */
export async function simulate(ctx: TxContext, request: TxRequest): Promise<Simulation> {
  try {
    const gas = await ctx.publicClient.estimateGas({
      account: accountAddress(ctx),
      to: request.to,
      data: request.data,
      value: request.value,
    });
    return { ok: true, gas };
  } catch (error) {
    return { ok: false, reason: revertReason(error, request.abi) };
  }
}

export async function sendTx(ctx: TxContext, request: TxRequest): Promise<TxResult> {
  const fields: Record<string, unknown> = { action: request.action, to: request.to, ...request.fields };
  if (request.value) fields.value = request.value;

  const simulation = await simulate(ctx, request);
  if (!ctx.enabled || !ctx.walletClient) {
    log("dry-run", {
      ...fields,
      simulation: simulation.ok ? "ok" : `would revert: ${simulation.reason}`,
      gasEstimate: simulation.ok ? simulation.gas : undefined,
      note: "KEEPER_ENABLED is off; nothing sent",
    });
    return { status: "dry-run", simulation };
  }
  if (!simulation.ok) {
    log("tx-skipped", { ...fields, reason: `simulation failed: ${simulation.reason}` }, "warn");
    return { status: "skipped", reason: simulation.reason, simulation };
  }
  if (simulation.gas > ctx.maxGasPerTx) {
    const reason = `needs ${simulation.gas} gas, above KEEPER_MAX_GAS_PER_TX ${ctx.maxGasPerTx}`;
    log("tx-skipped", { ...fields, reason }, "warn");
    return { status: "skipped", reason, simulation };
  }

  const block = await ctx.publicClient.getBlock();
  const baseFee = block.baseFeePerGas ?? 0n;
  if (baseFee > ctx.maxGasPriceWei) {
    const reason = `base fee ${baseFee} wei is above KEEPER_MAX_GAS_PRICE_GWEI`;
    log("tx-skipped", { ...fields, reason }, "warn");
    return { status: "skipped", reason, simulation };
  }
  let priority = 0n;
  try {
    priority = await ctx.publicClient.estimateMaxPriorityFeePerGas({ chain: ctx.chain });
  } catch {
    priority = 0n;
  }
  const headroom = ctx.maxGasPriceWei - baseFee;
  const maxPriorityFeePerGas = priority < headroom ? priority : headroom;
  const estimated = gasLimitFor(simulation.gas, ctx.maxGasPerTx);
  const floor =
    request.minGas !== undefined && request.minGas < ctx.maxGasPerTx ? request.minGas : ctx.maxGasPerTx;
  const gasLimit = request.minGas !== undefined && estimated < floor ? floor : estimated;

  let hash: Hex;
  try {
    hash = await ctx.walletClient.sendTransaction({
      account: ctx.account,
      chain: ctx.chain,
      to: request.to,
      data: request.data,
      value: request.value,
      gas: gasLimit,
      maxFeePerGas: ctx.maxGasPriceWei,
      maxPriorityFeePerGas,
    });
  } catch (error) {
    const reason = errorMessage(error);
    log("tx-skipped", { ...fields, reason: `send failed: ${reason}` }, "error");
    return { status: "skipped", reason, simulation };
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

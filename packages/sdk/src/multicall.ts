import type { Abi, Address, ContractFunctionParameters } from "viem";
import type { HunchContext } from "./context.js";

// Batched reads through Multicall3 with per-call failure. Results are typed loosely on purpose and
// parsed field by field by the caller, so one failed read never sinks a whole page of markets.

export interface Call {
  address: Address;
  abi: Abi | readonly unknown[];
  functionName: string;
  args?: readonly unknown[];
}

export type CallResult = { status: "success"; result: unknown } | { status: "failure"; error: Error };

/** Calldata bytes per Multicall3 chunk: about 150 calls per eth_call. */
const BATCH_BYTES = 16_384;

export async function multicall(
  ctx: HunchContext,
  calls: readonly Call[],
  options: { blockNumber?: bigint } = {},
): Promise<CallResult[]> {
  if (calls.length === 0) return [];
  const results = await ctx.publicClient.multicall({
    contracts: calls as unknown as readonly ContractFunctionParameters[],
    allowFailure: true,
    batchSize: BATCH_BYTES,
    multicallAddress: ctx.multicallAddress,
    ...(options.blockNumber === undefined ? {} : { blockNumber: options.blockNumber }),
  });
  return results as CallResult[];
}

/** The result of a successful call, or undefined. */
export function ok<T>(result: CallResult | undefined): T | undefined {
  return result?.status === "success" ? (result.result as T) : undefined;
}

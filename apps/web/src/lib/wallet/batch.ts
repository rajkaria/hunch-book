"use client";

import { type Abi, type Address, encodeFunctionData, type Hex } from "viem";
import { useCapabilities, useConnection } from "wagmi";
import { PASSKEY_CONNECTOR_TYPE } from "../account/connector";
import { appChain } from "../config";
import type { TxStep } from "./useTxRunner";

// One confirmation for many calls: EIP-5792 `wallet_sendCalls`, used only when the wallet says it can
// run calls on this chain as one atomic batch (all land or none do). The SDK's `atomicSupported` uses
// the same rule; this copy keeps the SDK out of the browser bundle.

/** Whether EIP-5792 capabilities (one chain's, or a map by chain id) offer atomic batches on `chainId`. */
export function atomicBatchReady(capabilities: unknown, chainId: number): boolean {
  if (!capabilities || typeof capabilities !== "object") return false;
  const caps = capabilities as Record<string, unknown>;
  const forChain = (caps[chainId] ?? caps[`0x${chainId.toString(16)}`] ?? caps) as Record<string, unknown>;
  const atomic = forChain?.atomic as { status?: string } | undefined;
  return atomic?.status === "supported" || atomic?.status === "ready";
}

/** The steps as raw calls for `wallet_sendCalls`. */
export function encodeCalls(steps: readonly TxStep[]): { to: Address; data: Hex; value?: bigint }[] {
  return steps.map(({ request }) => ({
    to: request.address,
    data: encodeFunctionData({
      abi: request.abi as Abi,
      functionName: request.functionName,
      args: request.args ?? [],
    } as never),
    ...(request.value ? { value: request.value } : {}),
  }));
}

/** True when the connected wallet can send an atomic batch on the app's chain. Passkey accounts cannot. */
export function useAtomicBatch(account: Address | undefined): boolean {
  const { connector } = useConnection();
  const enabled = Boolean(account) && connector?.type !== PASSKEY_CONNECTOR_TYPE;
  const caps = useCapabilities({
    account,
    chainId: appChain.id,
    query: { enabled, retry: false, staleTime: 5 * 60_000 },
  });
  return enabled && atomicBatchReady(caps.data, appChain.id);
}

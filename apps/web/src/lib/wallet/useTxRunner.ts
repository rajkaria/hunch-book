"use client";

import { type QueryKey, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import type { Abi, Address, Hex } from "viem";
import { useWriteContract } from "wagmi";
import { getPublicClient } from "../chain/client";
import { appChain } from "../config";
import { describeTxError, withKnownErrors } from "./errors";

export interface TxRecord {
  hash: Hex;
  label: string;
  status: "pending" | "confirmed" | "failed";
}

export interface WriteRequest {
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
  value?: bigint;
}

export interface TxStep {
  label: string;
  request: WriteRequest;
}

export type TxStage = "idle" | "simulate" | "wallet" | "block";

/**
 * Sends contract writes one at a time: simulate (so a revert reads in plain words before the wallet
 * opens), ask the wallet, wait for the receipt, then refresh the given queries. Every hash is kept so
 * the UI can link it on the explorer.
 */
export function useTxRunner(refresh: QueryKey[]) {
  const write = useWriteContract();
  const queryClient = useQueryClient();
  const [txs, setTxs] = useState<TxRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [stage, setStage] = useState<TxStage>("idle");
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  const send = useCallback(
    async (label: string, request: WriteRequest, account: Address): Promise<boolean> => {
      setStage("simulate");
      const client = getPublicClient();
      await client.simulateContract({ ...request, abi: withKnownErrors(request.abi), account });
      setStage("wallet");
      // The request shape is checked by the simulation above; wagmi's generics cannot follow a dynamic ABI.
      const hash = await write.mutateAsync({ ...request, chainId: appChain.id } as never);
      setTxs((prev) => [{ hash, label, status: "pending" }, ...prev]);
      setStage("block");
      const receipt = await client.waitForTransactionReceipt({ hash, pollingInterval: 500 });
      const status = receipt.status === "success" ? "confirmed" : "failed";
      setTxs((prev) => prev.map((t) => (t.hash === hash ? { ...t, status } : t)));
      if (status === "failed") setError("The transaction reverted on chain. Nothing was moved.");
      return status === "confirmed";
    },
    [write],
  );

  const refreshAll = useCallback(
    () => Promise.all(refresh.map((queryKey) => queryClient.invalidateQueries({ queryKey }))),
    [queryClient, refresh],
  );

  /** One write. Resolves true once it is confirmed on chain. */
  const run = useCallback(
    async (label: string, request: WriteRequest, account: Address): Promise<boolean> => {
      setError(null);
      try {
        return await send(label, request, account);
      } catch (e) {
        setError(describeTxError(e));
        return false;
      } finally {
        setStage("idle");
        await refreshAll();
      }
    },
    [send, refreshAll],
  );

  /** Several writes in order, each simulated and confirmed before the next. Stops at the first failure. */
  const runAll = useCallback(
    async (steps: TxStep[], account: Address): Promise<number> => {
      setError(null);
      let done = 0;
      setProgress({ done, total: steps.length });
      try {
        for (const step of steps) {
          const ok = await send(step.label, step.request, account);
          if (!ok) break;
          done += 1;
          setProgress({ done, total: steps.length });
        }
      } catch (e) {
        setError(`${steps[done]?.label ?? "A step"} failed: ${describeTxError(e)}`);
      } finally {
        setStage("idle");
        setProgress(null);
        await refreshAll();
      }
      return done;
    },
    [send, refreshAll],
  );

  return { run, runAll, txs, error, stage, progress, busy: stage !== "idle" };
}

/** Button text while a write is in flight. */
export function stageText(stage: TxStage): string {
  switch (stage) {
    case "simulate":
      return "Checking...";
    case "wallet":
      return "Confirm in your wallet...";
    case "block":
      return "Waiting for the block...";
    default:
      return "";
  }
}

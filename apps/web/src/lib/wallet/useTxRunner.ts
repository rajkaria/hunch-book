"use client";

import { type QueryKey, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import type { Abi, Address, Hex } from "viem";
import { useWriteContract } from "wagmi";
import { getPublicClient } from "../chain/client";
import { appChain } from "../config";
import { describeTxError } from "./errors";

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
}

/**
 * Sends one contract write at a time: simulate (for a readable revert), ask the wallet, wait for the
 * receipt, then refresh the given queries. Every hash is kept so the UI can link it on the explorer.
 */
export function useTxRunner(refresh: QueryKey[]) {
  const write = useWriteContract();
  const queryClient = useQueryClient();
  const [txs, setTxs] = useState<TxRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [stage, setStage] = useState<"idle" | "wallet" | "block">("idle");

  const run = useCallback(
    async (label: string, request: WriteRequest, account: Address): Promise<boolean> => {
      setError(null);
      setStage("wallet");
      try {
        const client = getPublicClient();
        await client.simulateContract({ ...request, account });
        // The request shape is checked by the simulation above; wagmi's generics cannot follow a dynamic ABI.
        const hash = await write.mutateAsync({ ...request, chainId: appChain.id } as never);
        setTxs((prev) => [{ hash, label, status: "pending" }, ...prev]);
        setStage("block");
        const receipt = await client.waitForTransactionReceipt({ hash, pollingInterval: 500 });
        const status = receipt.status === "success" ? "confirmed" : "failed";
        setTxs((prev) => prev.map((t) => (t.hash === hash ? { ...t, status } : t)));
        if (status === "failed") setError("The transaction reverted on chain. Nothing was moved.");
        await Promise.all(refresh.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
        return status === "confirmed";
      } catch (e) {
        setError(describeTxError(e));
        return false;
      } finally {
        setStage("idle");
      }
    },
    [write, queryClient, refresh],
  );

  return { run, txs, error, stage, busy: stage !== "idle" };
}

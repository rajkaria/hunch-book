"use client";

import { type QueryKey, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import type { Abi, Address, Hex } from "viem";
import { useConfig, useSendCalls, useWriteContract } from "wagmi";
import { waitForCallsStatus } from "wagmi/actions";
import { getPublicClient } from "../chain/client";
import { appChain, appNetwork, parseNetwork } from "../config";
import { encodeCalls } from "./batch";
import { describeTxError, withKnownErrors } from "./errors";
import { RECEIPT_POLL_MS, recordTxTiming, setTxBlockTime } from "./txTiming";

export interface TxRecord {
  hash: Hex;
  label: string;
  status: "pending" | "confirmed" | "failed";
  /** Milliseconds from the wallet's signature to the receipt, measured in this browser. */
  includedMs?: number;
  /** The block it landed in. */
  block?: bigint;
}

/**
 * A refresh key aimed at the network active now. Callers may build their keys once, at import, with the
 * network of that moment; the network element (the second one, by convention) follows any switch since.
 */
export function forActiveNetwork(key: QueryKey): QueryKey {
  return key.length > 1 && parseNetwork(String(key[1])) ? [key[0], appNetwork, ...key.slice(2)] : key;
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
  const sendCalls = useSendCalls();
  const config = useConfig();
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
      // The wallet has signed and sent it: start the inclusion clock (this browser's clock).
      const signedAt = Date.now();
      const network = appNetwork;
      setTxs((prev) => [{ hash, label, status: "pending" }, ...prev]);
      setStage("block");
      const receipt = await client.waitForTransactionReceipt({ hash, pollingInterval: RECEIPT_POLL_MS });
      const seenAt = Date.now();
      const includedMs = seenAt - signedAt;
      recordTxTiming({
        hash,
        network,
        signedAt,
        seenAt,
        includedMs,
        block: receipt.blockNumber,
        blockTime: null,
      });
      client
        .getBlock({ blockNumber: receipt.blockNumber })
        .then((b) => setTxBlockTime(hash, Number(b.timestamp)))
        .catch(() => undefined);
      const status = receipt.status === "success" ? "confirmed" : "failed";
      setTxs((prev) =>
        prev.map((t) => (t.hash === hash ? { ...t, status, includedMs, block: receipt.blockNumber } : t)),
      );
      if (status === "failed") setError("The transaction reverted on chain. Nothing was moved.");
      return status === "confirmed";
    },
    [write],
  );

  const refreshAll = useCallback(
    () =>
      Promise.all(
        refresh.map((queryKey) => queryClient.invalidateQueries({ queryKey: forActiveNetwork(queryKey) })),
      ),
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

  /**
   * Several writes as one atomic batch (EIP-5792): one confirmation, and either every call lands or none
   * does. Only for wallets that report atomic support (`useAtomicBatch`). The calls can depend on each
   * other (a claim, then a redeem of what was claimed), so they are not simulated one by one: the wallet
   * runs the batch, and a revert anywhere moves nothing. Resolves true once the batch is confirmed.
   */
  const runBatch = useCallback(
    async (steps: TxStep[], account: Address, label: string): Promise<boolean> => {
      setError(null);
      setProgress({ done: 0, total: steps.length });
      try {
        setStage("wallet");
        const { id } = await sendCalls.mutateAsync({
          account,
          chainId: appChain.id,
          forceAtomic: true,
          calls: encodeCalls(steps),
        } as never);
        const signedAt = Date.now();
        setStage("block");
        const status = await waitForCallsStatus(config, { id, pollingInterval: RECEIPT_POLL_MS });
        const seenAt = Date.now();
        const ok = status.status === "success";
        const records: TxRecord[] = (status.receipts ?? []).map((r) => ({
          hash: r.transactionHash,
          label,
          status: ok && r.status === "success" ? "confirmed" : "failed",
          includedMs: seenAt - signedAt,
          block: r.blockNumber,
        }));
        setTxs((prev) => [...records, ...prev]);
        if (!ok) {
          setError("The batch reverted on chain, so none of its calls went through. Nothing was moved.");
          return false;
        }
        setProgress({ done: steps.length, total: steps.length });
        return true;
      } catch (e) {
        setError(describeTxError(e));
        return false;
      } finally {
        setStage("idle");
        setProgress(null);
        await refreshAll();
      }
    },
    [sendCalls, config, refreshAll],
  );

  return { run, runAll, runBatch, txs, error, stage, progress, busy: stage !== "idle" };
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

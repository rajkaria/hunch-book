"use client";

import { type QueryKey, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import type { Address } from "viem";
import { useSignTypedData } from "wagmi";
import { getPublicClient } from "../chain/client";
import { appChain, appNetwork } from "../config";
import { formatUsdc } from "../format";
import { describeTxError } from "../wallet/errors";
import type { TxRecord } from "../wallet/useTxRunner";
import { fetchDripStatus, fetchRelayStatus, prepareRelayedStake, submitRelayedStake } from "./client";

export const relayerKeys = {
  drip: () => ["relayer", "drip", appNetwork] as const,
  relay: () => ["relayer", "relay", appNetwork] as const,
};

/** Whether this server runs the gas drip (GET /api/drip). Asked only when `enabled`. */
export function useDripStatus(enabled = true) {
  return useQuery({
    queryKey: relayerKeys.drip(),
    queryFn: () => fetchDripStatus(),
    staleTime: 5 * 60_000,
    enabled,
  });
}

/** Whether this server relays stakes (GET /api/relay/stake). Asked only when `enabled`. */
export function useRelayStatus(enabled = true) {
  return useQuery({
    queryKey: relayerKeys.relay(),
    queryFn: () => fetchRelayStatus(),
    staleTime: 5 * 60_000,
    enabled,
  });
}

export type RelayStage = "idle" | "sign" | "relay" | "block";

export function relayStageText(stage: RelayStage): string {
  switch (stage) {
    case "sign":
      return "Sign the USDC authorisation...";
    case "relay":
      return "Sending through the relayer...";
    case "block":
      return "Waiting for the block...";
    default:
      return "";
  }
}

/**
 * A stake with no MON: sign an EIP-3009 authorisation for exactly this market, side and amount, then
 * the relayer submits Market.stakeWithAuthorization and pays the gas. No approval is needed.
 */
export function useRelayedStake(refresh: QueryKey[]) {
  const sign = useSignTypedData();
  const queryClient = useQueryClient();
  const [stage, setStage] = useState<RelayStage>("idle");
  const [error, setError] = useState<string | null>(null);
  const [txs, setTxs] = useState<TxRecord[]>([]);

  const stake = useCallback(
    async (args: { market: Address; usdc: Address; user: Address; side: 0 | 1; amount: bigint }) => {
      setError(null);
      setStage("sign");
      try {
        const client = getPublicClient();
        const { auth, typedData } = await prepareRelayedStake({
          client,
          chainId: appChain.id,
          usdc: args.usdc,
          market: args.market,
          user: args.user,
          side: args.side,
          amount: args.amount,
          nowSeconds: Date.now() / 1000,
        });
        const signature = await sign.signTypedDataAsync(typedData as never);
        setStage("relay");
        const result = await submitRelayedStake(auth, signature, appNetwork);
        if (!result.ok) {
          setError(result.error);
          return false;
        }
        const label = `Stake ${formatUsdc(args.amount)} USDC on ${args.side === 0 ? "YES" : "NO"} (relayed)`;
        setTxs((prev) => [{ hash: result.hash, label, status: "pending" }, ...prev]);
        setStage("block");
        const receipt = await client.waitForTransactionReceipt({ hash: result.hash, pollingInterval: 500 });
        const status = receipt.status === "success" ? "confirmed" : "failed";
        setTxs((prev) => prev.map((t) => (t.hash === result.hash ? { ...t, status } : t)));
        if (status === "failed") setError("The relayed stake reverted on chain. Nothing was moved.");
        return status === "confirmed";
      } catch (e) {
        setError(describeTxError(e));
        return false;
      } finally {
        setStage("idle");
        await Promise.all(refresh.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
      }
    },
    [sign, queryClient, refresh],
  );

  return { stake, stage, error, txs, busy: stage !== "idle" };
}

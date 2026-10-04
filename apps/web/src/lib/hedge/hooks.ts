"use client";

import { useQuery } from "@tanstack/react-query";
import type { Address } from "viem";
import { getPublicClient } from "../chain/client";
import { appDeployment, appNetwork } from "../config";
import { readFundingHistory, readFundingSum, readPerplPositions, readPerpMeta } from "./perpl";

// React Query hooks for the hedge assistant. Query keys never hold bigints.

const exchange = (): Address => appDeployment.external.perpl.exchange;

/** Intervals of history the page reads: 48 is about 34 hours at today's block times. */
export const HISTORY_INTERVALS = 48;

export const hedgeKeys = {
  positions: (owner: Address) => ["hedge", "positions", appNetwork, owner.toLowerCase()] as const,
  meta: (perpId: bigint) => ["hedge", "perp", appNetwork, perpId.toString()] as const,
  funding: (perpId: bigint) => ["hedge", "funding", appNetwork, perpId.toString()] as const,
  sumNow: (perpId: bigint) => ["hedge", "sum-now", appNetwork, perpId.toString()] as const,
};

/** Open Perpl positions of `owner`, or { status: "no-account" }. */
export function usePerplPositions(owner: Address | undefined) {
  return useQuery({
    queryKey: hedgeKeys.positions(owner ?? "0x"),
    queryFn: () => readPerplPositions(getPublicClient(), exchange(), owner as Address),
    enabled: Boolean(owner),
    refetchInterval: 60_000,
    retry: 1,
  });
}

export function usePerpMeta(perpId: bigint | undefined) {
  return useQuery({
    queryKey: hedgeKeys.meta(perpId ?? -1n),
    queryFn: () => readPerpMeta(getPublicClient(), exchange(), perpId as bigint),
    enabled: perpId !== undefined,
    refetchInterval: 60_000,
  });
}

/** The perp's recent funding, at Perpl's grid blocks up to the latest event. */
export function useFundingHistory(perpId: bigint | undefined) {
  return useQuery({
    queryKey: hedgeKeys.funding(perpId ?? -1n),
    queryFn: async () => {
      const client = getPublicClient();
      const head = await client.getBlockNumber();
      return {
        head,
        ...(await readFundingHistory(client, exchange(), perpId as bigint, head, HISTORY_INTERVALS)),
      };
    },
    enabled: perpId !== undefined,
    refetchInterval: 60_000,
  });
}

/** The perp's funding sum now (as of its last funding event). */
export function useFundingSumNow(perpId: bigint | undefined) {
  return useQuery({
    queryKey: hedgeKeys.sumNow(perpId ?? -1n),
    queryFn: async () => {
      const client = getPublicClient();
      const head = await client.getBlockNumber();
      return { head, ...(await readFundingSum(client, exchange(), perpId as bigint, head)) };
    },
    enabled: perpId !== undefined,
    refetchInterval: 60_000,
  });
}

"use client";

import { useQueries, useQuery } from "@tanstack/react-query";
import type { Address } from "viem";
import { getPublicClient } from "../chain/client";
import { readMarket } from "../chain/reads";
import { appDeployment, appNetwork, isDeployed } from "../config";
import { queryKeys } from "../hooks";
import type { MarketView } from "../market/types";
import {
  readFundingHistory,
  readFundingSum,
  readFundingSums,
  readPerplPositions,
  readPerpMeta,
} from "./perpl";

// React Query hooks for the hedge assistant. Query keys never hold bigints.

const exchange = (): Address => appDeployment.external.perpl.exchange;

/** Intervals of history the page reads: 48 is about 34 hours at today's block times. */
export const HISTORY_INTERVALS = 48;

export const hedgeKeys = {
  positions: (owner: Address) => ["hedge", "positions", appNetwork, owner.toLowerCase()] as const,
  meta: (perpId: bigint) => ["hedge", "perp", appNetwork, perpId.toString()] as const,
  funding: (perpId: bigint) => ["hedge", "funding", appNetwork, perpId.toString()] as const,
  sumNow: (perpId: bigint) => ["hedge", "sum-now", appNetwork, perpId.toString()] as const,
  sumsAt: (perpId: bigint, blocks: readonly string[]) =>
    ["hedge", "sums-at", appNetwork, perpId.toString(), ...blocks] as const,
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

/**
 * The perp's funding sum at past blocks, keyed by block: the start of a window that has begun, or the end
 * of a tracked basket. Sums at past funding events are final, so they are read once in a while.
 */
export function useFundingSumsAt(perpId: bigint | undefined, blocks: readonly bigint[]) {
  const unique = [...new Set(blocks.map((b) => b.toString()))].sort();
  return useQuery({
    queryKey: hedgeKeys.sumsAt(perpId ?? -1n, unique),
    queryFn: () =>
      readFundingSums(
        getPublicClient(),
        exchange(),
        perpId as bigint,
        unique.map((b) => BigInt(b)),
      ),
    enabled: perpId !== undefined && unique.length > 0,
    staleTime: 10 * 60_000,
  });
}

/** Several markets at once, sharing the market page's cache: the legs of a tracked basket. */
export function useLegMarkets(addresses: readonly Address[]): (MarketView | null)[] {
  const results = useQueries({
    queries: addresses.map((address) => ({
      queryKey: queryKeys.market(address),
      queryFn: () => readMarket(getPublicClient(), appDeployment, address),
      enabled: isDeployed(appDeployment),
      refetchInterval: 6_000,
    })),
  });
  return results.map((r) => (r.data?.status === "ok" ? r.data.data : null));
}

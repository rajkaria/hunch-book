"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { Address } from "viem";
import { getPublicClient } from "./chain/client";
import {
  listMarkets,
  measureMsPerBlock,
  readChainHead,
  readMarket,
  readPortfolio,
  readProtocolAddresses,
  readUsdcState,
  readUserPosition,
} from "./chain/reads";
import { appChain, appDeployment, appNetwork, isDeployed } from "./config";
import type { ChainClock } from "./market/types";

// React Query hooks over the read layer. Query keys never hold bigints.

const deployed = isDeployed(appDeployment);

export const queryKeys = {
  markets: () => ["markets", appNetwork] as const,
  market: (address: Address) => ["market", appNetwork, address.toLowerCase()] as const,
  portfolio: (user: Address) => ["portfolio", appNetwork, user.toLowerCase()] as const,
  position: (market: Address, user: Address) =>
    ["position", appNetwork, market.toLowerCase(), user.toLowerCase()] as const,
  head: () => ["head", appNetwork] as const,
  blockTime: () => ["block-time", appNetwork] as const,
  protocol: () => ["protocol", appNetwork] as const,
  usdc: (user: Address) => ["usdc", appNetwork, user.toLowerCase()] as const,
};

export function useMarkets() {
  return useQuery({
    queryKey: queryKeys.markets(),
    queryFn: () => listMarkets(getPublicClient(), appDeployment),
    enabled: deployed,
    refetchInterval: 15_000,
  });
}

export function useMarket(address: Address) {
  return useQuery({
    queryKey: queryKeys.market(address),
    queryFn: () => readMarket(getPublicClient(), appDeployment, address),
    enabled: deployed,
    refetchInterval: 6_000,
  });
}

export function usePortfolio(user: Address | undefined) {
  return useQuery({
    queryKey: queryKeys.portfolio(user ?? "0x"),
    queryFn: () => readPortfolio(getPublicClient(), appDeployment, user as Address),
    enabled: deployed && Boolean(user),
    refetchInterval: 15_000,
  });
}

export function useUserPosition(market: Address, user: Address | undefined) {
  return useQuery({
    queryKey: queryKeys.position(market, user ?? "0x"),
    queryFn: () => readUserPosition(getPublicClient(), market, user as Address),
    enabled: deployed && Boolean(user),
    refetchInterval: 10_000,
  });
}

export function useProtocolAddresses() {
  return useQuery({
    queryKey: queryKeys.protocol(),
    queryFn: () => readProtocolAddresses(getPublicClient(), appDeployment),
    enabled: deployed,
    staleTime: Number.POSITIVE_INFINITY,
  });
}

export function useUsdcState(
  user: Address | undefined,
  protocol: { vault: Address; usdc: Address } | null | undefined,
) {
  return useQuery({
    queryKey: queryKeys.usdc(user ?? "0x"),
    queryFn: () =>
      readUsdcState(
        getPublicClient(),
        protocol?.usdc as Address,
        protocol?.vault as Address,
        user as Address,
      ),
    enabled: Boolean(user && protocol),
    refetchInterval: 10_000,
  });
}

/** The chain head (every 5 seconds) plus the measured block time (once), for block-clock markets. */
export function useChainClock(enabled = true): ChainClock | null {
  const head = useQuery({
    queryKey: queryKeys.head(),
    queryFn: () => readChainHead(getPublicClient()),
    enabled,
    refetchInterval: 5_000,
  });
  const blockNumber = head.data?.blockNumber;
  const pace = useQuery({
    queryKey: queryKeys.blockTime(),
    queryFn: () => measureMsPerBlock(getPublicClient(), blockNumber as bigint),
    enabled: enabled && blockNumber !== undefined,
    staleTime: 10 * 60_000,
  });
  if (!head.data) return null;
  const measured = typeof pace.data === "number";
  return {
    blockNumber: head.data.blockNumber,
    timestamp: head.data.timestamp,
    msPerBlock: measured ? (pace.data as number) : (appChain.blockTime ?? 400),
    measured,
  };
}

/** Unix seconds, ticking. Null until the component mounts, so server and client HTML match. */
export function useNow(intervalMs = 1_000): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Math.floor(Date.now() / 1000));
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

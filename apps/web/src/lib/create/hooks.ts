"use client";

import { marketKey } from "@hunch-book/shared";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { Address, Hex } from "viem";
import { getPublicClient } from "../chain/client";
import { appChain, appDeployment, appNetwork, isDeployed } from "../config";
import type { PriceFeedOption } from "./price";
import {
  previewMarket,
  readChallengeBlocks,
  readClock,
  readCreateConfig,
  readFastBlockTime,
  readMarketOf,
  readPerpContext,
  readPriceFeeds,
  readSpotPrice,
} from "./reads";

// React Query hooks over the create flow's reads. Query keys never hold bigints.

const deployed = isDeployed(appDeployment);

export const createKeys = {
  config: () => ["create", "config", appNetwork] as const,
  clock: () => ["create", "clock", appNetwork] as const,
  perp: (perpId: bigint) => ["create", "perp", appNetwork, perpId.toString()] as const,
  feeds: (resolver: Address) => ["create", "feeds", appNetwork, resolver.toLowerCase()] as const,
  spot: (key: string) => ["create", "spot", appNetwork, key] as const,
  preview: (resolver: Address, params: Hex) =>
    ["create", "preview", appNetwork, resolver.toLowerCase(), params] as const,
  marketOf: (key: Hex) => ["create", "market-of", appNetwork, key] as const,
  resolverView: (resolver: Address, view: string) =>
    ["create", "resolver-view", appNetwork, resolver.toLowerCase(), view] as const,
};

/** `value`, once it has stopped changing for `ms` milliseconds. */
export function useDebounced<T>(value: T, ms = 400): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return settled;
}

export function useCreateConfig() {
  return useQuery({
    queryKey: createKeys.config(),
    queryFn: () => readCreateConfig(getPublicClient(), appDeployment),
    enabled: deployed,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

/** The head every 15 seconds, with the block pace measured over two 10,000-block spans. */
export function useCreateClock(enabled = true) {
  return useQuery({
    queryKey: createKeys.clock(),
    queryFn: () => readClock(getPublicClient(), appChain.blockTime ?? 400),
    enabled: deployed && enabled,
    refetchInterval: 15_000,
  });
}

export function usePerpContext(perpId: bigint | null, headBlock: bigint | undefined) {
  return useQuery({
    queryKey: createKeys.perp(perpId ?? 0n),
    queryFn: () => readPerpContext(getPublicClient(), appDeployment, perpId as bigint, headBlock as bigint),
    enabled: deployed && perpId !== null && headBlock !== undefined,
    staleTime: 5 * 60_000,
  });
}

export function usePriceFeeds(resolver: Address | undefined) {
  return useQuery({
    queryKey: createKeys.feeds(resolver ?? "0x"),
    queryFn: () => readPriceFeeds(getPublicClient(), appDeployment, resolver as Address),
    enabled: deployed && Boolean(resolver),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/** Template 4's challenge period in blocks (fixed per resolver). */
export function useChallengeBlocks(resolver: Address | undefined) {
  return useQuery({
    queryKey: createKeys.resolverView(resolver ?? "0x", "challengeBlocks"),
    queryFn: () => readChallengeBlocks(getPublicClient(), resolver as Address),
    enabled: deployed && Boolean(resolver),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/** Template 6's fast block time in milliseconds (fixed per resolver). */
export function useFastBlockTime(resolver: Address | undefined) {
  return useQuery({
    queryKey: createKeys.resolverView(resolver ?? "0x", "fastBlockTimeMs"),
    queryFn: () => readFastBlockTime(getPublicClient(), resolver as Address),
    enabled: deployed && Boolean(resolver),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

export function useSpotPrice(option: PriceFeedOption | null) {
  return useQuery({
    queryKey: createKeys.spot(option?.key ?? "none"),
    queryFn: () => readSpotPrice(getPublicClient(), appDeployment, option as PriceFeedOption),
    enabled: deployed && option !== null,
    refetchInterval: 30_000,
  });
}

/**
 * The resolver's `validate` and `describe` for the params, through eth_call, once the params have
 * stopped changing for 400 ms.
 */
export function usePreview(resolver: Address | undefined, params: Hex | null) {
  const settled = useDebounced(params);
  const query = useQuery({
    queryKey: createKeys.preview(resolver ?? "0x", settled ?? "0x"),
    queryFn: () => previewMarket(getPublicClient(), resolver as Address, settled as Hex),
    enabled: deployed && Boolean(resolver) && settled !== null,
    staleTime: 10_000,
  });
  return { ...query, settling: params !== settled };
}

/** The canonical key for (template, params) and the market already at it, if any. */
export function useExistingMarket(
  factory: Address | undefined,
  templateId: number | null,
  params: Hex | null,
) {
  const settled = useDebounced(params);
  const key = templateId !== null && settled !== null ? marketKey(templateId, settled) : null;
  const query = useQuery({
    queryKey: createKeys.marketOf(key ?? "0x"),
    queryFn: () => readMarketOf(getPublicClient(), factory as Address, key as Hex),
    enabled: deployed && Boolean(factory) && key !== null,
    staleTime: 10_000,
  });
  return { ...query, key };
}

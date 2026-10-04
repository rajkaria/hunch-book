"use client";

import { snapshotWindowState } from "@hunch-book/shared";
import { useQuery } from "@tanstack/react-query";
import type { Address, Hex } from "viem";
import { getPublicClient } from "../chain/client";
import { appNetwork } from "../config";
import { readCurrentValue, readSnapshotFor, readSnapshotSources } from "./index";

export const snapshotKeys = {
  sources: (resolver: Address) => ["snapshot", appNetwork, "sources", resolver.toLowerCase()] as const,
  current: (resolver: Address, id: number) =>
    ["snapshot", appNetwork, "current", resolver.toLowerCase(), id] as const,
  stored: (resolver: Address, params: Hex) =>
    ["snapshot", appNetwork, "stored", resolver.toLowerCase(), params] as const,
};

/** The resolver's sources (fixed at its deployment). */
export function useSnapshotSources(resolver: Address | undefined) {
  return useQuery({
    queryKey: snapshotKeys.sources(resolver ?? "0x"),
    queryFn: () => readSnapshotSources(getPublicClient(), resolver as Address),
    enabled: Boolean(resolver),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/** What a snapshot of the source would store now; an error says why the resolver refuses it. */
export function useSnapshotCurrentValue(
  resolver: Address | undefined,
  sourceId: number | null,
  enabled = true,
) {
  return useQuery({
    queryKey: snapshotKeys.current(resolver ?? "0x", sourceId ?? -1),
    queryFn: () => readCurrentValue(getPublicClient(), resolver as Address, sourceId as number),
    enabled: enabled && Boolean(resolver) && sourceId !== null,
    refetchInterval: 30_000,
    retry: 1,
  });
}

/** The snapshot a market answers from (null until one is taken), refreshed while the window can be open. */
export function useStoredSnapshot(
  resolver: Address,
  params: Hex,
  window: { closeTime: bigint; snapshotWindow: number } | null,
  now: number | null,
) {
  const state =
    window && now !== null ? snapshotWindowState(window.closeTime, window.snapshotWindow, BigInt(now)) : null;
  return useQuery({
    queryKey: snapshotKeys.stored(resolver, params),
    queryFn: () => readSnapshotFor(getPublicClient(), resolver, params),
    enabled: window !== null,
    refetchInterval: state === "open" ? 10_000 : 60_000,
  });
}

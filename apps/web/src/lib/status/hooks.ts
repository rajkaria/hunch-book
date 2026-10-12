"use client";

import { useQuery } from "@tanstack/react-query";
import { getPublicClient } from "../chain/client";
import { appDeployment, appNetwork, isDeployed } from "../config";
import { indexerUrl } from "../indexer/client";
import type { ServiceHealthView, ServiceName } from "./health";
import { readLifecycleFromIndexer } from "./lifecycle";
import { readStatusSnapshots } from "./reads";

export const statusKeys = {
  snapshot: () => ["status", "snapshot", appNetwork] as const,
  health: (service: ServiceName) => ["status", "health", appNetwork, service] as const,
  lifecycle: () => ["status", "lifecycle", appNetwork] as const,
};

/** Everything the chain checks need, one snapshot per stack, re-read every 15 seconds. */
export function useStatusSnapshots() {
  return useQuery({
    queryKey: statusKeys.snapshot(),
    queryFn: () => readStatusSnapshots(getPublicClient() as never, appDeployment),
    enabled: isDeployed(appDeployment),
    refetchInterval: 15_000,
  });
}

/** A service's health on the active network, through /api/health/<service>?network=<network>. */
export function useServiceHealth(service: ServiceName) {
  return useQuery({
    queryKey: statusKeys.health(service),
    queryFn: async (): Promise<ServiceHealthView> => {
      try {
        const res = await fetch(`/api/health/${service}?network=${encodeURIComponent(appNetwork)}`, {
          cache: "no-store",
        });
        if (!res.ok)
          return { service, configured: true, reachable: false, error: `The app answered ${res.status}.` };
        return (await res.json()) as ServiceHealthView;
      } catch {
        return {
          service,
          configured: true,
          reachable: false,
          error: "The app's health route could not be reached.",
        };
      }
    },
    refetchInterval: 30_000,
  });
}

/**
 * Last settlement and graduation from the active network's indexer (NEXT_PUBLIC_INDEXER_URL on testnet,
 * NEXT_PUBLIC_INDEXER_URL_MAINNET on mainnet), when one is configured.
 */
export function useIndexerLifecycle() {
  const url = indexerUrl(appNetwork) ?? undefined;
  return useQuery({
    queryKey: statusKeys.lifecycle(),
    queryFn: () => readLifecycleFromIndexer(url),
    enabled: Boolean(url),
    refetchInterval: 60_000,
  });
}

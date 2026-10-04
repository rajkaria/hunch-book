"use client";

import { useQuery } from "@tanstack/react-query";
import { getPublicClient } from "../chain/client";
import { appDeployment, appNetwork, isDeployed } from "../config";
import type { ServiceHealthView, ServiceName } from "./health";
import { readLifecycleFromIndexer } from "./lifecycle";
import { readStatusSnapshot } from "./reads";

export const statusKeys = {
  snapshot: () => ["status", "snapshot", appNetwork] as const,
  health: (service: ServiceName) => ["status", "health", appNetwork, service] as const,
  lifecycle: () => ["status", "lifecycle", appNetwork] as const,
};

/** Everything the chain checks need, re-read every 15 seconds. */
export function useStatusSnapshot() {
  return useQuery({
    queryKey: statusKeys.snapshot(),
    queryFn: () => readStatusSnapshot(getPublicClient() as never, appDeployment),
    enabled: isDeployed(appDeployment),
    refetchInterval: 15_000,
  });
}

/** A service's health through /api/health/<service>. */
export function useServiceHealth(service: ServiceName) {
  return useQuery({
    queryKey: statusKeys.health(service),
    queryFn: async (): Promise<ServiceHealthView> => {
      try {
        const res = await fetch(`/api/health/${service}`, { cache: "no-store" });
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

const INDEXER_URL = process.env.NEXT_PUBLIC_INDEXER_URL?.trim() || undefined;

/** Last settlement and graduation from the indexer, when one is configured. */
export function useIndexerLifecycle() {
  return useQuery({
    queryKey: statusKeys.lifecycle(),
    queryFn: () => readLifecycleFromIndexer(INDEXER_URL),
    enabled: Boolean(INDEXER_URL),
    refetchInterval: 60_000,
  });
}

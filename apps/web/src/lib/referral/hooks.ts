"use client";

import { referralRegistryAbi } from "@hunch-book/shared";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import type { Address } from "viem";
import { getPublicClient } from "../chain/client";
import { appDeployment, appNetwork } from "../config";
import { peripheryAddress, peripheryDeployBlock } from "../periphery";
import { type BindScan, scanBinds } from "./binds";
import { fetchFeeEvents, indexerUrl } from "./earnings";
import {
  browserStore,
  clearReferrer,
  dismissReferrer,
  readReferrer,
  type StoredReferrer,
  saveReferrer,
} from "./storage";

export const referralKeys = {
  binding: (user: Address) => ["referral", appNetwork, "binding", user.toLowerCase()] as const,
  binds: (referrer: Address) => ["referral", appNetwork, "binds", referrer.toLowerCase()] as const,
  fees: (referrer: Address, users: readonly Address[]) =>
    [
      "referral",
      appNetwork,
      "fees",
      referrer.toLowerCase(),
      users
        .map((u) => u.toLowerCase())
        .sort()
        .join(","),
    ] as const,
};

export const referralRegistryAddress = (): Address | undefined =>
  peripheryAddress(appDeployment, "referralRegistry");

/** The referrer remembered in this browser, read after mount so server and client HTML match. */
export function useStoredReferrer() {
  const [stored, setStored] = useState<StoredReferrer | null>(null);
  const [ready, setReady] = useState(false);
  const reload = useCallback(() => {
    setStored(readReferrer(browserStore(), Date.now()));
    setReady(true);
  }, []);
  useEffect(() => {
    reload();
    const onStorage = () => reload();
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [reload]);
  const save = useCallback(
    (referrer: string, self?: Address) => {
      const result = saveReferrer(browserStore(), referrer, Date.now(), self);
      reload();
      return result;
    },
    [reload],
  );
  const dismiss = useCallback(() => {
    dismissReferrer(browserStore(), Date.now());
    reload();
  }, [reload]);
  const clear = useCallback(() => {
    clearReferrer(browserStore());
    reload();
  }, [reload]);
  return { stored, ready, save, dismiss, clear };
}

export interface Binding {
  referrer: Address;
  boundAt: bigint;
  expiresAt: bigint;
  active: boolean;
}

/** The wallet's latest binding in the ReferralRegistry, active or not. */
export function useBinding(user: Address | undefined) {
  const registry = referralRegistryAddress();
  return useQuery({
    queryKey: referralKeys.binding(user ?? "0x"),
    queryFn: async (): Promise<Binding> => {
      const [referrer, boundAt, expiresAt, active] = await getPublicClient().readContract({
        address: registry as Address,
        abi: referralRegistryAbi,
        functionName: "bindingOf",
        args: [user as Address],
      });
      return { referrer, boundAt: BigInt(boundAt), expiresAt: BigInt(expiresAt), active };
    },
    enabled: Boolean(registry && user),
    refetchInterval: 30_000,
  });
}

/** Binds to `referrer`, newest first, scanned from the head back in pages (see lib/referral/binds). */
export function useReferralBinds(referrer: Address | undefined) {
  const registry = referralRegistryAddress();
  return useInfiniteQuery({
    queryKey: referralKeys.binds(referrer ?? "0x"),
    initialPageParam: null as bigint | null,
    queryFn: async ({ pageParam }): Promise<BindScan> => {
      const client = getPublicClient();
      const to = pageParam ?? (await client.getBlockNumber());
      return scanBinds(client, registry as Address, referrer as Address, {
        from: peripheryDeployBlock(appDeployment),
        to,
      });
    },
    getNextPageParam: (last) => (last.complete ? undefined : last.scannedFrom - 1n),
    enabled: Boolean(registry && referrer),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
}

/** Fee events paid by the referred users, from the indexer when one is configured. */
export function useReferralFees(referrer: Address | undefined, users: Address[]) {
  const url = indexerUrl();
  return useQuery({
    queryKey: referralKeys.fees(referrer ?? "0x", users),
    queryFn: () => fetchFeeEvents(url as string, users),
    enabled: Boolean(url && referrer && users.length > 0),
    staleTime: 60_000,
    retry: 1,
  });
}

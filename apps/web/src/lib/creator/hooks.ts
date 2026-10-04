"use client";

import { useQuery } from "@tanstack/react-query";
import type { Address } from "viem";
import { getPublicClient } from "../chain/client";
import { appDeployment, appNetwork, isDeployed } from "../config";
import { getIndexerClient } from "../indexer/client";
import { withIndexer } from "../indexer/source";
import { type CreatorData, creatorFromChain, creatorFromIndexerClient, readCreatorFees } from "./read";

export const creatorKeys = {
  page: (creator: Address) => ["creator", appNetwork, creator.toLowerCase()] as const,
  fees: (creator: Address) => ["creator-fees", appNetwork, creator.toLowerCase()] as const,
};

/** The creator's markets and earnings history, from the indexer or the chain. */
export function useCreator(creator: Address) {
  return useQuery({
    queryKey: creatorKeys.page(creator),
    queryFn: () =>
      withIndexer<CreatorData>({
        indexer: getIndexerClient(),
        fromIndexer: (client) => creatorFromIndexerClient(client, creator),
        fromChain: () => creatorFromChain(getPublicClient(), appDeployment, creator),
      }),
    enabled: isDeployed(appDeployment),
    refetchInterval: 20_000,
  });
}

/** vault.creatorFees(creator), live: what a withdrawal would pay now. */
export function useCreatorFees(creator: Address) {
  return useQuery({
    queryKey: creatorKeys.fees(creator),
    queryFn: () => readCreatorFees(getPublicClient(), appDeployment, creator),
    enabled: isDeployed(appDeployment),
    refetchInterval: 10_000,
  });
}

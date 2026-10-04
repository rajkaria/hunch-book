"use client";

import { merkleDistributorAbi } from "@hunch-book/shared";
import { useQuery } from "@tanstack/react-query";
import { type Abi, type Address, type ContractFunctionParameters, erc20Abi } from "viem";
import { getPublicClient, MULTICALL3 } from "../chain/client";
import { appDeployment, appNetwork } from "../config";
import { peripheryAddress } from "../periphery";
import { type EpochFile, parseEpochFiles } from "./epochs";
import type { OnchainEpoch } from "./status";

export const rewardKeys = {
  remote: (url: string) => ["rewards", appNetwork, "remote", url] as const,
  onchain: (account: string, epochs: string) => ["rewards", appNetwork, "onchain", account, epochs] as const,
  count: () => ["rewards", appNetwork, "count"] as const,
  tokens: (tokens: string) => ["rewards", appNetwork, "tokens", tokens] as const,
};

export const merkleDistributorAddress = (): Address | undefined =>
  peripheryAddress(appDeployment, "merkleDistributor");

/** NEXT_PUBLIC_REWARDS_URL: a URL serving one epoch file or a list of them. */
export function rewardsUrl(): string | null {
  const url = process.env.NEXT_PUBLIC_REWARDS_URL?.trim();
  return url ? url : null;
}

/** Epoch files from NEXT_PUBLIC_REWARDS_URL, when it is set. */
export function useRemoteEpochs() {
  const url = rewardsUrl();
  return useQuery({
    queryKey: rewardKeys.remote(url ?? ""),
    queryFn: async () => {
      const res = await fetch(url as string, { headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`The rewards URL answered ${res.status}.`);
      return parseEpochFiles(await res.json(), url as string);
    },
    enabled: Boolean(url),
    staleTime: 5 * 60_000,
    retry: 1,
  });
}

/** How many epochs the MerkleDistributor has created. */
export function useEpochCount() {
  const distributor = merkleDistributorAddress();
  return useQuery({
    queryKey: rewardKeys.count(),
    queryFn: () =>
      getPublicClient().readContract({
        address: distributor as Address,
        abi: merkleDistributorAbi,
        functionName: "epochCount",
      }),
    enabled: Boolean(distributor),
    refetchInterval: 60_000,
  });
}

type Result = { status: "success"; result: unknown } | { status: "failure"; error: Error };

/** Each file's epoch as the contract sees it, and whether `account` already claimed it. */
export function useOnchainEpochs(files: readonly EpochFile[], account: Address | undefined) {
  const distributor = merkleDistributorAddress();
  const ids = files.map((f) => f.epoch.toString()).join(",");
  return useQuery({
    queryKey: rewardKeys.onchain(account?.toLowerCase() ?? "", ids),
    queryFn: async () => {
      const calls = files.flatMap((f) => [
        {
          address: distributor as Address,
          abi: merkleDistributorAbi as Abi,
          functionName: "epochs",
          args: [f.epoch],
        },
        ...(account
          ? [
              {
                address: distributor as Address,
                abi: merkleDistributorAbi as Abi,
                functionName: "isClaimed",
                args: [f.epoch, account],
              },
            ]
          : []),
      ]);
      const results = (await getPublicClient().multicall({
        contracts: calls as unknown as readonly ContractFunctionParameters[],
        allowFailure: true,
        multicallAddress: MULTICALL3,
      })) as Result[];
      const per = account ? 2 : 1;
      return files.map((_, i) => {
        const e = results[i * per];
        const c = account ? results[i * per + 1] : undefined;
        const raw = e?.status === "success" ? (e.result as OnchainEpoch) : null;
        return {
          epoch: raw
            ? {
                ...raw,
                claimDeadline: BigInt(raw.claimDeadline),
                total: BigInt(raw.total),
                claimed: BigInt(raw.claimed),
              }
            : null,
          claimed: c?.status === "success" ? (c.result as boolean) : false,
        };
      });
    },
    enabled: Boolean(distributor) && files.length > 0,
    refetchInterval: 30_000,
  });
}

/** Symbol and decimals of each reward token, for display. */
export function useTokenInfo(tokens: readonly Address[]) {
  const unique = [...new Set(tokens.map((t) => t.toLowerCase()))].sort();
  return useQuery({
    queryKey: rewardKeys.tokens(unique.join(",")),
    queryFn: async () => {
      const results = (await getPublicClient().multicall({
        contracts: unique.flatMap((t) => [
          { address: t as Address, abi: erc20Abi, functionName: "symbol" },
          { address: t as Address, abi: erc20Abi, functionName: "decimals" },
        ]) as unknown as readonly ContractFunctionParameters[],
        allowFailure: true,
        multicallAddress: MULTICALL3,
      })) as Result[];
      const info = new Map<string, { symbol: string; decimals: number }>();
      unique.forEach((t, i) => {
        const symbol = results[i * 2];
        const decimals = results[i * 2 + 1];
        info.set(t, {
          symbol: symbol?.status === "success" ? String(symbol.result) : "tokens",
          decimals: decimals?.status === "success" ? Number(decimals.result) : 6,
        });
      });
      return info;
    },
    enabled: unique.length > 0,
    staleTime: Number.POSITIVE_INFINITY,
  });
}

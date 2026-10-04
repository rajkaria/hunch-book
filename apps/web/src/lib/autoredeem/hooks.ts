"use client";

import { useQuery } from "@tanstack/react-query";
import type { Address } from "viem";
import { getPublicClient } from "../chain/client";
import { appDeployment, appNetwork } from "../config";
import type { PortfolioEntry } from "../market/types";
import { peripheryAddress } from "../periphery";
import { readRedeemerState } from "./read";

export const autoRedeemKeys = {
  state: (user: Address, markets: string) => ["autoredeem", appNetwork, user.toLowerCase(), markets] as const,
};

export const autoRedeemerAddress = (): Address | undefined => peripheryAddress(appDeployment, "autoRedeemer");

export function useRedeemerState(user: Address | undefined, entries: readonly PortfolioEntry[]) {
  const redeemer = autoRedeemerAddress();
  const markets = entries
    .filter((e) => e.market.graduated)
    .map((e) => e.market.address.toLowerCase())
    .sort()
    .join(",");
  return useQuery({
    queryKey: autoRedeemKeys.state(user ?? "0x", markets),
    queryFn: () => readRedeemerState(getPublicClient(), redeemer as Address, user as Address, entries),
    enabled: Boolean(redeemer && user),
    refetchInterval: 20_000,
  });
}

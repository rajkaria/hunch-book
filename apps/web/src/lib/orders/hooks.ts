"use client";

import { useQuery } from "@tanstack/react-query";
import type { Address } from "viem";
import { getPublicClient } from "../chain/client";
import { appDeployment, appNetwork } from "../config";
import { useProtocolAddresses } from "../hooks";
import type { MarketView } from "../market/types";
import { peripheryAddress, stackPeripheryAddress } from "../periphery";
import { readOrderFunds, readOwnerOrders } from "./read";

export const orderKeys = {
  all: () => ["orders", appNetwork] as const,
  owner: (owner: Address) => ["orders", appNetwork, "owner", owner.toLowerCase()] as const,
  funds: (market: Address, owner: Address) =>
    ["orders", appNetwork, "funds", market.toLowerCase(), owner.toLowerCase()] as const,
};

/** The ConditionalOrders address on this network, or undefined. */
/**
 * The ConditionalOrders contract of `m`'s stack (the primary stack when no market is given): each stack's
 * contract trades through its own router and reads its own books.
 */
export const conditionalOrdersAddress = (m?: Pick<MarketView, "stack">): Address | undefined =>
  m?.stack
    ? stackPeripheryAddress(appDeployment, "conditionalOrders", m.stack)
    : peripheryAddress(appDeployment, "conditionalOrders");

/** Every order the wallet placed (newest first), read from `contract` (default: the primary stack's). */
export function useOwnerOrders(
  owner: Address | undefined,
  contract: Address | undefined = conditionalOrdersAddress(),
) {
  return useQuery({
    queryKey: [...orderKeys.owner(owner ?? "0x"), contract ?? "none"],
    queryFn: () => readOwnerOrders(getPublicClient(), contract as Address, owner as Address),
    enabled: Boolean(contract && owner),
    refetchInterval: 15_000,
  });
}

/** The wallet's USDC, YES and NO for a market, and its approvals to ConditionalOrders. */
export function useOrderFunds(owner: Address | undefined, m: MarketView) {
  const contract = conditionalOrdersAddress(m);
  const protocol = useProtocolAddresses(m);
  return useQuery({
    queryKey: orderKeys.funds(m.address, owner ?? "0x"),
    queryFn: () =>
      readOrderFunds(
        getPublicClient(),
        contract as Address,
        { usdc: protocol.data?.usdc as Address, yes: m.tokens.yes, no: m.tokens.no },
        owner as Address,
      ),
    enabled: Boolean(contract && owner && protocol.data),
    refetchInterval: 15_000,
  });
}

"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useSyncExternalStore } from "react";
import { type Address, parseEther } from "viem";
import { getPublicClient } from "../chain/client";
import { appNetwork } from "../config";
import { queryKeys } from "../hooks";
import { requestDrip } from "../relayer/client";

// Gas for new accounts: what the app knows about each address's drip in this tab, shared by the
// account menu and the stake ticket. The server decides who gets a drip; this only remembers the
// answer so the app asks once per address per page load.

/** Below this the app offers gas help (the drip, a relayed stake, or the faucet). */
export const LOW_MON_WEI = parseEther("0.01");

export type DripState =
  | { status: "pending" }
  | { status: "sent"; hash: `0x${string}`; url: string; amountMon?: string }
  | { status: "refused"; error: string; faucet?: string };

const states = new Map<string, DripState>();
const listeners = new Set<() => void>();

export function dripState(address: Address | undefined): DripState | undefined {
  return address ? states.get(address.toLowerCase()) : undefined;
}

export function setDripState(address: Address, state: DripState): void {
  states.set(address.toLowerCase(), state);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useDripState(address: Address | undefined): DripState | undefined {
  return useSyncExternalStore(
    subscribe,
    () => dripState(address),
    () => undefined,
  );
}

/** Asks the drip for gas for `address`, records the answer, then refreshes the MON balance. */
export function useAskForGas() {
  const queryClient = useQueryClient();
  return useCallback(
    async (address: Address) => {
      if (dripState(address)?.status === "pending") return;
      setDripState(address, { status: "pending" });
      const result = await requestDrip(address, appNetwork);
      setDripState(
        address,
        result.ok
          ? {
              status: "sent",
              hash: result.hash,
              url: result.url,
              ...(result.amountMon ? { amountMon: result.amountMon } : {}),
            }
          : { status: "refused", error: result.error, ...(result.faucet ? { faucet: result.faucet } : {}) },
      );
      if (result.ok) {
        await getPublicClient()
          .waitForTransactionReceipt({ hash: result.hash, pollingInterval: 1_000, timeout: 60_000 })
          .catch(() => undefined);
      }
      await queryClient.invalidateQueries({ queryKey: queryKeys.mon(address) });
    },
    [queryClient],
  );
}

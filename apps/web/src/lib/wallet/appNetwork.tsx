"use client";

import { chainsByNetwork, deployments, type Network } from "@hunch-book/shared";
import { Fragment, type ReactNode, useEffect, useSyncExternalStore } from "react";
import type { Connector } from "wagmi";
import {
  buildNetwork,
  getActiveNetwork,
  pickNetwork,
  readStoredNetwork,
  setActiveNetwork,
  storeNetwork,
  subscribeNetwork,
} from "../config";
import { addThenSwitch, type Eip1193Like, isUserRejection } from "./network";

/** The active network. Hydrates on the build's network, then follows every switch. */
export function useAppNetwork(): Network {
  return useSyncExternalStore(subscribeNetwork, getActiveNetwork, () => buildNetwork);
}

/**
 * Remounts everything under it when the network changes, so every component reads the new network's
 * deployment, chain and query keys from scratch. After the first render (which matches the server's
 * HTML), it moves to the network the visitor chose last time, if that is still selectable.
 */
export function NetworkBoundary({ children }: { children: ReactNode }) {
  const network = useAppNetwork();
  useEffect(() => {
    const wanted = pickNetwork(readStoredNetwork());
    if (wanted !== getActiveNetwork()) setActiveNetwork(wanted);
  }, []);
  return <Fragment key={network}>{children}</Fragment>;
}

/**
 * Switches the app to `network` and remembers it. When a wallet is connected on another chain, its
 * wallet is asked to add and switch to the new one; if the person says no, the app still switches and
 * every ticket offers the wallet switch again.
 */
export async function chooseNetwork(
  network: Network,
  wallet?: { connector?: Connector; chainId?: number },
): Promise<void> {
  storeNetwork(network);
  setActiveNetwork(network);
  const chain = chainsByNetwork[network];
  if (!wallet?.connector || wallet.chainId === undefined || wallet.chainId === chain.id) return;
  try {
    const provider = (await wallet.connector.getProvider()) as Eip1193Like;
    await addThenSwitch(provider, chain, deployments[network].rpc);
  } catch (error) {
    if (!isUserRejection(error)) console.warn("The wallet did not switch networks.", error);
  }
}

import {
  chainsByNetwork,
  collateralOf,
  type Deployment,
  deployments,
  type Network,
} from "@hunch-book/shared";
import type { Address } from "viem";

// The app serves exactly one network, chosen at build time. Addresses come only from
// deployments/<network>.json (through @hunch-book/shared), never from env vars or code.

export const DEFAULT_NETWORK: Network = "monad-testnet";

export const NETWORK_LABEL: Record<Network, string> = {
  "monad-testnet": "Monad testnet",
  "monad-mainnet": "Monad mainnet",
};

/** Reads NEXT_PUBLIC_HUNCH_NETWORK. Anything unknown falls back to the default network. */
export function resolveNetwork(value: string | undefined): Network {
  const v = value?.trim().toLowerCase();
  if (v === "monad-testnet" || v === "monad-mainnet") return v;
  return DEFAULT_NETWORK;
}

export const appNetwork: Network = resolveNetwork(process.env.NEXT_PUBLIC_HUNCH_NETWORK);
export const appDeployment: Deployment = deployments[appNetwork];
export const appChain = chainsByNetwork[appNetwork];
export const appNetworkLabel = NETWORK_LABEL[appNetwork];

/** True once the factory address is in deployments/<network>.json. */
export function isDeployed(deployment: Deployment): boolean {
  return Boolean(deployment.hunchBook.factory);
}

/** The factory address, or undefined while the contracts are not deployed. */
export function factoryOf(deployment: Deployment): Address | undefined {
  return deployment.hunchBook.factory;
}

/** The collateral token from deployments (test USDC on testnet, Circle USDC on mainnet). */
export function usdcOf(deployment: Deployment): Address | undefined {
  return collateralOf(deployment);
}

export const REPO_URL = "https://github.com/rajkaria/hunch-book";

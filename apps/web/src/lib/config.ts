import {
  chainsByNetwork,
  collateralOf,
  type Deployment,
  deployments,
  type Network,
} from "@hunch-book/shared";
import type { Address } from "viem";

// Addresses come only from deployments/<network>.json (through @hunch-book/shared), never from env vars
// or code. The build picks the default network (NEXT_PUBLIC_HUNCH_NETWORK): the server renders it and
// the browser starts on it. In the browser a visitor can switch to any other network whose factory is
// deployed; the choice is kept in localStorage and drives every read, link and write from then on.

export const DEFAULT_NETWORK: Network = "monad-testnet";

/** Every network the app knows, in the order the network switch lists them. */
export const NETWORKS: readonly Network[] = ["monad-testnet", "monad-mainnet"];

export const NETWORK_LABEL: Record<Network, string> = {
  "monad-testnet": "Monad testnet",
  "monad-mainnet": "Monad mainnet",
};

/** Reads NEXT_PUBLIC_HUNCH_NETWORK. Anything unknown falls back to the default network. */
export function resolveNetwork(value: string | undefined): Network {
  return parseNetwork(value) ?? DEFAULT_NETWORK;
}

/** A network name, or null for anything else. */
export function parseNetwork(value: string | null | undefined): Network | null {
  const v = value?.trim().toLowerCase();
  return v === "monad-testnet" || v === "monad-mainnet" ? v : null;
}

/** The build's network: what the server renders, and where the browser starts. */
export const buildNetwork: Network = resolveNetwork(process.env.NEXT_PUBLIC_HUNCH_NETWORK);

type AppChain = (typeof chainsByNetwork)[Network];

// The active network. These are live bindings: every module that imports them reads the current value,
// so once the browser switches network (setActiveNetwork) and the tree re-renders, every read, explorer
// link and write follows. They change only in the browser; on the server they stay the build's network.
export let appNetwork: Network = buildNetwork;
export let appDeployment: Deployment = deployments[buildNetwork];
export let appChain: AppChain = chainsByNetwork[buildNetwork];
export let appNetworkLabel: string = NETWORK_LABEL[buildNetwork];

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

/** The production domain (passkey accounts are bound to one domain, PROTOCOL.md §9.5). */
export const SITE_URL = "https://book.playhunch.xyz";

/** How a mainnet deployment ships, linked while mainnet is still planned. */
export const DEPLOY_DOCS_URL = `${REPO_URL}/blob/main/docs/DEPLOY.md`;

// ---------- network selection ----------

export interface NetworkOption {
  network: Network;
  label: string;
  /** The factory is in deployments/<network>.json. */
  deployed: boolean;
  /** The switch can move to it: deployed, or the build's own network. */
  selectable: boolean;
}

/** The networks the switch shows. A network becomes selectable as soon as its factory is deployed. */
export function networkOptions(
  all: Record<Network, Deployment> = deployments,
  build: Network = buildNetwork,
): NetworkOption[] {
  return NETWORKS.map((network) => {
    const deployed = isDeployed(all[network]);
    return { network, label: NETWORK_LABEL[network], deployed, selectable: deployed || network === build };
  });
}

/**
 * The network to run on, given what the visitor chose before: their choice while it is still
 * selectable, else the build's network.
 */
export function pickNetwork(
  stored: string | null | undefined,
  all: Record<Network, Deployment> = deployments,
  build: Network = buildNetwork,
): Network {
  const wanted = parseNetwork(stored);
  if (!wanted) return build;
  const option = networkOptions(all, build).find((o) => o.network === wanted);
  return option?.selectable ? wanted : build;
}

/** The localStorage key that remembers the visitor's network. */
export const NETWORK_STORAGE_KEY = "hunch-book:network";

/** Storage access never throws: private windows and blocked storage just remember nothing. */
function browserStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readStoredNetwork(storage: Storage | null = browserStorage()): Network | null {
  try {
    return parseNetwork(storage?.getItem(NETWORK_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function storeNetwork(network: Network, storage: Storage | null = browserStorage()): void {
  try {
    storage?.setItem(NETWORK_STORAGE_KEY, network);
  } catch {
    // Nothing to do: the switch still works for this page view.
  }
}

const listeners = new Set<() => void>();

export function getActiveNetwork(): Network {
  return appNetwork;
}

/** Calls `listener` after every network switch. Returns the unsubscribe function. */
export function subscribeNetwork(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Makes `network` the active one and tells subscribers. Browser only: on the server the active network
 * is shared by every request, so it never changes there. Returns true when it changed.
 */
export function setActiveNetwork(network: Network): boolean {
  if (typeof window === "undefined" || network === appNetwork) return false;
  appNetwork = network;
  appDeployment = deployments[network];
  appChain = chainsByNetwork[network];
  appNetworkLabel = NETWORK_LABEL[network];
  for (const listener of listeners) listener();
  return true;
}

import mainnetJson from "@hunch-book/deployments/monad-mainnet.json" with { type: "json" };
import testnetJson from "@hunch-book/deployments/monad-testnet.json" with { type: "json" };
import type { Address, Hex } from "viem";

/** Hunch Book's own contracts. Filled in by the deploy script; empty until a network is deployed. */
export interface HunchBookContracts {
  factory?: Address;
  vault?: Address;
  marketImplementation?: Address;
  graduator?: Address;
  router?: Address;
  usdc?: Address;
  resolvers?: Record<string, Address>;
  deployBlock?: number;
  deployTx?: Hex;
}

export interface Deployment {
  network: Network;
  chainId: number;
  rpc: string;
  explorer: string;
  hunchBook: HunchBookContracts;
  wallets: { maker: Address; keeper: Address };
  external: {
    usdc?: Address;
    circleUsdc?: Address;
    kuru: { router: Address; marginAccount: Address };
    perpl: { exchange: Address; perps: Record<string, number> };
    chainlink: Record<string, Address>;
    pyth: { contract: Address; ids: Record<string, Hex> };
  };
  notes?: string;
}

export type Network = "monad-testnet" | "monad-mainnet";

export const deployments: Record<Network, Deployment> = {
  "monad-testnet": testnetJson as unknown as Deployment,
  "monad-mainnet": mainnetJson as unknown as Deployment,
};

export function loadDeployment(network: Network | number): Deployment {
  const found =
    typeof network === "number"
      ? Object.values(deployments).find((d) => d.chainId === network)
      : deployments[network];
  if (!found) throw new Error(`no deployment for ${String(network)}`);
  return found;
}

/** The collateral token Hunch Book uses on this network (test USDC on testnet, Circle USDC on mainnet). */
export function collateralOf(deployment: Deployment): Address | undefined {
  return deployment.hunchBook.usdc ?? deployment.external.usdc;
}

/** Throws if a required Hunch Book contract is missing, so readers never fall back to a zero address. */
export function requireContract<K extends keyof HunchBookContracts>(
  deployment: Deployment,
  key: K,
): NonNullable<HunchBookContracts[K]> {
  const value = deployment.hunchBook[key];
  if (value === undefined || value === null) {
    throw new Error(`${String(key)} is not deployed on ${deployment.network}`);
  }
  return value as NonNullable<HunchBookContracts[K]>;
}

export function txUrl(deployment: Deployment, hash: Hex): string {
  return `${deployment.explorer}/tx/${hash}`;
}

export function addressUrl(deployment: Deployment, address: Address): string {
  return `${deployment.explorer}/address/${address}`;
}

export function blockUrl(deployment: Deployment, block: bigint | number): string {
  return `${deployment.explorer}/block/${block.toString()}`;
}

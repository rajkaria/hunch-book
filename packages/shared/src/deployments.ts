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
  /** One resolver per template: 1 perplFunding, 2 priceAtTime, 3 chainlinkTouch, 4 perplFundingSpike,
   * 5 priceRange, 6 marketOutcome (parlays), 7 snapshot. */
  resolvers?: {
    perplFunding?: Address;
    priceAtTime?: Address;
    chainlinkTouch?: Address;
    perplFundingSpike?: Address;
    priceRange?: Address;
    marketOutcome?: Address;
    snapshot?: Address;
  };
  /** Optional contracts around the core (docs/PERIPHERY.md). */
  periphery?: PeripheryContracts;
  guardian?: Address;
  feeRecipient?: Address;
  /** Block of the first deployment transaction: indexers start here. */
  deployBlock?: number;
  /** Deployment and wiring transactions, by contract or action, for explorer links. */
  deployTxs?: Record<string, Hex>;
  /** Which Kuru exchange this stack's books are on (absent = 1). docs/PROTOCOL.md §8.1. */
  kuruVersion?: 1 | 2;
}

/** Written by contracts/script/DeployPeriphery.s.sol. */
export interface PeripheryContracts {
  autoRedeemer?: Address;
  conditionalOrders?: Address;
  referralRegistry?: Address;
  merkleDistributor?: Address;
  impliedProbabilityOracle?: Address;
  priceAdapterFactory?: Address;
  /** Kuru v2 stacks: the fair-value feeds Kuru's WithdrawalLimiter prices YES and NO with. */
  kuruFeedFactory?: Address;
  templateTimelock?: Address;
  timelockProposer?: Address;
  timelockDelay?: number;
  distributorFunder?: Address;
  referralDuration?: number;
  deployBlock?: number;
  deployTxs?: Record<string, Hex>;
}

/** Kuru v2 contracts on a network (docs/PROTOCOL.md §8.1, Kuru v2). */
export interface KuruV2Contracts {
  accountCore: Address;
  spotRouter: Address;
  withdrawalLimiter?: Address;
  orderBookImplementation?: Address;
  protocolAuthority?: Address;
  /** Kuru's own USDC (on testnet owner-mint only, so not Hunch Book's collateral there). */
  usdc?: Address;
}

export interface Deployment {
  network: Network;
  chainId: number;
  rpc: string;
  explorer: string;
  /** The primary stack. */
  hunchBook: HunchBookContracts;
  /** Extra stacks by name (testnet: `kuruV2` next to the v1 primary stack). */
  stacks?: Record<string, HunchBookContracts>;
  wallets: { maker: Address; keeper: Address };
  external: {
    usdc?: Address;
    circleUsdc?: Address;
    kuru: { router: Address; marginAccount: Address };
    kuruV2?: KuruV2Contracts;
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

/** One deployed Hunch Book stack: a factory with its vault, graduator, router and periphery. */
export interface Stack {
  /** "primary" for `hunchBook`, otherwise the key under `stacks`. */
  name: string;
  primary: boolean;
  kuruVersion: 1 | 2;
  contracts: HunchBookContracts;
}

/** Every stack with a factory, the primary first. Readers that list markets go through all of them. */
export function stacksOf(deployment: Deployment): Stack[] {
  const out: Stack[] = [];
  const add = (name: string, primary: boolean, contracts: HunchBookContracts | undefined) => {
    if (!contracts?.factory) return;
    out.push({ name, primary, kuruVersion: contracts.kuruVersion === 2 ? 2 : 1, contracts });
  };
  add("primary", true, deployment.hunchBook);
  for (const [name, contracts] of Object.entries(deployment.stacks ?? {})) add(name, false, contracts);
  return out;
}

const sameAddress = (a: string | undefined, b: string): boolean =>
  a !== undefined && a.toLowerCase() === b.toLowerCase();

/** The stack whose factory is `factory` (what a market's `factory()` returns), or undefined. */
export function stackForFactory(deployment: Deployment, factory: Address): Stack | undefined {
  return stacksOf(deployment).find((s) => sameAddress(s.contracts.factory, factory));
}

/** The stack whose router is `router`, or undefined. */
export function stackForRouter(deployment: Deployment, router: Address): Stack | undefined {
  return stacksOf(deployment).find((s) => sameAddress(s.contracts.router, router));
}

/** The stack called `name` ("primary" or a key under `stacks`), or undefined. */
export function stackNamed(deployment: Deployment, name: string): Stack | undefined {
  return stacksOf(deployment).find((s) => s.name === name);
}

/**
 * The deployment as seen by one stack: `hunchBook` is that stack's contracts. Services written for one
 * factory (the keeper, the maker) run once per stack on this view, unchanged.
 */
export function deploymentForStack(deployment: Deployment, stack: Stack): Deployment {
  return { ...deployment, hunchBook: stack.contracts };
}

/** Throws if a stack contract is missing, so readers never fall back to a zero address. */
export function requireStackContract<K extends keyof HunchBookContracts>(
  stack: Stack,
  key: K,
): NonNullable<HunchBookContracts[K]> {
  const value = stack.contracts[key];
  if (value === undefined || value === null)
    throw new Error(`${String(key)} is not deployed on stack ${stack.name}`);
  return value as NonNullable<HunchBookContracts[K]>;
}

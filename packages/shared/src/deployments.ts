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
  /** Which Kuru interface this stack's books speak (absent = 1). docs/PROTOCOL.md §8.1. */
  kuruVersion?: 1 | 2;
  /**
   * Set when this stack's books are on Hunch Book's own order book instead of Kuru (docs/PROTOCOL.md
   * §8.1, "Hunch order book"). The books speak Kuru v1's interface, so `kuruVersion` is 1 and every v1
   * reader works on them through `deploymentForStack`, which points `external.kuru` here.
   */
  venue?: HunchVenueContracts;
}

/** Hunch Book's own order book: written by Deploy.s.sol (VENUE=hunch) and DeployHunchStack.s.sol. */
export interface HunchVenueContracts {
  kind: "hunch";
  /** HunchOrderBookFactory: Kuru v1 Router's deployProxy and computeAddress. */
  bookFactory: Address;
  /** HunchMarginAccount: Kuru v1 MarginAccount's deposit, withdraw, getBalance, verifiedMarket. */
  marginAccount: Address;
  /** The HunchOrderBook every book is a clone of. */
  bookImplementation: Address;
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
  /** Extra stacks by name (testnet: `kuruV2` and `hunch` next to the v1 primary stack). */
  stacks?: Record<string, HunchBookContracts>;
  /**
   * The stack new markets go to (the app's create page, the keeper's series): "primary" or a key under
   * `stacks`. Absent = the primary stack.
   */
  defaultStack?: string;
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

/** Where a stack's books are: Kuru's exchange, or Hunch Book's own order book. */
export type Venue = "kuru" | "hunch";

/** One deployed Hunch Book stack: a factory with its vault, graduator, router and periphery. */
export interface Stack {
  /** "primary" for `hunchBook`, otherwise the key under `stacks`. */
  name: string;
  primary: boolean;
  kuruVersion: 1 | 2;
  venue: Venue;
  contracts: HunchBookContracts;
}

/** The venue of a stack's contracts: "hunch" when they carry a Hunch venue, otherwise "kuru". */
export function venueOf(contracts: Pick<HunchBookContracts, "venue">): Venue {
  return contracts.venue?.kind === "hunch" ? "hunch" : "kuru";
}

/**
 * What to call a stack's book venue in copy: "Hunch order book", "Kuru v2" or "Kuru". Markets on a Hunch
 * venue trade on Hunch Book's own onchain order book.
 */
export function venueLabel(s: { venue: Venue; kuruVersion: 1 | 2 }): string {
  if (s.venue === "hunch") return "Hunch order book";
  return s.kuruVersion === 2 ? "Kuru v2" : "Kuru";
}

/** Every stack with a factory, the primary first. Readers that list markets go through all of them. */
export function stacksOf(deployment: Deployment): Stack[] {
  const out: Stack[] = [];
  const add = (name: string, primary: boolean, contracts: HunchBookContracts | undefined) => {
    if (!contracts?.factory) return;
    out.push({
      name,
      primary,
      kuruVersion: contracts.kuruVersion === 2 ? 2 : 1,
      venue: venueOf(contracts),
      contracts,
    });
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
 * The stack new markets go to: `defaultStack` if it names a deployed stack, otherwise the primary
 * stack (or the first deployed one). Undefined only on a network with no factory yet.
 */
export function defaultStackOf(deployment: Deployment): Stack | undefined {
  const all = stacksOf(deployment);
  const named = deployment.defaultStack ? all.find((s) => s.name === deployment.defaultStack) : undefined;
  return named ?? all[0];
}

/**
 * The deployment as seen by one stack: `hunchBook` is that stack's contracts. Services written for one
 * factory (the keeper, the maker) run once per stack on this view, unchanged. On a Hunch venue
 * `external.kuru` points at Hunch's own book factory and margin account, which speak Kuru v1's
 * interface, so v1 readers and writers use them as they would Kuru's.
 */
export function deploymentForStack(deployment: Deployment, stack: Stack): Deployment {
  const venue = stack.contracts.venue;
  if (venue?.kind !== "hunch") return { ...deployment, hunchBook: stack.contracts };
  return {
    ...deployment,
    hunchBook: stack.contracts,
    external: {
      ...deployment.external,
      kuru: { router: venue.bookFactory, marginAccount: venue.marginAccount },
    },
  };
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

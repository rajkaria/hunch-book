import type { Enum } from "envio";
import generated from "../networks.generated.json" with { type: "json" };

/**
 * What the handlers know about one chain, generated from deployments/<network>.json by
 * scripts/gen-config.ts (the deployments files are the only source of addresses). Addresses are lowercase.
 */
export interface NetworkConstants {
  chainId: number;
  network: string;
  explorer: string;
  deployed: boolean;
  deployBlock: number | null;
  contracts: {
    factory: string | null;
    vault: string | null;
    router: string | null;
    graduator: string | null;
    usdc: string | null;
    marketImplementation: string | null;
  };
  /** Resolver address by name (perplFunding, priceAtTime, ..., snapshot), from `hunchBook.resolvers`. */
  resolvers: Record<string, string>;
  /** The periphery (docs/PERIPHERY.md), from `hunchBook.periphery`. */
  periphery: {
    autoRedeemer: string | null;
    conditionalOrders: string | null;
    referralRegistry: string | null;
    merkleDistributor: string | null;
    impliedProbabilityOracle: string | null;
    priceAdapterFactory: string | null;
    templateTimelock: string | null;
    deployBlock: number | null;
  };
  /** Wallets whose activity is ours and is labelled as ours wherever it is counted. */
  ours: {
    maker: string;
    keeper: string;
    guardian: string | null;
    feeRecipient: string | null;
    distributorFunder: string | null;
    timelockProposer: string | null;
  };
  kuru: { router: string; marginAccount: string };
  /** Perpl perp id to asset symbol. */
  perps: Record<string, string>;
  /** Chainlink feed address to pair, for example "BTC/USD". */
  chainlinkFeeds: Record<string, string>;
  /** Pyth price id to pair. */
  pythIds: Record<string, string>;
}

const NETWORKS = generated as unknown as Record<string, NetworkConstants>;

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export function networkOf(chainId: number): NetworkConstants {
  const n = NETWORKS[String(chainId)];
  if (!n) throw new Error(`no network constants for chain ${chainId}: run gen-config`);
  return n;
}

/** Lowercase, so every id and comparison matches the indexed (lowercase) addresses. */
export function addr(a: string): string {
  return a.toLowerCase();
}

/** The fixed role of one of our wallets, from the deployments file. Seeded wallets are found while indexing. */
export function staticRoleOf(chainId: number, address: string): Enum<"OurRole"> {
  const a = addr(address);
  const { ours } = networkOf(chainId);
  if (a === ours.maker) return "Maker";
  if (a === ours.keeper) return "Keeper";
  if (a === ours.guardian) return "Guardian";
  if (a === ours.feeRecipient) return "FeeRecipient";
  if (a === ours.distributorFunder) return "DistributorFunder";
  if (a === ours.timelockProposer) return "TimelockProposer";
  return "None";
}

export function isOurMaker(chainId: number, address: string): boolean {
  return addr(address) === networkOf(chainId).ours.maker;
}

/** The AutoRedeemer: it redeems a holder's tokens and the vault pays the holder directly. */
export function isAutoRedeemer(chainId: number, address: string): boolean {
  return addr(address) === networkOf(chainId).periphery.autoRedeemer;
}

/** ConditionalOrders: it trades through the router for an order's owner. */
export function isConditionalOrders(chainId: number, address: string): boolean {
  return addr(address) === networkOf(chainId).periphery.conditionalOrders;
}

/**
 * Contracts that only pass tokens through. They get no Position. The AutoRedeemer and ConditionalOrders
 * hold nothing between transactions: what they move belongs to the holder or the order's owner.
 */
export function isPlumbing(chainId: number, address: string, market: string): boolean {
  const a = addr(address);
  const { contracts, periphery } = networkOf(chainId);
  return (
    a === ZERO_ADDRESS ||
    a === addr(market) ||
    a === contracts.vault ||
    a === contracts.router ||
    a === periphery.autoRedeemer ||
    a === periphery.conditionalOrders
  );
}

import type { Enum } from "envio";
import generated from "../networks.generated.json" with { type: "json" };

/**
 * One stack of Hunch Book contracts (docs/PROTOCOL.md section 8.1): the primary one (`hunchBook` in the
 * deployments file) or an extra one under `stacks` (testnet: `kuruV2`). Addresses are lowercase.
 */
export interface StackConstants {
  /** "primary", or the stack's key under `stacks`. */
  name: string;
  primary: boolean;
  /** The Kuru version its books are on: 1 (anyone creates a book) or 2 (Kuru creates them). */
  kuruVersion: 1 | 2;
  factory: string | null;
  vault: string | null;
  router: string | null;
  graduator: string | null;
  guardian: string | null;
  feeRecipient: string | null;
  resolvers: Record<string, string>;
  periphery: {
    autoRedeemer: string | null;
    conditionalOrders: string | null;
    referralRegistry: string | null;
    merkleDistributor: string | null;
    impliedProbabilityOracle: string | null;
    priceAdapterFactory: string | null;
    /** Kuru v2 stacks: the factory of the price feeds Kuru's WithdrawalLimiter reads for YES and NO. */
    kuruFeedFactory: string | null;
    templateTimelock: string | null;
    distributorFunder: string | null;
    timelockProposer: string | null;
  };
}

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
  /** Kuru v2's AccountCore and SpotRouter, once the deployments file names them. */
  kuruV2: { accountCore: string; spotRouter: string } | null;
  /**
   * Every deployed stack, the primary first. `contracts`, `resolvers` and `periphery` above are the
   * primary stack's; handlers that must recognise any stack's contract go through these.
   */
  stacks: StackConstants[];
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
  const { ours, stacks } = networkOf(chainId);
  if (a === ours.maker) return "Maker";
  if (a === ours.keeper) return "Keeper";
  // Every stack's guardian, fee recipient, reward funder and timelock proposer is ours.
  for (const s of [ours, ...stacks.map((k) => ({ ...k, ...k.periphery }))]) {
    if (a === s.guardian) return "Guardian";
    if (a === s.feeRecipient) return "FeeRecipient";
    if (a === s.distributorFunder) return "DistributorFunder";
    if (a === s.timelockProposer) return "TimelockProposer";
  }
  return "None";
}

/** The primary stack's constants: what a chain with no stacks list (not deployed) falls back to. */
function primaryOf(n: NetworkConstants): StackConstants {
  return (
    n.stacks[0] ?? {
      name: "primary",
      primary: true,
      kuruVersion: 1,
      ...n.contracts,
      guardian: n.ours.guardian,
      feeRecipient: n.ours.feeRecipient,
      resolvers: n.resolvers,
      periphery: {
        ...n.periphery,
        kuruFeedFactory: null,
        distributorFunder: n.ours.distributorFunder,
        timelockProposer: n.ours.timelockProposer,
      },
    }
  );
}

/** Every contract address of a stack (not its wallets), for finding which stack a contract belongs to. */
function contractsOf(s: StackConstants): (string | null)[] {
  const { distributorFunder: _funder, timelockProposer: _proposer, ...contracts } = s.periphery;
  return [
    s.factory,
    s.vault,
    s.router,
    s.graduator,
    ...Object.values(s.resolvers),
    ...Object.values(contracts),
  ];
}

/**
 * The stack a contract of ours belongs to (its factory, vault, router, graduator, a resolver or a
 * periphery contract). Undefined for any other address.
 */
export function stackOfContract(chainId: number, address: string): StackConstants | undefined {
  const a = addr(address);
  return networkOf(chainId).stacks.find((s) => contractsOf(s).includes(a));
}

/** The stack called `name`, or the primary stack when there is none by that name. */
export function stackNamed(chainId: number, name: string | undefined): StackConstants {
  const n = networkOf(chainId);
  return n.stacks.find((s) => s.name === name) ?? primaryOf(n);
}

/**
 * The id of a record a contract numbers on its own (a template, an order, a reward epoch, a timelock
 * operation): the plain number on the primary stack, "<stack>-<number>" on any other, so two stacks'
 * records never share an id.
 */
export function scopedId(chainId: number, contract: string, id: string): string {
  const stack = stackOfContract(chainId, contract);
  return !stack || stack.primary ? id : `${stack.name}-${id}`;
}

/** The scoped id of a record on the stack called `stack` (see scopedId). */
export function stackScopedId(stack: string, id: string): string {
  return stack === "primary" ? id : `${stack}-${id}`;
}

/** Any stack's router. */
export function isRouter(chainId: number, address: string): boolean {
  const a = addr(address);
  return networkOf(chainId).stacks.some((s) => s.router === a);
}

/** Any stack's vault. */
export function isVault(chainId: number, address: string): boolean {
  const a = addr(address);
  return networkOf(chainId).stacks.some((s) => s.vault === a);
}

/** Every stack's vault: the USDC filter reads transfers into and out of each. */
export function vaultsOf(chainId: number): string[] {
  return networkOf(chainId).stacks.flatMap((s) => (s.vault ? [s.vault] : []));
}

export function isOurMaker(chainId: number, address: string): boolean {
  return addr(address) === networkOf(chainId).ours.maker;
}

/** Any stack's AutoRedeemer: it redeems a holder's tokens and the vault pays the holder directly. */
export function isAutoRedeemer(chainId: number, address: string): boolean {
  const a = addr(address);
  return networkOf(chainId).stacks.some((s) => s.periphery.autoRedeemer === a);
}

/** Any stack's ConditionalOrders: it trades through the router for an order's owner. */
export function isConditionalOrders(chainId: number, address: string): boolean {
  const a = addr(address);
  return networkOf(chainId).stacks.some((s) => s.periphery.conditionalOrders === a);
}

/** A Kuru v2 stack's feed factory: its adapters are Kuru's price feeds, not lending adapters. */
export function isKuruFeedFactory(chainId: number, address: string): boolean {
  const a = addr(address);
  return networkOf(chainId).stacks.some((s) => s.periphery.kuruFeedFactory === a);
}

/**
 * Contracts that only pass tokens through. They get no Position. The AutoRedeemer and ConditionalOrders
 * hold nothing between transactions: what they move belongs to the holder or the order's owner.
 */
export function isPlumbing(chainId: number, address: string, market: string): boolean {
  const a = addr(address);
  return (
    a === ZERO_ADDRESS ||
    a === addr(market) ||
    networkOf(chainId).stacks.some(
      (s) =>
        a === s.vault ||
        a === s.router ||
        a === s.periphery.autoRedeemer ||
        a === s.periphery.conditionalOrders,
    )
  );
}

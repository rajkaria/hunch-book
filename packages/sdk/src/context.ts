import { chainsByNetwork, type Deployment, deployments, type Network } from "@hunch-book/shared";
import {
  type Account,
  type Address,
  type Chain,
  createPublicClient,
  http,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";

// Everything the SDK's functions need: the network's deployment (the only source of addresses), a
// public client for reads, and optionally a wallet client for writes. Every exported function takes
// this context first, so the functions stay tree-shakeable; `createHunchClient` binds them to one.

/** Multicall3 at its canonical address, deployed on Monad testnet and mainnet. */
export const MULTICALL3: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";

/** Optional access to Pyth's Hermes service, for price markets that settle from a Pyth update. */
export interface PythOptions {
  /** Hermes needs an API key for historical updates. */
  apiKey?: string;
  /** Defaults to https://hermes.pyth.network. */
  hermesUrl?: string;
  fetch?: typeof fetch;
}

/** A wallet client with an account attached, so it can sign and send. */
export type SigningWallet = WalletClient<Transport, Chain | undefined, Account>;

export interface HunchContext {
  network: Network;
  deployment: Deployment;
  chain: Chain;
  publicClient: PublicClient;
  walletClient: SigningWallet | undefined;
  multicallAddress: Address;
  pyth: PythOptions | undefined;
}

export interface ContextOptions {
  /** "monad-testnet" (the default) or "monad-mainnet". */
  network?: Network;
  /** Reads go through this client. Without one, a client is made from `rpcUrl` or the deployment's RPC. */
  publicClient?: PublicClient;
  /** Writes are signed and sent by this client. Without one, the SDK is read-only. */
  walletClient?: SigningWallet;
  /** RPC for the public client the SDK makes when none is given. */
  rpcUrl?: string;
  /** Replaces the deployment read from deployments/<network>.json, for a local chain in tests. */
  deployment?: Deployment;
  /** Replaces the chain definition, for a local chain in tests. */
  chain?: Chain;
  multicallAddress?: Address;
  pyth?: PythOptions;
}

export function createContext(options: ContextOptions = {}): HunchContext {
  const network = options.network ?? options.deployment?.network ?? "monad-testnet";
  const deployment = options.deployment ?? deployments[network];
  if (!deployment) throw new Error(`unknown network ${String(network)}`);
  const chain = options.chain ?? chainsByNetwork[network];
  const publicClient =
    options.publicClient ??
    (createPublicClient({
      chain,
      transport: http(options.rpcUrl ?? deployment.rpc, { timeout: 15_000, retryCount: 2 }),
    }) as PublicClient);
  return {
    network,
    deployment,
    chain,
    publicClient,
    walletClient: options.walletClient,
    multicallAddress: options.multicallAddress ?? MULTICALL3,
    pyth: options.pyth,
  };
}

/** The wallet client, or a plain error when the SDK was created without one. */
export function requireWallet(ctx: HunchContext): SigningWallet {
  if (!ctx.walletClient) {
    throw new Error("This action sends a transaction: create the client with a walletClient.");
  }
  return ctx.walletClient;
}

/** The address that signs, or undefined in read-only mode. */
export function accountAddress(ctx: HunchContext): Address | undefined {
  return ctx.walletClient?.account.address;
}

import {
  createHunchClient,
  type Deployment,
  deployments,
  type HunchClient,
  type Network,
} from "@hunch-book/sdk";

// What the data API handlers need, made once per server process from the environment. Handlers take
// it as an argument, so tests pass a fake SDK and a fake fetch.

export type ApiSdk = Pick<HunchClient, "network" | "deployment" | "context"> & {
  markets: Pick<HunchClient["markets"], "all" | "get" | "book">;
  settlement: Pick<HunchClient["settlement"], "plan" | "verify">;
};

export interface ApiDeps {
  sdk: ApiSdk;
  network: Network;
  deployment: Deployment;
  /** The app's public origin, for links back: https://book.playhunch.xyz. */
  siteUrl: string;
  /** Envio GraphQL endpoint, when one is configured. */
  indexerUrl: string | undefined;
  fetch: typeof fetch;
  /** Milliseconds since the epoch. */
  now: () => number;
}

/** The production domain, as the app's config names it; NEXT_PUBLIC_SITE_URL overrides it for previews. */
export const DEFAULT_SITE_URL = "https://book.playhunch.xyz";

/** NEXT_PUBLIC_HUNCH_NETWORK, the same switch the app reads; anything unknown is testnet. */
export function apiNetwork(value: string | undefined): Network {
  const v = value?.trim().toLowerCase();
  return v === "monad-mainnet" ? "monad-mainnet" : "monad-testnet";
}

/** A server-side RPC if one is set (private RPCs are faster), else the deployment's public RPC. */
export function apiRpcUrl(network: Network, env: Record<string, string | undefined>): string | undefined {
  const own = env.HUNCH_API_RPC_URL?.trim();
  if (own) return own;
  const repo = network === "monad-mainnet" ? env.MONAD_MAINNET_RPC : env.MONAD_TESTNET_RPC;
  return repo?.trim() || undefined;
}

export function depsFromEnv(env: Record<string, string | undefined>): ApiDeps {
  const network = apiNetwork(env.NEXT_PUBLIC_HUNCH_NETWORK);
  const sdk = createHunchClient({ network, rpcUrl: apiRpcUrl(network, env) });
  return {
    sdk,
    network,
    deployment: deployments[network],
    siteUrl: (env.NEXT_PUBLIC_SITE_URL?.trim() || DEFAULT_SITE_URL).replace(/\/$/, ""),
    indexerUrl: env.INDEXER_URL?.trim() || env.NEXT_PUBLIC_INDEXER_URL?.trim() || undefined,
    fetch: globalThis.fetch.bind(globalThis),
    now: () => Date.now(),
  };
}

let shared: ApiDeps | undefined;

/** One set of dependencies per server process. */
export function apiDeps(): ApiDeps {
  shared ??= depsFromEnv(process.env);
  return shared;
}

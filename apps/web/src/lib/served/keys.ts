import { type Deployment, type Network, rpcUrlsOf } from "@hunch-book/shared";
import type { SwrTimes } from "./swr";

// What the server reads for the browser (GET /api/read/<kind>?network=<network>), how its answers are
// keyed and how long each may be served. Pure, so the route, the loaders and the browser agree on it.

/** The read results the server serves: the markets list, the proof page and the landing panel. */
export const SERVED_KINDS = ["markets", "proof", "landing"] as const;
export type ServedKind = (typeof SERVED_KINDS)[number];

/** A served kind from a URL segment, or null for anything else. */
export function parseServedKind(value: string | null | undefined): ServedKind | null {
  const v = value?.trim().toLowerCase();
  return (SERVED_KINDS as readonly string[]).includes(v ?? "") ? (v as ServedKind) : null;
}

/** The in-process cache key: one entry per kind and network. */
export function servedKey(kind: ServedKind, network: Network): string {
  return `${kind}:${network}`;
}

/** The URL the browser fetches. The network is in the query, so the CDN keeps one copy per network. */
export function servedPath(kind: ServedKind, network: Network): string {
  return `/api/read/${kind}?network=${encodeURIComponent(network)}`;
}

/**
 * How long the server reuses a read (in its own memory) and how long the CDN may serve the response.
 * Prices move every block, so lists stay fresh for 15 seconds; a value up to 10 minutes old is still
 * served while a refresh runs, so a slow or rate-limited RPC never blanks a page.
 */
export const SERVED_TIMES: Record<ServedKind, SwrTimes & { cdnSeconds: number; cdnStaleSeconds: number }> = {
  markets: { freshMs: 15_000, maxStaleMs: 600_000, cdnSeconds: 15, cdnStaleSeconds: 60 },
  proof: { freshMs: 30_000, maxStaleMs: 600_000, cdnSeconds: 30, cdnStaleSeconds: 120 },
  landing: { freshMs: 30_000, maxStaleMs: 600_000, cdnSeconds: 30, cdnStaleSeconds: 120 },
};

/** The Cache-Control header for a served kind: the browser asks every time, the CDN shares one copy. */
export function servedCacheControl(kind: ServedKind): string {
  const t = SERVED_TIMES[kind];
  return `public, max-age=0, s-maxage=${t.cdnSeconds}, stale-while-revalidate=${t.cdnStaleSeconds}`;
}

/**
 * The RPCs the server reads from, in order: a keyed server-side RPC when one is set (HUNCH_API_RPC_URL,
 * else MONAD_TESTNET_RPC or MONAD_MAINNET_RPC for the network; never sent to the browser), then the
 * deployment's `rpc` and `rpcFallbacks`.
 */
export function serverRpcUrls(
  network: Network,
  deployment: Pick<Deployment, "rpc" | "rpcFallbacks">,
  env: Record<string, string | undefined>,
): string[] {
  const networkRpc = network === "monad-mainnet" ? env.MONAD_MAINNET_RPC : env.MONAD_TESTNET_RPC;
  const keyed = env.HUNCH_API_RPC_URL?.trim() || networkRpc?.trim() || undefined;
  return rpcUrlsOf(deployment, keyed);
}

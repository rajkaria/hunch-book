import { chainsByNetwork, type Deployment, type Network, rpcUrlsOf } from "@hunch-book/shared";
import { createPublicClient, fallback, http, type PublicClient } from "viem";

// Where the watchdog reads from, and how it tells a rate limit apart from a real failure. Public Monad
// RPCs limit each IP (testnet: "requests limited to 15/sec") and a CI runner shares its IP with others,
// so a keyed RPC goes first when one is set, then the deployment's public RPCs in turn, each retried
// with backoff. A read that still hits a rate limit is reported as a warning, not as a broken protocol.

/** Retries per endpoint before the fallback moves to the next one. */
export const RETRY_COUNT = 3;
/** First retry delay; viem doubles it on each retry (0.75 s, 1.5 s, 3 s). */
export const RETRY_DELAY_MS = 750;
/** Per-request timeout. */
export const TIMEOUT_MS = 15_000;
/** Exit code when every endpoint refused the read for sending too many requests: a soft warning. */
export const EXIT_RATE_LIMITED = 4;

/**
 * The endpoints to try, in order: the keyed RPC (WATCHDOG_RPC_URL, else MONAD_TESTNET_RPC or
 * MONAD_MAINNET_RPC for the network), then the deployment's `rpc` and `rpcFallbacks`, without repeats.
 */
export function watchdogRpcUrls(
  network: Network,
  deployment: Pick<Deployment, "rpc" | "rpcFallbacks">,
  env: Record<string, string | undefined>,
): string[] {
  const networkRpc = network === "monad-mainnet" ? env.MONAD_MAINNET_RPC : env.MONAD_TESTNET_RPC;
  const keyed = env.WATCHDOG_RPC_URL?.trim() || networkRpc?.trim() || undefined;
  return rpcUrlsOf(deployment, keyed);
}

/** A read client over `urls`: each with retries and backoff, then the next one. */
export function makeClient(network: Network, urls: readonly string[]): PublicClient {
  if (urls.length === 0) throw new Error(`no RPC endpoint for ${network}`);
  return createPublicClient({
    chain: chainsByNetwork[network],
    transport: fallback(
      urls.map((url) =>
        http(url, { retryCount: RETRY_COUNT, retryDelay: RETRY_DELAY_MS, timeout: TIMEOUT_MS }),
      ),
      { retryCount: 1, retryDelay: RETRY_DELAY_MS },
    ),
  });
}

/** JSON-RPC "limit exceeded" (EIP-1474), which viem raises as LimitExceededRpcError. */
const LIMIT_EXCEEDED = -32005;
const RATE_WORDS = /rate.?limit|too many requests|requests limited to|status:? 429/i;

/**
 * True when `error`, or any error it wraps, says the RPC refused the read for sending too many
 * requests: HTTP 429, JSON-RPC -32005, or a provider's own words for it. Anything else (a revert, a
 * timeout, a node that is down) is not a rate limit.
 */
export function isRateLimited(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const e = current as {
      status?: unknown;
      code?: unknown;
      message?: unknown;
      details?: unknown;
      cause?: unknown;
    };
    if (e.status === 429 || e.code === LIMIT_EXCEEDED) return true;
    for (const text of [e.details, e.message]) {
      if (typeof text === "string" && RATE_WORDS.test(text)) return true;
    }
    current = e.cause;
  }
  return typeof error === "string" && RATE_WORDS.test(error);
}

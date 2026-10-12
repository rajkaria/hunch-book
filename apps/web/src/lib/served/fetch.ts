import type { Network } from "@hunch-book/shared";
import type { Address } from "viem";
import type { MarketsSnapshot } from "../chain/reads";
import type { ChainClock, MarketView, ReadResult } from "../market/types";
import { type ServedKind, servedPath } from "./keys";
import { fromWireJson } from "./wire";

// The browser's side of the served reads: one request to /api/read/<kind> in place of dozens of RPC
// calls. If that request fails, the page reads the chain itself, as it did before, so the server is a
// fast path and never a single point of failure.

export interface ServedEnvelope<T> {
  /** Milliseconds since the epoch when the server read the chain. */
  readAt: number;
  data: T;
}

/** Milliseconds the browser waits for the server before reading the chain itself. */
export const SERVED_TIMEOUT_MS = 12_000;

/** Fetches one served read. Throws on any failure, so callers can fall back to the chain. */
export async function fetchServed<T>(
  kind: ServedKind,
  network: Network,
  fetcher: typeof fetch = (input, init) => globalThis.fetch(input, init),
  timeoutMs = SERVED_TIMEOUT_MS,
): Promise<ServedEnvelope<T>> {
  const response = await fetcher(servedPath(kind, network), {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`The server's ${kind} read answered HTTP ${response.status}.`);
  const body = fromWireJson<Partial<ServedEnvelope<T>>>(await response.text());
  if (typeof body.readAt !== "number" || body.data === undefined) {
    throw new Error(`The server's ${kind} read had no data.`);
  }
  return { readAt: body.readAt, data: body.data };
}

/** The markets list as the list pages use it, with the chain clock the server read alongside. */
export type MarketsRead = ReadResult<{ markets: MarketView[]; total: number; clock: ChainClock | null }>;

/** A markets snapshot as the list pages use it. */
export function marketsRead(snapshot: MarketsSnapshot): MarketsRead {
  return snapshot.list.status === "ok"
    ? { status: "ok", data: { ...snapshot.list.data, clock: snapshot.clock } }
    : snapshot.list;
}

/** One market and the chain clock read with it: what a market page needs for its first paint. */
export interface MarketSeed {
  market: MarketView;
  clock: ChainClock | null;
}

/** The market at `address` in a markets list, or null when the list does not have it. */
export function seedFromList(read: MarketsRead | undefined, address: Address): MarketSeed | null {
  if (read?.status !== "ok") return null;
  const market = read.data.markets.find((m) => m.address.toLowerCase() === address.toLowerCase());
  return market ? { market, clock: read.data.clock } : null;
}

/** Milliseconds a market page waits for the server's list; its own chain read runs alongside anyway. */
export const SEED_TIMEOUT_MS = 5_000;

/**
 * One market from the server's cached markets list (/api/read/markets, the read /markets uses): a
 * single request to our own server, often answered by the CDN, in place of the two RPC round trips a
 * chain read of the market needs. Null when the list does not have the market (it lists the newest
 * MARKET_LIST_LIMIT per stack). Throws when the request fails.
 */
export async function servedMarket(
  network: Network,
  address: Address,
  fetcher?: typeof fetch,
  timeoutMs = SEED_TIMEOUT_MS,
): Promise<MarketSeed | null> {
  const served = await fetchServed<MarketsSnapshot>("markets", network, fetcher, timeoutMs);
  return seedFromList(marketsRead(served.data), address);
}

/**
 * The markets snapshot from the server; if that fails, `readChain` reads it in this browser (the old
 * path). Either way the result has the same shape.
 */
export async function marketsServedFirst(
  network: Network,
  readChain: () => Promise<MarketsSnapshot>,
  fetcher?: typeof fetch,
): Promise<MarketsSnapshot> {
  try {
    return (await fetchServed<MarketsSnapshot>("markets", network, fetcher)).data;
  } catch {
    return readChain();
  }
}

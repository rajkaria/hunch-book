import { deployments, type Network } from "@hunch-book/shared";
import { appNetwork } from "../config";

// A small typed GraphQL client for the Hunch Book indexer (docs/INDEXER.md): Envio HyperIndex behind
// Hasura. Every call has a timeout, every failure is an IndexerError, and a client that just failed
// rests for a while, so a page that polls falls back to chain reads at once instead of waiting on
// timeouts. Pages never depend on it: each one also reads the chain (see ./source.ts).

export type IndexerFailure =
  /** The request took longer than the timeout. */
  | "timeout"
  /** The request never got an answer (DNS, TLS, CORS, offline). */
  | "network"
  /** The endpoint answered with an HTTP error. */
  | "http"
  /** The query reached Hasura and came back with errors. */
  | "graphql"
  /** The answer was not the JSON a GraphQL server sends. */
  | "shape"
  /** The endpoint indexes another chain. */
  | "wrong-chain"
  /** The indexer has not caught up with the chain yet. */
  | "behind";

export class IndexerError extends Error {
  readonly kind: IndexerFailure;
  constructor(kind: IndexerFailure, message: string) {
    super(message);
    this.name = "IndexerError";
    this.kind = kind;
  }
}

export type Fetcher = (input: string, init: RequestInit) => Promise<Response>;

export interface IndexerStatus {
  chainId: number;
  /** The last block the indexer has processed. */
  progressBlock: bigint;
  /** The chain head the indexer last saw. */
  sourceBlock: bigint | null;
  /** Caught up with the head at least once since it started. */
  isReady: boolean;
}

export interface IndexerClient {
  readonly url: string;
  readonly network: Network;
  readonly chainId: number;
  /** Runs one query. Throws IndexerError. */
  query<T>(document: string, variables?: Record<string, unknown>): Promise<T>;
  /** The indexer's sync status from its `_meta` view, or null when the endpoint does not serve one. */
  status(): Promise<IndexerStatus | null>;
  /** False while the client rests after a failure. */
  available(now?: number): boolean;
}

/** Milliseconds a query may take. */
export const INDEXER_TIMEOUT_MS = 8_000;
/** Milliseconds a client rests after a failure before it is tried again. */
export const INDEXER_REST_MS = 30_000;
/** Milliseconds a status answer is reused. */
const STATUS_TTL_MS = 30_000;

/**
 * The indexer endpoint for a network, from the build's environment: NEXT_PUBLIC_INDEXER_URL for Monad
 * testnet (the indexer that config.yaml describes) and NEXT_PUBLIC_INDEXER_URL_MAINNET for mainnet.
 * Null when unset or not an http(s) URL.
 */
export function indexerUrl(
  network: Network,
  env: { testnet?: string; mainnet?: string } = {
    // Literal accesses, so Next.js inlines them into the browser bundle.
    testnet: process.env.NEXT_PUBLIC_INDEXER_URL,
    mainnet: process.env.NEXT_PUBLIC_INDEXER_URL_MAINNET,
  },
): string | null {
  const raw = (network === "monad-mainnet" ? env.mainnet : env.testnet)?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

interface GraphqlBody<T> {
  data?: T | null;
  errors?: { message?: string }[];
}

interface MetaRow {
  chainId: number | string;
  progressBlock: number | string | null;
  sourceBlock: number | string | null;
  isReady: boolean | null;
}

const STATUS_QUERY = "query IndexerStatus { _meta { chainId progressBlock sourceBlock isReady } }";

export function makeIndexerClient({
  url,
  network,
  fetch: fetcher = (input, init) => globalThis.fetch(input, init),
  timeoutMs = INDEXER_TIMEOUT_MS,
  restMs = INDEXER_REST_MS,
  now = () => Date.now(),
}: {
  url: string;
  network: Network;
  fetch?: Fetcher;
  timeoutMs?: number;
  restMs?: number;
  now?: () => number;
}): IndexerClient {
  const chainId = deployments[network].chainId;
  let restUntil = 0;
  let cachedStatus: { at: number; value: IndexerStatus | null } | null = null;

  const fail = (error: IndexerError): never => {
    restUntil = now() + restMs;
    throw error;
  };

  async function query<T>(document: string, variables: Record<string, unknown> = {}): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetcher(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ query: document, variables }),
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      if (controller.signal.aborted) {
        return fail(new IndexerError("timeout", `The indexer did not answer within ${timeoutMs} ms.`));
      }
      return fail(
        new IndexerError("network", `Could not reach the indexer: ${(error as Error)?.message ?? "error"}.`),
      );
    }
    let body: GraphqlBody<T>;
    try {
      if (!response.ok) {
        return fail(new IndexerError("http", `The indexer answered HTTP ${response.status}.`));
      }
      body = (await response.json()) as GraphqlBody<T>;
    } catch (error) {
      if (error instanceof IndexerError) throw error;
      if (controller.signal.aborted) {
        return fail(new IndexerError("timeout", `The indexer did not answer within ${timeoutMs} ms.`));
      }
      return fail(new IndexerError("shape", "The indexer's answer was not JSON."));
    } finally {
      clearTimeout(timer);
    }
    if (body?.errors && body.errors.length > 0) {
      return fail(new IndexerError("graphql", body.errors[0]?.message ?? "The indexer refused the query."));
    }
    if (!body || body.data === undefined || body.data === null) {
      return fail(new IndexerError("shape", "The indexer's answer had no data."));
    }
    return body.data;
  }

  async function status(): Promise<IndexerStatus | null> {
    if (cachedStatus && now() - cachedStatus.at < STATUS_TTL_MS) return cachedStatus.value;
    let rows: MetaRow[] | undefined;
    try {
      rows = (await query<{ _meta?: MetaRow[] }>(STATUS_QUERY))._meta;
    } catch (error) {
      // An endpoint without the _meta view still answers entity queries: status unknown, not down.
      if (error instanceof IndexerError && error.kind === "graphql") {
        restUntil = 0;
        cachedStatus = { at: now(), value: null };
        return null;
      }
      throw error;
    }
    const row = rows?.find((r) => Number(r.chainId) === chainId);
    if (!row) {
      if (!rows || rows.length === 0) {
        cachedStatus = { at: now(), value: null };
        return null;
      }
      return fail(
        new IndexerError("wrong-chain", `The indexer serves chain ${rows[0]?.chainId}, not ${chainId}.`),
      );
    }
    const value: IndexerStatus = {
      chainId,
      progressBlock: BigInt(row.progressBlock ?? 0),
      sourceBlock: row.sourceBlock === null ? null : BigInt(row.sourceBlock),
      isReady: Boolean(row.isReady),
    };
    cachedStatus = { at: now(), value };
    return value;
  }

  return {
    url,
    network,
    chainId,
    query,
    status,
    available: (at = now()) => at >= restUntil,
  };
}

const clients = new Map<Network, IndexerClient | null>();

/** The indexer client for the active network, or null when the build has no endpoint for it. */
export function getIndexerClient(network: Network = appNetwork): IndexerClient | null {
  if (!clients.has(network)) {
    const url = indexerUrl(network);
    clients.set(network, url ? makeIndexerClient({ url, network }) : null);
  }
  return clients.get(network) ?? null;
}

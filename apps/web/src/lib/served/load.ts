import {
  chainsByNetwork,
  type Deployment,
  deployments,
  type GraduationRule,
  type Network,
} from "@hunch-book/shared";
import { createPublicClient, fallback, http, type PublicClient } from "viem";
import {
  type LandingRead,
  readGraduationRule,
  readLandingSnapshot,
  withNetworkRules,
} from "../chain/landing";
import { type MarketsSnapshot, measureMsPerBlock, readMarketsSnapshot } from "../chain/reads";
import { isDeployed, NETWORKS } from "../config";
import { getIndexerClient } from "../indexer/client";
import type { Sourced } from "../indexer/source";
import { type ProofView, readProofFrom } from "../proof/read";
import { SERVED_TIMES, type ServedKind, servedKey, serverRpcUrls } from "./keys";
import { createSwrCache, type SwrResult } from "./swr";

// The server's read path for the pages every visitor loads: one cached read per kind and network,
// shared by every request, instead of every browser reading dozens of contracts through the public RPC.
// The markets list is read once and reused by the proof and landing reads. Server only: it reads
// server-side RPC variables and keeps its cache in this process.

const cache = createSwrCache();
const clients = new Map<Network, PublicClient>();

/** Milliseconds per block changes slowly: measured at most once every 10 minutes. */
const PACE_TIMES = { freshMs: 600_000, maxStaleMs: 3_600_000 };
/** How long a cold landing read may take before it gives up (the page then says it could not read). */
const LANDING_TIMEOUT_MS = 20_000;
/** A graduation rule changes only when the guardian registers a template: reused for 10 minutes. */
const RULE_TIMES = { freshMs: 600_000, maxStaleMs: 86_400_000 };
/** How long the landing page waits for another network's rule before it leaves that rule out. */
const RULE_TIMEOUT_MS = 5_000;

/** One read client per network: a keyed server-side RPC first, then the public ones, with retries. */
export function serverClient(network: Network, deployment: Deployment = deployments[network]): PublicClient {
  let client = clients.get(network);
  if (!client) {
    const urls = serverRpcUrls(network, deployment, process.env);
    client = createPublicClient({
      chain: chainsByNetwork[network],
      transport: fallback(
        urls.map((url) => http(url, { timeout: 10_000, retryCount: 2, retryDelay: 400 })),
        { retryCount: 1 },
      ),
    });
    clients.set(network, client);
  }
  return client;
}

async function pace(network: Network, client: PublicClient, head: bigint): Promise<number | null> {
  const result = await cache.get(`pace:${network}`, PACE_TIMES, async () => {
    const ms = await measureMsPerBlock(client, head);
    if (ms === null) throw new Error("The block time could not be measured.");
    return ms;
  });
  return result.served.value;
}

/** Every stack's markets and the chain clock, from the cache when fresh. */
export function loadMarkets(
  network: Network,
  deployment: Deployment = deployments[network],
): Promise<SwrResult<MarketsSnapshot>> {
  const client = serverClient(network, deployment);
  return cache.get(servedKey("markets", network), SERVED_TIMES.markets, () =>
    readMarketsSnapshot(client, deployment, {
      pace: (head) => pace(network, client, head),
      nominalMsPerBlock: chainsByNetwork[network].blockTime ?? 400,
    }),
  );
}

/** The cached markets snapshot's value, for reads that build on it. */
export async function servedMarkets(network: Network, deployment: Deployment = deployments[network]) {
  return (await loadMarkets(network, deployment)).served.value;
}

/** The proof page's figures: the indexer when configured and caught up, else the chain. */
export function loadProof(
  network: Network,
  deployment: Deployment = deployments[network],
): Promise<SwrResult<Sourced<ProofView>>> {
  return cache.get(servedKey("proof", network), SERVED_TIMES.proof, () =>
    readProofFrom({
      client: serverClient(network, deployment),
      deployment,
      indexer: getIndexerClient(network),
      readList: async () => (await servedMarkets(network, deployment)).list,
    }),
  );
}

/** A network's graduation rule for new markets, cached; null if it is not read within RULE_TIMEOUT_MS. */
export async function networkRule(network: Network): Promise<GraduationRule | null> {
  const deployment = deployments[network];
  const read = cache
    .get(`rule:${network}`, RULE_TIMES, () =>
      readGraduationRule(serverClient(network, deployment), deployment),
    )
    .then((r) => r.served.value);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), RULE_TIMEOUT_MS);
  });
  try {
    return await Promise.race([read, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The landing panel's live figures, built on the cached markets read; gives up after `timeoutMs`. Every
 * other deployed network's graduation rule rides along, so the page can state the rule per network.
 */
export async function landingRead(
  network: Network,
  deployment: Deployment = deployments[network],
  timeoutMs = LANDING_TIMEOUT_MS,
): Promise<LandingRead> {
  const others = NETWORKS.filter((n) => n !== network && isDeployed(deployments[n]));
  const [read, rules] = await Promise.all([
    readLandingSnapshot(serverClient(network, deployment), deployment, timeoutMs, {
      markets: () => servedMarkets(network, deployment),
    }),
    // Started with the snapshot, so a slow RPC on the other network costs no extra time.
    Promise.all(others.map(async (n) => [n, await networkRule(n).catch(() => null)] as const)),
  ]);
  const known = new Map(rules);
  return withNetworkRules(read, network, others, async (n) => known.get(n) ?? null);
}

/** The landing panel, cached. A failed read is not kept: the next request tries again. */
export function loadLanding(
  network: Network,
  deployment: Deployment = deployments[network],
): Promise<SwrResult<LandingRead>> {
  return cache.get(servedKey("landing", network), SERVED_TIMES.landing, async () => {
    const read = await landingRead(network, deployment);
    if (read.status === "error") throw new Error("The landing figures could not be read.");
    return read;
  });
}

/** The served read for a kind. */
export function loadServed(kind: ServedKind, network: Network): Promise<SwrResult<unknown>> {
  switch (kind) {
    case "markets":
      return loadMarkets(network);
    case "proof":
      return loadProof(network);
    case "landing":
      return loadLanding(network);
  }
}

import type { ServiceHealthView } from "./health";

// When the last settlement and the last graduation happened. From the indexer when
// NEXT_PUBLIC_INDEXER_URL is set (exact chain times); otherwise from the keeper's health (its own last
// actions); otherwise unknown. The page says which source it used.

export interface LastEvent {
  /** Unix seconds. */
  at: number;
  market?: string;
  tx?: string;
  source: "indexer" | "keeper";
}

export interface Lifecycle {
  settlement: LastEvent | null;
  graduation: LastEvent | null;
}

export const LIFECYCLE_QUERY = `query StatusLifecycle {
  settled: Market(where: {settledAt: {_is_null: false}}, order_by: {settledAt: desc}, limit: 1) { id settledAt settleTx }
  graduated: Market(where: {graduatedAt: {_is_null: false}}, order_by: {graduatedAt: desc}, limit: 1) { id graduatedAt }
}`;

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** One GraphQL request. Null when the indexer is unset, unreachable or answers with errors. */
export async function readLifecycleFromIndexer(
  indexerUrl: string | undefined,
  fetchImpl: Fetch = fetch,
): Promise<Lifecycle | null> {
  if (!indexerUrl) return null;
  try {
    const res = await fetchImpl(indexerUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: LIFECYCLE_QUERY }),
      signal: AbortSignal.timeout(6_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      data?: {
        settled?: { id: string; settledAt: string | number; settleTx?: string }[];
        graduated?: { id: string; graduatedAt: string | number }[];
      };
      errors?: unknown;
    };
    if (body.errors || !body.data) return null;
    const s = body.data.settled?.[0];
    const g = body.data.graduated?.[0];
    return {
      settlement: s
        ? {
            at: Number(s.settledAt),
            market: s.id,
            ...(s.settleTx ? { tx: s.settleTx } : {}),
            source: "indexer",
          }
        : null,
      graduation: g ? { at: Number(g.graduatedAt), market: g.id, source: "indexer" } : null,
    };
  } catch {
    return null;
  }
}

/** The keeper's last successful settle and graduate actions, from its health snapshot. */
export function lifecycleFromKeeper(h: ServiceHealthView | null | undefined): Lifecycle | null {
  if (!h?.reachable || !h.jobs) return null;
  const pick = (job: string): LastEvent | null => {
    const a = h.jobs?.[job]?.lastAction;
    if (!a?.at || a.status !== "success") return null;
    const at = Math.floor(Date.parse(a.at) / 1000);
    if (Number.isNaN(at)) return null;
    return {
      at,
      ...(a.market ? { market: a.market } : {}),
      ...(a.hash ? { tx: a.hash } : {}),
      source: "keeper",
    };
  };
  return { settlement: pick("settle"), graduation: pick("graduate") };
}

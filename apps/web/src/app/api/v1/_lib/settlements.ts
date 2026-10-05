import { addressUrl, describeError, type MarketInfo, type Verification } from "@hunch-book/sdk";
import { cached } from "./cache";
import type { ApiDeps } from "./deps";
import { type ChainClock, isOurs, marketTitleText, marketUrl } from "./markets";

// The settlement archive: every settled or voided market with the exact read that settled it (the
// evidence, what it decodes to, the transaction and who sent it) and whether that read still reproduces
// today. Built from the SDK's verifySettlement, the same check /verify runs in the browser.

/** Markets verified at once, so a cold archive does not flood the RPC. */
export const ARCHIVE_CONCURRENCY = 3;
export const ARCHIVE_DEFAULT_LIMIT = 25;
export const ARCHIVE_MAX_LIMIT = 100;

export interface ArchiveQuery {
  template: number | null;
  limit: number;
  offset: number;
}

export function parseArchiveQuery(url: URL): ArchiveQuery | string {
  const num = (name: string, fallback: number, min: number, max: number): number | string => {
    const raw = url.searchParams.get(name);
    if (raw === null || raw === "") return fallback;
    if (!/^\d+$/.test(raw)) return `${name} must be a whole number.`;
    const n = Number(raw);
    if (n < min || n > max) return `${name} must be between ${min} and ${max}.`;
    return n;
  };
  const limit = num("limit", ARCHIVE_DEFAULT_LIMIT, 1, ARCHIVE_MAX_LIMIT);
  if (typeof limit === "string") return limit;
  const offset = num("offset", 0, 0, 1_000_000);
  if (typeof offset === "string") return offset;
  const template = url.searchParams.get("template");
  if (template !== null && template !== "" && !/^[1-9]\d*$/.test(template)) {
    return "template must be a template id such as 1.";
  }
  return { template: template ? Number(template) : null, limit, offset };
}

export const isFinal = (m: Pick<MarketInfo, "phaseName">): boolean =>
  m.phaseName === "settled" || m.phaseName === "voided";

/**
 * The verification of one market, shared with /markets/{address}/evidence's cache. For a finished
 * market it always names the settling transaction: the SDK looks that up only when a template's check
 * needs it, so it is found here otherwise (a search of `phase()` over past blocks), and kept, since it
 * never changes.
 */
export function verification(deps: ApiDeps, m: MarketInfo): Promise<Verification> {
  return cached(
    `evidence:${deps.network}:${m.address}:${m.phase}`,
    m.phaseName === "settled" ? 300_000 : 30_000,
    async () => {
      const v = await deps.sdk.settlement.verify(m);
      if (v.settlement || !isFinal(m)) return v;
      // Only a found transaction is kept: a miss (or an RPC hiccup during the search) is tried again.
      const tx = await cached(
        `settle-tx:${deps.network}:${m.address}`,
        86_400_000,
        async () => {
          const found = await deps.sdk.settlement.findTransaction(m.address);
          if (!found) throw new Error("not found");
          return found;
        },
        deps.now(),
      ).catch(() => null);
      return tx ? { ...v, settlement: tx } : v;
    },
    deps.now(),
  );
}

/** Runs `work` over `items`, at most `limit` at a time, keeping the order. */
export async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  work: (t: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await work(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export function settlementRecord(
  m: MarketInfo,
  v: Verification | null,
  error: string | null,
  deps: ApiDeps,
  clock: ChainClock | null,
) {
  const tx = v?.settlement ?? null;
  return {
    id: m.id,
    market: m.address,
    title: marketTitleText(m, clock),
    rule: m.rule,
    template: { id: m.templateId, name: m.template },
    asset: m.asset,
    status: m.phaseName,
    outcome: m.outcomeLabel,
    settledAt: tx
      ? { block: tx.block.toString(), time: new Date(Number(tx.time) * 1000).toISOString() }
      : null,
    settlementTx: tx
      ? {
          hash: tx.hash,
          explorer: `${deps.deployment.explorer}/tx/${tx.hash}`,
          by: tx.by,
          byHunch: isOurs(deps, tx.by),
          method: tx.method,
        }
      : null,
    evidence: tx?.evidence ?? v?.recomputed.evidence ?? null,
    evidenceHash: v?.stored.evidenceHash ?? m.evidenceHash,
    reads: v?.recomputed.reads ?? null,
    verified: v?.verified ?? null,
    matches: v?.matches ?? null,
    notes: v?.notes ?? [],
    error,
    links: {
      app: marketUrl(deps, m.address),
      verify: `${deps.siteUrl}/verify/${m.address}`,
      evidence: `${deps.siteUrl}/api/v1/markets/${m.address}/evidence`,
      explorer: addressUrl(deps.deployment, m.address),
    },
  };
}

export type SettlementRecord = ReturnType<typeof settlementRecord>;

/** Newest settlement first; markets whose transaction was not found go last, newest id first. */
export function byNewestSettlement(a: SettlementRecord, b: SettlementRecord): number {
  const ab = a.settledAt ? BigInt(a.settledAt.block) : -1n;
  const bb = b.settledAt ? BigInt(b.settledAt.block) : -1n;
  if (ab !== bb) return ab > bb ? -1 : 1;
  return b.id - a.id;
}

export async function archive(
  deps: ApiDeps,
  markets: MarketInfo[],
  clock: ChainClock | null,
): Promise<SettlementRecord[]> {
  const records = await mapLimited(markets, ARCHIVE_CONCURRENCY, async (m) => {
    try {
      return settlementRecord(m, await verification(deps, m), null, deps, clock);
    } catch (e) {
      return settlementRecord(
        m,
        null,
        `Could not verify this one right now: ${describeError(e)}`,
        deps,
        clock,
      );
    }
  });
  return records.sort(byNewestSettlement);
}

export const SETTLEMENT_CSV_COLUMNS = [
  "id",
  "market",
  "template_id",
  "template",
  "asset",
  "status",
  "outcome",
  "settled_block",
  "settled_at",
  "settle_tx",
  "settled_by",
  "settled_by_hunch",
  "method",
  "evidence",
  "evidence_hash",
  "reads",
  "verified",
  "rule",
  "verify_url",
] as const;

export function settlementCsvRow(r: SettlementRecord): Record<string, unknown> {
  return {
    id: r.id,
    market: r.market,
    template_id: r.template.id,
    template: r.template.name,
    asset: r.asset,
    status: r.status,
    outcome: r.outcome,
    settled_block: r.settledAt?.block,
    settled_at: r.settledAt?.time,
    settle_tx: r.settlementTx?.hash,
    settled_by: r.settlementTx?.by,
    settled_by_hunch: r.settlementTx?.byHunch,
    method: r.settlementTx?.method,
    evidence: r.evidence,
    evidence_hash: r.evidenceHash,
    reads: r.reads ? JSON.stringify(r.reads, (_k, v) => (typeof v === "bigint" ? v.toString() : v)) : null,
    verified: r.verified,
    rule: r.rule,
    verify_url: r.links.verify,
  };
}

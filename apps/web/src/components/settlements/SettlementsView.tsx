"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { appNetwork } from "@/lib/config";
import { formatInt, shortAddress } from "@/lib/format";
import { EmptyState, ErrorState, LoadingRows } from "../states";
import { Badge, Panel, type Tone } from "../ui";
import s from "./settlements.module.css";

// The settlement archive: every finished market with the read that settled it, from the data API's
// /api/v1/settlements (docs/API.md), with a CSV of the same.

export interface ArchiveRecord {
  id: number;
  market: string;
  /** The market's stack and book venue (the API names them; older answers leave them out). */
  stack?: string;
  venue?: "kuru" | "hunch";
  venueLabel?: string;
  title: string;
  template: { id: number; name: string };
  status: "settled" | "voided";
  outcome: string;
  settledAt: { block: string; time: string } | null;
  settlementTx: {
    hash: string;
    explorer: string;
    by: string;
    byHunch: boolean;
    method: string | null;
  } | null;
  evidence: string | null;
  reads: Record<string, unknown> | null;
  verified: boolean | null;
  complete?: boolean;
  error: string | null;
  links: { app: string; verify: string; evidence: string; explorer: string };
}

export interface ArchiveBody {
  network: string;
  total: number;
  settlements: ArchiveRecord[];
}

export const ARCHIVE_CSV_URL = "/api/v1/settlements?limit=100&format=csv";

/** A finished market as the market list has it: enough to show its row before its check is in. */
export interface FinishedMarket {
  id: number;
  address: string;
  rule: string;
  template: { id: number; name: string };
  phase: "settled" | "voided";
  outcome: string;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `The data API did not answer (${res.status}).`);
  }
  return (await res.json()) as T;
}

/** Every settled or voided market, newest first, from one cheap read of the market list. */
export async function fetchFinished(): Promise<FinishedMarket[]> {
  const body = await getJson<{ markets: (FinishedMarket & { phase: string })[] }>(
    "/api/v1/markets?limit=200",
  );
  return body.markets
    .filter((m): m is FinishedMarket => m.phase === "settled" || m.phase === "voided")
    .sort((a, b) => b.id - a.id);
}

/** One market's archive record. Each is its own request, so the public RPC is never asked for all at once. */
export async function fetchRecord(address: string): Promise<ArchiveRecord | null> {
  const body = await getJson<ArchiveBody>(`/api/v1/settlements?market=${address}`);
  return body.settlements[0] ?? null;
}

function resultBadge(r: ArchiveRecord): { tone: Tone; text: string } {
  if (r.status === "voided") return { tone: "muted", text: "Voided" };
  if (r.outcome === "yes") return { tone: "yes", text: "YES" };
  if (r.outcome === "no") return { tone: "no", text: "NO" };
  return { tone: "neutral", text: r.outcome };
}

export function verifiedText(v: boolean | null): { tone: Tone; text: string } {
  if (v === true) return { tone: "yes", text: "Read reproduced" };
  if (v === false) return { tone: "danger", text: "Read does not match" };
  return { tone: "muted", text: "Not checked" };
}

/** The reads as "name: value" pairs, numbers and strings only. */
export function readPairs(reads: Record<string, unknown> | null): [string, string][] {
  if (!reads) return [];
  return Object.entries(reads)
    .filter(([, v]) => typeof v === "string" || typeof v === "number" || typeof v === "boolean")
    .slice(0, 6)
    .map(([k, v]) => [k, String(v)]);
}

export function SettlementRow({ r, checking = false }: { r: ArchiveRecord; checking?: boolean }) {
  const result = resultBadge(r);
  const check = verifiedText(r.verified);
  return (
    <li className={s.row}>
      <div className={s.meta}>
        <Badge tone={result.tone}>{result.text}</Badge>
        <span>{r.template.name}</span>
        <span className="mono">
          #{r.id}
          {r.venueLabel && r.venue !== "hunch" ? ` · ${r.venueLabel}` : ""}
        </span>
        <span className={s.metaRight}>
          <Badge tone={checking ? "muted" : check.tone}>
            {checking ? "Checking the read..." : check.text}
          </Badge>
        </span>
      </div>
      <h2 className={s.title}>
        <Link href={`/m/${r.market}`}>{r.title}</Link>
      </h2>
      <dl className={s.facts}>
        <div>
          <dt>Settled</dt>
          <dd>
            {r.settledAt ? (
              <>
                {new Date(r.settledAt.time).toUTCString().replace(" GMT", " UTC")} · block{" "}
                <span className="mono">{formatInt(BigInt(r.settledAt.block))}</span>
              </>
            ) : checking ? (
              "Reading the chain..."
            ) : r.complete === false ? (
              "Not found on this load: the chain did not answer every read. It is asked again shortly."
            ) : (
              "Transaction not found yet"
            )}
          </dd>
        </div>
        {r.settlementTx ? (
          <div>
            <dt>By</dt>
            <dd>
              <span className="mono">{shortAddress(r.settlementTx.by)}</span>
              {r.settlementTx.byHunch ? " (ours)" : ""}
              {r.settlementTx.method ? ` · ${r.settlementTx.method}` : ""}
            </dd>
          </div>
        ) : null}
        {readPairs(r.reads).map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd className="mono">{v}</dd>
          </div>
        ))}
      </dl>
      {r.error ? <p className={s.error}>{r.error}</p> : null}
      <div className={s.links}>
        <Link href={`/verify/${r.market}`}>Re-run the read</Link>
        {r.settlementTx ? (
          <a href={r.settlementTx.explorer} target="_blank" rel="noreferrer">
            Settlement transaction
          </a>
        ) : null}
        <a href={r.links.evidence} target="_blank" rel="noreferrer">
          Evidence (JSON)
        </a>
      </div>
    </li>
  );
}

/** A finished market's row: its outcome at once, then the read and transaction once its check is in. */
export function ArchiveItem({ m }: { m: FinishedMarket }) {
  const q = useQuery({
    queryKey: ["settlement", appNetwork, m.address.toLowerCase()],
    queryFn: () => fetchRecord(m.address),
    staleTime: 5 * 60_000,
    retry: 3,
    retryDelay: (n) => 2_000 * 2 ** n,
    // An incomplete record (the RPC dropped reads) is asked for again until it fills in.
    refetchInterval: (query) => (query.state.data && query.state.data.complete === false ? 30_000 : false),
  });
  if (q.data) return <SettlementRow r={q.data} />;
  const pending: ArchiveRecord = {
    id: m.id,
    market: m.address,
    title: m.rule,
    template: m.template,
    status: m.phase,
    outcome: m.outcome,
    settledAt: null,
    settlementTx: null,
    evidence: null,
    reads: null,
    verified: null,
    complete: false,
    error: q.isError ? `Could not check this one right now: ${(q.error as Error).message}` : null,
    links: { app: "", verify: "", evidence: `/api/v1/markets/${m.address}/evidence`, explorer: "" },
  };
  return <SettlementRow r={pending} checking={!q.isError} />;
}

export function SettlementsView() {
  const list = useQuery({
    queryKey: ["settlements-list", appNetwork],
    queryFn: fetchFinished,
    staleTime: 60_000,
  });
  if (list.isPending) return <LoadingRows rows={4} label="Loading finished markets" />;
  if (list.isError)
    return <ErrorState title="Could not load the archive" detail={(list.error as Error).message} />;
  const markets = list.data;
  return (
    <Panel
      title={`${formatInt(markets.length)} finished ${markets.length === 1 ? "market" : "markets"}`}
      aside={
        <a className={s.download} href={ARCHIVE_CSV_URL} download>
          Download CSV
        </a>
      }
    >
      {markets.length === 0 ? (
        <EmptyState title="Nothing has settled yet">
          <p>Markets appear here once they settle or void.</p>
        </EmptyState>
      ) : (
        <>
          <p className={s.note}>
            Each record is checked against the chain as it loads: the read that settled it, done again, and
            the transaction that did it.
          </p>
          <ul className={s.list}>
            {markets.map((m) => (
              <ArchiveItem key={m.address} m={m} />
            ))}
          </ul>
        </>
      )}
    </Panel>
  );
}

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
  error: string | null;
  links: { app: string; verify: string; evidence: string; explorer: string };
}

export interface ArchiveBody {
  network: string;
  total: number;
  settlements: ArchiveRecord[];
}

export const ARCHIVE_URL = "/api/v1/settlements?limit=100";
export const ARCHIVE_CSV_URL = "/api/v1/settlements?limit=100&format=csv";

async function fetchArchive(): Promise<ArchiveBody> {
  const res = await fetch(ARCHIVE_URL);
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `The archive did not answer (${res.status}).`);
  }
  return (await res.json()) as ArchiveBody;
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

export function SettlementRow({ r }: { r: ArchiveRecord }) {
  const result = resultBadge(r);
  const check = verifiedText(r.verified);
  return (
    <li className={s.row}>
      <div className={s.meta}>
        <Badge tone={result.tone}>{result.text}</Badge>
        <span>{r.template.name}</span>
        <span className="mono">#{r.id}</span>
        <span className={s.metaRight}>
          <Badge tone={check.tone}>{check.text}</Badge>
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

export function SettlementsView() {
  const q = useQuery({ queryKey: ["settlements", appNetwork], queryFn: fetchArchive, staleTime: 60_000 });
  if (q.isPending) return <LoadingRows rows={4} />;
  if (q.isError) return <ErrorState title="Could not load the archive" detail={(q.error as Error).message} />;
  const body = q.data;
  return (
    <Panel
      title={`${formatInt(body.total)} finished ${body.total === 1 ? "market" : "markets"}`}
      aside={
        <a className={s.download} href={ARCHIVE_CSV_URL} download>
          Download CSV
        </a>
      }
    >
      {body.network !== appNetwork ? (
        <p className={s.note}>This archive covers {body.network}, the network the data API serves.</p>
      ) : null}
      {body.settlements.length === 0 ? (
        <EmptyState title="Nothing has settled yet">
          <p>Markets appear here once they settle or void.</p>
        </EmptyState>
      ) : (
        <ul className={s.list}>
          {body.settlements.map((r) => (
            <SettlementRow key={r.market} r={r} />
          ))}
        </ul>
      )}
    </Panel>
  );
}

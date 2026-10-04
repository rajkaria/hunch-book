"use client";

import Link from "next/link";
import type { Address } from "viem";
import { appNetwork } from "@/lib/config";
import { formatInt, formatUsdc, shortAddress } from "@/lib/format";
import type { PortfolioEntry } from "@/lib/market/types";
import { csvFilename, downloadText, historyCsv } from "@/lib/pnl/csv";
import { usePortfolioPnl } from "@/lib/pnl/hooks";
import type { MarketPnl } from "@/lib/pnl/ledger";
import { SourceTag } from "../indexer/SourceTag";
import { LoadingRows } from "../states";
import { Button, Notice, Panel, Stat } from "../ui";
import p from "./pnl.module.css";

/** A signed USDC amount: "+12.50", "-3.10" or "0.00". */
export function formatSigned(value: bigint): string {
  return value > 0n ? `+${formatUsdc(value)}` : formatUsdc(value);
}

function Signed({ value }: { value: bigint | null }) {
  if (value === null) return <span className={p.subtle}>n/a</span>;
  return <span className={value > 0n ? p.up : value < 0n ? p.down : undefined}>{formatSigned(value)}</span>;
}

function Row({
  r,
  label,
}: {
  r: MarketPnl;
  label: { number: number | null; question: string | null } | undefined;
}) {
  return (
    <tr>
      <td className={p.market}>
        <Link href={`/m/${r.market}`} title={label?.question ?? r.market}>
          {label?.number !== null && label?.number !== undefined
            ? `#${label.number}`
            : shortAddress(r.market)}
          {label?.question ? <span className={p.question}> {label.question}</span> : null}
        </Link>
      </td>
      <td className={`${p.num} mono`}>{formatUsdc(r.costBasis)}</td>
      <td className={`${p.num} mono`}>
        {r.value === null ? <span className={p.subtle}>n/a</span> : formatUsdc(r.value)}
      </td>
      <td className={`${p.num} mono`}>
        <Signed value={r.realised} />
      </td>
      <td className={`${p.num} mono`}>
        <Signed value={r.unrealised} />
      </td>
      <td className={`${p.num} mono`}>
        <Signed value={r.total} />
      </td>
      <td>
        {r.complete ? (
          <span className={p.subtle}>complete</span>
        ) : (
          <span className={p.partial} title={r.notes.join(" ")}>
            cost partly unknown
          </span>
        )}
      </td>
    </tr>
  );
}

/**
 * Profit and loss per market and in total, realised and unrealised at the book's mid, with the whole
 * history as a CSV download.
 */
export function PnlPanel({ user, entries }: { user: Address; entries: readonly PortfolioEntry[] }) {
  const pnl = usePortfolioPnl(user, entries);
  if (pnl.isPending) {
    return (
      <Panel title="Profit and loss" labelledBy="pnl-title">
        <LoadingRows rows={1} label="Working out profit and loss" />
      </Panel>
    );
  }
  if (pnl.rows.length === 0 && pnl.events.length === 0) return null;
  const t = pnl.totals;
  const save = () =>
    downloadText(csvFilename(appNetwork, user), historyCsv(pnl.events, pnl.labels, pnl.source));
  return (
    <Panel
      title="Profit and loss"
      labelledBy="pnl-title"
      aside={<SourceTag source={pnl.source} fallback={pnl.fallback} indexedBlock={pnl.indexedBlock} />}
    >
      <div className={p.totals}>
        <Stat label="Realised" value={<Signed value={t.realised} />} hint="USDC, closed out" />
        <Stat
          label="Unrealised at mid"
          value={<Signed value={t.unrealised} />}
          hint={t.unpriced > 0 ? `${formatInt(t.unpriced)} without a price left out` : "USDC, still held"}
        />
        <Stat label="Total" value={<Signed value={t.realised + t.unrealised} />} hint="USDC" />
        <Stat label="Paid in" value={formatUsdc(t.spent)} hint="stakes, buys, mints" />
        <Stat label="Paid out" value={formatUsdc(t.received)} hint="payouts, sells, merges, redemptions" />
      </div>

      {pnl.source === "chain" ? (
        <Notice tone="accent" title="Rebuilt from chain state">
          <p className="muted">
            Without the indexer, this page rebuilds your stakes, token claims and pool payouts from the
            contracts, exactly. Trades, mints and redemptions need the indexer, so a market with any of them
            shows "cost partly unknown".
          </p>
        </Notice>
      ) : null}

      {pnl.rows.length > 0 ? (
        <div className={p.scroll}>
          <table className={p.table}>
            <caption className="visually-hidden">Profit and loss per market</caption>
            <thead>
              <tr>
                <th scope="col">Market</th>
                <th scope="col" className={p.num}>
                  Cost basis
                </th>
                <th scope="col" className={p.num}>
                  Value now
                </th>
                <th scope="col" className={p.num}>
                  Realised
                </th>
                <th scope="col" className={p.num}>
                  Unrealised
                </th>
                <th scope="col" className={p.num}>
                  Total
                </th>
                <th scope="col">Cost</th>
              </tr>
            </thead>
            <tbody>
              {pnl.rows.map((r) => (
                <Row key={r.market} r={r} label={pnl.labels.get(r.market.toLowerCase())} />
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <div className={p.foot}>
        <p className={p.note}>
          Average cost per side. A mint splits its cost evenly between YES and NO. Value now prices YES at the
          book's mid and NO at one minus it; once a market settles, winning tokens count at what they redeem
          for and losing tokens as a realised loss.
        </p>
        <Button size="sm" onClick={save} disabled={pnl.events.length === 0}>
          Download history (CSV)
        </Button>
      </div>
    </Panel>
  );
}

"use client";

import { blockUrl, snapshotWindowState } from "@hunch-book/shared";
import Link from "next/link";
import { appDeployment } from "@/lib/config";
import { formatInt, formatUtc } from "@/lib/format";
import type { MarketView } from "@/lib/market/types";
import { COMPARATOR_TEXT, formatSnapshotValue, windowSentence } from "@/lib/snapshot";
import { useSnapshotCurrentValue, useSnapshotSources, useStoredSnapshot } from "@/lib/snapshot/hooks";
import { Badge, KeyValues, Panel } from "../ui";
import s from "./market.module.css";

const WINDOW_LABEL = { before: "Opens at close", open: "Open now", after: "Closed" } as const;

/**
 * Template 7: what the market reads, the snapshot window and where it stands, and the stored snapshot
 * (value, block, time) once anyone has taken it. Before that, the value a snapshot would store now.
 */
export function SnapshotPanel({ m, now }: { m: MarketView; now: number | null }) {
  const p = m.decoded.kind === "snapshot" ? m.decoded.params : null;
  const sources = useSnapshotSources(p ? m.resolver : undefined);
  const stored = useStoredSnapshot(m.resolver, m.params, p, now);
  const snapshot = stored.data?.snapshot ?? null;
  const window = p && now !== null ? snapshotWindowState(p.closeTime, p.snapshotWindow, BigInt(now)) : null;
  const current = useSnapshotCurrentValue(
    p ? m.resolver : undefined,
    p ? p.sourceId : null,
    stored.data !== undefined && snapshot === null && window !== "after",
  );
  if (!p) return null;
  const source = sources.data?.find((x) => x.id === p.sourceId) ?? null;
  const show = (raw: bigint) => (source ? formatSnapshotValue(raw, source) : `${raw.toString()} (raw)`);
  const end = p.closeTime + BigInt(p.snapshotWindow);

  return (
    <Panel title="Snapshot" labelledBy="snapshot-title">
      <KeyValues
        items={[
          { label: "Reads", value: source ? source.label : `source ${p.sourceId}` },
          { label: "YES if it is", value: `${COMPARATOR_TEXT[p.comparator]} ${show(p.threshold)}` },
          {
            label: "Window",
            value: (
              <>
                {formatUtc(p.closeTime)} to {formatUtc(end)}{" "}
                {window ? (
                  <Badge tone={window === "open" ? "accent" : "muted"} dot>
                    {WINDOW_LABEL[window]}
                  </Badge>
                ) : null}
              </>
            ),
          },
          snapshot
            ? {
                label: "Snapshot",
                value: (
                  <>
                    <span className="mono">{show(snapshot.value)}</span> at block{" "}
                    <a
                      href={blockUrl(appDeployment, snapshot.blockNumber)}
                      target="_blank"
                      rel="noreferrer"
                      className="mono"
                    >
                      {formatInt(snapshot.blockNumber)}
                    </a>
                    , {formatUtc(snapshot.timestamp)}
                  </>
                ),
              }
            : {
                label: "Now",
                value:
                  current.data !== undefined ? (
                    <span className="mono">{show(current.data)}</span>
                  ) : current.isError ? (
                    "The resolver cannot read the source right now."
                  ) : window === "after" ? (
                    "No snapshot was taken."
                  ) : (
                    "Reading..."
                  ),
              },
        ]}
      />
      <p className={s.laterNote} style={{ marginTop: 12 }}>
        {window ? windowSentence(window, snapshot !== null) : null} The first snapshot is final and every
        market on the same source and window answers from it.{" "}
        <Link href={`/verify/${m.address}`}>Check it on the verify page</Link>.
      </p>
    </Panel>
  );
}

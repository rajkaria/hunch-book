import { blockUrl, Outcome } from "@hunch-book/shared";
import type { ReactNode } from "react";
import { appDeployment } from "@/lib/config";
import { formatInt, formatUtc } from "@/lib/format";
import { COMPARATOR_TEXT, formatSnapshotValue, type SnapshotCheck, windowSentence } from "@/lib/snapshot";
import { AddressLink, Badge, KeyValues, Panel } from "../ui";
import v from "./verify.module.css";

const OUTCOME: Record<number, string> = {
  [Outcome.Unresolved]: "Unresolved",
  [Outcome.Yes]: "YES",
  [Outcome.No]: "NO",
};

const WINDOW_LABEL: Record<SnapshotCheck["window"], string> = {
  before: "Not open yet",
  open: "Open now",
  after: "Closed",
};

const mono = (value: ReactNode) => <span className="mono">{value}</span>;

/**
 * Template 7's read: the source call, the snapshot the market answers from (value, block, time), where the
 * window stands, and the source re-read at the snapshot's block.
 */
export function SnapshotReadPanel({ read }: { read: SnapshotCheck }) {
  const { params: p, source, snapshot } = read;
  const value = (raw: bigint) =>
    source ? `${formatSnapshotValue(raw, source)} (raw ${raw.toString()})` : raw.toString();
  const end = p.closeTime + BigInt(p.snapshotWindow);
  const items: { label: ReactNode; value: ReactNode; key?: string }[] = [
    {
      label: "Source",
      value: source ? `${source.label}, in ${source.unit}` : `id ${p.sourceId} (could not read it)`,
    },
  ];
  if (source) {
    items.push(
      { label: "Call", value: <AddressLink address={source.target} full /> },
      { label: "Call data", value: mono(source.callData) },
      {
        label: "Value read",
        value: `word ${source.valueWord}${source.tuple ? " of the returned tuple" : ""}, ${source.signed ? "signed" : "unsigned"}`,
      },
    );
  }
  items.push(
    {
      label: "Snapshot window",
      value: (
        <>
          {formatUtc(p.closeTime)} to {formatUtc(end)}{" "}
          <Badge tone={read.window === "open" ? "accent" : "muted"} dot>
            {WINDOW_LABEL[read.window]}
          </Badge>
        </>
      ),
    },
    { label: "Snapshot key", value: mono(read.key) },
    {
      label: "Stored snapshot",
      value: snapshot ? (
        <>
          {mono(value(snapshot.value))} at block{" "}
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
      ) : (
        "None yet."
      ),
    },
  );
  if (!snapshot && read.current !== null) {
    items.push({ label: "Value now", value: mono(value(read.current)) });
  }
  items.push({
    label: "Rule",
    value: (
      <>
        YES if the value is {COMPARATOR_TEXT[p.comparator]} {mono(value(p.threshold))}:{" "}
        <strong>{read.outcome === null ? "n/a" : OUTCOME[read.outcome]}</strong>
      </>
    ),
  });
  if (read.reread) {
    items.push({
      label: "Re-read at that block",
      value: read.reread.error ? (
        `Could not re-run the call: ${read.reread.error}`
      ) : (
        <span className={v.compare}>
          {mono(read.reread.value === null ? "unreadable" : value(read.reread.value))}
          {read.reread.matches === null ? (
            <Badge tone="muted">not compared</Badge>
          ) : read.reread.matches ? (
            <Badge tone="accent" dot>
              Match
            </Badge>
          ) : (
            <Badge tone="warn" dot>
              Differs
            </Badge>
          )}
        </span>
      ),
    });
  }
  return (
    <Panel
      title="The read"
      labelledBy="verify-read"
      aside={<span className="subtle">Snapshot of current state</span>}
    >
      <KeyValues items={items} />
      <p className={v.note}>
        {windowSentence(read.window, snapshot !== null)} The evidence hash commits to the call, the word read,
        the value, and the block and time of the snapshot transaction. A call re-run at a block reads the
        state at the end of that block, so a later transaction in the same block that moved the value makes
        the re-read differ; the snapshot transaction's trace shows the exact read.
      </p>
    </Panel>
  );
}

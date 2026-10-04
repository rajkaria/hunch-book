"use client";

import type { SnapshotComparator } from "@hunch-book/shared";
import { useEffect, useState } from "react";
import type { Address } from "viem";
import { type FormResult, issueFor } from "@/lib/create/build";
import { fromLocalInput, toLocalInput } from "@/lib/create/clock";
import { describeCreateError } from "@/lib/create/errors";
import type { LockLead } from "@/lib/create/price";
import {
  buildSnapshotParams,
  defaultSnapshotDraft,
  SNAPSHOT_WINDOWS,
  type SnapshotDraft,
  snapshotLockTime,
  suggestedThreshold,
} from "@/lib/create/snapshot";
import { formatUtc } from "@/lib/format";
import {
  COMPARATOR_TEXT,
  formatSnapshotValue,
  SNAPSHOT_COMPARATORS,
  type SnapshotSourceView,
} from "@/lib/snapshot";
import { useSnapshotCurrentValue, useSnapshotSources } from "@/lib/snapshot/hooks";
import { Button, Field, fieldA11y, Input, Notice, Panel, SegmentedControl, Skeleton } from "../ui";
import s from "./create.module.css";
import { When } from "./When";

const LEADS: { value: LockLead; label: string }[] = [
  { value: "day", label: "24 hours before" },
  { value: "hour", label: "1 hour before" },
  { value: "custom", label: "Custom" },
];

/**
 * Step 2 for template 7: a value Perpl only holds as current state (open interest, mark price), read
 * once onchain in the first snapshot taken right after the close, compared with a level.
 */
export function SnapshotForm({
  now,
  resolver,
  onResult,
}: {
  now: number;
  resolver: Address;
  onResult: (r: FormResult) => void;
}) {
  const sources = useSnapshotSources(resolver);
  if (sources.isError) {
    return (
      <Panel title="Step 2: parameters" labelledBy="params-title">
        <Notice tone="danger" title="Could not read the sources" role="alert">
          <p>The RPC did not answer for the resolver's list of sources. Nothing was sent.</p>
          <div style={{ marginTop: 8 }}>
            <Button size="sm" onClick={() => void sources.refetch()}>
              Try again
            </Button>
          </div>
        </Notice>
      </Panel>
    );
  }
  if (!sources.data) {
    return (
      <Panel title="Step 2: parameters" labelledBy="params-title">
        <div className={s.fields} role="status">
          <span className="visually-hidden">Reading the sources</span>
          <Skeleton width="100%" height={44} />
          <Skeleton width="60%" height={44} />
        </div>
      </Panel>
    );
  }
  if (sources.data.length === 0) {
    return (
      <Panel title="Step 2: parameters" labelledBy="params-title">
        <Notice tone="warn" title="No sources">
          <p>This template's resolver lists no sources on this network.</p>
        </Notice>
      </Panel>
    );
  }
  return <SnapshotFields now={now} resolver={resolver} sources={sources.data} onResult={onResult} />;
}

export function SnapshotFields({
  now,
  resolver,
  sources,
  onResult,
}: {
  now: number;
  resolver: Address;
  sources: SnapshotSourceView[];
  onResult: (r: FormResult) => void;
}) {
  const [draft, setDraft] = useState<SnapshotDraft>(() => defaultSnapshotDraft(now, sources));
  const [touched, setTouched] = useState(false);
  const set = (patch: Partial<SnapshotDraft>) => setDraft((d) => ({ ...d, ...patch }));

  const build = buildSnapshotParams(draft, { sources, now });
  const source = build.source;
  const current = useSnapshotCurrentValue(resolver, source ? source.id : null);
  const suggestion = current.data !== undefined && source ? suggestedThreshold(current.data, source) : null;

  // Until the creator types a level, start from the current value, rounded.
  useEffect(() => {
    if (touched || suggestion === null) return;
    setDraft((d) => (d.threshold === suggestion ? d : { ...d, threshold: suggestion }));
  }, [suggestion, touched]);

  const params = build.params;
  useEffect(() => {
    onResult({ params, clock: null, priceSource: null, challengeEnd: null });
  }, [params, onResult]);

  const closeTime = fromLocalInput(draft.close);
  const lockTime = snapshotLockTime(draft, closeTime);
  const sourceError = issueFor(build.issues, "source");
  const thresholdError = issueFor(build.issues, "threshold");
  const closeError = issueFor(build.issues, "close");
  const lockError = issueFor(build.issues, "lock");
  const windowError = issueFor(build.issues, "window");

  return (
    <Panel title="Step 2: parameters" labelledBy="params-title">
      <div className={s.fields}>
        <fieldset className={s.legs} aria-describedby="snapshot-source-hint">
          <legend className={s.groupLabel}>What to read</legend>
          <p className={s.small} id="snapshot-source-hint">
            Perpl holds these only as current state, so the resolver reads the value itself, once, in the
            first snapshot taken after the close, and keeps it.
          </p>
          <ul className={s.legList}>
            {sources.map((src) => {
              const checked = String(src.id) === draft.sourceId;
              return (
                <li key={src.id}>
                  <label className={s.leg} data-checked={checked || undefined}>
                    <input
                      type="radio"
                      name="snapshot-source"
                      value={src.id}
                      checked={checked}
                      onChange={() => {
                        setTouched(false);
                        set({ sourceId: String(src.id), threshold: "" });
                      }}
                    />
                    <span className={s.legText}>
                      <span>{src.label}</span>
                      <span className={s.legMeta}>
                        In {src.unit}
                        {src.maxAge > 0 ? `, refused if older than ${src.maxAge} seconds` : ""}
                      </span>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
          {sourceError ? (
            <p className={s.error} role="alert">
              {sourceError}
            </p>
          ) : null}
          {source ? (
            <p className={s.small} style={{ marginTop: 8 }}>
              {current.data !== undefined ? (
                <>
                  Now: <span className={s.mono}>{formatSnapshotValue(current.data, source)}</span>, read
                  through the resolver just now.
                </>
              ) : current.isError ? (
                `The resolver refuses to read this source now: ${describeCreateError(current.error)}`
              ) : (
                "Reading the current value..."
              )}
            </p>
          ) : null}
        </fieldset>

        <div>
          <span className={s.groupLabel}>YES if the value is</span>
          <SegmentedControl
            label="How the value is compared"
            name="snapshot-comparator"
            block
            size="sm"
            value={String(draft.comparator)}
            onChange={(v) => set({ comparator: Number(v) as SnapshotComparator })}
            options={SNAPSHOT_COMPARATORS.map((c) => ({ value: String(c), label: COMPARATOR_TEXT[c] }))}
          />
        </div>

        <div>
          <Field
            id="snapshot-threshold"
            label={`Level, in ${source?.unit ?? "the source's unit"}`}
            hint={
              source
                ? `YES if ${source.label} is ${COMPARATOR_TEXT[draft.comparator]} this in the snapshot. Equal counts only for "at or" choices.`
                : "Pick what to read first."
            }
            error={thresholdError}
          >
            <Input
              mono
              inputMode="decimal"
              autoComplete="off"
              unit={source?.unit}
              value={draft.threshold}
              onChange={(e) => {
                setTouched(true);
                set({ threshold: e.target.value });
              }}
              {...fieldA11y("snapshot-threshold", { hint: true, error: Boolean(thresholdError) })}
            />
          </Field>
          {suggestion !== null && source && current.data !== undefined ? (
            <div className={s.quick} style={{ marginTop: 8 }}>
              <Button
                size="sm"
                onClick={() => {
                  setTouched(false);
                  set({ threshold: suggestion });
                }}
              >
                Use the current value, rounded: {suggestion} {source.unit}
              </Button>
            </div>
          ) : null}
        </div>

        <Field
          id="snapshot-close"
          label="Close: when the snapshot window opens"
          hint={closeTime !== null ? <When unix={closeTime} /> : "Pick a date and time."}
          error={closeError}
        >
          <Input
            type="datetime-local"
            value={draft.close}
            onChange={(e) => set({ close: e.target.value })}
            {...fieldA11y("snapshot-close", { hint: true, error: Boolean(closeError) })}
          />
        </Field>

        <div>
          <span className={s.groupLabel}>Snapshot window</span>
          <SegmentedControl
            label="How long the snapshot window stays open"
            name="snapshot-window"
            block
            size="sm"
            value={String(draft.window)}
            onChange={(v) => set({ window: Number(v) })}
            options={SNAPSHOT_WINDOWS.map((w) => ({ value: String(w), label: `${w / 60} minutes` }))}
          />
          <p className={s.small} style={{ marginTop: 8 }}>
            {closeTime !== null
              ? `Anyone can take the snapshot from ${formatUtc(closeTime)} to ${formatUtc(closeTime + draft.window)}. `
              : ""}
            Settling at the first block after the close takes it and settles in one transaction. With no
            snapshot in the window, the market voids.
          </p>
          {windowError ? (
            <p className={s.error} role="alert">
              {windowError}
            </p>
          ) : null}
        </div>

        <div>
          <span className={s.groupLabel}>Lock: when staking stops</span>
          <SegmentedControl
            label="When staking stops"
            name="snapshot-lock"
            block
            size="sm"
            value={draft.lockLead}
            onChange={(lockLead) =>
              set({
                lockLead,
                lock: lockLead === "custom" && lockTime !== null ? toLocalInput(lockTime) : draft.lock,
              })
            }
            options={LEADS}
          />
          {draft.lockLead === "custom" ? (
            <div style={{ marginTop: 12 }}>
              <Field
                id="snapshot-lock"
                label="Lock time"
                hint={lockTime !== null ? <When unix={lockTime} /> : "Pick a date and time."}
                error={lockError}
              >
                <Input
                  type="datetime-local"
                  value={draft.lock}
                  onChange={(e) => set({ lock: e.target.value })}
                  {...fieldA11y("snapshot-lock", { hint: true, error: Boolean(lockError) })}
                />
              </Field>
            </div>
          ) : lockTime !== null ? (
            <p className={s.small} style={{ marginTop: 8 }}>
              Staking stops <When unix={lockTime} />
            </p>
          ) : null}
        </div>
      </div>
    </Panel>
  );
}

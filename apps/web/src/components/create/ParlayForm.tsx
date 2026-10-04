"use client";

import { PARLAY_MAX_LEGS, PARLAY_MIN_LEGS, PHASE_LABEL, Phase } from "@hunch-book/shared";
import { useEffect, useMemo, useState } from "react";
import type { Address } from "viem";
import { appDeployment } from "@/lib/config";
import {
  buildParlayParams,
  defaultParlayTimes,
  type FormResult,
  issueFor,
  type ParlayDraft,
} from "@/lib/create/build";
import { fromLocalInput, toLocalInput } from "@/lib/create/clock";
import { useCreateClock, useFastBlockTime } from "@/lib/create/hooks";
import { type ParlayLinked, toExactLocalInput } from "@/lib/create/linked";
import { parlayCandidates, searchCandidates } from "@/lib/create/parlay";
import { formatDuration } from "@/lib/format";
import { useMarkets } from "@/lib/hooks";
import { Badge, Button, Field, fieldA11y, Input, Notice, Panel, Skeleton } from "../ui";
import s from "./create.module.css";
import { When } from "./When";

/** Step 2 for template 6: a parlay of 2 to 5 open Hunch Book markets. */
export function ParlayForm({
  now,
  resolver,
  onResult,
  linked,
}: {
  now: number;
  resolver: Address;
  onResult: (r: FormResult) => void;
  /** A parlay's exact legs and times from a link (lib/create/linked.ts), sent by the parlay page. */
  linked?: ParlayLinked;
}) {
  const markets = useMarkets();
  const clock = useCreateClock();
  const fast = useFastBlockTime(resolver);
  const [draft, setDraft] = useState<ParlayDraft>(() =>
    linked
      ? {
          legs: linked.legs.slice(0, PARLAY_MAX_LEGS),
          lock: toExactLocalInput(linked.lockTime),
          close: toExactLocalInput(linked.closeTime),
        }
      : { legs: [], lock: "", close: "" },
  );
  const [timesTouched, setTimesTouched] = useState(linked !== undefined);
  // Linked legs that can no longer be legs (locked, settled, or locking too soon), once checked.
  const [dropped, setDropped] = useState<Address[] | null>(linked ? null : []);
  const [query, setQuery] = useState("");

  const list = markets.data?.status === "ok" ? markets.data.data.markets : null;
  const candidates = useMemo(
    () =>
      list && clock.data && fast.data !== undefined
        ? parlayCandidates(list, appDeployment, {
            head: clock.data.head,
            pace: clock.data.pace,
            now,
            fastBlockTimeMs: fast.data,
          })
        : [],
    [list, clock.data, fast.data, now],
  );
  const ctx =
    clock.data && fast.data !== undefined
      ? { legs: candidates, head: clock.data.head, pace: clock.data.pace, now, fastBlockTimeMs: fast.data }
      : null;
  const build = ctx ? buildParlayParams(draft, ctx) : null;

  // A link's legs are checked once the open markets are read: the ones that cannot be legs come out.
  const ready = list !== null && ctx !== null;
  useEffect(() => {
    if (dropped !== null || !ready) return;
    const usable = (a: Address) => candidates.some((c) => c.address.toLowerCase() === a.toLowerCase());
    setDropped(draft.legs.filter((a) => !usable(a)));
    setDraft((d) => ({ ...d, legs: d.legs.filter(usable) }));
  }, [dropped, ready, candidates, draft.legs]);
  const droppedLabels = (dropped ?? []).map((a) => {
    const m = list?.find((x) => x.address.toLowerCase() === a.toLowerCase());
    return m ? `#${m.marketId.toString()}` : a;
  });

  // Until the creator edits the times, lock just before the first leg can and close with the last leg.
  const chosen = useMemo(
    () => candidates.filter((c) => draft.legs.some((a) => a.toLowerCase() === c.address.toLowerCase())),
    [candidates, draft.legs],
  );
  const defaults = ctx && chosen.length > 0 ? defaultParlayTimes({ ...ctx, legs: chosen }) : null;
  const defaultLock = defaults ? toLocalInput(defaults.lock) : null;
  const defaultClose = defaults ? toLocalInput(defaults.close) : null;
  useEffect(() => {
    if (timesTouched || defaultLock === null || defaultClose === null) return;
    setDraft((d) =>
      d.lock === defaultLock && d.close === defaultClose
        ? d
        : { ...d, lock: defaultLock, close: defaultClose },
    );
  }, [defaultLock, defaultClose, timesTouched]);

  const params = build?.params ?? null;
  useEffect(() => {
    onResult({ params, clock: null, priceSource: null, challengeEnd: null });
  }, [params, onResult]);

  const toggle = (address: Address) =>
    setDraft((d) => {
      const has = d.legs.some((a) => a.toLowerCase() === address.toLowerCase());
      if (has) return { ...d, legs: d.legs.filter((a) => a.toLowerCase() !== address.toLowerCase()) };
      if (d.legs.length >= PARLAY_MAX_LEGS) return d;
      return { ...d, legs: [...d.legs, address] };
    });

  const issues = build?.issues ?? [];
  const legsError = draft.legs.length > 0 ? issueFor(issues, "legs") : undefined;
  const lockError = draft.legs.length >= PARLAY_MIN_LEGS ? issueFor(issues, "lock") : undefined;
  const closeError = draft.legs.length >= PARLAY_MIN_LEGS ? issueFor(issues, "close") : undefined;
  const lock = fromLocalInput(draft.lock);
  const close = fromLocalInput(draft.close);
  const shown = searchCandidates(candidates, query);
  const full = draft.legs.length >= PARLAY_MAX_LEGS;

  if (markets.isError || clock.isError || fast.isError) {
    return (
      <Panel title="Step 2: parameters" labelledBy="params-title">
        <Notice tone="danger" title="Could not read the open markets" role="alert">
          <p>The RPC did not answer. Nothing was sent.</p>
          <div style={{ marginTop: 8 }}>
            <Button
              size="sm"
              onClick={() => {
                void markets.refetch();
                void clock.refetch();
                void fast.refetch();
              }}
            >
              Try again
            </Button>
          </div>
        </Notice>
      </Panel>
    );
  }

  return (
    <Panel title="Step 2: parameters" labelledBy="params-title">
      <div className={s.fields}>
        <fieldset className={s.legs} aria-describedby="parlay-legs-hint">
          <legend className={s.groupLabel}>
            Legs: {draft.legs.length} of {PARLAY_MIN_LEGS} to {PARLAY_MAX_LEGS} chosen
          </legend>
          <p className={s.small} id="parlay-legs-hint">
            YES only if every leg settles YES; NO as soon as any leg settles NO. A leg can only be a market
            that has not settled and has not locked yet, because the parlay must lock first.
          </p>
          <Input
            type="search"
            placeholder="Search by question or #number"
            aria-label="Search open markets"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {!list || !clock.data || fast.data === undefined ? (
            <div role="status">
              <span className="visually-hidden">Reading open markets</span>
              <Skeleton width="100%" height={56} />
              <Skeleton width="100%" height={56} style={{ marginTop: 8 }} />
            </div>
          ) : candidates.length === 0 ? (
            <p className={s.small}>
              No open market can be a leg right now: each one has locked, settled or is about to lock.
            </p>
          ) : (
            <ul className={s.legList}>
              {shown.map((c) => {
                const checked = draft.legs.some((a) => a.toLowerCase() === c.address.toLowerCase());
                return (
                  <li key={c.address}>
                    <label className={s.leg} data-checked={checked || undefined}>
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={!checked && full}
                        onChange={() => toggle(c.address)}
                      />
                      <span className={s.legText}>
                        <span className={s.legMeta}>
                          <span className={s.mono}>#{c.marketId.toString()}</span>
                          <Badge tone={c.phase === Phase.Pool ? "cyan" : "accent"}>
                            {PHASE_LABEL[c.phase]}
                          </Badge>
                          <span>
                            Locks in {c.window.blockClock ? "about " : ""}
                            {formatDuration(c.expectedLock - now)}
                            {c.window.blockClock
                              ? `; a parlay with it must lock within ${formatDuration(c.earliestLock - now)}`
                              : ""}
                          </span>
                        </span>
                        <span>{c.label}</span>
                      </span>
                    </label>
                  </li>
                );
              })}
              {shown.length === 0 ? <li className={s.small}>No open market matches that search.</li> : null}
            </ul>
          )}
          {droppedLabels.length > 0 ? (
            <p className={s.error} role="status">
              From the link, {droppedLabels.length === 1 ? "this market" : "these markets"} can no longer be a
              leg, because {droppedLabels.length === 1 ? "it has" : "each has"} locked, settled or locks too
              soon: {droppedLabels.join(", ")}.
            </p>
          ) : null}
          {legsError ? (
            <p className={s.error} role="alert">
              {legsError}
            </p>
          ) : null}
        </fieldset>

        <div className={s.row}>
          <Field
            id="parlay-lock"
            label="Lock: when staking stops"
            hint={
              build?.firstLock ? (
                <>
                  {lock !== null ? <When unix={lock} /> : null}
                  <span className={s.estimate}>
                    Must be at or before market #{build.firstLock.leg.marketId.toString()} can lock.
                  </span>
                </>
              ) : (
                "Pick legs first: the lock defaults to just before the first leg can lock."
              )
            }
            error={lockError}
          >
            <Input
              type="datetime-local"
              value={draft.lock}
              onChange={(e) => {
                setTimesTouched(true);
                setDraft((d) => ({ ...d, lock: e.target.value }));
              }}
              {...fieldA11y("parlay-lock", { hint: true, error: Boolean(lockError) })}
            />
          </Field>
          <Field
            id="parlay-close"
            label="Close: when settlement opens"
            hint={
              close !== null ? (
                <>
                  <When unix={close} />
                  <span className={s.estimate}>The parlay settles once its legs have.</span>
                </>
              ) : (
                "Defaults to when the last leg closes."
              )
            }
            error={closeError}
          >
            <Input
              type="datetime-local"
              value={draft.close}
              onChange={(e) => {
                setTimesTouched(true);
                setDraft((d) => ({ ...d, close: e.target.value }));
              }}
              {...fieldA11y("parlay-close", { hint: true, error: Boolean(closeError) })}
            />
          </Field>
        </div>
        {timesTouched && defaults ? (
          <div className={s.quick}>
            <Button size="sm" onClick={() => setTimesTouched(false)}>
              Use the times from the legs
            </Button>
          </div>
        ) : null}
      </div>
    </Panel>
  );
}

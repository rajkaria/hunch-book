"use client";

import { useEffect, useMemo, useState } from "react";
import type { Address } from "viem";
import { appDeployment } from "@/lib/config";
import {
  buildPerplParams,
  defaultPerplDraft,
  type FormResult,
  issueFor,
  type PerplDraft,
} from "@/lib/create/build";
import { blockAt, fromLocalInput, timeAt, toLocalInput, uncertaintySeconds } from "@/lib/create/clock";
import { useChallengeBlocks, useCreateClock, usePerpContext } from "@/lib/create/hooks";
import type { PerplLinked } from "@/lib/create/linked";
import {
  type FundingRule,
  formatFundingUsd,
  formatPercent,
  fundingDecimals,
  fundingDeltas,
  historicalHits,
  isLopsided,
  meanDelta,
  PERPL_INTERVAL,
  percentOfPrice,
  snapWindow,
  suggestThreshold,
} from "@/lib/create/perpl";
import type { CreatePrefill } from "@/lib/create/prefill";
import { toInputString } from "@/lib/create/units";
import { formatInt } from "@/lib/format";
import { Button, Field, fieldA11y, Input, Notice, Panel, SegmentedControl, Skeleton } from "../ui";
import s from "./create.module.css";
import { When } from "./When";

/**
 * The active network's Perpl perps (perp ids differ between testnet and mainnet), read at render so a
 * network switch in the browser never builds params with the other network's ids. MON comes first where
 * it exists: it is the chain's own asset and the most active Perpl market on testnet.
 */
function perpsOf(deployment: typeof appDeployment) {
  const perps = deployment.external.perpl.perps;
  const assets = Object.keys(perps);
  return { perps, assets, defaultAsset: assets.includes("MON") ? "MON" : (assets[0] ?? "") };
}

/** How many recent funding events to show as chips. */
const RECENT_SHOWN = 8;

/** Template 4's window limit: 31 days of its challenge period. */
const SPIKE_MAX_DAYS = 31n;

/**
 * Step 2 for the Perpl templates: total funding over a window (template 1, rule "window") or any
 * single funding event in a window (template 4, rule "spike"). Both are defined in blocks; the form
 * takes clock times and converts them with the measured block pace.
 */
export function PerplForm({
  now,
  rule,
  resolver,
  onResult,
  prefill,
  linked,
}: {
  now: number;
  rule: FundingRule;
  resolver: Address;
  onResult: (r: FormResult) => void;
  /** Values from a link (lib/create/prefill.ts), for example the hedge assistant's. */
  prefill?: CreatePrefill;
  /** A market's exact params from a link (lib/create/linked.ts), for example a ladder's missing strike. */
  linked?: PerplLinked;
}) {
  const { perps, assets, defaultAsset } = perpsOf(appDeployment);
  const [draft, setDraft] = useState<PerplDraft>(() =>
    linked
      ? {
          ...defaultPerplDraft(now, linked.asset ?? defaultAsset),
          start: "",
          end: "",
          pinned: { startBlock: linked.startBlock, endBlock: linked.endBlock },
        }
      : {
          ...defaultPerplDraft(now, prefill?.asset ?? defaultAsset),
          ...(prefill?.start !== undefined ? { start: toLocalInput(prefill.start) } : {}),
          ...(prefill?.end !== undefined ? { end: toLocalInput(prefill.end) } : {}),
          ...(prefill?.threshold !== undefined ? { threshold: prefill.threshold } : {}),
        },
  );
  const [thresholdTouched, setThresholdTouched] = useState(
    prefill?.threshold !== undefined || linked !== undefined,
  );
  // A linked threshold is in Perpl's raw units; it becomes USD once the perp's decimals are read.
  const [linkedThreshold, setLinkedThreshold] = useState<bigint | null>(linked?.threshold ?? null);
  const set = (patch: Partial<PerplDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const spike = rule === "spike";

  const clock = useCreateClock();
  const perpId = perps[draft.asset] !== undefined ? BigInt(perps[draft.asset] as number) : null;
  const perp = usePerpContext(perpId, clock.data?.head.number);

  // Linked blocks: show their estimated times in the inputs once the chain clock is read.
  const pinned = draft.pinned ?? null;
  const clockNow = clock.data ?? null;
  useEffect(() => {
    if (!pinned || !clockNow) return;
    const start = toLocalInput(timeAt(pinned.startBlock, clockNow.head, clockNow.pace.msPerBlock));
    const end = toLocalInput(timeAt(pinned.endBlock, clockNow.head, clockNow.pace.msPerBlock));
    setDraft((d) => (d.pinned && d.start === "" && d.end === "" ? { ...d, start, end } : d));
  }, [pinned, clockNow]);
  const linkedInfo = perp.data?.info;
  useEffect(() => {
    if (linkedThreshold === null || !linkedInfo) return;
    setDraft((d) => ({ ...d, threshold: toInputString(linkedThreshold, fundingDecimals(linkedInfo)) }));
    setLinkedThreshold(null);
  }, [linkedThreshold, linkedInfo]);
  const challenge = useChallengeBlocks(spike ? resolver : undefined);
  const challengeBlocks = spike ? (challenge.data ?? null) : null;
  const ready = Boolean(clock.data && perp.data && perpId !== null && (!spike || challengeBlocks !== null));

  const build =
    ready && clock.data && perp.data && perpId !== null
      ? buildPerplParams(draft, {
          perpId,
          info: perp.data.info,
          interval: perp.data.interval,
          anchor: perp.data.anchor,
          head: clock.data.head,
          pace: clock.data.pace,
          now,
          rule,
          maxWindowBlocks: challengeBlocks !== null ? challengeBlocks * SPIKE_MAX_DAYS : null,
        })
      : null;

  const info = perp.data?.info;
  const decimals = info ? fundingDecimals(info) : 0;
  const deltas = useMemo(() => (perp.data ? fundingDeltas(perp.data.history.samples) : []), [perp.data]);

  // The window length in funding events, even while the threshold is still empty.
  const intervals = useMemo(() => {
    if (build?.intervals !== null && build?.intervals !== undefined) return Number(build.intervals);
    if (!clock.data || !perp.data) return null;
    const start = fromLocalInput(draft.start);
    const end = fromLocalInput(draft.end);
    if (start === null || end === null || end <= start) return null;
    const ms = clock.data.pace.msPerBlock;
    const snapped = snapWindow({
      startBlock: blockAt(start, clock.data.head, ms),
      endBlock: blockAt(end, clock.data.head, ms),
      interval: perp.data.interval,
      anchor: perp.data.anchor,
    });
    return Number(snapped.intervals);
  }, [build?.intervals, clock.data, perp.data, draft.start, draft.end]);

  const suggestion = intervals !== null ? suggestThreshold(deltas, intervals, rule) : null;

  // Until the creator types a threshold, keep it where past windows split about half and half.
  useEffect(() => {
    if (thresholdTouched || suggestion === null) return;
    const next = toInputString(suggestion, decimals);
    setDraft((d) => (d.threshold === next ? d : { ...d, threshold: next }));
  }, [suggestion, decimals, thresholdTouched]);

  const params = build?.params ?? null;
  const clockData = clock.data ?? null;
  const endBlock = build?.endBlock ?? null;
  const challengeEndBlock =
    spike && endBlock !== null && challengeBlocks !== null ? endBlock + challengeBlocks : null;
  const challengeUnix =
    challengeEndBlock !== null && clockData
      ? timeAt(challengeEndBlock, clockData.head, clockData.pace.msPerBlock)
      : null;
  useEffect(() => {
    onResult({
      params,
      clock: clockData,
      priceSource: null,
      challengeEnd: challengeEndBlock !== null ? { block: challengeEndBlock, unix: challengeUnix } : null,
    });
  }, [params, clockData, challengeEndBlock, challengeUnix, onResult]);

  const issues = build?.issues ?? [];
  const startError = issueFor(issues, "start");
  const endError = issueFor(issues, "end");
  const thresholdError = issueFor(issues, "threshold");
  const assetError = issueFor(issues, "asset");
  const interval = perp.data?.interval ?? PERPL_INTERVAL;
  const symbol = info?.symbol ?? draft.asset;

  const estimate = (block: bigint | null) =>
    block !== null && clock.data ? (
      <When
        block={block}
        unix={timeAt(block, clock.data.head, clock.data.pace.msPerBlock)}
        estimated
        plusMinus={uncertaintySeconds(block, clock.data.head, clock.data.pace)}
      />
    ) : null;

  const hits =
    build?.threshold !== null && build?.threshold !== undefined && intervals !== null
      ? historicalHits(deltas, intervals, build.threshold, rule)
      : null;
  const pct = build?.threshold != null && info ? percentOfPrice(build.threshold, decimals, info) : null;

  return (
    <Panel title="Step 2: parameters" labelledBy="params-title">
      <div className={s.fields}>
        <div>
          <span className={s.groupLabel}>Perpl perp</span>
          <SegmentedControl
            label="Perpl perp"
            name="perpl-asset"
            block
            value={draft.asset}
            onChange={(asset) => {
              setThresholdTouched(false);
              setLinkedThreshold(null);
              set({ asset, threshold: "" });
            }}
            options={assets.map((a) => ({ value: a, label: a }))}
          />
          {assetError ? (
            <p className={s.error} role="alert">
              {assetError}
            </p>
          ) : null}
        </div>

        <FundingContext
          loading={clock.isPending || perp.isPending || (spike && challenge.isPending)}
          failed={clock.isError || perp.isError || (spike && challenge.isError)}
          onRetry={() => {
            void clock.refetch();
            void perp.refetch();
            if (spike) void challenge.refetch();
          }}
          rule={rule}
          name={info?.name ?? draft.asset}
          symbol={symbol}
          decimals={decimals}
          deltas={deltas}
          markPrice={info ? formatFundingUsd(info.markPrice, info.priceDecimals) : null}
          intervals={intervals}
          hits={hits}
          head={clock.data?.head.number ?? null}
          msPerBlock={clock.data?.pace.msPerBlock ?? null}
          measured={clock.data?.pace.measured ?? false}
        />

        <div className={s.row}>
          <Field
            id="perpl-start"
            label="Window starts (staking stops)"
            hint={
              estimate(build?.startBlock ?? null) ??
              "Staking stops here. The block is worked out from the time."
            }
            error={startError}
          >
            <Input
              type="datetime-local"
              value={draft.start}
              onChange={(e) => set({ start: e.target.value, pinned: null })}
              {...fieldA11y("perpl-start", { hint: true, error: Boolean(startError) })}
            />
          </Field>
          <Field
            id="perpl-end"
            label="Window ends (close)"
            hint={
              build?.endBlock != null ? (
                <>
                  {estimate(build.endBlock)}
                  {build.intervals !== null ? (
                    <span className={s.estimate}>
                      {formatInt(build.intervals)} funding event{build.intervals === 1n ? "" : "s"} in the
                      window.
                    </span>
                  ) : null}
                </>
              ) : spike ? (
                "The last block a counted funding event can sit on."
              ) : (
                "Settlement opens one block after this."
              )
            }
            error={endError}
          >
            <Input
              type="datetime-local"
              value={draft.end}
              onChange={(e) => set({ end: e.target.value, pinned: null })}
              {...fieldA11y("perpl-end", { hint: true, error: Boolean(endError) })}
            />
          </Field>
        </div>

        {pinned ? (
          <p className={s.small}>
            The link's exact blocks: {formatInt(pinned.startBlock)} to {formatInt(pinned.endBlock)}. The times
            above are estimates of them. Editing a time works the blocks out again from the clock.
          </p>
        ) : null}

        <label className={s.check}>
          <input
            type="checkbox"
            checked={draft.snap}
            onChange={(e) => set({ snap: e.target.checked, pinned: null })}
          />
          <span className={s.checkText}>
            <span>Snap the window to Perpl's funding grid</span>
            <span className={s.small}>
              Perpl charges funding once every {formatInt(interval)} blocks. Snapping starts the window at the
              next funding event and ends it on one, so it holds a whole number of events.
            </span>
          </span>
        </label>

        <div>
          <Field
            id="perpl-threshold"
            label={
              spike
                ? `Threshold: what one funding event charges longs, in USD per ${symbol}`
                : `Threshold: funding paid by longs, in USD per ${symbol}`
            }
            hint={
              build?.threshold != null ? (
                <>
                  {build.threshold.toString()} in Perpl's raw units
                  {pct !== null ? `, about ${formatPercent(pct)} of ${symbol}'s price` : ""}.{" "}
                  {spike
                    ? "YES if any single funding event in the window charges longs more than this; exactly equal is not a spike."
                    : "YES if longs pay more than this in total over the window; exactly equal is NO."}
                </>
              ) : spike ? (
                "YES if any single funding event in the window charges longs more than this."
              ) : (
                "YES if longs pay more than this in total over the window. 0 means longs pay shorts on net."
              )
            }
            error={thresholdError}
          >
            <Input
              mono
              inputMode="decimal"
              autoComplete="off"
              unit={`USD per ${symbol}`}
              value={draft.threshold}
              onChange={(e) => {
                setThresholdTouched(true);
                set({ threshold: e.target.value });
              }}
              {...fieldA11y("perpl-threshold", { hint: true, error: Boolean(thresholdError) })}
            />
          </Field>
          <div className={s.quick} style={{ marginTop: 8 }}>
            {spike ? null : (
              <Button
                size="sm"
                onClick={() => {
                  setThresholdTouched(true);
                  set({ threshold: "0" });
                }}
              >
                Use 0: longs pay on net
              </Button>
            )}
            {suggestion !== null ? (
              <Button
                size="sm"
                onClick={() => {
                  setThresholdTouched(false);
                  set({ threshold: toInputString(suggestion, decimals) });
                }}
              >
                Use the recent middle: {formatFundingUsd(suggestion, decimals)}
              </Button>
            ) : null}
          </div>
          {isLopsided(hits) ? (
            <div style={{ marginTop: 12 }}>
              <Notice tone="warn" title="Close to certain">
                <p>
                  Past windows of this length went YES in {hits?.hits} of {hits?.total} cases. A market with
                  an answer this predictable draws few stakers on the other side.
                </p>
              </Notice>
            </div>
          ) : null}
        </div>
      </div>
    </Panel>
  );
}

function FundingContext(props: {
  loading: boolean;
  failed: boolean;
  onRetry: () => void;
  rule: FundingRule;
  name: string;
  symbol: string;
  decimals: number;
  deltas: bigint[];
  markPrice: string | null;
  intervals: number | null;
  hits: { hits: number; total: number } | null;
  head: bigint | null;
  msPerBlock: number | null;
  measured: boolean;
}) {
  if (props.failed) {
    return (
      <Notice tone="danger" title="Could not read Perpl" role="alert">
        <p>The RPC did not answer for Perpl's funding history. Nothing was sent.</p>
        <div style={{ marginTop: 8 }}>
          <Button size="sm" onClick={props.onRetry}>
            Try again
          </Button>
        </div>
      </Notice>
    );
  }
  if (props.loading) {
    return (
      <div className={s.context} role="status">
        <span className="visually-hidden">Reading Perpl's funding history</span>
        <Skeleton width="40%" height={16} />
        <Skeleton width="100%" height={22} />
        <Skeleton width="70%" height={14} />
      </div>
    );
  }
  const recent = props.deltas.slice(-RECENT_SHOWN);
  const mean = meanDelta(props.deltas);
  const largest = props.deltas.length > 0 ? props.deltas.reduce((a, b) => (b > a ? b : a)) : null;
  return (
    <section className={s.context} aria-labelledby="funding-context-title">
      <span className={s.contextTitle} id="funding-context-title">
        Recent funding on {props.name}
      </span>
      {recent.length > 0 ? (
        <>
          <span className={s.small}>
            Paid by longs at each of the last {recent.length} funding events, oldest first:
          </span>
          <ul className={s.deltas}>
            {recent.map((d, i) => (
              <li
                // biome-ignore lint/suspicious/noArrayIndexKey: a fixed window of past events, never reordered
                key={i}
                className={`${s.delta} ${d > 0n ? s.deltaUp : d < 0n ? s.deltaDown : ""}`}
              >
                {d > 0n ? "+" : ""}
                {formatFundingUsd(d, props.decimals)}
              </li>
            ))}
          </ul>
          {mean !== null ? (
            <span>
              Average per event over the last {props.deltas.length}:{" "}
              <span className={s.mono}>{formatFundingUsd(mean, props.decimals)}</span> per {props.symbol}
              {props.rule === "spike" && largest !== null ? (
                <>
                  ; largest single event:{" "}
                  <span className={s.mono}>{formatFundingUsd(largest, props.decimals)}</span>
                </>
              ) : null}
              {props.markPrice ? (
                <>
                  , with {props.symbol} at <span className={s.mono}>{props.markPrice}</span>
                </>
              ) : null}
              .
            </span>
          ) : null}
          {props.hits && props.intervals !== null ? (
            <span>
              Over the last {props.deltas.length} events, a window of {props.intervals}{" "}
              {props.rule === "spike" ? "had a single event above" : "paid more than"} your threshold in{" "}
              <strong>{props.hits.hits}</strong> of {props.hits.total} cases. Near half makes a market people
              want to take both sides of.
            </span>
          ) : props.intervals !== null && props.intervals > props.deltas.length ? (
            <span>
              This window is longer than the history read here, so there is no past rate to compare.
            </span>
          ) : null}
        </>
      ) : (
        <span>No funding events yet on this perp.</span>
      )}
      <span className={s.small}>
        Read live from Perpl's getFundingSumAtBlock at each funding event.
        {props.head !== null ? ` Chain head: block ${formatInt(props.head)}.` : ""}
        {props.msPerBlock !== null
          ? props.measured
            ? ` Measured pace: ${Math.round(props.msPerBlock)} ms per block over the last 10,000 blocks.`
            : ` Pace not measured yet: using ${Math.round(props.msPerBlock)} ms per block.`
          : ""}
      </span>
    </section>
  );
}

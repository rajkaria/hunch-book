"use client";

import { useState } from "react";
import { appDeployment } from "@/lib/config";
import { formatChance, formatInt, formatUtc } from "@/lib/format";
import { useFundingHistory, usePerpMeta } from "@/lib/hedge/hooks";
import {
  averageStep,
  createPrefillUrl,
  formatUsdNumber,
  fundingSteps,
  intervalsIn,
  type PerpMeta,
  type PerpPosition,
  type Proposal,
  priceUsd,
  projectFunding,
  proposeHedges,
  ratePercent,
  sizeUnits,
  suggestNewMarket,
  type ThresholdChoice,
  thresholdText,
  usdPerUnit,
} from "@/lib/hedge/math";
import { estimateBlockTime } from "@/lib/market/logic";
import { perpName } from "@/lib/market/params";
import type { ChainClock, MarketView } from "@/lib/market/types";
import { marketHeadline } from "../markets/MarketCard";
import { ErrorState, LoadingRows } from "../states";
import { Badge, Button, ButtonLink, Card, Notice, Panel, PhasePill, SegmentedControl, Stat } from "../ui";
import { FundingChart } from "./FundingChart";
import s from "./hedge.module.css";

export type Horizon = "day" | "week";
export type RateBasis = "current" | "average";

export const HORIZON_SECONDS: Record<Horizon, number> = { day: 86_400, week: 7 * 86_400 };
const HORIZON_WORDS: Record<Horizon, string> = { day: "the next 24 hours", week: "the next 7 days" };

/** What "Track this hedge" records. */
export interface TrackRequest {
  proposal: Proposal;
  position: PerpPosition;
  meta: PerpMeta;
  units: number;
  startBlock: bigint;
  startSum: bigint;
}

const fmtUnits = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 6 });
const fmtCount = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 1 });
const fmtPct = (n: number | null) =>
  n === null ? "n/a" : `${n.toLocaleString("en-US", { maximumSignificantDigits: 3 })}%`;
const usdc = (n: number) => `${formatUsdNumber(n).replace("$", "")} USDC`;

function PaidWords({ usd }: { usd: number }) {
  return usd >= 0 ? <>pays {formatUsdNumber(usd)}</> : <>receives {formatUsdNumber(-usd)}</>;
}

function ProposalCard({
  p,
  meta,
  clock,
  onTrack,
  tracked,
}: {
  p: Proposal;
  meta: PerpMeta;
  clock: ChainClock | null;
  onTrack: () => void;
  tracked: boolean;
}) {
  const m: MarketView = p.fm.market;
  const side = p.buy.toUpperCase();
  const ends = clock ? estimateBlockTime(p.fm.endBlock, clock) : null;
  const sizing = p.sizing;
  return (
    <Card as="article" className={s.proposal}>
      <div className={s.proposalHead}>
        <p className={s.proposalQuestion}>{marketHeadline(m)}</p>
        <PhasePill phase={m.phase} outcome={m.outcome} />
      </div>
      <p className="muted" style={{ fontSize: 14 }}>
        {p.pays} At the rate used above, the window projects {formatUsdNumber(p.projectedUsdPerUnit)} per{" "}
        {meta.symbol} over its {fmtCount(p.intervals)} remaining funding events
        {ends ? `, ending about ${formatUtc(ends)}` : ""}.
      </p>
      <div className={s.figures}>
        <Stat size="sm" label="To cover" value={formatUsdNumber(p.target)} hint="projected funding cost" />
        <Stat
          size="sm"
          label={`Chance ${side} wins`}
          value={p.chance === null ? "n/a" : formatChance(Math.round(p.chance * 10_000))}
          hint={m.graduated ? "book price" : "pool split"}
        />
        {sizing.ok ? (
          <>
            <Stat
              size="sm"
              label={sizing.mode === "pool" ? `Stake on ${side}` : `Buy ${side}`}
              value={
                sizing.mode === "pool"
                  ? usdc(sizing.cost)
                  : `${fmtUnits(Math.ceil((sizing.tokens ?? 0) * 100) / 100)} tokens`
              }
              hint={
                sizing.mode === "pool"
                  ? "at the pool as it is now"
                  : `at ${formatUsdNumber(sizing.price ?? 0)} each`
              }
            />
            <Stat
              size="sm"
              label={`If ${side} wins`}
              value={usdc(sizing.payoutIfWin)}
              hint={`${formatUsdNumber(sizing.netIfWin)} more than it cost`}
            />
          </>
        ) : null}
      </div>
      {sizing.ok ? (
        <div className={s.math}>
          {sizing.mode === "pool" ? (
            <span className={s.mathLine}>
              stake s solves (1 − 0.02) × s × other side / ({side} side + s) = {formatUsdNumber(p.target)}
            </span>
          ) : (
            <span className={s.mathLine}>
              tokens = {formatUsdNumber(p.target)} ÷ (1 − fee − price) = {formatUsdNumber(p.target)} ÷ (1 −{" "}
              {(sizing.fee ?? 0).toFixed(4)} − {(sizing.price ?? 0).toFixed(4)})
            </span>
          )}
          <span className={s.mathResult}>
            {sizing.covered >= 0.999
              ? `If ${side} wins, the hedge pays back its cost plus ${formatUsdNumber(sizing.netIfWin)}: the projected funding.`
              : `This covers ${Math.floor(sizing.covered * 100)}% of the projected funding: ${
                  sizing.limitedBy === "cap"
                    ? "the pool or wallet cap stops a larger stake."
                    : "the other side of the pool is too small to pay more."
                }`}{" "}
            If {side === "YES" ? "NO" : "YES"} wins, the hedge loses its {usdc(sizing.cost)}.
          </span>
        </div>
      ) : (
        <p className={s.error}>{sizing.reason}</p>
      )}
      <div className={s.actions}>
        <ButtonLink href={`/m/${m.address}`} variant="primary" size="sm" arrow>
          {sizing.ok && sizing.mode === "book"
            ? `Buy ${side} on the market page`
            : `Stake ${side} on the market page`}
        </ButtonLink>
        {sizing.ok ? (
          <Button size="sm" onClick={onTrack} disabled={tracked}>
            {tracked ? "Tracking" : "Track this hedge"}
          </Button>
        ) : null}
      </div>
    </Card>
  );
}

function NewMarket({
  position,
  meta,
  rawPerInterval,
  head,
  lastEvent,
  interval,
  horizonIntervals,
  clock,
}: {
  position: PerpPosition;
  meta: PerpMeta;
  rawPerInterval: number;
  head: bigint;
  lastEvent: bigint;
  interval: bigint;
  horizonIntervals: number;
  clock: ChainClock | null;
}) {
  const [choice, setChoice] = useState<ThresholdChoice>(position.side === "long" ? "half" : "zero");
  const msPerBlock = clock?.msPerBlock ?? 400;
  const suggestion = suggestNewMarket({
    side: position.side,
    rawPerInterval,
    head,
    lastEvent,
    interval,
    intervals: horizonIntervals,
    leadBlocks: BigInt(Math.ceil((30 * 60 * 1000) / msPerBlock)),
    choice,
  });
  const threshold = usdPerUnit(suggestion.thresholdRaw, meta);
  const side = suggestion.buy.toUpperCase();
  const rule =
    suggestion.thresholdRaw === 0n
      ? `Will ${meta.symbol} longs pay shorts on net between block ${formatInt(suggestion.startBlock)} and block ${formatInt(suggestion.endBlock)}?`
      : `Will ${meta.symbol} longs pay more than ${formatUsdNumber(threshold)} per ${meta.symbol} between block ${formatInt(suggestion.startBlock)} and block ${formatInt(suggestion.endBlock)}?`;
  // The create form takes clock times and snaps them back to Perpl's grid with its own block pace.
  const at = (block: bigint) =>
    clock ? estimateBlockTime(block, clock) : Date.now() / 1000 + (Number(block - head) * msPerBlock) / 1000;
  const asset = perpName(appDeployment, meta.perpId);
  const href = asset
    ? createPrefillUrl({
        asset,
        startUnix: at(suggestion.startBlock),
        endUnix: at(suggestion.endBlock),
        threshold: thresholdText(suggestion.thresholdRaw, meta),
        side: suggestion.buy,
      })
    : "/create?template=1";
  return (
    <Notice tone="accent" title={`No open market covers ${meta.symbol} funding for this position`}>
      <div className={s.controls}>
        <p className="muted" style={{ fontSize: 14 }}>
          Start one. Its window begins on Perpl's funding grid in about half an hour and runs{" "}
          {fmtCount(suggestion.intervals)} funding events. You would hold {side}.
        </p>
        <div className={s.choice}>
          <span className={s.choiceLabel}>{side} pays when</span>
          <SegmentedControl<ThresholdChoice>
            label="Threshold for the new market"
            size="sm"
            value={choice}
            onChange={setChoice}
            options={
              position.side === "long"
                ? [
                    { value: "zero", label: "longs pay at all" },
                    { value: "half", label: "half today's rate" },
                    { value: "full", label: "today's rate" },
                  ]
                : [
                    { value: "zero", label: "shorts pay at all" },
                    { value: "half", label: "half today's rate" },
                    { value: "full", label: "today's rate" },
                  ]
            }
          />
        </div>
        <p style={{ fontSize: 14 }}>
          <strong>{rule}</strong> You would hold {side}.
        </p>
        <div className={s.actions}>
          <ButtonLink href={href} variant="primary" size="sm" arrow>
            Create this market
          </ButtonLink>
        </div>
        <p className={s.note}>
          The create page opens with these values filled in. Check them there before you sign.
        </p>
      </div>
    </Notice>
  );
}

export function PositionHedge({
  position,
  metaHint,
  horizon,
  basis,
  markets,
  clock,
  onTrack,
  trackedMarkets,
  onRemove,
}: {
  position: PerpPosition;
  metaHint?: PerpMeta;
  horizon: Horizon;
  basis: RateBasis;
  markets: MarketView[] | undefined;
  clock: ChainClock | null;
  onTrack: (request: TrackRequest) => void;
  trackedMarkets: ReadonlySet<string>;
  onRemove?: () => void;
}) {
  const metaQuery = usePerpMeta(position.perpId);
  const history = useFundingHistory(position.perpId);
  const meta = metaQuery.data ?? metaHint;

  if (!meta || history.isPending) {
    if (metaQuery.isError || history.isError) {
      return (
        <ErrorState
          title="Could not read this perp's funding from Perpl"
          onRetry={() => {
            void metaQuery.refetch();
            void history.refetch();
          }}
        />
      );
    }
    return <LoadingRows rows={2} label="Reading funding from Perpl" />;
  }
  if (!history.data) {
    return (
      <ErrorState
        title="Could not read this perp's funding from Perpl"
        onRetry={() => void history.refetch()}
      />
    );
  }

  const h = history.data;
  const steps = fundingSteps(h.samples);
  const units = sizeUnits(position.lots, meta);
  const msPerBlock = clock?.msPerBlock ?? 400;
  const intervalBlocks = Number(h.interval);
  const perDay = intervalsIn(86_400, msPerBlock, intervalBlocks);
  const current = steps.at(-1)?.raw ?? null;
  const average = averageStep(steps, Math.max(1, Math.round(perDay)));
  const raw = basis === "current" ? (current === null ? null : Number(current)) : average;
  const horizonIntervals = intervalsIn(HORIZON_SECONDS[horizon], msPerBlock, intervalBlocks);
  const sideWord = position.side === "long" ? "long" : "short";
  const premium = position.premiumPnlCNS === null ? null : Number(position.premiumPnlCNS) / 1e6;

  const projection =
    raw === null
      ? null
      : projectFunding({
          rawPerInterval: raw,
          intervals: horizonIntervals,
          units,
          side: position.side,
          meta,
        });
  const hedges =
    raw === null || !markets
      ? null
      : proposeHedges({
          side: position.side,
          units,
          meta,
          rawPerInterval: raw,
          markets,
          head: h.head,
          lastEvent: h.lastEvent,
          interval: h.interval,
        });

  return (
    <Panel
      title={
        <span className={s.positionTitle}>
          {meta.symbol} {sideWord}, {fmtUnits(units)} {meta.symbol}
        </span>
      }
      aside={
        <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
          <Badge tone={position.source === "chain" ? "accent" : "neutral"} dot>
            {position.source === "chain" ? "read from Perpl" : "entered by hand"}
          </Badge>
          {onRemove ? (
            <Button size="sm" variant="ghost" onClick={onRemove}>
              Remove
            </Button>
          ) : null}
        </span>
      }
    >
      <div className={s.figures}>
        <Stat
          size="sm"
          label="Entry price"
          value={
            position.entryPricePNS === null ? "n/a" : formatUsdNumber(priceUsd(position.entryPricePNS, meta))
          }
        />
        <Stat size="sm" label="Mark price" value={formatUsdNumber(priceUsd(meta.markPNS, meta))} />
        <Stat
          size="sm"
          label="Funding since entry"
          value={
            premium === null
              ? "n/a"
              : premium <= 0
                ? `paid ${formatUsdNumber(-premium)}`
                : `got ${formatUsdNumber(premium)}`
          }
          hint={premium === null ? "not known for a position typed in" : "Perpl's premium PnL"}
        />
        <Stat
          size="sm"
          label="Funding now"
          value={current === null ? "n/a" : `${formatUsdNumber(usdPerUnit(current, meta))}`}
          hint={
            current === null
              ? "no funding events yet"
              : `per ${meta.symbol} per interval, ${fmtPct(ratePercent(Number(current), meta))} of the mark`
          }
        />
      </div>

      <FundingChart steps={steps} meta={meta} />

      {projection && raw !== null ? (
        <div className={s.math}>
          <span className={s.mathLine}>
            funding events in {HORIZON_WORDS[horizon]} = {formatInt(HORIZON_SECONDS[horizon])} s ÷ (
            {(msPerBlock / 1000).toFixed(3)} s per block × {formatInt(intervalBlocks)} blocks) ={" "}
            {fmtCount(horizonIntervals)}
          </span>
          <span className={s.mathLine}>
            rate (
            {basis === "current"
              ? "last interval"
              : `average of the last ${Math.min(steps.length, Math.round(perDay))} intervals`}
            ) = {raw.toLocaleString("en-US", { maximumFractionDigits: 2 })} ÷ 10^({meta.priceDecimals} +{" "}
            {meta.scalingExp}) = {formatUsdNumber(projection.perIntervalUsdPerUnit)} per {meta.symbol} per
            interval
          </span>
          <span className={s.mathLine}>
            {formatUsdNumber(projection.perIntervalUsdPerUnit)} × {fmtCount(horizonIntervals)} ×{" "}
            {fmtUnits(units)} {meta.symbol} = {formatUsdNumber(Math.abs(projection.positionUsd))}
          </span>
          <span className={s.mathResult}>
            If the rate holds, this {sideWord} <PaidWords usd={projection.positionUsd} /> in funding over{" "}
            {HORIZON_WORDS[horizon]}.
          </span>
        </div>
      ) : (
        <p className={s.note}>This perp has no funding history yet, so there is nothing to project.</p>
      )}

      {hedges && projection ? (
        <div className={s.proposals}>
          <h3 className={s.proposalsTitle}>Hedges on Hunch Book</h3>
          {projection.positionUsd <= 0 ? (
            <p className="muted" style={{ fontSize: 14 }}>
              At this rate the position is paid funding, so there is no funding cost to hedge.
            </p>
          ) : hedges.proposals.length > 0 ? (
            hedges.proposals.map((p) => (
              <ProposalCard
                key={p.fm.market.address}
                p={p}
                meta={meta}
                clock={clock}
                tracked={trackedMarkets.has(`${position.perpId}:${p.fm.market.address.toLowerCase()}`)}
                onTrack={() =>
                  onTrack({
                    proposal: p,
                    position,
                    meta,
                    units,
                    startBlock: h.lastEvent,
                    startSum: h.lastSum,
                  })
                }
              />
            ))
          ) : (
            <NewMarket
              position={position}
              meta={meta}
              rawPerInterval={raw ?? 0}
              head={h.head}
              lastEvent={h.lastEvent}
              interval={h.interval}
              horizonIntervals={horizonIntervals}
              clock={clock}
            />
          )}
          {hedges.skipped.length > 0 ? (
            <ul className={s.skipped}>
              {hedges.skipped.map((k) => (
                <li key={k.fm.market.address}>
                  {marketHeadline(k.fm.market)}: {k.why}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </Panel>
  );
}

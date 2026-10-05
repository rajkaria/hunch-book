"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  assumptionText,
  type CustomUnit,
  estimateFundingCost,
  type FundingCost,
  formatRateUsd,
  type HorizonChoice,
  horizonSeconds,
  horizonWords,
  parseAmount,
  perpsOf,
  type RateBasis,
  type SizeMode,
  sizeText,
  unitsFromSize,
} from "@/lib/calculator/math";
import { type CalculatorInputs, calculatorUrl } from "@/lib/calculator/query";
import { appDeployment, appNetworkLabel, isDeployed } from "@/lib/config";
import { formatChance, formatInt, formatUtc } from "@/lib/format";
import { useFundingHistory, usePerpMeta } from "@/lib/hedge/hooks";
import {
  type FundingStep,
  formatUsdNumber,
  fundingSteps,
  type PerpMeta,
  type PositionSide,
  type Proposal,
  priceUsd,
  proposeHedges,
} from "@/lib/hedge/math";
import { hedgeUrl } from "@/lib/hedge/prefill";
import { useChainClock, useMarkets } from "@/lib/hooks";
import { estimateBlockTime } from "@/lib/market/logic";
import type { ChainClock } from "@/lib/market/types";
import { FundingChart } from "../hedge/FundingChart";
import { marketHeadline } from "../markets/MarketCard";
import ps from "../page.module.css";
import { ErrorState, LoadingRows } from "../states";
import {
  ButtonLink,
  Card,
  Field,
  fieldA11y,
  Input,
  Notice,
  Panel,
  PhasePill,
  SegmentedControl,
  Stat,
} from "../ui";
import s from "./calculator.module.css";

const fmtUnits = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 6 });
const fmtCount = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 1 });
const fmtPct = (n: number | null) =>
  n === null ? "n/a" : `${n.toLocaleString("en-US", { maximumSignificantDigits: 3 })}%`;
const usdc = (n: number) => `${formatUsdNumber(n).replace("$", "")} USDC`;

/**
 * When the hedge side pays, in words. The threshold keeps its significant digits: on a low-priced perp
 * it can be a millionth of a dollar per unit.
 */
function paysText(p: Proposal, symbol: string): string {
  const x = `${formatRateUsd(p.thresholdUsdPerUnit)} per ${symbol}`;
  if (p.fm.kind === "spike")
    return `YES pays if any single funding event charges ${symbol} longs more than ${x}.`;
  return p.buy === "yes"
    ? `YES pays if ${symbol} longs pay more than ${x} over the window.`
    : `NO pays if ${symbol} longs pay no more than ${x} over the window.`;
}

/** One open market that would hedge the position, sized by the hedge assistant's math. */
function HedgeOption({ p, symbol, clock }: { p: Proposal; symbol: string; clock: ChainClock | null }) {
  const m = p.fm.market;
  const side = p.buy.toUpperCase();
  const sizing = p.sizing;
  const ends = clock ? estimateBlockTime(p.fm.endBlock, clock) : null;
  return (
    <Card as="article" className={s.option}>
      <div className={s.optionHead}>
        <p className={s.optionQuestion}>{marketHeadline(m, clock)}</p>
        <PhasePill phase={m.phase} outcome={m.outcome} />
      </div>
      <p className={s.note}>
        {paysText(p, symbol)}
        {ends ? ` Its window ends about ${formatUtc(ends)}.` : ""}
      </p>
      <div className={s.optionFigures}>
        <Stat
          size="sm"
          label="To cover"
          value={formatUsdNumber(p.target)}
          hint={`funding over its ${fmtCount(p.intervals)} events left`}
        />
        <Stat
          size="sm"
          label={`Chance ${side} wins`}
          value={p.chance === null ? "n/a" : formatChance(Math.round(p.chance * 10_000))}
          hint={m.graduated ? "book price" : "pool split"}
        />
        {sizing.ok ? (
          <Stat
            size="sm"
            label={sizing.mode === "pool" ? `Stake on ${side}` : `Buy ${side}`}
            value={
              sizing.mode === "pool"
                ? usdc(sizing.cost)
                : `${fmtUnits(Math.ceil((sizing.tokens ?? 0) * 100) / 100)} tokens`
            }
            hint={
              sizing.covered >= 0.999
                ? `pays ${usdc(sizing.payoutIfWin)} if ${side} wins`
                : `covers ${Math.floor(sizing.covered * 100)}% of the funding`
            }
          />
        ) : null}
      </div>
      {sizing.ok ? null : <p className={s.error}>{sizing.reason}</p>}
      <div className={s.actions}>
        <ButtonLink href={`/m/${m.address}`} variant="primary" size="sm" arrow>
          Open the market
        </ButtonLink>
      </div>
    </Card>
  );
}

function CostResult({
  cost,
  meta,
  side,
  basis,
  seconds,
  steps,
  intervalBlocks,
  msPerBlock,
}: {
  cost: FundingCost;
  meta: PerpMeta;
  side: PositionSide;
  basis: RateBasis;
  seconds: number;
  steps: readonly FundingStep[];
  intervalBlocks: number;
  msPerBlock: number;
}) {
  const words = horizonWords(seconds);
  const p = cost.projection;
  const rateText = `${formatRateUsd(p.perIntervalUsdPerUnit)} per ${meta.symbol}`;
  const pays = cost.costUsd > 0;
  const receives = cost.costUsd < 0;
  return (
    <div className={s.result}>
      <div className={s.headline}>
        <Stat
          size="lg"
          label={pays ? `This ${side} pays` : receives ? `This ${side} receives` : "Funding"}
          value={formatUsdNumber(Math.abs(cost.costUsd))}
          tone={receives ? "accent" : undefined}
          hint={`in funding over ${words}, if the rate holds`}
        />
        <Stat
          size="sm"
          label="Share of the notional"
          value={fmtPct(cost.costPercent)}
          hint={`of ${formatUsdNumber(cost.notionalUsd)}`}
        />
      </div>
      <div className={s.figures}>
        <Stat
          size="sm"
          label="Size"
          value={`${fmtUnits(cost.units)} ${meta.symbol}`}
          hint={`at the mark, ${formatUsdNumber(cost.markUsd)}`}
        />
        <Stat
          size="sm"
          label="Funding events"
          value={fmtCount(cost.intervals)}
          hint={`one every ${formatInt(intervalBlocks)} blocks, about ${Math.round(cost.intervalMinutes)} minutes`}
        />
        <Stat
          size="sm"
          label="Rate per event"
          value={formatRateUsd(p.perIntervalUsdPerUnit)}
          hint={`per ${meta.symbol}, ${fmtPct(cost.ratePercentPerInterval)} of the mark`}
        />
        <Stat
          size="sm"
          label="Who pays"
          value={p.perIntervalUsdPerUnit > 0 ? "Longs" : p.perIntervalUsdPerUnit < 0 ? "Shorts" : "Nobody"}
          hint={
            p.perIntervalUsdPerUnit > 0
              ? "to shorts, at this rate"
              : p.perIntervalUsdPerUnit < 0
                ? "to longs, at this rate"
                : "the rate is zero"
          }
        />
      </div>
      <p className={s.assumption}>
        {assumptionText({ basis, rateIntervals: cost.rateIntervals, rateText, horizon: words })}
      </p>
      <div className={s.math}>
        <span className={s.mathLine}>
          funding events in {words} = {formatInt(Math.round(seconds))} s ÷ ({(msPerBlock / 1000).toFixed(3)} s
          per block × {formatInt(intervalBlocks)} blocks) = {fmtCount(cost.intervals)}
        </span>
        <span className={s.mathLine}>
          rate = {p.rawPerInterval.toLocaleString("en-US", { maximumFractionDigits: 2 })} ÷ 10^(
          {meta.priceDecimals} + {meta.scalingExp}) = {rateText} per event
        </span>
        <span className={s.mathLine}>
          {side === "long" ? "+1 (long)" : "−1 (short)"} × {formatRateUsd(p.perIntervalUsdPerUnit)} ×{" "}
          {fmtCount(cost.intervals)} × {fmtUnits(cost.units)} {meta.symbol} = {formatUsdNumber(cost.costUsd)}
          {pays ? ", paid" : receives ? ", received" : ""}
        </span>
      </div>
      <FundingChart steps={steps} meta={meta} />
    </div>
  );
}

export function CalculatorView({ initial = {} }: { initial?: CalculatorInputs }) {
  const base = useId();
  const perps = perpsOf(appDeployment);
  const [asset, setAsset] = useState(
    () => perps.find((p) => p.symbol === initial.asset)?.symbol ?? perps[0]?.symbol ?? "",
  );
  const [side, setSide] = useState<PositionSide>(initial.side ?? "long");
  const [size, setSize] = useState(initial.size ?? "10000");
  const [unit, setUnit] = useState<SizeMode>(initial.unit ?? (initial.size ? "units" : "usd"));
  const [horizon, setHorizon] = useState<HorizonChoice>(initial.horizon ?? "week");
  const [custom, setCustom] = useState(initial.custom ?? "3");
  const [customUnit, setCustomUnit] = useState<CustomUnit>(initial.customUnit ?? "days");
  const [basis, setBasis] = useState<RateBasis>(initial.basis ?? "current");

  // Once the person changes anything, the address follows, so the result can be shared.
  const touched = useRef(false);
  const edit =
    <T,>(set: (value: T) => void) =>
    (value: T) => {
      touched.current = true;
      set(value);
    };
  useEffect(() => {
    if (!touched.current || !asset) return;
    const url = calculatorUrl({ asset, side, size, unit, horizon, custom, customUnit, basis });
    if (`${window.location.pathname}${window.location.search}` !== url)
      window.history.replaceState(null, "", url);
  }, [asset, side, size, unit, horizon, custom, customUnit, basis]);

  const perp = perps.find((p) => p.symbol === asset);
  const meta = usePerpMeta(perp?.id);
  const history = useFundingHistory(perp?.id);
  const markets = useMarkets();
  const clock = useChainClock();
  const msPerBlock = clock?.msPerBlock ?? 400;

  const m = meta.data;
  const h = history.data;
  const steps = useMemo(() => (h ? fundingSteps(h.samples) : []), [h]);
  const amount = parseAmount(size);
  const seconds = horizonSeconds(horizon, custom, customUnit);
  const markUsd = m ? priceUsd(m.markPNS, m) : 0;
  const units = amount === null || !m ? null : unitsFromSize(amount, unit, markUsd);
  const intervalBlocks = h ? Number(h.interval) : 0;
  const cost =
    m && h && units !== null && seconds !== null
      ? estimateFundingCost({ meta: m, steps, basis, side, units, seconds, msPerBlock, intervalBlocks })
      : null;

  const marketList = markets.data?.status === "ok" ? markets.data.data.markets : undefined;
  const hedges =
    cost && m && h && marketList
      ? proposeHedges({
          side,
          units: cost.units,
          meta: m,
          rawPerInterval: cost.projection.rawPerInterval,
          markets: marketList,
          head: h.head,
          lastEvent: h.lastEvent,
          interval: h.interval,
        })
      : null;
  const unitsText = m && units !== null ? sizeText(units, m.lotDecimals) : null;
  const hedgeHref = unitsText && Number(unitsText) > 0 ? hedgeUrl({ asset, side, size: unitsText }) : null;

  const sizeError = size.trim() !== "" && amount === null ? "Enter a size above zero." : null;
  const horizonError =
    horizon === "custom" && seconds === null ? "Enter a number of hours or days, up to 365 days." : null;
  const symbol = m?.symbol ?? asset;
  const words = seconds !== null ? horizonWords(seconds) : null;

  return (
    <div className={ps.stack}>
      <Panel title="The position" labelledBy="calculator-input-title">
        <div className={s.form}>
          <div className={s.choice}>
            <label className={s.choiceLabel} htmlFor={`${base}-perp`}>
              Perp on Perpl
            </label>
            <select
              id={`${base}-perp`}
              className={s.select}
              value={asset}
              onChange={(e) => edit(setAsset)(e.target.value)}
            >
              {perps.map((p) => (
                <option key={p.symbol} value={p.symbol}>
                  {p.symbol} (perp {p.id.toString()})
                </option>
              ))}
            </select>
          </div>
          <div className={s.choice}>
            <span className={s.choiceLabel}>Side</span>
            <SegmentedControl<PositionSide>
              label="Position side"
              value={side}
              onChange={edit(setSide)}
              options={[
                { value: "long", label: "Long" },
                { value: "short", label: "Short" },
              ]}
            />
          </div>
          <div className={s.row}>
            <div className={s.grow}>
              <Field
                id={`${base}-size`}
                label="Size"
                hint={
                  unit === "usd"
                    ? m && units !== null
                      ? `${fmtUnits(units)} ${symbol} at the mark price`
                      : "Notional in USD, turned into units at Perpl's mark price"
                    : m && units !== null
                      ? `${formatUsdNumber(units * markUsd)} at the mark price`
                      : `Units of ${symbol}`
                }
                error={sizeError ?? undefined}
              >
                <Input
                  {...fieldA11y(`${base}-size`, { hint: true, error: Boolean(sizeError) })}
                  inputMode="decimal"
                  autoComplete="off"
                  value={size}
                  onChange={(e) => edit(setSize)(e.target.value)}
                  unit={unit === "usd" ? "USD" : symbol}
                  mono
                />
              </Field>
            </div>
            <SegmentedControl<SizeMode>
              label="Size in"
              size="sm"
              value={unit}
              onChange={edit(setUnit)}
              options={[
                { value: "usd", label: "USD" },
                { value: "units", label: symbol || "Units" },
              ]}
            />
          </div>
          <div className={s.choice}>
            <span className={s.choiceLabel}>Over</span>
            <SegmentedControl<HorizonChoice>
              label="Horizon"
              value={horizon}
              onChange={edit(setHorizon)}
              options={[
                { value: "day", label: "24 hours" },
                { value: "week", label: "7 days" },
                { value: "custom", label: "Custom" },
              ]}
            />
            {horizon === "custom" ? (
              <div className={s.row}>
                <div className={s.grow}>
                  <Field id={`${base}-custom`} label="Custom horizon" error={horizonError ?? undefined}>
                    <Input
                      {...fieldA11y(`${base}-custom`, { error: Boolean(horizonError) })}
                      inputMode="decimal"
                      autoComplete="off"
                      value={custom}
                      onChange={(e) => edit(setCustom)(e.target.value)}
                      unit={customUnit}
                      mono
                    />
                  </Field>
                </div>
                <SegmentedControl<CustomUnit>
                  label="Custom horizon unit"
                  size="sm"
                  value={customUnit}
                  onChange={edit(setCustomUnit)}
                  options={[
                    { value: "hours", label: "Hours" },
                    { value: "days", label: "Days" },
                  ]}
                />
              </div>
            ) : null}
          </div>
          <div className={s.choice}>
            <span className={s.choiceLabel}>At the rate of</span>
            <SegmentedControl<RateBasis>
              label="Funding rate used"
              value={basis}
              onChange={edit(setBasis)}
              options={[
                { value: "current", label: "the last interval" },
                { value: "average", label: "the last 24 hours" },
              ]}
            />
          </div>
        </div>
      </Panel>

      <Panel title={words ? `Funding over ${words}` : "Funding"} labelledBy="calculator-result-title">
        {!perp ? (
          <p className={s.note}>The deployments file lists no Perpl perps on {appNetworkLabel}.</p>
        ) : meta.isError || history.isError ? (
          <ErrorState
            title="Could not read this perp's funding from Perpl"
            onRetry={() => {
              void meta.refetch();
              void history.refetch();
            }}
          />
        ) : !m || !h ? (
          <LoadingRows rows={3} label="Reading funding from Perpl" />
        ) : units === null || seconds === null ? (
          <p className={s.note}>Enter a size and a horizon to see what the position would pay.</p>
        ) : cost ? (
          <CostResult
            cost={cost}
            meta={m}
            side={side}
            basis={basis}
            seconds={seconds}
            steps={steps}
            intervalBlocks={intervalBlocks}
            msPerBlock={msPerBlock}
          />
        ) : (
          <p className={s.note}>This perp has no funding history yet, so there is nothing to project.</p>
        )}
      </Panel>

      <Panel title="Hedge it on Hunch Book" labelledBy="calculator-hedge-title">
        <div className={s.options}>
          {!isDeployed(appDeployment) ? (
            <p className={s.note}>
              Hunch Book is not deployed on {appNetworkLabel} yet, so there are no markets to hedge with here.
            </p>
          ) : !cost ? (
            <p className={s.note}>
              The markets that would hedge this position show here once the cost is in.
            </p>
          ) : cost.costUsd <= 0 ? (
            <p className={s.note}>
              At this rate the position receives funding, so there is no funding cost to hedge.
            </p>
          ) : !hedges ? (
            markets.isError ? (
              <p className={s.error}>Could not read Hunch Book's markets right now.</p>
            ) : (
              <LoadingRows rows={2} label="Reading Hunch Book markets" />
            )
          ) : hedges.proposals.length > 0 ? (
            <>
              <p className={s.note}>
                Open markets on {symbol} funding that pay out when this {side} pays, each sized so its win
                covers the funding projected over the rest of its window.
              </p>
              {hedges.proposals.map((p) => (
                <HedgeOption key={p.fm.market.address} p={p} symbol={symbol} clock={clock} />
              ))}
            </>
          ) : (
            <Notice
              tone="accent"
              title={`No open market on ${symbol} funding covers this position right now`}
            >
              <p className={s.note}>
                The hedge assistant can build one: it suggests a window and a threshold, and opens the create
                page with them filled in.
              </p>
            </Notice>
          )}
          {hedges && hedges.skipped.length > 0 && cost && cost.costUsd > 0 ? (
            <ul className={s.skipped}>
              {hedges.skipped.map((k) => (
                <li key={k.fm.market.address}>
                  {marketHeadline(k.fm.market, clock)}: {k.why}
                </li>
              ))}
            </ul>
          ) : null}
          {hedgeHref ? (
            <div className={s.actions}>
              <ButtonLink href={hedgeHref} variant={hedges?.proposals.length ? "default" : "primary"} arrow>
                Open in the hedge assistant
              </ButtonLink>
            </div>
          ) : null}
          <p className={s.note}>
            The hedge assistant sizes each hedge in detail and can track it. This page sends nothing: you
            stake or trade on the market page, with your own wallet.
          </p>
        </div>
      </Panel>
    </div>
  );
}

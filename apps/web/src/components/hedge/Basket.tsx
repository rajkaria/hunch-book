"use client";

import Link from "next/link";
import { useId } from "react";
import type { Address } from "viem";
import { formatInt, formatUtc } from "@/lib/format";
import {
  type Basket,
  type BasketPlan,
  COVER_CHOICES,
  planBasket,
  type ScenarioRow,
  startedWindowStarts,
} from "@/lib/hedge/basket";
import { useFundingSumsAt } from "@/lib/hedge/hooks";
import {
  formatUsdNumber,
  type PerpMeta,
  type PositionSide,
  type Proposal,
  usdPerUnit,
} from "@/lib/hedge/math";
import { estimateBlockTime } from "@/lib/market/logic";
import type { ChainClock } from "@/lib/market/types";
import { marketHeadline } from "../markets/MarketCard";
import { Button, SegmentedControl } from "../ui";
import { fmtCount, fmtCover, fmtTokens, fmtUnits, PaidWords, usdc } from "./fmt";
import s from "./hedge.module.css";

/** The funding read the basket is planned from. */
export interface BasketHistory {
  head: bigint;
  lastEvent: bigint;
  lastSum: bigint;
  interval: bigint;
}

type OkBasket = Extract<Basket, { ok: true }>;

function BasketMath({
  plan,
  basket,
  meta,
  units,
  rawPerInterval,
  clock,
}: {
  plan: BasketPlan;
  basket: OkBasket;
  meta: PerpMeta;
  units: number;
  rawPerInterval: number;
  clock: ChainClock | null;
}) {
  const n = basket.legs.length;
  const ends = clock && plan.to !== null ? estimateBlockTime(plan.to, clock) : null;
  return (
    <div className={s.math}>
      <span className={s.mathLine}>
        funding events inside at least one leg's window = {fmtCount(plan.events)}
        {plan.from !== null && plan.to !== null
          ? `, from block ${formatInt(plan.from)} to block ${formatInt(plan.to)}`
          : ""}
        {ends ? ` (about ${formatUtc(ends)})` : ""}
      </span>
      <span className={s.mathLine}>
        projected funding = {formatUsdNumber(Math.abs(usdPerUnit(rawPerInterval, meta)))} per {meta.symbol}{" "}
        per interval, paid by {rawPerInterval >= 0 ? "longs" : "shorts"}, × {fmtCount(plan.events)} ×{" "}
        {fmtUnits(units)} {meta.symbol} = {formatUsdNumber(basket.cost)}
      </span>
      <span className={s.mathLine}>
        to cover = {fmtCover(basket.cover)} × {formatUsdNumber(basket.cost)} ={" "}
        {formatUsdNumber(basket.target)}
      </span>
      <span className={s.mathLine}>
        each leg's share = {formatUsdNumber(basket.target)} ÷ {n} {n === 1 ? "leg" : "legs"} ={" "}
        {formatUsdNumber(basket.share)}
      </span>
      <span className={s.mathResult}>
        Each leg is sized so that, if it wins, it pays back its cost plus {formatUsdNumber(basket.share)}. If
        every leg wins, the basket pays back its {usdc(basket.totalCost)} plus{" "}
        {formatUsdNumber(basket.netIfAllWin)}
        {basket.covered >= 0.999
          ? ": the funding it covers."
          : `, ${Math.floor(basket.covered * 100)}% of the cover: a pool too small or full limits a leg.`}{" "}
        A leg that loses loses what it cost.
      </span>
    </div>
  );
}

function ScenarioTable({
  rows,
  legs,
  meta,
  accruedPending,
}: {
  rows: ScenarioRow[];
  legs: number;
  meta: PerpMeta;
  accruedPending: boolean;
}) {
  return (
    <div>
      <h4 className={s.subTitle}>If funding changes</h4>
      <div className={s.tableWrap}>
        <table className={s.table}>
          <caption className="visually-hidden">
            What the position pays in funding and what the basket pays out, for four funding rates
          </caption>
          <thead>
            <tr>
              <th scope="col">Funding</th>
              <th scope="col" className={s.num}>
                Per interval
              </th>
              <th scope="col">Position</th>
              <th scope="col" className={s.num}>
                Legs that win
              </th>
              <th scope="col" className={s.num}>
                Basket pays out
              </th>
              <th scope="col" className={s.num}>
                Net with the basket
              </th>
              <th scope="col" className={s.num}>
                Net without
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.scenario.key} data-scenario={row.scenario.key}>
                <th scope="row">{row.scenario.label}</th>
                <td className={s.num}>
                  {formatUsdNumber(usdPerUnit(row.rawPerInterval, meta))} per {meta.symbol}
                </td>
                <td>
                  <PaidWords usd={row.fundingPaid} />
                </td>
                <td className={s.num}>
                  {row.wins.filter(Boolean).length} of {legs}
                </td>
                <td className={s.num}>{usdc(row.payout)}</td>
                <td className={row.net < 0 ? `${s.num} ${s.negative}` : s.num}>{formatUsdNumber(row.net)}</td>
                <td className={row.unhedged < 0 ? `${s.num} ${s.negative}` : s.num}>
                  {formatUsdNumber(row.unhedged)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className={s.note}>
        Each row multiplies the rate above, runs it over every funding event left in each leg's window, and
        checks each leg's rule. Net is what the basket pays out, minus what it cost, minus the funding the
        position pays. Pool legs pay at the pool as it is now; later stakes move them.
        {accruedPending ? " Funding already counted in a window that has started is still being read." : ""}
      </p>
    </div>
  );
}

/**
 * The basket for one position: the chosen markets sized by the even split, the math in words, what each
 * leg costs and pays, and what the whole pays if funding changes. It sends nothing: each leg links to
 * its market page.
 */
export function BasketBuilder({
  chosen,
  side,
  units,
  meta,
  rawPerInterval,
  history,
  cover,
  onCover,
  onRemove,
  onTrack,
  tracked,
  clock,
}: {
  chosen: Proposal[];
  side: PositionSide;
  units: number;
  meta: PerpMeta;
  rawPerInterval: number;
  history: BasketHistory;
  cover: number;
  onCover: (cover: number) => void;
  onRemove: (market: Address) => void;
  onTrack: (plan: BasketPlan) => void;
  tracked: boolean;
  clock: ChainClock | null;
}) {
  const titleId = useId();
  const starts = startedWindowStarts(chosen, history.lastEvent);
  const sums = useFundingSumsAt(meta.perpId, starts);
  const plan = planBasket({
    chosen,
    side,
    units,
    meta,
    rawPerInterval,
    head: history.head,
    lastEvent: history.lastEvent,
    lastSum: history.lastSum,
    interval: history.interval,
    cover,
    sumsAtStart: sums.data,
  });
  const basket = plan.basket;
  const byMarket = new Map(chosen.map((p) => [p.fm.market.address.toLowerCase(), p]));
  const proposalOf = (market: Address) => byMarket.get(market.toLowerCase());
  const accruedPending = plan.candidates.some((c) => c.accruedRaw === null);

  return (
    <section className={s.basket} aria-labelledby={titleId}>
      <div className={s.basketHead}>
        <h3 className={s.proposalsTitle} id={titleId}>
          Your basket
        </h3>
        <div className={s.choice}>
          <span className={s.choiceLabel}>Cover</span>
          <SegmentedControl<string>
            label="Share of the projected funding to cover"
            size="sm"
            value={String(cover)}
            onChange={(v) => onCover(Number(v))}
            options={COVER_CHOICES.map((c) => ({ value: String(c), label: fmtCover(c) }))}
          />
        </div>
      </div>
      <p className="muted" style={{ fontSize: 14 }}>
        One hedge across one or more of the markets above. The basket covers {fmtCover(cover)} of the funding
        this position is projected to pay over the legs' windows, split evenly: each leg is sized so its win
        pays its share.
      </p>

      {chosen.length === 0 ? (
        <p className={s.note}>The basket is empty. Add a market above.</p>
      ) : basket.ok ? (
        <>
          <BasketMath
            plan={plan}
            basket={basket}
            meta={meta}
            units={units}
            rawPerInterval={rawPerInterval}
            clock={clock}
          />
          <div className={s.tableWrap}>
            <table className={s.table}>
              <caption className="visually-hidden">
                The legs of the basket, with what each costs and pays
              </caption>
              <thead>
                <tr>
                  <th scope="col">Leg</th>
                  <th scope="col">Size</th>
                  <th scope="col" className={s.num}>
                    Cost
                  </th>
                  <th scope="col" className={s.num}>
                    Pays if it wins
                  </th>
                  <th scope="col">
                    <span className="visually-hidden">Remove</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {basket.legs.map(({ candidate, sizing }) => {
                  const p = proposalOf(candidate.market);
                  const holds = candidate.buy.toUpperCase();
                  return (
                    <tr key={candidate.market}>
                      <th scope="row" className={s.legCell}>
                        <Link href={`/m/${candidate.market}`}>
                          {p ? marketHeadline(p.fm.market, clock) : candidate.market}
                        </Link>
                        {p ? <span className={s.legRule}>{p.pays}</span> : null}
                      </th>
                      <td>
                        {sizing.mode === "pool"
                          ? `Stake ${usdc(sizing.cost)} on ${holds}`
                          : `Buy ${fmtTokens(sizing.tokens ?? 0)} of ${holds} at ${formatUsdNumber(sizing.price ?? 0)}`}
                      </td>
                      <td className={s.num}>{usdc(sizing.cost)}</td>
                      <td className={s.num}>{usdc(sizing.payoutIfWin)}</td>
                      <td>
                        <Button size="sm" variant="ghost" onClick={() => onRemove(candidate.market)}>
                          Remove
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row">Basket</th>
                  <td>
                    {basket.legs.length} {basket.legs.length === 1 ? "leg" : "legs"}
                  </td>
                  <td className={s.num}>{usdc(basket.totalCost)}</td>
                  <td className={s.num}>{usdc(basket.payoutIfAllWin)}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
          {basket.dropped.length > 0 ? (
            <ul className={s.skipped}>
              {basket.dropped.map((d) => {
                const p = proposalOf(d.candidate.market);
                return (
                  <li key={d.candidate.market}>
                    {p ? marketHeadline(p.fm.market, clock) : d.candidate.market}: left out of the split.{" "}
                    {d.reason}
                  </li>
                );
              })}
            </ul>
          ) : null}
          <ScenarioTable
            rows={basket.scenarios}
            legs={basket.legs.length}
            meta={meta}
            accruedPending={accruedPending}
          />
          <div className={s.actions}>
            <Button size="sm" onClick={() => onTrack(plan)} disabled={tracked}>
              {tracked ? "Tracking this basket" : "Track this basket"}
            </Button>
          </div>
          <p className={s.note}>
            Open each leg's market page to stake or buy. This page sends nothing; tracking assumes you took
            each leg as sized here.
          </p>
        </>
      ) : (
        <>
          <p className={s.error}>{basket.reason}</p>
          {basket.dropped.length > 0 ? (
            <ul className={s.skipped}>
              {basket.dropped.map((d) => {
                const p = proposalOf(d.candidate.market);
                return (
                  <li key={d.candidate.market}>
                    {p ? marketHeadline(p.fm.market, clock) : d.candidate.market}: {d.reason}
                  </li>
                );
              })}
            </ul>
          ) : null}
        </>
      )}
    </section>
  );
}

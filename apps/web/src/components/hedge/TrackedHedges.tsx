"use client";

import Link from "next/link";
import { basketValue, type LegValue } from "@/lib/hedge/basket";
import { useFundingSumNow, useFundingSumsAt, useLegMarkets, usePerpMeta } from "@/lib/hedge/hooks";
import { formatUsdNumber, fundingPaidUsd } from "@/lib/hedge/math";
import type { TrackedBasket } from "@/lib/hedge/tracking";
import { useChainClock } from "@/lib/hooks";
import type { MarketView } from "@/lib/market/types";
import { marketHeadline } from "../markets/MarketCard";
import { Badge, Button, Card, PhasePill, Stat } from "../ui";
import { fmtCover, fmtTokens, fmtUnits, usdc } from "./fmt";
import s from "./hedge.module.css";

/** One leg's status in words: open, graduated, settled with its outcome, or voided. */
function LegStatus({ m, v }: { m: MarketView | null; v: LegValue | null }) {
  if (!m) return <span className="muted">reading</span>;
  return (
    <span className={s.legStatus}>
      <PhasePill phase={m.phase} outcome={m.outcome} />
      {v?.won === true ? <Badge tone="yes">won</Badge> : null}
      {v?.won === false ? <Badge tone="no">lost</Badge> : null}
    </span>
  );
}

function TrackedBasketCard({ basket, onRemove }: { basket: TrackedBasket; onRemove: () => void }) {
  const perpId = BigInt(basket.perpId);
  const meta = usePerpMeta(perpId);
  const sumNow = useFundingSumNow(perpId);
  const markets = useLegMarkets(basket.legs.map((l) => l.market));
  const clock = useChainClock();
  const worth = basketValue(basket, markets);
  // Funding after the last leg's window is not hedged: once the chain is past it, measure up to it.
  const head = sumNow.data?.head;
  const until =
    worth.endBlock !== null && head !== undefined && head > worth.endBlock ? worth.endBlock : null;
  const sumAtEnd = useFundingSumsAt(perpId, until === null ? [] : [until]);
  const sumTo = until === null ? sumNow.data?.sum : sumAtEnd.data?.[until.toString()];
  const paid =
    meta.data && sumTo !== undefined
      ? fundingPaidUsd({
          sumFrom: BigInt(basket.startSum),
          sumTo,
          side: basket.side,
          units: basket.units,
          meta: meta.data,
        })
      : null;
  const net = paid !== null && worth.value !== null ? worth.value - worth.cost - paid : null;
  const n = basket.legs.length;
  const legWord = n === 1 ? "1 leg" : `${n} legs`;
  return (
    <Card as="article" className={s.proposal}>
      <div className={s.proposalHead}>
        <p className={s.proposalQuestion}>
          {basket.symbol} {basket.side}, {fmtUnits(basket.units)} {basket.symbol}: a basket of {legWord}
        </p>
        <Badge tone={worth.allFinal ? "accent" : "neutral"} dot>
          {worth.allFinal ? "every leg settled" : `${worth.final} of ${n} settled`}
        </Badge>
      </div>
      <div className={s.figures}>
        <Stat
          size="sm"
          label="Funding since tracking"
          value={
            paid === null
              ? "..."
              : paid >= 0
                ? `paid ${formatUsdNumber(paid)}`
                : `got ${formatUsdNumber(-paid)}`
          }
          hint={
            until === null
              ? `from block ${Number(basket.startBlock).toLocaleString("en-US")}`
              : `blocks ${Number(basket.startBlock).toLocaleString("en-US")} to ${Number(until).toLocaleString("en-US")}, the last leg's end`
          }
        />
        <Stat
          size="sm"
          label="Basket cost"
          value={formatUsdNumber(worth.cost)}
          hint={`${legWord}, sized to cover ${fmtCover(basket.cover)}`}
        />
        <Stat
          size="sm"
          label={worth.allFinal ? "Basket paid" : "Basket worth now"}
          value={worth.value === null ? "..." : formatUsdNumber(worth.value)}
          hint={
            worth.allFinal ? "every leg's payout" : "settled legs at their payout, open legs at their price"
          }
        />
        <Stat
          size="sm"
          label={worth.allFinal ? "Net" : "Net so far"}
          value={net === null ? "..." : formatUsdNumber(net)}
          hint="basket value − cost − funding paid"
          tone={net !== null && net < 0 ? "no" : undefined}
        />
      </div>
      <div className={s.tableWrap}>
        <table className={s.table}>
          <caption className="visually-hidden">
            Each leg of the basket, its status and what it is worth
          </caption>
          <thead>
            <tr>
              <th scope="col">Leg</th>
              <th scope="col">Took</th>
              <th scope="col">Status</th>
              <th scope="col" className={s.num}>
                Worth
              </th>
            </tr>
          </thead>
          <tbody>
            {basket.legs.map((leg, i) => {
              const m = markets[i] ?? null;
              const v = worth.legs[i] ?? null;
              const holds = leg.buy.toUpperCase();
              return (
                <tr key={leg.market}>
                  <th scope="row" className={s.legCell}>
                    <Link href={`/m/${leg.market}`}>{m ? marketHeadline(m, clock) : "the market"}</Link>
                  </th>
                  <td>
                    {leg.mode === "pool"
                      ? `${usdc(leg.cost)} staked on ${holds}`
                      : `${fmtTokens(leg.tokens ?? 0)} of ${holds} for ${usdc(leg.cost)}`}
                  </td>
                  <td>
                    <LegStatus m={m} v={v} />
                  </td>
                  <td className={s.num}>
                    {v ? formatUsdNumber(v.value) : "..."}
                    {v ? <span className={s.legRule}>{v.basis}</span> : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className={s.actions}>
        <Button size="sm" variant="ghost" onClick={onRemove}>
          Stop tracking
        </Button>
      </div>
    </Card>
  );
}

export function TrackedHedges({
  baskets,
  onRemove,
}: {
  baskets: TrackedBasket[];
  onRemove: (id: string) => void;
}) {
  if (baskets.length === 0) return null;
  return (
    <div className={s.tracked}>
      <p className={s.note}>
        Kept in this browser only, until every leg settles. Tracking assumes you took each leg as sized; it
        does not read your wallet. A hedge tracked before baskets shows as a basket of one leg.
      </p>
      {baskets.map((b) => (
        <TrackedBasketCard key={b.id} basket={b} onRemove={() => onRemove(b.id)} />
      ))}
    </div>
  );
}

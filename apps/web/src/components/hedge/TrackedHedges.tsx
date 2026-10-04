"use client";

import { Outcome, Phase } from "@hunch-book/shared";
import Link from "next/link";
import { formatChance } from "@/lib/format";
import { useFundingSumNow, usePerpMeta } from "@/lib/hedge/hooks";
import { formatUsdNumber, fundingPaidUsd, PHI, poolNetGain } from "@/lib/hedge/math";
import type { TrackedHedge } from "@/lib/hedge/tracking";
import { useMarket } from "@/lib/hooks";
import { marketChance } from "@/lib/market/logic";
import type { MarketView } from "@/lib/market/types";
import { marketHeadline } from "../markets/MarketCard";
import { Button, Card, PhasePill, Stat } from "../ui";
import s from "./hedge.module.css";

const usdcOf = (v: bigint) => Number(v) / 1e6;

/**
 * What the hedge is worth: its final payout once the market settles or voids, before that its
 * payout if it wins times the market's chance (a pool stake), or the tokens at the book's mid.
 */
export function hedgeValue(h: TrackedHedge, m: MarketView): { value: number; final: boolean; basis: string } {
  const won = (m.outcome === Outcome.Yes && h.buy === "yes") || (m.outcome === Outcome.No && h.buy === "no");
  const side = h.buy === "yes" ? m.pool.yes : m.pool.no;
  const other = h.buy === "yes" ? m.pool.no : m.pool.yes;
  const feePerToken = m.pool.total > 0n ? (PHI * Number(other)) / Number(m.pool.total) : 0;
  if (m.phase === Phase.Settled) {
    if (!won) return { value: 0, final: true, basis: "lost" };
    if (h.mode === "book")
      return { value: (h.tokens ?? 0) * (1 - feePerToken), final: true, basis: "redeemable" };
    // The stake is already part of the final pool, so the winnings are (1 − φ) · s · L / W.
    const winnings = ((1 - PHI) * h.cost * usdcOf(other)) / Math.max(usdcOf(side), h.cost);
    return { value: h.cost + winnings, final: true, basis: "payout" };
  }
  if (m.phase === Phase.Voided) {
    return h.mode === "book"
      ? { value: (h.tokens ?? 0) * 0.5, final: true, basis: "void: 0.50 per token" }
      : { value: h.cost, final: true, basis: "void: refunded" };
  }
  const chanceYes = marketChance(m).bps;
  if (chanceYes === null) return { value: h.cost, final: false, basis: "no price yet: shown at cost" };
  const chance = h.buy === "yes" ? Number(chanceYes) / 10_000 : 1 - Number(chanceYes) / 10_000;
  if (h.mode === "book") return { value: (h.tokens ?? 0) * chance, final: false, basis: "tokens at the mid" };
  const payout = h.cost + poolNetGain(h.cost, Math.max(usdcOf(side) - h.cost, 0), usdcOf(other));
  return { value: payout * chance, final: false, basis: `payout × chance (${formatChance(chanceYes)})` };
}

function TrackedRow({ hedge, onRemove }: { hedge: TrackedHedge; onRemove: () => void }) {
  const perpId = BigInt(hedge.perpId);
  const meta = usePerpMeta(perpId);
  const sum = useFundingSumNow(perpId);
  const market = useMarket(hedge.market);
  const m = market.data?.status === "ok" ? market.data.data : null;
  const paid =
    meta.data && sum.data
      ? fundingPaidUsd({
          sumFrom: BigInt(hedge.startSum),
          sumTo: sum.data.sum,
          side: hedge.side,
          units: hedge.units,
          meta: meta.data,
        })
      : null;
  const value = m ? hedgeValue(hedge, m) : null;
  const net = paid !== null && value ? value.value - hedge.cost - paid : null;
  return (
    <Card as="article" className={s.proposal}>
      <div className={s.proposalHead}>
        <p className={s.proposalQuestion}>
          {hedge.symbol} {hedge.side}, {hedge.units.toLocaleString("en-US", { maximumFractionDigits: 6 })}{" "}
          {hedge.symbol}: {hedge.buy.toUpperCase()} on{" "}
          <Link href={`/m/${hedge.market}`}>{m ? marketHeadline(m) : "the market"}</Link>
        </p>
        {m ? <PhasePill phase={m.phase} outcome={m.outcome} /> : null}
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
          hint={`from block ${Number(hedge.startBlock).toLocaleString("en-US")}`}
        />
        <Stat
          size="sm"
          label="Hedge cost"
          value={formatUsdNumber(hedge.cost)}
          hint={hedge.mode === "pool" ? "pool stake" : "tokens bought"}
        />
        <Stat
          size="sm"
          label={value?.final ? "Hedge paid" : "Hedge worth now"}
          value={value ? formatUsdNumber(value.value) : "..."}
          hint={value?.basis}
        />
        <Stat
          size="sm"
          label="Net so far"
          value={net === null ? "..." : formatUsdNumber(net)}
          hint="hedge value − cost − funding paid"
          tone={net !== null && net < 0 ? "no" : undefined}
        />
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
  hedges,
  onRemove,
}: {
  hedges: TrackedHedge[];
  onRemove: (id: string) => void;
}) {
  if (hedges.length === 0) return null;
  return (
    <div className={s.tracked}>
      <p className={s.note}>
        Kept in this browser only. Tracking assumes you took the hedge as proposed; it does not read your
        wallet.
      </p>
      {hedges.map((h) => (
        <TrackedRow key={h.id} hedge={h} onRemove={() => onRemove(h.id)} />
      ))}
    </div>
  );
}

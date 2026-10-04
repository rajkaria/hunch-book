"use client";

import { canonicalParlayLegs, Phase, TemplateId } from "@hunch-book/shared";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useId, useMemo, useState } from "react";
import { type Address, isAddressEqual } from "viem";
import { getPublicClient } from "@/lib/chain/client";
import { readMarketViews } from "@/lib/chain/reads";
import { appNetwork } from "@/lib/config";
import { formatChance, formatDuration, formatInt, formatUtc } from "@/lib/format";
import { useChainClock, useMarkets, useNow } from "@/lib/hooks";
import { chanceDisplay, marketChance } from "@/lib/market/logic";
import type { ChainClock, MarketView } from "@/lib/market/types";
import {
  earliestLock,
  type LegState,
  legBlocker,
  oneIn,
  PARLAY_MAX_LEGS,
  PARLAY_MIN_LEGS,
  type ParlayView as ParlayData,
  parlayLegsOf,
  parlayPrefillPath,
  parlayQuote,
  parlayView,
  parlayWindow,
} from "@/lib/parlay/math";
import { marketHeadline } from "../markets/MarketCard";
import { EmptyState, ErrorState, LoadingRows, NotDeployed } from "../states";
import { Badge, ButtonLink, Input, Notice, Panel, PhasePill, type Tone } from "../ui";
import s from "./parlay.module.css";

const LEG_STATE: Record<LegState, { label: string; tone: Tone }> = {
  yes: { label: "Settled YES", tone: "yes" },
  no: { label: "Settled NO", tone: "no" },
  void: { label: "Voided", tone: "muted" },
  open: { label: "Open", tone: "accent" },
  unknown: { label: "Not read", tone: "muted" },
};

const VERDICT: Record<ParlayData["verdict"], { label: string; tone: Tone }> = {
  yes: { label: "Every leg YES", tone: "yes" },
  no: { label: "A leg settled NO", tone: "no" },
  void: { label: "A leg voided", tone: "muted" },
  open: { label: "Legs open", tone: "accent" },
};

const sameSet = (a: readonly Address[], b: readonly Address[]): boolean =>
  a.length === b.length && a.every((x) => b.some((y) => isAddressEqual(x, y)));

/** Pick 2 to 5 open markets, see their implied parlay chance, and create the template 6 market. */
export function ParlayBuilder({
  markets,
  clock,
  now,
}: {
  markets: MarketView[];
  clock: ChainClock | null;
  now: number;
}) {
  const [picked, setPicked] = useState<Address[]>([]);
  const [query, setQuery] = useState("");
  const searchId = useId();
  const candidates = markets.filter(
    (m) => m.phase === Phase.Pool || m.phase === Phase.PoolLocked || m.phase === Phase.Graduated,
  );
  const shown = candidates.filter((m) => {
    const q = query.trim().toLowerCase();
    return q === "" || marketHeadline(m).toLowerCase().includes(q) || `#${m.marketId}`.includes(q);
  });
  const legs = picked.flatMap((a) => markets.filter((m) => isAddressEqual(m.address, a)));
  const quote = parlayQuote(legs);
  const window = parlayWindow(legs, clock, now);
  const enough = legs.length >= PARLAY_MIN_LEGS;
  const existing = enough
    ? markets.find((m) => {
        const set = parlayLegsOf(m);
        return set !== null && sameSet(set, picked);
      })
    : undefined;

  const toggle = (m: MarketView) =>
    setPicked((prev) =>
      prev.some((a) => isAddressEqual(a, m.address))
        ? prev.filter((a) => !isAddressEqual(a, m.address))
        : prev.length >= PARLAY_MAX_LEGS
          ? prev
          : [...prev, m.address],
    );

  return (
    <Panel title="Build a parlay" labelledBy="parlay-build-title">
      <p className={s.note}>
        A parlay pays YES only if every leg settles YES, and NO as soon as any leg settles NO. Pick{" "}
        {PARLAY_MIN_LEGS} to {PARLAY_MAX_LEGS} open markets. A parlay must lock before every one of its legs
        does.
      </p>

      <div className={s.summary} aria-live="polite">
        <div className={s.summaryHead}>
          <span className={s.big}>
            {quote.chanceBps === null || !enough ? "n/a" : formatChance(quote.chanceBps)}
          </span>
          <span className={s.note}>
            {enough
              ? `implied chance that all ${legs.length} legs settle YES${quote.chanceBps !== null && oneIn(quote.chanceBps) ? `, ${oneIn(quote.chanceBps)}` : ""}`
              : `pick at least ${PARLAY_MIN_LEGS} legs`}
          </span>
        </div>
        <p className={s.note}>
          The product of each leg's own chance. That assumes the legs are independent: legs that move together
          (two prices of the same asset, say) make the real chance higher than this.
        </p>
        {legs.length > 0 ? (
          <ol className={s.legs}>
            {legs.map((m, i) => (
              <li key={m.address}>
                <span className={s.legName}>{marketHeadline(m)}</span>
                <span className="mono">
                  {quote.legs[i] === null ? "n/a" : formatChance(quote.legs[i] as bigint)}
                </span>
              </li>
            ))}
          </ol>
        ) : null}
        {enough ? (
          window ? (
            <p className={s.note}>
              Proposed window: locks {formatUtc(window.lockTime)} (before the first leg can lock), closes{" "}
              {formatUtc(window.closeTime)} (after the last leg closes). You can change them on the create
              page.
            </p>
          ) : (
            <p className={s.warn}>
              A leg locks too soon for a parlay to open before it. Drop the leg that locks first.
            </p>
          )
        ) : null}
        {existing ? (
          <Notice title="A parlay on these legs exists">
            <Link href={`/m/${existing.address}`}>{marketHeadline(existing)}</Link>. Stake there, or create
            one with other times.
          </Notice>
        ) : null}
        <div className={s.row}>
          {enough && window ? (
            <ButtonLink variant="primary" href={parlayPrefillPath(canonicalParlayLegs(picked), window)} arrow>
              Create this parlay
            </ButtonLink>
          ) : null}
          {picked.length > 0 ? (
            <button type="button" className={s.clear} onClick={() => setPicked([])}>
              Clear
            </button>
          ) : null}
        </div>
      </div>

      <div className={s.search}>
        <label className={s.label} htmlFor={searchId}>
          Find markets
        </label>
        <Input
          id={searchId}
          placeholder="Search by question or #number"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoComplete="off"
        />
      </div>
      {shown.length === 0 ? (
        <p className={s.note}>No open markets match.</p>
      ) : (
        <ul className={s.picker}>
          {shown.map((m) => {
            const blocker = legBlocker(m, clock, now);
            const checked = picked.some((a) => isAddressEqual(a, m.address));
            const full = !checked && picked.length >= PARLAY_MAX_LEGS;
            const lock = earliestLock(m, clock);
            const id = `leg-${m.address}`;
            return (
              <li key={m.address} className={s.option} data-checked={checked || undefined}>
                <input
                  id={id}
                  type="checkbox"
                  checked={checked}
                  disabled={(blocker !== null && !checked) || full}
                  onChange={() => toggle(m)}
                  aria-describedby={`${id}-note`}
                />
                <label htmlFor={id} className={s.optionBody}>
                  <span className={s.optionTitle}>{marketHeadline(m)}</span>
                  <span className={s.optionMeta} id={`${id}-note`}>
                    #{m.marketId.toString()} · {chanceDisplay(marketChance(m)).value}
                    {lock !== null && lock > now ? ` · locks in about ${formatDuration(lock - now)}` : ""}
                    {blocker ? ` · ${blocker}` : full ? " · five legs at most" : ""}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

/** Every template 6 market with its legs' states, reading legs older than the market list on demand. */
export function ParlayList({ markets }: { markets: MarketView[] }) {
  const parlays = markets.filter((m) => m.templateId === TemplateId.Parlay);
  const known = useMemo(() => new Map(markets.map((m) => [m.address.toLowerCase(), m])), [markets]);
  const missing = useMemo(() => {
    const set = new Set<string>();
    for (const p of parlays)
      for (const leg of parlayLegsOf(p) ?? []) if (!known.has(leg.toLowerCase())) set.add(leg);
    return [...set].sort() as Address[];
  }, [parlays, known]);
  const extra = useQuery({
    queryKey: ["parlay-legs", appNetwork, missing.join(",")],
    queryFn: () => readMarketViews(getPublicClient(), missing),
    enabled: missing.length > 0,
    staleTime: 30_000,
  });
  const byAddress = useMemo(() => {
    const map = new Map(known);
    for (const m of extra.data ?? []) map.set(m.address.toLowerCase(), m);
    return map;
  }, [known, extra.data]);
  const views = parlays.flatMap((p) => {
    const v = parlayView(p, byAddress);
    return v ? [v] : [];
  });

  return (
    <Panel title={`Parlays · ${formatInt(views.length)}`} labelledBy="parlay-list-title">
      {views.length === 0 ? (
        <p className={s.note}>No parlay markets yet. Build the first one above.</p>
      ) : (
        <ul className={s.list}>
          {views.map((v) => {
            const own = marketChance(v.market);
            return (
              <li key={v.market.address} className={s.card}>
                <div className={s.cardHead}>
                  <PhasePill phase={v.market.phase} outcome={v.market.outcome} />
                  <Badge tone={VERDICT[v.verdict].tone} dot>
                    {VERDICT[v.verdict].label}
                  </Badge>
                </div>
                <Link className={s.cardTitle} href={`/m/${v.market.address}`}>
                  {marketHeadline(v.market)}
                </Link>
                <p className={s.note}>
                  Parlay market: {chanceDisplay(own).value} · legs imply{" "}
                  {v.impliedBps === null ? "n/a" : formatChance(v.impliedBps)}, assuming they are independent.
                </p>
                <ol className={s.legs}>
                  {v.legs.map((leg) => (
                    <li key={leg.address}>
                      <span className={s.legName}>
                        {leg.market ? (
                          <Link href={`/m/${leg.address}`}>{marketHeadline(leg.market)}</Link>
                        ) : (
                          <Link href={`/m/${leg.address}`} className="mono">
                            {leg.address}
                          </Link>
                        )}
                      </span>
                      <span className={s.legState}>
                        <Badge tone={LEG_STATE[leg.state].tone}>{LEG_STATE[leg.state].label}</Badge>
                        {leg.state === "open" && leg.chanceBps !== null ? (
                          <span className="mono">{formatChance(leg.chanceBps)}</span>
                        ) : null}
                      </span>
                    </li>
                  ))}
                </ol>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

/** The /parlay page body. */
export function ParlayPage() {
  const query = useMarkets();
  const markets = query.data?.status === "ok" ? query.data.data.markets : [];
  const clock = useChainClock(markets.some((m) => m.window.blockClock));
  const now = useNow(15_000);
  if (query.isPending || (query.data?.status === "ok" && now === null)) {
    return <LoadingRows rows={2} label="Loading parlays" />;
  }
  if (query.isError)
    return <ErrorState title="Could not load markets" onRetry={() => void query.refetch()} />;
  if (query.data.status !== "ok") return <NotDeployed />;
  if (markets.length === 0) {
    return (
      <EmptyState label="Parlays" title="No markets to combine yet">
        <p>
          A parlay combines 2 to 5 existing markets. <Link href="/create">Create a market</Link> first.
        </p>
      </EmptyState>
    );
  }
  return (
    <div className={s.stack}>
      <ParlayBuilder markets={markets} clock={clock} now={now as number} />
      <ParlayList markets={markets} />
    </div>
  );
}

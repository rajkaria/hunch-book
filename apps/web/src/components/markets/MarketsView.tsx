"use client";

import Link from "next/link";
import { MARKETS_WILL_SHOW } from "@/lib/copy";
import { useChainClock, useMarkets, useNow } from "@/lib/hooks";
import { PHASE_GROUP_LABEL, PHASE_GROUPS, type PhaseGroup, phaseGroup } from "@/lib/market/logic";
import type { MarketView } from "@/lib/market/types";
import { EmptyState, ErrorState, LoadingRows, NotDeployed } from "../states";
import { MarketCard } from "./MarketCard";
import s from "./markets.module.css";

type Filter = PhaseGroup | "all";

export function FilterTabs({ filter, counts }: { filter: Filter; counts: Record<Filter, number> }) {
  const tabs: Filter[] = ["all", ...PHASE_GROUPS];
  return (
    <nav className={s.tabs} aria-label="Filter markets by phase">
      {tabs.map((tab) => {
        const active = tab === filter;
        return (
          <Link
            key={tab}
            href={tab === "all" ? "/markets" : `/markets?phase=${tab}`}
            className={active ? `${s.tab} ${s.tabActive}` : s.tab}
            aria-current={active ? "page" : undefined}
            scroll={false}
          >
            {tab === "all" ? "All" : PHASE_GROUP_LABEL[tab]}
            <span className={s.count}>{counts[tab]}</span>
          </Link>
        );
      })}
    </nav>
  );
}

export function countByGroup(markets: MarketView[]): Record<Filter, number> {
  const counts: Record<Filter, number> = {
    all: markets.length,
    pools: 0,
    trading: 0,
    settling: 0,
    settled: 0,
  };
  for (const m of markets) counts[phaseGroup(m.phase)] += 1;
  return counts;
}

export function MarketsList({
  markets,
  total,
  filter,
}: {
  markets: MarketView[];
  total: number;
  filter: Filter;
}) {
  const clock = useChainClock(markets.some((m) => m.window.blockClock));
  const now = useNow();
  const shown = filter === "all" ? markets : markets.filter((m) => phaseGroup(m.phase) === filter);

  if (markets.length === 0) {
    return (
      <EmptyState label="No markets yet" title="Nobody has created a market yet">
        <p>
          Markets appear here as soon as someone creates one from a template: Perpl funding (will longs pay
          shorts over a block window?) or price at a time (will an asset be at or above a strike at a set
          time?). Each one lists its pool, its implied chance and when it locks.
        </p>
      </EmptyState>
    );
  }

  return (
    <>
      <FilterTabs filter={filter} counts={countByGroup(markets)} />
      {shown.length === 0 ? (
        <EmptyState
          title={`No markets in "${filter === "all" ? "All" : PHASE_GROUP_LABEL[filter]}" right now`}
        >
          <p>
            Try another phase. <Link href="/markets">Show all markets</Link>.
          </p>
        </EmptyState>
      ) : (
        <ul className={s.list}>
          {shown.map((m) => (
            <MarketCard key={m.address} m={m} clock={clock} now={now} />
          ))}
        </ul>
      )}
      {total > markets.length ? (
        <p className={s.footnote}>
          Showing the newest {markets.length} of {total} markets. Older markets arrive with the indexer.
        </p>
      ) : null}
    </>
  );
}

export function MarketsView({ filter }: { filter: Filter }) {
  const query = useMarkets();
  if (query.isPending) return <LoadingRows rows={4} label="Loading markets" />;
  if (query.isError)
    return <ErrorState title="Could not load markets" onRetry={() => void query.refetch()} />;
  if (query.data.status !== "ok") return <NotDeployed willShow={MARKETS_WILL_SHOW} />;
  return <MarketsList markets={query.data.data.markets} total={query.data.data.total} filter={filter} />;
}

"use client";

import Link from "next/link";
import { useId, useState } from "react";
import { MARKETS_WILL_SHOW } from "@/lib/copy";
import { formatCount } from "@/lib/format";
import { useChainClock, useMarkets, useNow } from "@/lib/hooks";
import {
  activeFilterCount,
  type ExplorerPreset,
  explorerCounts,
  explorerHref,
  explorerStats,
  filterMarkets,
  isOneSidedLockedPool,
  matchesSearch,
  type PhaseFilter,
  searchTerms,
  searchText,
  VENUE_FILTER_LABEL,
  VENUE_FILTERS,
  type VenueFilter,
  wholePercent,
} from "@/lib/market/explorer";
import { PHASE_GROUP_LABEL, PHASE_GROUPS } from "@/lib/market/logic";
import type { MarketView } from "@/lib/market/types";
import { venueChipLabel } from "@/lib/stacks";
import { EmptyState, ErrorState, LoadingRows, NotDeployed } from "../states";
import { Badge, cx } from "../ui";
import s from "./explorer.module.css";
import { MarketCard, marketHeadline } from "./MarketCard";

export type { PhaseFilter, VenueFilter };

interface ChipOption<T extends string> {
  id: T;
  label: string;
  count: number;
  href: string;
}

/**
 * One row of filter chips, each a link to its filtered URL with its count. The count rides the link's
 * name ("Trading, 3 markets"), so it reaches screen readers as well as eyes.
 */
export function FilterChips<T extends string>({
  label,
  ariaLabel,
  options,
  value,
  small,
}: {
  label: string;
  ariaLabel: string;
  options: readonly ChipOption<T>[];
  value: T;
  small?: boolean;
}) {
  return (
    <nav className={s.group} aria-label={ariaLabel}>
      <span className={s.groupLabel} aria-hidden="true">
        {label}
      </span>
      <div className={s.chips}>
        {options.map((option) => {
          const active = option.id === value;
          return (
            <Link
              key={option.id}
              href={option.href}
              scroll={false}
              aria-current={active ? "page" : undefined}
              aria-label={`${option.label}, ${formatCount(option.count, "market")}`}
              className={cx(
                s.chip,
                small && s.chipSmall,
                option.count === 0 && !active && s.chipQuiet,
                active && s.chipActive,
              )}
            >
              <span>{option.label}</span>
              <span className={s.count} aria-hidden="true">
                {option.count}
              </span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

function SearchIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
      <path d="m20 20-3.2-3.2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function FilterIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M3 5h18M6 12h12M10 19h4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

/** "Trading", "Pools filling on Kuru": the words for a selection, for the empty result. */
function selectionWords(phase: PhaseFilter, venue: VenueFilter): string {
  const what = phase === "all" ? "All" : PHASE_GROUP_LABEL[phase];
  return venue === "all" ? what : `${what} on ${VENUE_FILTER_LABEL[venue]}`;
}

export function MarketsList({
  markets,
  total,
  filter,
  venue = "all",
  preset,
}: {
  markets: MarketView[];
  total: number;
  filter: PhaseFilter;
  venue?: VenueFilter;
  /** Set on a page that fixes the venue, such as /kuru. */
  preset?: ExplorerPreset;
}) {
  const clock = useChainClock(markets.some((m) => m.window.blockClock));
  const now = useNow();
  const [query, setQuery] = useState("");
  const [panelOpen, setPanelOpen] = useState(false);
  const searchId = useId();
  const panelId = useId();

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

  const selection = { phase: filter, venue };
  // Pools that locked one-sided cannot move, so they are left out of the list and its counts.
  const listed = markets.filter((m) => !isOneSidedLockedPool(m));
  const hiddenPools = markets.length - listed.length;
  const terms = searchTerms(query);
  const searched =
    terms.length === 0
      ? listed
      : listed.filter((m) => matchesSearch(searchText(m, marketHeadline(m, clock)), terms));
  const counts = explorerCounts(searched, selection);
  const shown = filterMarkets(searched, selection);
  const present = explorerCounts(listed, { phase: "all", venue: "all" }).venue;
  // The page's own markets: every listed one on /markets, the preset venue's on /kuru. The panel's
  // figures and the "of" count read these.
  const scope = preset ? filterMarkets(listed, { phase: "all", venue: preset.venue }) : listed;
  const stats = explorerStats(scope);
  const active = activeFilterCount(selection, preset);
  const clearHref = explorerHref({ phase: "all", venue: preset?.venue ?? "all" }, preset);
  const templates = new Set(scope.map((m) => m.templateId)).size;
  const venues = new Set(scope.map((m) => venueChipLabel(m))).size;

  const phaseOptions = (["all", ...PHASE_GROUPS] as PhaseFilter[]).map((id) => ({
    id,
    label: id === "all" ? "All" : PHASE_GROUP_LABEL[id],
    count: counts.phase[id],
    href: explorerHref({ phase: id, venue }, preset),
  }));
  // A venue with no markets on this network is left out, unless the URL picked it.
  const venueOptions = VENUE_FILTERS.filter((id) => id === "all" || id === venue || present[id] > 0).map(
    (id) => ({
      id,
      label: VENUE_FILTER_LABEL[id],
      count: counts.venue[id],
      href: explorerHref({ phase: filter, venue: id }, preset),
    }),
  );

  return (
    <>
      <div className={s.searchRow}>
        <label htmlFor={searchId} className="visually-hidden">
          Search markets
        </label>
        <div className={s.searchField}>
          <span className={s.searchIcon}>
            <SearchIcon />
          </span>
          <input
            id={searchId}
            type="search"
            className={s.searchInput}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search by question or number"
            autoComplete="off"
            spellCheck={false}
          />
          {query ? (
            <button
              type="button"
              className={s.searchClear}
              onClick={() => setQuery("")}
              aria-label="Clear search"
            >
              <span aria-hidden="true">×</span>
            </button>
          ) : null}
        </div>
        {terms.length > 0 ? (
          <p className={s.searchCount}>
            <span className="mono">{shown.length}</span>{" "}
            {shown.length === 1 ? "market matches" : "markets match"} "{query.trim()}"
          </p>
        ) : null}
      </div>

      <div className={s.layout}>
        <div className={s.disclosure}>
          <button
            type="button"
            className={s.disclosureButton}
            aria-expanded={panelOpen}
            aria-controls={panelId}
            onClick={() => setPanelOpen((open) => !open)}
          >
            <span className={s.disclosureLabel}>
              <FilterIcon />
              Filters
              {active > 0 ? (
                <span className={s.disclosureBadge}>
                  {active}
                  <span className="visually-hidden"> set</span>
                </span>
              ) : null}
            </span>
            <span className={cx(s.caret, panelOpen && s.caretOpen)} aria-hidden="true">
              ▾
            </span>
          </button>
        </div>

        <aside
          id={panelId}
          className={s.controls}
          data-open={panelOpen ? "true" : "false"}
          aria-label="Market filters"
        >
          <div className={s.panel}>
            <div className={s.panelTop}>
              <div className={s.panelBadges}>
                <Badge tone="accent">Onchain</Badge>
                <Badge tone="cyan">USDC</Badge>
                <Badge tone="violet">Monad</Badge>
              </div>
              <span className={s.panelLabel}>Filters</span>
              {active > 0 || terms.length > 0 ? (
                <Link href={clearHref} scroll={false} className={s.clearAll} onClick={() => setQuery("")}>
                  Clear all <span aria-hidden="true">×</span>
                </Link>
              ) : null}
            </div>

            <FilterChips
              label="Status"
              ariaLabel="Filter markets by phase"
              options={phaseOptions}
              value={filter}
            />
            <FilterChips
              label="Book venue"
              ariaLabel="Filter markets by book venue"
              options={venueOptions}
              value={venue}
              small
            />

            <div className={s.stats}>
              <div className={s.stat}>
                <p className={s.statLabel}>Markets</p>
                <p className={s.statValue}>{scope.length}</p>
              </div>
              <div className={s.stat}>
                <p className={s.statLabel}>Open</p>
                <p className={s.statValue}>{stats.open}</p>
              </div>
              <div className={s.stat}>
                <p className={s.statLabel}>Avg YES</p>
                <p className={cx(s.statValue, s.statAccent)}>
                  {stats.avgYesBps === null ? "n/a" : wholePercent(stats.avgYesBps)}
                </p>
              </div>
            </div>
            <p className={s.panelNote}>
              {formatCount(templates, "market type")} · {formatCount(venues, "book venue")}. Open counts pools
              filling and books trading.
            </p>
          </div>
        </aside>

        <section className={s.results}>
          <p className={s.showing} aria-live="polite">
            Showing <span>{shown.length}</span> of <span>{scope.length}</span> markets
          </p>
          {shown.length === 0 ? (
            <div className={s.empty}>
              <p>
                {terms.length > 0
                  ? `No markets match "${query.trim()}" here. Try a word from the question, a template or a number.`
                  : `No markets in "${selectionWords(filter, venue)}" right now.`}
              </p>
              <Link href={clearHref} scroll={false} className={s.emptyAction} onClick={() => setQuery("")}>
                {preset ? `Show all ${VENUE_FILTER_LABEL[preset.venue]} markets` : "Show all markets"}
              </Link>
            </div>
          ) : (
            <ul className={s.grid}>
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
          {hiddenPools > 0 ? (
            <p className={s.footnote}>
              Not listed: {formatCount(hiddenPools, "pool")} that locked without graduating with every stake
              on one side. Each one's own page still works.
            </p>
          ) : null}
        </section>
      </div>
    </>
  );
}

export function MarketsView({
  filter,
  venue,
  preset,
}: {
  filter: PhaseFilter;
  venue?: VenueFilter;
  preset?: ExplorerPreset;
}) {
  const query = useMarkets();
  if (query.isPending) return <LoadingRows rows={4} label="Loading markets" />;
  if (query.isError)
    return <ErrorState title="Could not load markets" onRetry={() => void query.refetch()} />;
  if (query.data.status !== "ok") return <NotDeployed willShow={MARKETS_WILL_SHOW} />;
  return (
    <MarketsList
      markets={query.data.data.markets}
      total={query.data.data.total}
      filter={filter}
      venue={venue ?? preset?.venue ?? "all"}
      preset={preset}
    />
  );
}

import { BPS, type Deployment, Phase, USDC_DECIMALS } from "@hunch-book/shared";
import { appDeployment } from "../config";
import { formatDuration, formatFixed, formatUsdc } from "../format";
import { marketTag, marketVenue, onFallbackBook, venueChipLabel } from "../stacks";
import {
  type Milestone,
  marketChance,
  type PhaseGroup,
  PRICE_SCALE,
  phaseGroup,
  phaseLabel,
  priceE18ToBps,
} from "./logic";
import { templateLabel } from "./params";
import { listWords } from "./title";
import type { MarketView } from "./types";

// The markets list as pure logic: the phase and venue filters read from the URL, their counts, the
// links between them, the search box, and what each card shows. The components only render this.

export type PhaseFilter = PhaseGroup | "all";

// ---------------------------------------------------------------- the venue filter

/** Where a market's book is, as the list filters it: every venue, Kuru (v1 or v2), or Hunch Book's own. */
export type VenueFilter = "all" | "kuru" | "hunch";

export const VENUE_FILTERS: readonly VenueFilter[] = ["all", "kuru", "hunch"];

export const VENUE_FILTER_LABEL: Record<VenueFilter, string> = {
  all: "All venues",
  kuru: "Kuru",
  hunch: "Hunch book",
};

/** `?venue=` to a filter: "kuru" or "hunch" (any case, first value wins), anything else is "all". */
export function parseVenueFilter(value: string | string[] | undefined): VenueFilter {
  const v = (Array.isArray(value) ? value[0] : value)?.trim().toLowerCase();
  return v === "kuru" || v === "hunch" ? v : "all";
}

export interface ExplorerSelection {
  phase: PhaseFilter;
  venue: VenueFilter;
}

/** A page that shows the list with the venue fixed, such as /kuru for venue "kuru". */
export interface ExplorerPreset {
  path: string;
  venue: VenueFilter;
}

export const KURU_PRESET: ExplorerPreset = { path: "/kuru", venue: "kuru" };

/**
 * A pool that locked without graduating with every stake on one side, so its chance reads 0% or 100%
 * and cannot move. The list leaves these out; their own pages still work.
 */
export function isOneSidedLockedPool(
  m: Pick<MarketView, "phase" | "graduated" | "outcome" | "pool" | "quote" | "venue" | "kuruVersion">,
): boolean {
  if (m.phase !== Phase.PoolLocked || m.graduated) return false;
  const { bps } = marketChance(m);
  return bps === 0n || bps === BPS;
}

export function matchesPhase(m: Pick<MarketView, "phase">, phase: PhaseFilter): boolean {
  return phase === "all" || phaseGroup(m.phase) === phase;
}

export function matchesVenue(
  m: Pick<MarketView, "stack" | "venue" | "kuruVersion">,
  venue: VenueFilter,
  deployment: Deployment = appDeployment,
): boolean {
  return venue === "all" || marketVenue(m, deployment).venue === venue;
}

/** The markets that pass both filters, in the order given. */
export function filterMarkets<M extends Pick<MarketView, "phase" | "stack" | "venue" | "kuruVersion">>(
  markets: readonly M[],
  selection: ExplorerSelection,
  deployment: Deployment = appDeployment,
): M[] {
  return markets.filter(
    (m) => matchesPhase(m, selection.phase) && matchesVenue(m, selection.venue, deployment),
  );
}

export interface ExplorerCounts {
  phase: Record<PhaseFilter, number>;
  venue: Record<VenueFilter, number>;
}

/**
 * Counts for each filter option, given the other filter: phase counts are for the selected venue and
 * venue counts for the selected phase, so every count is what picking that option would show.
 */
export function explorerCounts(
  markets: readonly Pick<MarketView, "phase" | "stack" | "venue" | "kuruVersion">[],
  selection: ExplorerSelection,
  deployment: Deployment = appDeployment,
): ExplorerCounts {
  const phase: Record<PhaseFilter, number> = { all: 0, pools: 0, trading: 0, settling: 0, settled: 0 };
  const venue: Record<VenueFilter, number> = { all: 0, kuru: 0, hunch: 0 };
  for (const m of markets) {
    const group = phaseGroup(m.phase);
    const where = marketVenue(m, deployment).venue;
    if (selection.venue === "all" || where === selection.venue) {
      phase.all += 1;
      phase[group] += 1;
    }
    if (selection.phase === "all" || group === selection.phase) {
      venue.all += 1;
      venue[where] += 1;
    }
  }
  return { phase, venue };
}

/**
 * The link for a selection: "/markets", "/markets?phase=trading&venue=kuru". On a preset page (/kuru)
 * a selection with the preset's venue stays on that page; any other venue goes back to /markets.
 */
export function explorerHref(selection: ExplorerSelection, preset?: ExplorerPreset): string {
  const onPreset = preset !== undefined && selection.venue === preset.venue;
  const params = new URLSearchParams();
  if (selection.phase !== "all") params.set("phase", selection.phase);
  if (!onPreset && selection.venue !== "all") params.set("venue", selection.venue);
  const query = params.toString();
  return `${onPreset ? preset.path : "/markets"}${query ? `?${query}` : ""}`;
}

/** How many filters differ from the page's own default (the preset's venue on /kuru, else "all"). */
export function activeFilterCount(selection: ExplorerSelection, preset?: ExplorerPreset): number {
  return (selection.phase === "all" ? 0 : 1) + (selection.venue === (preset?.venue ?? "all") ? 0 : 1);
}

// ---------------------------------------------------------------- Kuru first

/**
 * Every new market opens on Kuru. Markets on Hunch Book's own order book are our fallback book: earlier
 * markets, still listed because they still trade and run to settlement. The list puts them after Kuru's.
 */
export const FALLBACK_HEADING = "Our fallback book: earlier markets";

export const FALLBACK_NOTE =
  "These opened on Hunch Book's own order book before every new market moved to Kuru. They still trade, and they settle as usual.";

/** One block of the list: its markets, and a heading when it is our fallback book. */
export interface ListSection<M> {
  id: "main" | "fallback";
  /** Set on the fallback book's block only. */
  heading: string | null;
  note: string | null;
  markets: M[];
}

/**
 * The list in blocks, Kuru's first: every market on Kuru (or on a network with no fallback book) in one
 * block with no heading, then our fallback book's under its heading. Each block keeps the order given;
 * empty blocks are left out.
 */
export function listSections<M extends Pick<MarketView, "stack" | "venue" | "kuruVersion">>(
  markets: readonly M[],
  deployment: Deployment = appDeployment,
): ListSection<M>[] {
  const main: M[] = [];
  const fallback: M[] = [];
  for (const m of markets) {
    if (onFallbackBook(m, deployment)) fallback.push(m);
    else main.push(m);
  }
  const out: ListSection<M>[] = [];
  if (main.length > 0) out.push({ id: "main", heading: null, note: null, markets: main });
  if (fallback.length > 0) {
    out.push({ id: "fallback", heading: FALLBACK_HEADING, note: FALLBACK_NOTE, markets: fallback });
  }
  return out;
}

// ---------------------------------------------------------------- same question

/**
 * Listed markets that ask the same question as another listed market, by lower-case address, each with
 * the tags of the others ("#12 · Kuru v1"). Two markets can ask the same question: testnet's Kuru v1
 * markets #11 and #12 were created about a minute apart with the same threshold, and their windows,
 * 207 blocks apart, read as the same estimated times. They are separate markets with their own pools and
 * books, so the list says so rather than hiding one.
 */
export function sameQuestion<
  M extends Pick<MarketView, "address" | "marketId" | "stack" | "venue" | "kuruVersion">,
>(
  markets: readonly M[],
  titleOf: (m: M) => string,
  deployment: Deployment = appDeployment,
): Map<string, string[]> {
  const byTitle = new Map<string, M[]>();
  for (const m of markets) {
    const key = titleOf(m).trim().toLowerCase();
    byTitle.set(key, [...(byTitle.get(key) ?? []), m]);
  }
  const out = new Map<string, string[]>();
  for (const group of byTitle.values()) {
    if (group.length < 2) continue;
    for (const m of group) {
      out.set(
        m.address.toLowerCase(),
        group.filter((o) => o.address !== m.address).map((o) => marketTag(o, deployment)),
      );
    }
  }
  return out;
}

/** The card's line for a market that shares its question with others in the list. */
export function sameQuestionWords(others: readonly string[]): string {
  return `A separate market with the same question as ${listWords(others)}.`;
}

// ---------------------------------------------------------------- search

/** The words of a search, lower case. */
export function searchTerms(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/** Everything a search looks through for one market: its title, template, tagged number ("#4 · Kuru v1"), venue and phase. */
export function searchText(
  m: Pick<MarketView, "marketId" | "templateId" | "phase" | "stack" | "venue" | "kuruVersion">,
  title: string,
  deployment: Deployment = appDeployment,
): string {
  return [
    title,
    templateLabel(m.templateId),
    marketTag(m, deployment),
    venueChipLabel(m, deployment),
    phaseLabel(m.phase),
  ]
    .join(" ")
    .toLowerCase();
}

/** True when every term appears in the text. No terms matches everything. */
export function matchesSearch(text: string, terms: readonly string[]): boolean {
  return terms.every((t) => text.includes(t));
}

// ---------------------------------------------------------------- one card

/** Under a day to the next lock or close: the card and its countdown turn coral. */
export const URGENT_SECONDS = 24 * 60 * 60;

/** True when the next lock or close is less than a day away. A settlement deadline is never urgent. */
export function isUrgent(milestone: Milestone | null, nowSeconds: number): boolean {
  if (!milestone || milestone.label === "Settle within") return false;
  const left = milestone.moment.time - nowSeconds;
  return left > 0 && left <= URGENT_SECONDS;
}

const SHORT_VERB: Record<string, string> = {
  "Locks in": "Locks",
  "Closes in": "Closes",
  "Settle within": "Settle within",
};

const SHORT_PASSED: Record<string, string> = {
  "Locks in": "Locking now",
  "Closes in": "Closing now",
  "Settle within": "Past deadline",
};

/**
 * The card's countdown chip, short enough to sit on one line with the tags: "Locks 2d 4h", "Closes ~3h
 * 12m" (a block-clock estimate), "Settle within 6d 23h". The card also carries milestoneText's full
 * words for screen readers.
 */
export function milestoneShort(milestone: Milestone, nowSeconds: number): string {
  const left = milestone.moment.time - nowSeconds;
  if (left <= 0) return SHORT_PASSED[milestone.label] ?? milestone.label;
  const verb = SHORT_VERB[milestone.label] ?? milestone.label;
  return `${verb} ${milestone.moment.estimated ? "~" : ""}${formatDuration(left)}`;
}

/** USDC for a card's footer: whole units from 100 up ("1,240"), two decimals below ("80.00"). */
export function compactUsdc(base: bigint): string {
  return base >= 100n * 10n ** BigInt(USDC_DECIMALS)
    ? formatFixed(base, USDC_DECIMALS, { maxDecimals: 0 })
    : formatUsdc(base);
}

/** A 1e18 price as cents, to a tenth: 0.64 USDC reads "64c", 0.645 reads "64.5c". */
export function priceCents(priceE18: bigint): string {
  const bps = Number(priceE18ToBps(priceE18));
  const whole = Math.trunc(bps / 100);
  const tenth = Math.trunc((bps % 100) / 10);
  return tenth === 0 ? `${whole}c` : `${whole}.${tenth}c`;
}

export interface CardTile {
  label: string;
  value: string;
  unit?: string;
}

/**
 * The two tiles under a card's chance. A pool shows what each side has staked. A live book shows what
 * a share costs now: YES at the best ask, NO at one minus the best bid. Other phases show none.
 */
export function cardTiles(m: Pick<MarketView, "phase" | "pool" | "quote">): [CardTile, CardTile] | null {
  if (m.phase === Phase.Pool) {
    return [
      { label: "Yes pool", value: formatUsdc(m.pool.yes), unit: "USDC" },
      { label: "No pool", value: formatUsdc(m.pool.no), unit: "USDC" },
    ];
  }
  if (m.phase === Phase.Graduated && m.quote) {
    return [
      { label: "Yes", value: m.quote.ask === null ? "n/a" : priceCents(m.quote.ask) },
      { label: "No", value: m.quote.bid === null ? "n/a" : priceCents(PRICE_SCALE - m.quote.bid) },
    ];
  }
  return null;
}

export type CardBody =
  | { kind: "outcome"; text: string; side: "yes" | "no" | null }
  | { kind: "note"; text: string }
  | { kind: "chance"; bps: bigint; tiles: [CardTile, CardTile] | null };

/** What sits between a card's title and its footer: the result, a note, or the chance and its tiles. */
export function cardBody(
  m: Pick<MarketView, "phase" | "outcome" | "pool" | "quote" | "venue" | "kuruVersion">,
): CardBody {
  const chance = marketChance(m);
  if (chance.source === "settled") {
    return { kind: "outcome", text: chance.note, side: chance.bps === BPS ? "yes" : "no" };
  }
  if (chance.source === "void") return { kind: "outcome", text: chance.note, side: null };
  if (chance.bps === null) return { kind: "note", text: chance.note };
  return { kind: "chance", bps: chance.bps, tiles: cardTiles(m) };
}

// ---------------------------------------------------------------- the panel's figures

export interface ExplorerStats {
  /** Pools filling plus books trading. */
  open: number;
  /** The mean YES chance over open and settling markets that have one, in basis points. */
  avgYesBps: number | null;
}

export function explorerStats(
  markets: readonly Pick<MarketView, "phase" | "outcome" | "pool" | "quote" | "venue" | "kuruVersion">[],
): ExplorerStats {
  let open = 0;
  let sum = 0;
  let priced = 0;
  for (const m of markets) {
    const group = phaseGroup(m.phase);
    if (group === "pools" || group === "trading") open += 1;
    if (group === "settled") continue;
    const chance = marketChance(m);
    if (chance.bps === null) continue;
    sum += Number(chance.bps);
    priced += 1;
  }
  return { open, avgYesBps: priced === 0 ? null : Math.round(sum / priced) };
}

/** Basis points as a whole percent: 4,830 reads "48%". */
export function wholePercent(bps: number): string {
  return `${Math.round(bps / 100)}%`;
}

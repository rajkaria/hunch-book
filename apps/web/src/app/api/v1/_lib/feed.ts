import { formatUsdc, type MarketInfo } from "@hunch-book/sdk";
import type { ApiDeps } from "./deps";
import { type ChainClock, embedUrl, marketUrl, pointTime, priceString } from "./markets";

// The feed the main Hunch app (and anyone) reads to list Hunch Book markets: one small card per open
// market (a pool taking stakes, or a book trading), in a schema that stays stable across versions.
// docs/API.md documents every field.

export const FEED_VERSION = 1;

export interface FeedCard {
  /** Stable across requests: "hunch-book:<network>:<market address>". */
  id: string;
  marketId: number;
  address: string;
  /** The rule in one sentence, from the market's resolver. */
  title: string;
  template: string;
  asset: string | null;
  /** "pool": staking open. "trading": YES and NO trade on the book. */
  status: "pool" | "trading";
  chance: {
    /** 0 to 1, or null when there is no price yet. */
    yes: number | null;
    bps: number | null;
    /** "pool": the pool's split. "book": the book's mid. "book-one-sided": the one side with orders. */
    source: string;
  };
  pool: { totalUsdc: string; stakers: number };
  /** Best YES prices on the book, USDC per token, while trading. */
  book: { bid: string | null; ask: string | null } | null;
  /** When staking stops (pool) or the market closes (trading), ISO 8601 UTC. */
  endsAt: string | null;
  /** True for block-clock markets, whose times are estimated from the measured block time. */
  endsAtEstimated: boolean;
  url: string;
  embedUrl: string;
}

export function feedCard(m: MarketInfo, deps: ApiDeps, clock: ChainClock | null): FeedCard {
  const status = m.phaseName === "trading" ? "trading" : "pool";
  const ends = status === "pool" ? m.window.lock : m.window.close;
  return {
    id: `hunch-book:${deps.network}:${m.address.toLowerCase()}`,
    marketId: m.id,
    address: m.address,
    title: m.rule ?? `${m.template}${m.asset ? ` on ${m.asset}` : ""}`,
    template: m.template,
    asset: m.asset,
    status,
    chance: {
      yes: m.chance.bps === null ? null : m.chance.bps / 10_000,
      bps: m.chance.bps,
      source: m.chance.source,
    },
    pool: { totalUsdc: formatUsdc(m.pool.total), stakers: m.pool.stakers },
    book:
      m.book && status === "trading"
        ? { bid: priceString(m.prices?.bidE6), ask: priceString(m.prices?.askE6) }
        : null,
    endsAt: pointTime(m.window, ends, clock),
    endsAtEstimated: m.window.blockClock,
    url: marketUrl(deps, m.address),
    embedUrl: embedUrl(deps, m.address),
  };
}

/** The feed: open markets, ending soonest first. */
export function feed(markets: MarketInfo[], deps: ApiDeps, clock: ChainClock | null) {
  const cards = markets
    .filter((m) => m.phaseName === "pool" || m.phaseName === "trading")
    .map((m) => feedCard(m, deps, clock))
    .sort((a, b) => (a.endsAt ?? "9999").localeCompare(b.endsAt ?? "9999"));
  return {
    version: FEED_VERSION,
    source: "Hunch Book",
    network: deps.network,
    generatedAt: new Date(deps.now()).toISOString(),
    home: deps.siteUrl,
    count: cards.length,
    cards,
  };
}

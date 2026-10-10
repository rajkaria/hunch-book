import {
  addressUrl,
  assetMatches,
  formatBps,
  formatUsdc,
  type MarketInfo,
  type PhaseName,
  type Window,
} from "@hunch-book/sdk";
import { stackNamed, type Venue, venueLabel } from "@hunch-book/shared";
import { type Address, getAddress, isAddress, isAddressEqual } from "viem";
import { challengeSecondsFor, type Health, marketHealth } from "../../../../lib/health/score";
import { friendlyQuestion } from "../../../../lib/market/title";
import { cached } from "./cache";
import type { ApiDeps } from "./deps";

// How the data API writes a market: amounts as exact decimal strings in USDC ("690" or "12.5"),
// prices as decimal strings in USDC per token ("0.399"), chances in basis points, times as ISO 8601
// UTC (estimated from the measured block time for block-clock markets), and links back to the app.
// Each market names its stack and its book's venue: "hunch" (Hunch Book's own onchain order book) or
// "kuru", with a label ("Hunch order book", "Kuru" or "Kuru v2"). Each stack's factory numbers its
// markets from 1, so `id` alone is unique only within a stack.

export const PHASE_NAMES: readonly PhaseName[] = [
  "pool",
  "pool-locked",
  "trading",
  "closed",
  "settled",
  "voided",
];

/** "open" is pool and trading: the markets someone can still stake in or trade. */
export type PhaseFilter = PhaseName | "open";

export interface ChainClock {
  block: bigint;
  /** Unix seconds of the latest block. */
  timestamp: number;
  /** Measured over the last 10,000 blocks. */
  msPerBlock: number;
}

const FALLBACK_MS_PER_BLOCK = 400;

/**
 * A market's title for people: the resolver's sentence, with a Perpl window's block numbers turned into
 * estimated clock times (the same wording as the app). The exact sentence stays in `rule`.
 */
export function marketTitleText(
  m: Pick<MarketInfo, "rule" | "template" | "id">,
  clock: ChainClock | null,
): string {
  if (!m.rule) return `${m.template} market #${m.id}`;
  return friendlyQuestion(
    m.rule,
    clock ? { blockNumber: clock.block, timestamp: clock.timestamp, msPerBlock: clock.msPerBlock } : null,
  );
}

/** The chain head and its measured block time, cached for 30 seconds (the block time for 10 minutes). */
export async function chainClock(deps: ApiDeps): Promise<ChainClock> {
  return cached(
    `clock:${deps.network}`,
    30_000,
    async () => {
      const client = deps.sdk.context.publicClient;
      const latest = await client.getBlock({ blockTag: "latest" });
      const span = 10_000n;
      const msPerBlock = await cached(`block-time:${deps.network}`, 600_000, async () => {
        if (latest.number <= span) return FALLBACK_MS_PER_BLOCK;
        const earlier = await client.getBlock({ blockNumber: latest.number - span });
        const ms = (Number(latest.timestamp - earlier.timestamp) * 1000) / Number(span);
        return ms > 0 ? ms : FALLBACK_MS_PER_BLOCK;
      }).catch(() => FALLBACK_MS_PER_BLOCK);
      return { block: latest.number, timestamp: Number(latest.timestamp), msPerBlock };
    },
    deps.now(),
  );
}

const isoSeconds = (seconds: number): string => new Date(seconds * 1000).toISOString();

/** A window point as a time: exact for time-clock markets, estimated for block-clock ones. */
export function pointTime(window: Window, value: bigint, clock: ChainClock | null): string | null {
  if (!window.blockClock) return isoSeconds(Number(value));
  if (!clock) return null;
  return isoSeconds(Math.round(clock.timestamp + (Number(value - clock.block) * clock.msPerBlock) / 1000));
}

const e6ToNumber = (v: bigint | null | undefined): number | null =>
  v === null || v === undefined ? null : Number(v) / 1e6;

/** The market's health score (lib/health/score.ts), from what the API already read. */
export function healthOf(
  m: MarketInfo,
  deps: Pick<ApiDeps, "network" | "now">,
  clock: ChainClock | null,
): Health {
  const now = clock?.timestamp ?? Math.floor(deps.now() / 1000);
  const at = (point: bigint): number =>
    !m.window.blockClock
      ? Number(point)
      : clock
        ? clock.timestamp + (Number(point - clock.block) * clock.msPerBlock) / 1000
        : Number.NaN;
  const closeAt = at(m.window.close);
  return marketHealth({
    phase: m.phase,
    graduated: m.graduated,
    templateId: m.templateId,
    network: deps.network,
    bid: e6ToNumber(m.prices?.bidE6),
    ask: e6ToNumber(m.prices?.askE6),
    pool: { yesUsdc: Number(m.pool.yes) / 1e6, noUsdc: Number(m.pool.no) / 1e6, stakers: m.pool.stakers },
    rule: { minPoolUsdc: Number(m.graduationRule.minPool) / 1e6, minStakers: m.graduationRule.minStakers },
    now,
    closeAt,
    lockAt: at(m.window.lock),
    settleFrom: closeAt + challengeSecondsFor(m.templateId),
  });
}

export function priceString(e6: bigint | null | undefined): string | null {
  return e6 === null || e6 === undefined ? null : formatUsdc(e6);
}

/** Wallets the deployments file names as ours: the maker bot, the keeper, the guardian, the fee recipient. */
export function ourWallets(deps: Pick<ApiDeps, "deployment">): Address[] {
  const d = deps.deployment;
  return [d.wallets.maker, d.wallets.keeper, d.hunchBook.guardian, d.hunchBook.feeRecipient].filter(
    (a): a is Address => typeof a === "string" && isAddress(a),
  );
}

export function isOurs(deps: Pick<ApiDeps, "deployment">, who: string): boolean {
  return isAddress(who) && ourWallets(deps).some((a) => isAddressEqual(a, who));
}

export interface MarketVenue {
  /** "primary" or a key under `stacks` in deployments/<network>.json. */
  stack: string;
  venue: Venue;
  /** "Hunch order book", "Kuru" or "Kuru v2". */
  venueLabel: string;
}

/** The market's stack and its book's venue, from deployments/<network>.json. */
export function stackVenue(
  m: Pick<MarketInfo, "stack" | "kuruVersion">,
  deps: Pick<ApiDeps, "deployment">,
): MarketVenue {
  const stack = stackNamed(deps.deployment, m.stack ?? "primary");
  const venue: Venue = stack?.venue ?? "kuru";
  const kuruVersion = m.kuruVersion ?? stack?.kuruVersion ?? 1;
  return {
    stack: stack?.name ?? m.stack ?? "primary",
    venue,
    venueLabel: venueLabel({ venue, kuruVersion }),
  };
}

/** What to call the market's book in a phrase: "Hunch order book", "Kuru v2 book" or "Kuru book". */
export function bookWords(v: Pick<MarketVenue, "venue" | "venueLabel">): string {
  return v.venue === "hunch" ? v.venueLabel : `${v.venueLabel} book`;
}

export function marketUrl(deps: Pick<ApiDeps, "siteUrl">, address: Address): string {
  return `${deps.siteUrl}/m/${address}`;
}

export function embedUrl(deps: Pick<ApiDeps, "siteUrl">, address: Address): string {
  return `${deps.siteUrl}/embed/m/${address}`;
}

/** The API's view of one market. */
export function marketJson(m: MarketInfo, deps: ApiDeps, clock: ChainClock | null) {
  const mid =
    m.prices?.bidE6 != null && m.prices.askE6 != null ? (m.prices.bidE6 + m.prices.askE6) / 2n : null;
  const venue = stackVenue(m, deps);
  return {
    id: m.id,
    address: m.address,
    network: deps.network,
    stack: venue.stack,
    venue: venue.venue,
    venueLabel: venue.venueLabel,
    url: marketUrl(deps, m.address),
    embedUrl: embedUrl(deps, m.address),
    explorer: addressUrl(deps.deployment, m.address),
    template: { id: m.templateId, name: m.template },
    asset: m.asset,
    rule: m.rule,
    phase: m.phaseName,
    phaseLabel: m.phaseLabel,
    outcome: m.outcomeLabel,
    chance: { bps: m.chance.bps, percent: formatBps(m.chance.bps), source: m.chance.source },
    pool: {
      yesUsdc: formatUsdc(m.pool.yes),
      noUsdc: formatUsdc(m.pool.no),
      totalUsdc: formatUsdc(m.pool.total),
      stakers: m.pool.stakers,
    },
    book: m.book
      ? {
          address: m.book,
          bid: priceString(m.prices?.bidE6),
          ask: priceString(m.prices?.askE6),
          mid: priceString(mid),
          spread:
            m.prices?.bidE6 != null && m.prices.askE6 != null
              ? priceString(m.prices.askE6 - m.prices.bidE6)
              : null,
        }
      : null,
    window: {
      clock: m.window.blockClock ? "block" : "time",
      lock: m.window.lock.toString(),
      close: m.window.close.toString(),
      lockAt: pointTime(m.window, m.window.lock, clock),
      closeAt: pointTime(m.window, m.window.close, clock),
      estimated: m.window.blockClock,
      settleDeadline: isoSeconds(Number(m.window.settleDeadline)),
    },
    graduated: m.graduated,
    graduationRule: {
      minPoolUsdc: formatUsdc(m.graduationRule.minPool),
      minStakers: m.graduationRule.minStakers,
      minChanceBps: m.graduationRule.minChanceBps,
      maxChanceBps: m.graduationRule.maxChanceBps,
      met: m.graduationRuleMet,
    },
    tokens: m.tokens,
    resolver: m.resolver,
    creator: m.creator,
    createdByHunch: isOurs(deps, m.creator),
    evidenceHash: /^0x0+$/.test(m.evidenceHash) ? null : m.evidenceHash,
    health: healthOf(m, deps, clock),
  };
}

export type MarketJson = ReturnType<typeof marketJson>;

export interface MarketFilters {
  phase: PhaseFilter | null;
  template: number | null;
  asset: string | null;
  limit: number;
  offset: number;
}

/** Reads `phase`, `template`, `asset`, `limit` (1 to 200, default 50) and `offset` from the query. */
export function parseFilters(url: URL): MarketFilters | string {
  const q = url.searchParams;
  const phase = q.get("phase")?.trim().toLowerCase() || null;
  if (phase && phase !== "open" && !PHASE_NAMES.includes(phase as PhaseName)) {
    return `phase must be one of open, ${PHASE_NAMES.join(", ")}.`;
  }
  const template = q.get("template");
  if (template !== null && !/^[1-9]\d?$/.test(template)) return "template must be a template id, such as 1.";
  const limit = q.get("limit");
  if (limit !== null && !/^\d+$/.test(limit)) return "limit must be a whole number.";
  const offset = q.get("offset");
  if (offset !== null && !/^\d+$/.test(offset)) return "offset must be a whole number.";
  const asset = q.get("asset")?.trim() || null;
  if (asset && !/^[A-Za-z0-9/]{1,16}$/.test(asset)) return "asset must be a symbol such as BTC or BTC/USD.";
  return {
    phase: phase as PhaseFilter | null,
    template: template === null ? null : Number(template),
    asset,
    limit: Math.min(200, Math.max(1, limit === null ? 50 : Number(limit))),
    offset: offset === null ? 0 : Number(offset),
  };
}

export function matches(m: MarketInfo, f: Pick<MarketFilters, "phase" | "template" | "asset">): boolean {
  if (f.phase === "open" && m.phaseName !== "pool" && m.phaseName !== "trading") return false;
  if (f.phase && f.phase !== "open" && m.phaseName !== f.phase) return false;
  if (f.template !== null && m.templateId !== f.template) return false;
  if (f.asset && !assetMatches(m.asset, f.asset)) return false;
  return true;
}

/** Every market, read from the chain at most every 15 seconds per server. */
export function allMarkets(deps: ApiDeps): Promise<MarketInfo[]> {
  return cached(`markets:${deps.network}`, 15_000, () => deps.sdk.markets.all(), deps.now());
}

/** A checksummed address from a path segment, or null. */
export function addressParam(value: string): Address | null {
  return isAddress(value, { strict: false }) ? getAddress(value) : null;
}

export const MARKET_CSV_COLUMNS = [
  "id",
  "address",
  "template_id",
  "template",
  "asset",
  "phase",
  "outcome",
  "chance_bps",
  "chance_source",
  "pool_yes_usdc",
  "pool_no_usdc",
  "pool_total_usdc",
  "stakers",
  "best_bid",
  "best_ask",
  "clock",
  "lock",
  "close",
  "close_at",
  "settle_deadline",
  "created_by_hunch",
  "health_score",
  "rule",
  "url",
  "stack",
  "venue",
] as const;

export function marketCsvRow(j: MarketJson): Record<string, unknown> {
  return {
    id: j.id,
    address: j.address,
    template_id: j.template.id,
    template: j.template.name,
    asset: j.asset,
    phase: j.phase,
    outcome: j.outcome,
    chance_bps: j.chance.bps,
    chance_source: j.chance.source,
    pool_yes_usdc: j.pool.yesUsdc,
    pool_no_usdc: j.pool.noUsdc,
    pool_total_usdc: j.pool.totalUsdc,
    stakers: j.pool.stakers,
    best_bid: j.book?.bid,
    best_ask: j.book?.ask,
    clock: j.window.clock,
    lock: j.window.lock,
    close: j.window.close,
    close_at: j.window.closeAt,
    settle_deadline: j.window.settleDeadline,
    created_by_hunch: j.createdByHunch,
    health_score: j.health.score,
    rule: j.rule,
    url: j.url,
    stack: j.stack,
    venue: j.venue,
  };
}

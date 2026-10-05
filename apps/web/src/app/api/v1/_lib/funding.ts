import { addressUrl, type Deployment, formatBps, formatUsdc, type MarketInfo } from "@hunch-book/sdk";
import { blockWindowWords, type TitleClock } from "../../../../lib/market/title";
import type { ApiDeps } from "./deps";
import {
  type ChainClock,
  embedUrl,
  isOurs,
  marketTitleText,
  marketUrl,
  pointTime,
  priceString,
} from "./markets";

// "What does the market think?" for one Perpl perp: the open Hunch Book market that asks whether that
// perp's longs pay funding this period (template 1, Perpl net funding), its chance, and links. Served as
// JSON at /api/v1/funding/<asset> and as an iframe card at /embed/funding/<asset> (docs/API.md).

/** Which market answers, in words. The JSON carries it, so a reader knows why this one. */
export const FUNDING_PICK = {
  rule: "running-window-first-then-newest",
  text:
    "Among the open template 1 (Perpl net funding) markets on this perp (a pool taking stakes before its " +
    "window starts, or a book trading before its window ends), the newest one whose funding window is " +
    "running now; if none is running, the newest one still to start. Newest is the highest market number.",
} as const;

export type PerpParam = { asset: string; perpId: bigint } | "bad" | "unknown";

/** The perp a path segment names: "BTC" or "btc" for the deployment's BTC perp. */
export function perpParam(raw: string, deployment: Pick<Deployment, "external">): PerpParam {
  const value = raw.trim();
  if (!/^[A-Za-z0-9]{1,16}$/.test(value)) return "bad";
  const want = value.toUpperCase();
  const entry = Object.entries(deployment.external.perpl.perps).find(([name]) => name.toUpperCase() === want);
  return entry ? { asset: entry[0], perpId: BigInt(entry[1]) } : "unknown";
}

/** The perps a deployment lists, for error messages: "BTC, ETH, SOL, MON". */
export function knownAssets(deployment: Pick<Deployment, "external">): string {
  return Object.keys(deployment.external.perpl.perps).join(", ");
}

/** True once the chain is at or past a window point (block or unix time). Unknown without a clock. */
function reached(m: MarketInfo, value: bigint, clock: ChainClock | null): boolean | null {
  if (!clock) return null;
  return m.window.blockClock ? clock.block >= value : BigInt(clock.timestamp) >= value;
}

/**
 * A market someone can act on now: a pool before its lock (stake), or a book before its close (trade).
 * The phase alone lags (it moves on the next transaction), so the chain head is checked too.
 */
export function isOpenNow(m: MarketInfo, clock: ChainClock | null): boolean {
  if (m.phaseName === "pool") return reached(m, m.window.lock, clock) !== true;
  if (m.phaseName === "trading") return reached(m, m.window.close, clock) !== true;
  return false;
}

/** The funding window A to B of a template 1 market, or null for any other market. */
export function fundingWindow(
  m: MarketInfo,
): { perpId: bigint; start: bigint; end: bigint; threshold: bigint; scalingExp: number } | null {
  if (m.decoded.kind !== "perpl-funding") return null;
  const p = m.decoded.params;
  return {
    perpId: p.perpId,
    start: p.startBlock,
    end: p.endBlock,
    threshold: p.threshold,
    scalingExp: p.expectedScalingExp,
  };
}

/** Open template 1 markets on this perp, newest first. */
export function fundingCandidates(
  markets: readonly MarketInfo[],
  perpId: bigint,
  clock: ChainClock | null,
): MarketInfo[] {
  return markets
    .filter((m) => fundingWindow(m)?.perpId === perpId && isOpenNow(m, clock))
    .sort((a, b) => b.id - a.id);
}

/** True when the market's funding window has started: A at or before the head (or trading, without a clock). */
export function windowRunning(m: MarketInfo, clock: ChainClock | null): boolean {
  const w = fundingWindow(m);
  if (!w) return false;
  return clock ? clock.block >= w.start : m.phaseName === "trading";
}

/** FUNDING_PICK applied to the candidates (already newest first). */
export function pickFundingMarket(
  candidates: readonly MarketInfo[],
  clock: ChainClock | null,
): { market: MarketInfo; matched: "running" | "upcoming" } | null {
  const running = candidates.find((m) => windowRunning(m, clock));
  if (running) return { market: running, matched: "running" };
  const upcoming = candidates[0];
  return upcoming ? { market: upcoming, matched: "upcoming" } : null;
}

const RULE_CLAUSE =
  /^Will (\S+) longs (?:pay shorts on net|pay more than (-?)\$([\d,]+(?:\.\d+)?) per (\S+)) in funding on Perpl/;

/**
 * What YES means, as a clause: "BTC longs pay more than $12.04 per BTC", "BTC longs pay shorts on net",
 * or for a negative threshold "BTC shorts pay longs less than $5 per BTC on net". Read from the
 * resolver's own sentence (the rule of record); from the params when the resolver did not answer.
 */
export function fundingClause(rule: string | null, symbol: string, threshold: bigint): string {
  const match = rule ? RULE_CLAUSE.exec(rule) : null;
  if (match) {
    const [, who = symbol, minus, amount, unit = who] = match;
    if (amount === undefined) return `${who} longs pay shorts on net`;
    return minus
      ? `${who} shorts pay longs less than $${amount} per ${unit} on net`
      : `${who} longs pay more than $${amount} per ${unit}`;
  }
  if (threshold === 0n) return `${symbol} longs pay shorts on net`;
  return `${symbol} longs pay more than ${threshold.toString()} raw Perpl funding units`;
}

/** "85-minute", "24-hour", "3-day": a window's length in words, to the nearest 5 minutes, hour or day. */
export function durationWords(seconds: number): string {
  if (seconds < 2 * 3_600) return `${Math.max(5, Math.round(seconds / 300) * 5)}-minute`;
  const hours = Math.round(seconds / 3_600);
  if (hours < 48) return `${hours}-hour`;
  return `${Math.round(seconds / 86_400)}-day`;
}

/**
 * The period in words: "this week" for a running window of about seven days, "in the coming week"
 * before it starts; otherwise "in this 24-hour window" or "in the next 3-day window".
 */
export function periodWords(blocks: bigint, msPerBlock: number, running: boolean): string {
  const seconds = (Number(blocks) * msPerBlock) / 1000;
  const days = seconds / 86_400;
  if (days >= 6.5 && days <= 7.5) return running ? "this week" : "in the coming week";
  return `in ${running ? "this" : "the next"} ${durationWords(seconds)} window`;
}

/** "62%", with "under 1%" and "over 99%" so a near-certain market never rounds to a certainty. */
export function wholePercent(bps: number | null): string | null {
  if (bps === null) return null;
  if (bps > 0 && bps < 50) return "under 1%";
  if (bps < 10_000 && bps >= 9_950) return "over 99%";
  return `${Math.round(bps / 100)}%`;
}

const CHANCE_WORDS: Record<string, string> = {
  pool: "the pool's split",
  book: "the Kuru book's mid",
  "book-one-sided": "the one side of the Kuru book with orders",
  "book-empty": "no orders on the book yet",
  empty: "no stakes yet",
};

export function chanceWords(source: string): string {
  return CHANCE_WORDS[source] ?? source;
}

const FALLBACK_MS_PER_BLOCK = 400;

const titleClock = (clock: ChainClock | null): TitleClock | null =>
  clock ? { blockNumber: clock.block, timestamp: clock.timestamp, msPerBlock: clock.msPerBlock } : null;

/** The picked market as the funding endpoint writes it. */
export function fundingMarketJson(
  m: MarketInfo,
  asset: string,
  running: boolean,
  deps: Pick<ApiDeps, "siteUrl" | "deployment">,
  clock: ChainClock | null,
) {
  const w = fundingWindow(m);
  const start = w?.start ?? m.window.lock;
  const end = w?.end ?? m.window.close;
  const clause = fundingClause(m.rule, asset, w?.threshold ?? 0n);
  const period = periodWords(end - start, clock?.msPerBlock ?? FALLBACK_MS_PER_BLOCK, running);
  const percent = wholePercent(m.chance.bps);
  const bid = m.prices?.bidE6 ?? null;
  const ask = m.prices?.askE6 ?? null;
  const api = `${deps.siteUrl}/api/v1/markets/${m.address}`;
  return {
    id: m.id,
    address: m.address,
    phase: m.phaseName,
    phaseLabel: m.phaseLabel,
    headline: `Market's chance ${clause} ${period}: ${percent ?? "no price yet"}`,
    clause,
    period,
    question: marketTitleText(m, clock),
    rule: m.rule,
    chance: {
      yes: m.chance.bps === null ? null : m.chance.bps / 10_000,
      bps: m.chance.bps,
      percent: formatBps(m.chance.bps),
      source: m.chance.source,
      words: chanceWords(m.chance.source),
    },
    window: {
      startBlock: start.toString(),
      endBlock: end.toString(),
      startAt: pointTime(m.window, start, clock),
      endAt: pointTime(m.window, end, clock),
      estimated: m.window.blockClock,
      running,
      words: blockWindowWords(start, end, titleClock(clock)),
    },
    threshold: w ? { raw: w.threshold.toString(), expectedScalingExp: w.scalingExp } : null,
    pool: { totalUsdc: formatUsdc(m.pool.total), stakers: m.pool.stakers },
    book:
      m.phaseName === "trading" && m.book
        ? {
            bid: priceString(bid),
            ask: priceString(ask),
            mid: bid !== null && ask !== null ? priceString((bid + ask) / 2n) : null,
          }
        : null,
    createdByHunch: isOurs(deps, m.creator),
    links: {
      app: marketUrl(deps, m.address),
      verify: `${deps.siteUrl}/verify/${m.address}`,
      api,
      evidence: `${api}/evidence`,
      embed: embedUrl(deps, m.address),
      explorer: addressUrl(deps.deployment, m.address),
    },
  };
}

export type FundingMarketJson = ReturnType<typeof fundingMarketJson>;

/** The body of /api/v1/funding/<asset>; the iframe card renders the same object. */
export function fundingView(
  markets: readonly MarketInfo[],
  perp: { asset: string; perpId: bigint },
  deps: Pick<ApiDeps, "siteUrl" | "deployment" | "network">,
  clock: ChainClock | null,
) {
  const candidates = fundingCandidates(markets, perp.perpId, clock);
  const picked = pickFundingMarket(candidates, clock);
  const asset = encodeURIComponent(perp.asset);
  const market = picked
    ? fundingMarketJson(picked.market, perp.asset, picked.matched === "running", deps, clock)
    : null;
  return {
    network: deps.network,
    asset: perp.asset,
    perp: { id: perp.perpId.toString(), exchange: deps.deployment.external.perpl.exchange },
    pick: { ...FUNDING_PICK, matched: picked?.matched ?? null, candidates: candidates.length },
    market,
    reason: picked
      ? null
      : `No template 1 (Perpl net funding) market on ${perp.asset} is open right now: none is taking stakes before its window starts or trading before its window ends.`,
    alsoOpen: candidates
      .filter((m) => m !== picked?.market)
      .map((m) => ({
        id: m.id,
        address: m.address,
        phase: m.phaseName,
        question: marketTitleText(m, clock),
        chance: { bps: m.chance.bps, percent: formatBps(m.chance.bps), source: m.chance.source },
        url: marketUrl(deps, m.address),
      })),
    asOf: clock
      ? { block: clock.block.toString(), time: new Date(clock.timestamp * 1000).toISOString() }
      : null,
    links: {
      embed: `${deps.siteUrl}/embed/funding/${asset}`,
      calculator: `${deps.siteUrl}/calculator?perp=${asset}`,
      markets: `${deps.siteUrl}/api/v1/markets?template=1&asset=${asset}&phase=open`,
      create: `${deps.siteUrl}/create?template=1&asset=${asset}`,
    },
  };
}

export type FundingView = ReturnType<typeof fundingView>;

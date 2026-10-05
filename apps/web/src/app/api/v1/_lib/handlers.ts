import { describeError, formatUsdc, levelsE6, type MarketInfo } from "@hunch-book/sdk";
import { cached } from "./cache";
import type { ApiDeps } from "./deps";
import { EMBED_CSP, renderFundingCard, renderMarketCard, renderMessage } from "./embed";
import { feed } from "./feed";
import { fundingView, knownAssets, perpParam } from "./funding";
import { CACHE, csv, flatten, json, problem, wantsCsv } from "./http";
import {
  addressParam,
  allMarkets,
  type ChainClock,
  chainClock,
  MARKET_CSV_COLUMNS,
  marketCsvRow,
  marketJson,
  matches,
  parseFilters,
} from "./markets";
import {
  archive,
  isFinal,
  parseArchiveQuery,
  SETTLEMENT_CSV_COLUMNS,
  settlementCsvRow,
  verification,
} from "./settlements";
import { protocolStats } from "./stats";
import { DEFAULT_LOOKBACK, MAX_LOOKBACK, marketTrades, TRADE_CSV_COLUMNS } from "./trades";

// Every data API endpoint as a function of (request, dependencies) returning a Response. The route
// files under app/api/v1 only wire these to the process's dependencies; tests call them directly.

export const API_VERSION = "v1";

const clockOrNull = (deps: ApiDeps): Promise<ChainClock | null> => chainClock(deps).catch(() => null);

/** Any failure as a 502 with one plain sentence: the chain or the indexer did not answer. */
async function guard(run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (e) {
    return problem(502, `Could not read the chain right now: ${describeError(e)}`);
  }
}

async function oneMarket(deps: ApiDeps, raw: string): Promise<MarketInfo | Response> {
  const address = addressParam(raw);
  if (!address) return problem(400, `${raw.slice(0, 64)} is not an address.`);
  const m = await cached(
    `market:${deps.network}:${address}`,
    15_000,
    () => deps.sdk.markets.get(address),
    deps.now(),
  );
  if (!m) return problem(404, `${address} is not a Hunch Book market on ${deps.network}.`);
  return m;
}

/** GET /api/v1: what the API serves. */
export function getIndex(_request: Request, deps: ApiDeps): Response {
  const base = `${deps.siteUrl}/api/${API_VERSION}`;
  return json(
    {
      name: "Hunch Book data API",
      version: API_VERSION,
      network: deps.network,
      docs: "https://github.com/rajkaria/hunch-book/blob/main/docs/API.md",
      endpoints: {
        markets: `${base}/markets?phase=&template=&asset=&limit=&offset=&format=csv`,
        market: `${base}/markets/{address}`,
        trades: `${base}/markets/{address}/trades?limit=&blocks=&fromBlock=&format=csv`,
        evidence: `${base}/markets/{address}/evidence`,
        settlements: `${base}/settlements?template=&limit=&offset=&format=csv`,
        stats: `${base}/stats`,
        feed: `${base}/feed`,
        funding: `${base}/funding/{asset}`,
        embed: `${deps.siteUrl}/embed/m/{address}`,
        fundingEmbed: `${deps.siteUrl}/embed/funding/{asset}`,
      },
    },
    CACHE.slow,
  );
}

/** GET /api/v1/markets */
export async function getMarkets(request: Request, deps: ApiDeps): Promise<Response> {
  const filters = parseFilters(new URL(request.url));
  if (typeof filters === "string") return problem(400, filters);
  return guard(async () => {
    const [all, clock] = await Promise.all([allMarkets(deps), clockOrNull(deps)]);
    const matching = all.filter((m) => matches(m, filters));
    const page = matching
      .slice(filters.offset, filters.offset + filters.limit)
      .map((m) => marketJson(m, deps, clock));
    if (wantsCsv(request))
      return csv(page.map(marketCsvRow), MARKET_CSV_COLUMNS, "hunch-book-markets.csv", CACHE.live);
    return json(
      {
        network: deps.network,
        total: all.length,
        matching: matching.length,
        offset: filters.offset,
        limit: filters.limit,
        markets: page,
      },
      CACHE.live,
    );
  });
}

/** GET /api/v1/markets/{address} */
export async function getMarket(request: Request, raw: string, deps: ApiDeps): Promise<Response> {
  return guard(async () => {
    const m = await oneMarket(deps, raw);
    if (m instanceof Response) return m;
    const [clock, book] = await Promise.all([
      clockOrNull(deps),
      m.book && m.graduated ? deps.sdk.markets.book(m).catch(() => null) : Promise.resolve(null),
    ]);
    const base = marketJson(m, deps, clock);
    const body = {
      ...base,
      params: m.decoded,
      ...(m.snapshotSource ? { snapshotSource: m.snapshotSource } : {}),
      caps: {
        poolCapUsdc: formatUsdc(m.caps.poolCap),
        walletCapUsdc: formatUsdc(m.caps.walletCap),
        minStakeUsdc: formatUsdc(m.caps.minStake),
        creatorMinStakeUsdc: formatUsdc(m.caps.creatorMinStake),
      },
      book: base.book && {
        ...base.book,
        levels: book
          ? {
              bids: levelsE6(book.bids, book.params)
                .slice(0, 20)
                .map((l) => ({ price: formatUsdc(l.priceE6), sizeYes: formatUsdc(l.size) })),
              asks: levelsE6(book.asks, book.params)
                .slice(0, 20)
                .map((l) => ({ price: formatUsdc(l.priceE6), sizeYes: formatUsdc(l.size) })),
              block: book.block.toString(),
            }
          : null,
      },
      links: {
        trades: `${deps.siteUrl}/api/${API_VERSION}/markets/${m.address}/trades`,
        evidence: `${deps.siteUrl}/api/${API_VERSION}/markets/${m.address}/evidence`,
      },
    };
    if (wantsCsv(request))
      return csv(flatten(body), ["field", "value"], `hunch-book-market-${m.id}.csv`, CACHE.live);
    return json(body, CACHE.live);
  });
}

/** GET /api/v1/markets/{address}/trades */
export async function getTrades(request: Request, raw: string, deps: ApiDeps): Promise<Response> {
  const q = new URL(request.url).searchParams;
  const limitRaw = q.get("limit");
  const blocksRaw = q.get("blocks");
  const fromRaw = q.get("fromBlock");
  if (limitRaw !== null && !/^\d+$/.test(limitRaw)) return problem(400, "limit must be a whole number.");
  if (blocksRaw !== null && !/^\d+$/.test(blocksRaw)) return problem(400, "blocks must be a whole number.");
  if (fromRaw !== null && !/^\d{1,15}$/.test(fromRaw))
    return problem(400, "fromBlock must be a block number.");
  const limit = Math.min(500, Math.max(1, limitRaw === null ? 100 : Number(limitRaw)));
  const blocksWanted = blocksRaw === null ? DEFAULT_LOOKBACK : BigInt(blocksRaw);
  const blocks = blocksWanted > MAX_LOOKBACK ? MAX_LOOKBACK : blocksWanted < 1n ? 1n : blocksWanted;
  const fromBlock = fromRaw === null ? null : BigInt(fromRaw);
  return guard(async () => {
    const m = await oneMarket(deps, raw);
    if (m instanceof Response) return m;
    const result = await marketTrades(deps, m, { blocks, fromBlock }, limit);
    if (wantsCsv(request)) {
      return csv(
        result.trades as unknown as Record<string, unknown>[],
        TRADE_CSV_COLUMNS,
        `hunch-book-trades-${m.id}.csv`,
        CACHE.recent,
      );
    }
    return json({ market: m.address, id: m.id, count: result.trades.length, ...result }, CACHE.recent);
  });
}

/** GET /api/v1/markets/{address}/evidence */
export async function getEvidence(request: Request, raw: string, deps: ApiDeps): Promise<Response> {
  return guard(async () => {
    const m = await oneMarket(deps, raw);
    if (m instanceof Response) return m;
    const v = await verification(deps, m);
    const body = {
      market: m.address,
      id: m.id,
      template: { id: m.templateId, name: m.template },
      rule: m.rule,
      status: v.status,
      verified: v.verified,
      stored: v.stored,
      recomputed: v.recomputed,
      rerun: v.rerun,
      rerunError: v.rerunError,
      matches: v.matches,
      notes: v.notes,
      settlementTx: v.settlement
        ? {
            hash: v.settlement.hash,
            block: v.settlement.block.toString(),
            time: new Date(Number(v.settlement.time) * 1000).toISOString(),
            by: v.settlement.by,
            method: v.settlement.method,
            evidence: v.settlement.evidence,
            explorer: `${deps.deployment.explorer}/tx/${v.settlement.hash}`,
          }
        : null,
      plan: v.plan,
      checkedAt: {
        block: v.checkedAt.block.toString(),
        time: new Date(Number(v.checkedAt.timestamp) * 1000).toISOString(),
      },
      howToCheck: "Re-run this with any RPC: the SDK's verifySettlement does the same reads (docs/SDK.md).",
    };
    const cache = m.phaseName === "settled" || m.phaseName === "voided" ? CACHE.slow : CACHE.recent;
    if (wantsCsv(request))
      return csv(flatten(body), ["field", "value"], `hunch-book-evidence-${m.id}.csv`, cache);
    return json(body, cache);
  });
}

/** GET /api/v1/settlements: the settlement archive, newest first (docs/API.md). */
export async function getSettlements(request: Request, deps: ApiDeps): Promise<Response> {
  const query = parseArchiveQuery(new URL(request.url));
  if (typeof query === "string") return problem(400, query);
  return guard(async () => {
    const [all, clock] = await Promise.all([allMarkets(deps), clockOrNull(deps)]);
    const finished = all.filter(
      (m) =>
        isFinal(m) &&
        (query.template === null || m.templateId === query.template) &&
        (query.market === null || m.address.toLowerCase() === query.market),
    );
    // Newest markets first, so the first page holds the latest settlements without verifying them all.
    const page = [...finished].sort((a, b) => b.id - a.id).slice(query.offset, query.offset + query.limit);
    const records = await archive(deps, page, clock);
    // A page with a record still missing its check or transaction is cached briefly, so the next
    // request fills it in; a complete page is cached for minutes.
    const cache = records.every((r) => r.complete) ? CACHE.archive : CACHE.recent;
    if (wantsCsv(request))
      return csv(records.map(settlementCsvRow), SETTLEMENT_CSV_COLUMNS, "hunch-book-settlements.csv", cache);
    return json(
      {
        network: deps.network,
        total: finished.length,
        offset: query.offset,
        limit: query.limit,
        settlements: records,
        howToCheck:
          "Each record's verify link re-runs the read in your browser; the SDK's verifySettlement does the same with any RPC (docs/SDK.md).",
      },
      cache,
    );
  });
}

/** GET /api/v1/stats */
export async function getStats(request: Request, deps: ApiDeps): Promise<Response> {
  return guard(async () => {
    const stats = await protocolStats(deps);
    if (wantsCsv(request))
      return csv(flatten(stats), ["field", "value"], "hunch-book-stats.csv", CACHE.recent);
    return json(stats, CACHE.recent);
  });
}

/** GET /api/v1/feed */
export async function getFeed(request: Request, deps: ApiDeps): Promise<Response> {
  return guard(async () => {
    const [all, clock] = await Promise.all([allMarkets(deps), clockOrNull(deps)]);
    const body = feed(all, deps, clock);
    if (wantsCsv(request)) {
      const rows = body.cards.map((c) => ({
        id: c.id,
        marketId: c.marketId,
        address: c.address,
        status: c.status,
        chanceBps: c.chance.bps,
        chanceSource: c.chance.source,
        poolUsdc: c.pool.totalUsdc,
        bid: c.book?.bid,
        ask: c.book?.ask,
        endsAt: c.endsAt,
        endsAtEstimated: c.endsAtEstimated,
        title: c.title,
        url: c.url,
      }));
      const columns = Object.keys(rows[0] ?? { id: "" });
      return csv(rows, columns, "hunch-book-feed.csv", CACHE.live);
    }
    return json(body, CACHE.live);
  });
}

/** GET /api/v1/funding/{asset}: the market's view of a Perpl perp's funding this period. */
export async function getFunding(request: Request, raw: string, deps: ApiDeps): Promise<Response> {
  const perp = perpParam(raw, deps.deployment);
  if (perp === "bad") return problem(400, `${raw.slice(0, 32)} is not an asset name such as BTC.`);
  if (perp === "unknown") {
    return problem(
      404,
      `${raw.toUpperCase()} is not a Perpl perp on ${deps.network}. Known: ${knownAssets(deps.deployment)}.`,
    );
  }
  return guard(async () => {
    const [all, clock] = await Promise.all([allMarkets(deps), clockOrNull(deps)]);
    const body = fundingView(all, perp, deps, clock);
    if (wantsCsv(request))
      return csv(flatten(body), ["field", "value"], `hunch-book-funding-${perp.asset}.csv`, CACHE.live);
    return json(body, CACHE.live);
  });
}

function html(body: string, status: number, maxAge: number): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": EMBED_CSP,
      "Cache-Control":
        status === 200
          ? `public, max-age=${maxAge}, s-maxage=${maxAge}, stale-while-revalidate=120`
          : "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
    },
  });
}

/** GET /embed/m/{address}: the iframe card. */
export async function getEmbed(_request: Request, raw: string, deps: ApiDeps): Promise<Response> {
  const address = addressParam(raw);
  if (!address)
    return html(renderMessage("Not a market address", "This link does not name a market.", deps), 400, 0);
  try {
    const m = await cached(
      `market:${deps.network}:${address}`,
      15_000,
      () => deps.sdk.markets.get(address),
      deps.now(),
    );
    if (!m) {
      return html(
        renderMessage("Not a Hunch Book market", `This address is not a market on ${deps.network}.`, deps),
        404,
        0,
      );
    }
    const clock = await clockOrNull(deps);
    return html(renderMarketCard(m, deps, clock), 200, 30);
  } catch (e) {
    return html(renderMessage("Could not load this market", describeError(e), deps), 502, 0);
  }
}

/** GET /embed/funding/{asset}: the funding card for an iframe, such as on Perpl's own pages. */
export async function getFundingEmbed(_request: Request, raw: string, deps: ApiDeps): Promise<Response> {
  const perp = perpParam(raw, deps.deployment);
  if (perp === "bad") {
    return html(
      renderMessage("Not an asset", "This link does not name a Perpl perp, such as BTC.", deps),
      400,
      0,
    );
  }
  if (perp === "unknown") {
    return html(
      renderMessage(
        "Not a Perpl perp",
        `${raw.toUpperCase()} is not a Perpl perp on ${deps.network}. Known: ${knownAssets(deps.deployment)}.`,
        deps,
      ),
      404,
      0,
    );
  }
  try {
    const [all, clock] = await Promise.all([allMarkets(deps), clockOrNull(deps)]);
    return html(renderFundingCard(fundingView(all, perp, deps, clock), deps), 200, 30);
  } catch (e) {
    return html(renderMessage("Could not load this market", describeError(e), deps), 502, 0);
  }
}

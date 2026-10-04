import { type Address, getAddress, isAddress } from "viem";
import { log } from "./log.js";
import { type ScanContext, scanMarketCreated, scanStakers } from "./scan.js";

// Where the keeper gets a market's stakers from, for pushing token claims and pool payouts.
// The chain is the default: the market's Staked logs, scanned forward with a saved cursor. With
// INDEXER_URL set, one GraphQL query replaces the scan, and the scan is the fallback whenever the
// indexer fails or does not know the market yet. Either way the keeper checks every address onchain
// (claimableTokens / claimablePool) before it sends anything, so a wrong list can only cost a wasted
// read, never a wrong payment.

export interface StakerList {
  users: Address[];
  /** True when the list cannot grow any more (staking is closed and the history is fully read). */
  complete: boolean;
  /** Where the list came from and how far the scan got, for the log. */
  detail: string;
}

export interface StakerSource {
  readonly name: string;
  stakers(market: Address, ctx: ScanContext): Promise<StakerList>;
}

/** Stakers from the market's own Staked logs. */
export class RpcStakerSource implements StakerSource {
  readonly name = "logs";

  constructor(
    private readonly factory: Address,
    private readonly deployBlock: number | undefined,
  ) {}

  async stakers(market: Address, ctx: ScanContext): Promise<StakerList> {
    const m = ctx.store.market(market);
    if (m.createdBlock === undefined) {
      if (this.deployBlock === undefined) {
        return {
          users: m.stakers,
          complete: false,
          detail:
            "hunchBook.deployBlock is missing from the deployments file: cannot find the market's first block",
        };
      }
      const scan = await scanMarketCreated(ctx, this.factory, this.deployBlock, market);
      if (ctx.store.market(market).createdBlock === undefined) {
        return {
          users: m.stakers,
          complete: false,
          detail: `looking for the market's creation block: factory scan at block ${scan.cursor} of ${ctx.head}`,
        };
      }
    }
    const scan = await scanStakers(ctx, market);
    const users = ctx.store.market(market).stakers;
    return {
      users,
      complete: scan.complete,
      detail: scan.complete
        ? `${users.length} stakers from Staked logs (complete)`
        : `${users.length} stakers so far; Staked scan at block ${scan.cursor} of ${ctx.head}`,
    };
  }
}

type Fetch = typeof fetch;

/** A GraphQL query for one page of a market's stakers. Pluggable, so a schema change is one object. */
export interface StakerQuery {
  query: string;
  variables(market: Address, limit: number, offset: number): Record<string, unknown>;
  /** The staker addresses in one page of `data`. */
  users(data: unknown): string[];
}

/**
 * The default query, for an Envio HyperIndex schema with a `Stake` entity per Staked event (fields
 * `market_id` and `user`). Envio serves Hasura-style GraphQL.
 */
export const envioStakerQuery: StakerQuery = {
  query: `query Stakers($market: String!, $limit: Int!, $offset: Int!) {
  Stake(where: { market_id: { _ilike: $market } }, order_by: { id: asc }, limit: $limit, offset: $offset) {
    user
  }
}`,
  variables: (market, limit, offset) => ({ market, limit, offset }),
  users: (data) => {
    const rows = (data as { Stake?: { user?: unknown }[] } | undefined)?.Stake;
    if (!Array.isArray(rows)) throw new Error("indexer answer has no Stake list");
    return rows.map((r) => String(r.user ?? ""));
  },
};

const PAGE = 1_000;
const MAX_PAGES = 20;

/** Every staker of `market` from the indexer, deduplicated, checksummed. Throws on any GraphQL error. */
export async function queryIndexerStakers(
  url: string,
  market: Address,
  query: StakerQuery = envioStakerQuery,
  fetchFn: Fetch = fetch,
): Promise<Address[]> {
  const seen = new Set<Address>();
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ query: query.query, variables: query.variables(market, PAGE, page * PAGE) }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`indexer answered HTTP ${res.status}`);
    const body = (await res.json()) as { data?: unknown; errors?: { message?: string }[] };
    if (body.errors?.length) throw new Error(`indexer error: ${body.errors[0]?.message ?? "unknown"}`);
    const users = query.users(body.data);
    for (const user of users) {
      if (isAddress(user)) seen.add(getAddress(user));
    }
    if (users.length < PAGE) break;
  }
  return [...seen];
}

/** Stakers from the indexer; falls back to the log scan when the indexer fails or has none yet. */
export class IndexerStakerSource implements StakerSource {
  readonly name = "indexer";

  constructor(
    private readonly url: string,
    private readonly fallback: StakerSource,
    private readonly query: StakerQuery = envioStakerQuery,
    private readonly fetchFn: Fetch = fetch,
  ) {}

  async stakers(market: Address, ctx: ScanContext): Promise<StakerList> {
    try {
      const users = await queryIndexerStakers(this.url, market, this.query, this.fetchFn);
      // Every market has at least its creator as a staker: none means the indexer has not seen it yet.
      if (users.length > 0) {
        ctx.store.addStakers(market, users);
        return { users, complete: false, detail: `${users.length} stakers from the indexer` };
      }
      log("indexer-empty", { market, note: "no stakers in the indexer yet; scanning logs instead" }, "warn");
    } catch (error) {
      log("indexer-failed", { market, error: String(error), note: "scanning logs instead" }, "warn");
    }
    return this.fallback.stakers(market, ctx);
  }
}

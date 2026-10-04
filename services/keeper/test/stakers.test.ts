import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Address, PublicClient } from "viem";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setLogSink } from "../src/log.js";
import { ScanBudget, type ScanContext } from "../src/scan.js";
import {
  envioStakerQuery,
  IndexerStakerSource,
  queryIndexerStakers,
  type StakerList,
  type StakerQuery,
  type StakerSource,
} from "../src/stakers.js";
import { StateStore } from "../src/state.js";

const FACTORY = "0x2c30da53F8C384D6eD6603E3138a98fd15E4928A" as Address;
const MARKET = "0x2A44B99014cF73065BFb89197a08DE09D18d3982" as Address;
const user = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;

const lines: Record<string, unknown>[] = [];
beforeEach(() => {
  lines.length = 0;
  setLogSink((line) => lines.push(JSON.parse(line)));
});
afterEach(() => setLogSink((line) => console.log(line)));

/** A GraphQL endpoint that serves `users` for the market, in pages, recording each request. */
function fakeIndexer(users: string[], opts: { errors?: string; status?: number } = {}) {
  const requests: { query: string; variables: Record<string, unknown> }[] = [];
  const fetchFn = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    requests.push(body);
    if (opts.status) return new Response("down", { status: opts.status });
    if (opts.errors)
      return new Response(JSON.stringify({ errors: [{ message: opts.errors }] }), { status: 200 });
    const { limit, offset } = body.variables as { limit: number; offset: number };
    const page = users.slice(offset, offset + limit).map((u) => ({ user: u }));
    return new Response(JSON.stringify({ data: { Stake: page } }), { status: 200 });
  }) as typeof fetch;
  return { fetchFn, requests };
}

function scanContext(): ScanContext {
  const store = new StateStore(
    join(mkdtempSync(join(tmpdir(), "keeper-st-")), "s.json"),
    "monad-testnet",
    FACTORY,
  );
  return { client: {} as PublicClient, store, head: 100n, range: 100, budget: new ScanBudget(10) };
}

class FallbackSpy implements StakerSource {
  readonly name = "logs";
  calls = 0;
  async stakers(): Promise<StakerList> {
    this.calls++;
    return { users: [user(9) as Address], complete: true, detail: "from logs" };
  }
}

describe("indexer staker query", () => {
  it("pages through every staker, deduplicated and checksummed", async () => {
    const all = Array.from({ length: 2_500 }, (_, i) => user((i % 2_300) + 1));
    const { fetchFn, requests } = fakeIndexer(all);
    const users = await queryIndexerStakers(
      "https://indexer.example/graphql",
      MARKET,
      envioStakerQuery,
      fetchFn,
    );
    expect(users).toHaveLength(2_300);
    expect(users[0]).toBe("0x0000000000000000000000000000000000000001");
    expect(requests.map((r) => r.variables.offset)).toEqual([0, 1_000, 2_000]);
    expect(requests[0]?.variables.market).toBe(MARKET);
    expect(requests[0]?.query).toContain("Stake(where: { market_id: { _ilike: $market } }");
  });

  it("takes any query shape (pluggable)", async () => {
    const custom: StakerQuery = {
      query: "query { stakers }",
      variables: (market) => ({ m: market }),
      users: (data) => (data as { stakers: string[] }).stakers,
    };
    const fetchFn = (async () =>
      new Response(JSON.stringify({ data: { stakers: [user(1), "not an address", user(2)] } }), {
        status: 200,
      })) as unknown as typeof fetch;
    expect(await queryIndexerStakers("https://x", MARKET, custom, fetchFn)).toEqual([
      "0x0000000000000000000000000000000000000001",
      "0x0000000000000000000000000000000000000002",
    ]);
  });

  it("throws on GraphQL errors and HTTP failures", async () => {
    await expect(
      queryIndexerStakers(
        "https://x",
        MARKET,
        envioStakerQuery,
        fakeIndexer([], { errors: "field not found" }).fetchFn,
      ),
    ).rejects.toThrow(/field not found/);
    await expect(
      queryIndexerStakers("https://x", MARKET, envioStakerQuery, fakeIndexer([], { status: 503 }).fetchFn),
    ).rejects.toThrow(/HTTP 503/);
  });
});

describe("IndexerStakerSource", () => {
  it("uses the indexer when it answers, and remembers the stakers", async () => {
    const fallback = new FallbackSpy();
    const { fetchFn } = fakeIndexer([user(1), user(2)]);
    const source = new IndexerStakerSource("https://x", fallback, envioStakerQuery, fetchFn);
    const ctx = scanContext();
    const list = await source.stakers(MARKET, ctx);
    expect(list.users).toHaveLength(2);
    expect(list.detail).toBe("2 stakers from the indexer");
    expect(fallback.calls).toBe(0);
    expect(ctx.store.market(MARKET).stakers).toHaveLength(2);
  });

  it("falls back to the log scan when the indexer fails or does not know the market yet", async () => {
    for (const indexer of [
      fakeIndexer([], { errors: "boom" }),
      fakeIndexer([]),
      fakeIndexer([], { status: 500 }),
    ]) {
      const fallback = new FallbackSpy();
      const source = new IndexerStakerSource("https://x", fallback, envioStakerQuery, indexer.fetchFn);
      const list = await source.stakers(MARKET, scanContext());
      expect(list.detail).toBe("from logs");
      expect(fallback.calls).toBe(1);
    }
    expect(lines.map((l) => l.event)).toEqual(["indexer-failed", "indexer-empty", "indexer-failed"]);
  });
});

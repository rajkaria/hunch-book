import { deployments } from "@hunch-book/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readLandingSnapshot } from "../src/lib/chain/landing";
import { listMarkets, type MarketsSnapshot, readMarketsSnapshot } from "../src/lib/chain/reads";
import { readProofFromChain } from "../src/lib/proof/chain";
import { fetchServed, marketsRead, marketsServedFirst } from "../src/lib/served/fetch";
import {
  parseServedKind,
  SERVED_KINDS,
  SERVED_TIMES,
  servedCacheControl,
  servedKey,
  servedPath,
  serverRpcUrls,
} from "../src/lib/served/keys";
import { createSwrCache } from "../src/lib/served/swr";
import { fromWireJson, toWireJson } from "../src/lib/served/wire";
import { deployed, marketAddr, marketHandlers, stubClient } from "./chain";
import { makeMarket, RESOLVER, USDC } from "./fixtures";

// The server's read path (lib/served): bigint-safe JSON, the stale-while-revalidate cache, the keys and
// cache headers, the browser's fetch with its fallback to reading the chain, and the reads that reuse
// one market list.

const testnet = deployments["monad-testnet"];

describe("wire JSON", () => {
  it("round-trips bigints anywhere in a value, signs included", () => {
    const value = { a: 1n, b: [-2n, { c: 10n ** 30n }], d: "text", e: null, f: 1.5, g: true };
    expect(fromWireJson(toWireJson(value))).toEqual(value);
  });

  it("round-trips a full market view, so served pages render the same data", () => {
    const m = makeMarket({ funding: { markUsd: 0.027, priceDecimals: 5, intervalBlocks: 8_571 } });
    expect(fromWireJson(toWireJson({ markets: [m], total: 1 }))).toEqual({ markets: [m], total: 1 });
  });

  it("leaves objects that only look like a tag alone", () => {
    const text = JSON.stringify({ x: { $bigint: "12", other: 1 }, y: { $bigint: "1.5" }, z: { $bigint: 3 } });
    expect(fromWireJson(text)).toEqual({
      x: { $bigint: "12", other: 1 },
      y: { $bigint: "1.5" },
      z: { $bigint: 3 },
    });
  });
});

describe("the stale-while-revalidate cache", () => {
  const times = { freshMs: 1_000, maxStaleMs: 10_000 };
  let clock = 0;
  const cache = () => createSwrCache(() => clock);
  afterEach(() => {
    clock = 0;
  });

  it("reads once, then serves the fresh value without reading", async () => {
    const c = cache();
    const load = vi.fn(async () => "a");
    expect((await c.get("k", times, load)).served).toEqual({ value: "a", readAt: 0 });
    clock = 999;
    const again = await c.get("k", times, load);
    expect(again).toEqual({ served: { value: "a", readAt: 0 }, state: "fresh" });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("serves a stale value at once and refreshes it in the background", async () => {
    const c = cache();
    await c.get("k", times, async () => "old");
    clock = 5_000;
    const load = vi.fn(async () => "new");
    const stale = await c.get("k", times, load);
    expect(stale.state).toBe("stale");
    expect(stale.served.value).toBe("old");
    await stale.refreshing;
    expect(c.peek("k")).toEqual({ value: "new", readAt: 5_000 });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("shares one read between concurrent callers", async () => {
    const c = cache();
    let release: (v: string) => void = () => {};
    const load = vi.fn(() => new Promise<string>((resolve) => (release = resolve)));
    const both = Promise.all([c.get("k", times, load), c.get("k", times, load)]);
    await Promise.resolve();
    release("one");
    const [a, b] = await both;
    expect(load).toHaveBeenCalledTimes(1);
    expect(a.served.value).toBe("one");
    expect(b.served.value).toBe("one");
  });

  it("keeps the last good value when a refresh fails, and reads again next time", async () => {
    const c = cache();
    await c.get("k", times, async () => "good");
    clock = 2_000;
    const failing = await c.get("k", times, async () => {
      throw new Error("429");
    });
    await failing.refreshing;
    expect(failing.served.value).toBe("good");
    expect(c.peek("k")?.value).toBe("good");
    const load = vi.fn(async () => "better");
    await (await c.get("k", times, load)).refreshing;
    expect(load).toHaveBeenCalledTimes(1);
    expect(c.peek("k")?.value).toBe("better");
  });

  it("throws when there is nothing to serve, and never serves a value past its stale limit", async () => {
    const c = cache();
    await expect(
      c.get("k", times, async () => {
        throw new Error("down");
      }),
    ).rejects.toThrow("down");
    await c.get("k", times, async () => "v1");
    clock = 10_000;
    const fresh = await c.get("k", times, async () => "v2");
    expect(fresh).toEqual({ served: { value: "v2", readAt: 10_000 }, state: "fresh" });
    clock = 30_000;
    await expect(
      c.get("k", times, async () => {
        throw new Error("down");
      }),
    ).rejects.toThrow("down");
  });

  it("survives a loader that throws before it returns a promise", async () => {
    const c = cache();
    const load = () => {
      throw new Error("sync");
    };
    await expect(c.get("k", times, load as never)).rejects.toThrow("sync");
    expect((await c.get("k", times, async () => "ok")).served.value).toBe("ok");
  });
});

describe("served keys, paths and headers", () => {
  it("knows its kinds and nothing else", () => {
    expect(SERVED_KINDS).toEqual(["markets", "proof", "landing"]);
    expect(parseServedKind("markets")).toBe("markets");
    expect(parseServedKind(" Proof ")).toBe("proof");
    expect(parseServedKind("portfolio")).toBeNull();
    expect(parseServedKind(undefined)).toBeNull();
  });

  it("keys one entry per kind and network", () => {
    const keys = new Set(
      SERVED_KINDS.flatMap((k) => [servedKey(k, "monad-testnet"), servedKey(k, "monad-mainnet")]),
    );
    expect(keys.size).toBe(6);
    expect(servedKey("markets", "monad-testnet")).toBe("markets:monad-testnet");
  });

  it("puts the network in the URL, so the CDN keeps one copy per network", () => {
    expect(servedPath("markets", "monad-testnet")).toBe("/api/read/markets?network=monad-testnet");
    expect(servedPath("proof", "monad-mainnet")).toBe("/api/read/proof?network=monad-mainnet");
  });

  it("lets the CDN share and refresh a copy while the browser always asks", () => {
    expect(servedCacheControl("markets")).toBe("public, max-age=0, s-maxage=15, stale-while-revalidate=60");
    expect(servedCacheControl("proof")).toBe("public, max-age=0, s-maxage=30, stale-while-revalidate=120");
    for (const kind of SERVED_KINDS) {
      const t = SERVED_TIMES[kind];
      expect(t.freshMs).toBeLessThanOrEqual(t.cdnSeconds * 1000);
      expect(t.maxStaleMs).toBeGreaterThan(t.freshMs);
    }
  });

  it("reads a keyed server-side RPC first, then the deployment's public ones", () => {
    const publicUrls = [testnet.rpc, ...(testnet.rpcFallbacks ?? [])];
    expect(serverRpcUrls("monad-testnet", testnet, {})).toEqual(publicUrls);
    expect(serverRpcUrls("monad-testnet", testnet, { HUNCH_API_RPC_URL: "https://k.example" })).toEqual([
      "https://k.example",
      ...publicUrls,
    ]);
    expect(serverRpcUrls("monad-testnet", testnet, { MONAD_TESTNET_RPC: "https://t.example" })[0]).toBe(
      "https://t.example",
    );
    expect(serverRpcUrls("monad-testnet", testnet, { MONAD_MAINNET_RPC: "https://m.example" })).toEqual(
      publicUrls,
    );
  });
});

describe("the browser's served fetch", () => {
  const snapshot: MarketsSnapshot = {
    list: { status: "ok", data: { markets: [makeMarket()], total: 1 } },
    clock: { blockNumber: 70_000_000n, timestamp: 1_791_000_000, msPerBlock: 300, measured: true },
  };
  const answer = (status: number, body: string) =>
    vi.fn(async () => new Response(body, { status })) as unknown as typeof fetch;

  it("asks the network's path once and restores the bigints", async () => {
    const fetcher = answer(200, toWireJson({ readAt: 1_791_000_000_000, data: snapshot }));
    const served = await fetchServed<MarketsSnapshot>("markets", "monad-testnet", fetcher);
    expect(served.readAt).toBe(1_791_000_000_000);
    expect(served.data).toEqual(snapshot);
    expect(vi.mocked(fetcher).mock.calls[0]?.[0]).toBe("/api/read/markets?network=monad-testnet");
  });

  it("throws on an error status or a body without data", async () => {
    await expect(fetchServed("markets", "monad-testnet", answer(503, "{}"))).rejects.toThrow("HTTP 503");
    await expect(fetchServed("markets", "monad-testnet", answer(200, "{}"))).rejects.toThrow("no data");
  });

  it("reads the chain itself only when the server cannot answer", async () => {
    const readChain = vi.fn(async () => snapshot);
    const ok = answer(200, toWireJson({ readAt: 1, data: snapshot }));
    expect(await marketsServedFirst("monad-testnet", readChain, ok)).toEqual(snapshot);
    expect(readChain).not.toHaveBeenCalled();
    const down = vi.fn(async () => {
      throw new TypeError("offline");
    }) as unknown as typeof fetch;
    expect(await marketsServedFirst("monad-testnet", readChain, down)).toEqual(snapshot);
    expect(readChain).toHaveBeenCalledTimes(1);
  });

  it("hands the list pages the markets with the clock", () => {
    expect(marketsRead(snapshot)).toEqual({
      status: "ok",
      data: { markets: [makeMarket()], total: 1, clock: snapshot.clock },
    });
    expect(marketsRead({ list: { status: "not-deployed" }, clock: null })).toEqual({
      status: "not-deployed",
    });
  });
});

describe("reads that build on one market list", () => {
  const blocks = { "2000000": 1_000_003_000n, "1990000": 1_000_000_000n };

  it("reads the list and the head together, with the pace from the server's own measure", async () => {
    const client = stubClient(marketHandlers(2), blocks);
    const snap = await readMarketsSnapshot(client, deployed, { pace: async () => 301 });
    expect(snap.list.status).toBe("ok");
    expect(snap.clock).toEqual({
      blockNumber: 2_000_000n,
      timestamp: 1_000_003_000,
      msPerBlock: 301,
      measured: true,
    });
    const measured = await readMarketsSnapshot(stubClient(marketHandlers(2), blocks), deployed);
    expect(measured.clock?.msPerBlock).toBe(300);
    const nominal = await readMarketsSnapshot(client, deployed, {
      pace: async () => null,
      nominalMsPerBlock: 400,
    });
    expect(nominal.clock).toMatchObject({ msPerBlock: 400, measured: false });
  });

  it("still lists the markets when the head cannot be read", async () => {
    const client = stubClient(marketHandlers(2), blocks);
    client.getBlock = vi.fn().mockRejectedValue(new Error("rpc")) as never;
    const snap = await readMarketsSnapshot(client, deployed);
    expect(snap.clock).toBeNull();
    expect(snap.list.status === "ok" && snap.list.data.markets).toHaveLength(2);
  });

  it("builds the landing panel on a list it is given: no count or list reads of its own", async () => {
    const client = stubClient({
      templateOf: () => ({
        resolver: RESOLVER,
        rule: { minPool: USDC(100), minStakers: 3, minChanceBps: 300, maxChanceBps: 9_700 },
      }),
      balanceOf: () => USDC(710),
      totalObligations: () => USDC(700),
    });
    const list = await listMarkets(stubClient(marketHandlers(2)), deployed);
    const clock = { blockNumber: 2_000_000n, timestamp: 1_000_003_000, msPerBlock: 300, measured: true };
    const result = await readLandingSnapshot(client, deployed, 6_000, {
      markets: async () => ({ list, clock }),
    });
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.data.marketCount).toBe(2);
    expect(result.data.newest?.address).toBe(marketAddr(1));
    expect(result.data.block).toBe(2_000_000n);
    expect(result.data.msPerBlock).toBe(300);
    expect(result.data.vault).toEqual({ balance: USDC(710), obligations: USDC(700) });
    const asked = vi
      .mocked(client.readContract)
      .mock.calls.map(([c]) => (c as { functionName: string }).functionName);
    expect(asked).toEqual(["templateOf"]);
    expect(client.getBlock).not.toHaveBeenCalled();
  });

  it("falls back to its own reads when the given list fails", async () => {
    const client = stubClient(
      {
        ...marketHandlers(2),
        templateOf: () => ({
          resolver: RESOLVER,
          rule: { minPool: 0n, minStakers: 0, minChanceBps: 0, maxChanceBps: 0 },
        }),
        balanceOf: () => 1n,
        totalObligations: () => 1n,
      },
      blocks,
    );
    const result = await readLandingSnapshot(client, deployed, 6_000, {
      markets: async () => {
        throw new Error("cache cold and RPC down");
      },
    });
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.data.marketCount).toBe(2);
    expect(result.data.msPerBlock).toBe(300);
  });

  it("counts the proof page from a given list without listing again", async () => {
    const listing = stubClient(marketHandlers(3));
    const list = await listMarkets(listing, deployed);
    const client = stubClient({
      ledger: () => ({ pool: USDC(400), sets: 0n }),
      totalSupply: () => 0n,
      balanceOf: () => USDC(1_200),
      totalObligations: () => USDC(1_200),
    });
    const p = await readProofFromChain(client, deployed, async () => list);
    expect(p.markets).toMatchObject({ created: 3, covered: 3 });
    expect(p.listed).toHaveLength(3);
    expect(client.readContract).not.toHaveBeenCalled();
  });
});

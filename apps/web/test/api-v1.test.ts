import {
  decodeMarketParams,
  deployments,
  encodeMarketParams,
  type MarketInfo,
  Outcome,
  Phase,
  type PhaseName,
  type Verification,
} from "@hunch-book/sdk";
import type { Address, Hex } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearCache } from "@/app/api/v1/_lib/cache";
import { type ApiDeps, apiNetwork, apiRpcUrl } from "@/app/api/v1/_lib/deps";
import { escapeHtml } from "@/app/api/v1/_lib/embed";
import {
  getEmbed,
  getEvidence,
  getFeed,
  getIndex,
  getMarket,
  getMarkets,
  getSettlements,
  getStats,
  getTrades,
} from "@/app/api/v1/_lib/handlers";
import { csvCell, preflight } from "@/app/api/v1/_lib/http";
import nextConfig from "../next.config";

const testnet = deployments["monad-testnet"];
const NOW = 1_791_100_000_000;
const HEAD = 68_060_000n;
const BOOK = "0x0000000000000000000000000000000000003000" as Address;
const MAKER = testnet.wallets.maker;
const ROUTER = testnet.hunchBook.router as Address;
const TX = `0x${"ab".repeat(32)}` as Hex;

const addr = (n: number): Address => `0x${n.toString(16).padStart(40, "0")}` as Address;

function market(id: number, phaseName: PhaseName, overrides: Partial<MarketInfo> = {}): MarketInfo {
  const params = encodeMarketParams({
    templateId: 1,
    params: {
      perpId: 64n,
      startBlock: 68_058_301n + BigInt(id),
      endBlock: 68_264_005n,
      threshold: 1_500n,
      expectedScalingExp: 3,
    },
  });
  const phase = {
    pool: Phase.Pool,
    "pool-locked": Phase.PoolLocked,
    trading: Phase.Graduated,
    closed: Phase.Closed,
    settled: Phase.Settled,
    voided: Phase.Voided,
  }[phaseName];
  return {
    address: addr(0x1000 + id),
    id,
    templateId: 1,
    template: "Perpl net funding",
    phase,
    phaseName,
    phaseLabel: phaseName,
    outcome: Outcome.Unresolved,
    outcomeLabel: "unresolved",
    graduated: phaseName === "trading",
    pool: { yes: 410_000_000n, no: 280_000_000n, total: 690_000_000n, stakers: 11 },
    window: {
      blockClock: true,
      lock: HEAD + BigInt(id) * 1_000n,
      close: 68_264_005n,
      settleDeadline: 1_792_049_704n,
    },
    tokens: { yes: addr(0x2001), no: addr(0x2002) },
    book: phaseName === "trading" ? BOOK : null,
    resolver: addr(0xaaa),
    creator: testnet.hunchBook.guardian as Address,
    params,
    decoded: decodeMarketParams(1, params),
    asset: "MON",
    rule: "Will MON longs pay more than $0.000015 per MON in funding on Perpl?",
    graduationRule: { minPool: 500_000_000n, minStakers: 10, minChanceBps: 300, maxChanceBps: 9_700 },
    graduationRuleMet: true,
    caps: {
      poolCap: 5_000_000_000n,
      walletCap: 1_000_000_000n,
      minStake: 1_000_000n,
      creatorMinStake: 5_000_000n,
    },
    evidenceHash: `0x${"00".repeat(32)}`,
    prices: phaseName === "trading" ? { bidE6: 368_000n, askE6: 399_000n } : null,
    chance: phaseName === "trading" ? { bps: 3_835, source: "book" } : { bps: 5_942, source: "pool" },
    ...overrides,
  };
}

let markets: MarketInfo[];
let getLogs: ReturnType<typeof vi.fn>;
let fetchFn: ReturnType<typeof vi.fn>;

function deps(overrides: Partial<ApiDeps> = {}): ApiDeps {
  const publicClient = {
    getBlock: vi.fn(async (args: { blockTag?: string; blockNumber?: bigint }) => {
      const number = args.blockNumber ?? HEAD;
      return { number, timestamp: BigInt(NOW / 1000) - ((HEAD - number) * 2n) / 5n };
    }),
    getBlockNumber: vi.fn(async () => HEAD),
    getLogs,
    multicall: vi.fn(async () => [
      { status: "success", result: 700_000_000n },
      { status: "success", result: 690_000_000n },
      { status: "success", result: 10_000_000n },
      { status: "success", result: 50_000_000_000n },
    ]),
  };
  return {
    sdk: {
      network: "monad-testnet",
      deployment: testnet,
      context: { publicClient, multicallAddress: "0xcA11bde05977b3631167028862bE2a173976CA11" },
      markets: {
        all: vi.fn(async () => markets),
        get: vi.fn(
          async (a: Address) => markets.find((m) => m.address.toLowerCase() === a.toLowerCase()) ?? null,
        ),
        book: vi.fn(async () => ({
          market: addr(0x1002),
          book: BOOK,
          block: HEAD,
          bids: [{ price: 368_000n, size: 20_000_000n }],
          asks: [{ price: 399_000n, size: 20_000_000n }],
          params: {
            pricePrecision: 1_000_000n,
            sizePrecision: 1_000_000n,
            baseDecimals: 6,
            quoteDecimals: 6,
            takerFeeBps: 0n,
          },
          midE6: 383_500n,
          spreadE6: 31_000n,
          depth: { bidSize: 20_000_000n, bidValue: 7_360_000n, askSize: 20_000_000n, askCost: 7_980_000n },
        })),
      },
      settlement: { plan: vi.fn(), verify: vi.fn(), findTransaction: vi.fn(async () => null) },
    } as unknown as ApiDeps["sdk"],
    network: "monad-testnet",
    deployment: testnet,
    siteUrl: "https://book.playhunch.xyz",
    indexerUrl: undefined,
    fetch: fetchFn as unknown as typeof fetch,
    now: () => NOW,
    ...overrides,
  };
}

const req = (path: string): Request => new Request(`https://book.playhunch.xyz${path}`);

beforeEach(() => {
  clearCache();
  markets = [
    market(1, "pool"),
    market(2, "trading"),
    market(3, "settled", {
      outcome: Outcome.Yes,
      outcomeLabel: "yes",
      chance: { bps: 10_000, source: "settled" },
    }),
  ];
  getLogs = vi.fn(async () => []);
  fetchFn = vi.fn();
});

describe("config and plumbing", () => {
  it("reads the network and an optional server RPC from the environment", () => {
    expect(apiNetwork(undefined)).toBe("monad-testnet");
    expect(apiNetwork("MONAD-MAINNET")).toBe("monad-mainnet");
    expect(apiRpcUrl("monad-testnet", { MONAD_TESTNET_RPC: "https://rpc.example" })).toBe(
      "https://rpc.example",
    );
    expect(
      apiRpcUrl("monad-testnet", { HUNCH_API_RPC_URL: "https://own.example", MONAD_TESTNET_RPC: "x" }),
    ).toBe("https://own.example");
    expect(apiRpcUrl("monad-mainnet", {})).toBeUndefined();
  });

  it("answers CORS preflights and lists its endpoints", async () => {
    const pre = preflight();
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe("*");
    expect(pre.headers.get("access-control-allow-methods")).toBe("GET, OPTIONS");
    const index = await getIndex(req("/api/v1"), deps()).json();
    expect(index.endpoints.feed).toBe("https://book.playhunch.xyz/api/v1/feed");
  });

  it("neutralises spreadsheet formulas and quotes CSV cells", () => {
    expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvCell("-12.5")).toBe("-12.5");
    expect(csvCell('a "b", c')).toBe('"a ""b"", c"');
    expect(csvCell(null)).toBe("");
  });

  it("allows framing only for /embed, and keeps the wallet app unframeable", async () => {
    const rules = await nextConfig.headers?.();
    const app = rules?.find((r) => r.source === "/((?!embed/).*)");
    const embed = rules?.find((r) => r.source === "/embed/:path*");
    expect(app?.headers).toContainEqual({ key: "X-Frame-Options", value: "DENY" });
    expect(app?.headers).toContainEqual({ key: "Content-Security-Policy", value: "frame-ancestors 'none'" });
    expect(
      embed?.headers.some((h) => h.key === "X-Frame-Options" || h.key === "Content-Security-Policy"),
    ).toBe(false);
    const appRule = /^\/((?!embed\/).*)$/;
    expect(appRule.test("/markets")).toBe(true);
    expect(appRule.test("/m/0x1")).toBe(true);
    expect(appRule.test("/embed/m/0x1")).toBe(false);
    expect(nextConfig.transpilePackages).toContain("@hunch-book/sdk");
  });
});

describe("GET /api/v1/markets", () => {
  it("lists markets with CORS, cache headers and exact USDC strings", async () => {
    const res = await getMarkets(req("/api/v1/markets"), deps());
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("cache-control")).toBe(
      "public, max-age=15, s-maxage=15, stale-while-revalidate=60",
    );
    const body = await res.json();
    expect(body).toMatchObject({ network: "monad-testnet", total: 3, matching: 3, offset: 0, limit: 50 });
    const trading = body.markets.find((m: { id: number }) => m.id === 2);
    expect(trading).toMatchObject({
      url: `https://book.playhunch.xyz/m/${addr(0x1002)}`,
      embedUrl: `https://book.playhunch.xyz/embed/m/${addr(0x1002)}`,
      phase: "trading",
      chance: { bps: 3_835, percent: "38.35%", source: "book" },
      pool: { yesUsdc: "410", noUsdc: "280", totalUsdc: "690", stakers: 11 },
      book: { bid: "0.368", ask: "0.399", mid: "0.3835", spread: "0.031" },
      window: { clock: "block", estimated: true, close: "68264005" },
      createdByHunch: true,
      evidenceHash: null,
    });
    // Health: a 3.1 cent spread, a close long past, a Perpl source (lib/health/score.ts).
    expect(trading.health.score).toBeGreaterThan(0);
    expect(trading.health.parts.map((p: { name: string }) => p.name)).toEqual([
      "liquidity",
      "time",
      "source",
    ]);
    expect(body.markets.find((m: { id: number }) => m.id === 3).health).toEqual({
      score: null,
      grade: "finished",
      parts: [],
    });
    // Block-clock close estimated from the measured block time (400 ms here).
    expect(trading.window.closeAt).toBe(new Date(NOW + Number(68_264_005n - HEAD) * 400).toISOString());
  });

  it("filters by phase, template and asset, and pages", async () => {
    const open = await (await getMarkets(req("/api/v1/markets?phase=open"), deps())).json();
    expect(open.markets.map((m: { id: number }) => m.id)).toEqual([1, 2]);
    const settled = await (
      await getMarkets(req("/api/v1/markets?phase=settled&template=1&asset=mon"), deps())
    ).json();
    expect(settled.markets.map((m: { id: number }) => m.id)).toEqual([3]);
    const none = await (await getMarkets(req("/api/v1/markets?asset=BTC"), deps())).json();
    expect(none.matching).toBe(0);
    const page = await (await getMarkets(req("/api/v1/markets?limit=1&offset=1"), deps())).json();
    expect(page.markets.map((m: { id: number }) => m.id)).toEqual([2]);
  });

  it("refuses bad filters in plain words, uncached", async () => {
    for (const q of ["phase=soon", "template=abc", "limit=-1", "asset=%3Cscript%3E"]) {
      const res = await getMarkets(req(`/api/v1/markets?${q}`), deps());
      expect(res.status).toBe(400);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect((await res.json()).error).toMatch(/must/);
    }
  });

  it("writes CSV with a header row", async () => {
    const res = await getMarkets(req("/api/v1/markets?format=csv"), deps());
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    const lines = (await res.text()).trim().split("\r\n");
    expect(lines[0]?.startsWith("id,address,template_id,template,asset,phase")).toBe(true);
    expect(lines).toHaveLength(4);
    expect(lines[2]).toContain(",trading,unresolved,3835,book,410,280,690,11,0.368,0.399,block,");
  });

  it("says when the chain does not answer", async () => {
    const d = deps();
    (d.sdk.markets.all as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("timeout"));
    const res = await getMarkets(req("/api/v1/markets"), d);
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("Could not read the chain right now: timeout");
  });
});

describe("GET /api/v1/markets/{address}", () => {
  it("returns one market with decoded params, caps and the top of the book", async () => {
    const body = await (await getMarket(req("/x"), addr(0x1002).toLowerCase(), deps())).json();
    expect(body).toMatchObject({
      id: 2,
      params: { kind: "perpl-funding", params: { perpId: "64", threshold: "1500" } },
      caps: { poolCapUsdc: "5000", minStakeUsdc: "1" },
      book: {
        levels: { bids: [{ price: "0.368", sizeYes: "20" }], asks: [{ price: "0.399", sizeYes: "20" }] },
      },
      links: { trades: `https://book.playhunch.xyz/api/v1/markets/${addr(0x1002)}/trades` },
    });
  });

  it("answers 400 for a bad address and 404 for an unknown market", async () => {
    expect((await getMarket(req("/x"), "0x123", deps())).status).toBe(400);
    const missing = await getMarket(req("/x"), addr(0x9999), deps());
    expect(missing.status).toBe(404);
    expect((await missing.json()).error).toMatch(/not a Hunch Book market on monad-testnet/);
  });

  it("writes one market as field,value CSV rows", async () => {
    const text = await (await getMarket(req("/x?format=csv"), addr(0x1001), deps())).text();
    expect(text.split("\r\n")[0]).toBe("field,value");
    expect(text).toContain("pool.totalUsdc,690");
  });
});

describe("GET /api/v1/markets/{address}/trades", () => {
  const tradeLog = (block: bigint, logIndex: number, args: Record<string, unknown>) => ({
    blockNumber: block,
    logIndex,
    transactionHash: TX,
    args: {
      orderId: 1,
      makerAddress: MAKER,
      isBuy: true,
      price: 399_000_000_000_000_000n,
      updatedSize: 0n,
      takerAddress: ROUTER,
      txOrigin: addr(0xbeef),
      filledSize: 12_531_328n,
      ...args,
    },
  });

  it("reads Kuru's logs in 100-block windows and labels our maker", async () => {
    getLogs.mockImplementation(async ({ fromBlock }: { fromBlock: bigint }) =>
      fromBlock === HEAD - 249n
        ? [
            tradeLog(HEAD - 200n, 3, {}),
            tradeLog(HEAD - 200n, 5, { isBuy: false, makerAddress: addr(0x77), takerAddress: addr(0x88) }),
          ]
        : [],
    );
    const res = await getTrades(req("/x?blocks=250"), addr(0x1002), deps());
    const body = await res.json();
    expect(getLogs).toHaveBeenCalledTimes(3);
    for (const call of getLogs.mock.calls) {
      const { fromBlock, toBlock } = call[0] as { fromBlock: bigint; toBlock: bigint };
      expect(toBlock - fromBlock).toBeLessThan(100n);
    }
    expect(body).toMatchObject({
      source: "logs",
      count: 2,
      fromBlock: String(HEAD - 249n),
      toBlock: String(HEAD),
    });
    expect(body.trades[0]).toMatchObject({
      logIndex: 5,
      takerSide: "sell",
      makerIsHunchMaker: false,
      trader: addr(0x88),
      viaRouter: false,
    });
    expect(body.trades[1]).toMatchObject({
      logIndex: 3,
      takerSide: "buy",
      price: "0.399",
      sizeYes: "12.531328",
      notionalUsdc: "4.999999",
      maker: MAKER,
      makerIsHunchMaker: true,
      trader: addr(0xbeef),
      viaRouter: true,
    });
    expect(res.headers.get("cache-control")).toBe(
      "public, max-age=30, s-maxage=30, stale-while-revalidate=120",
    );
  });

  it("uses the indexer when configured, and falls back to logs when it fails", async () => {
    fetchFn.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: {
            Trade: [
              {
                block: "100",
                timestamp: "1791099000",
                tx: TX,
                logIndex: 1,
                priceE6: "399000",
                size: "2000000",
                takerBuysYes: false,
                maker: MAKER,
                taker: ROUTER,
                trader: addr(0x5),
                viaRouter: true,
                txOrigin: addr(0x5),
              },
            ],
          },
        }),
      ),
    );
    const indexed = await (
      await getTrades(req("/x"), addr(0x1002), deps({ indexerUrl: "https://indexer.example/v1/graphql" }))
    ).json();
    expect(indexed).toMatchObject({
      source: "indexer",
      count: 1,
      trades: [
        { price: "0.399", notionalUsdc: "0.798", trader: addr(0x5), time: "2026-10-04T07:30:00.000Z" },
      ],
    });
    const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body)).variables).toEqual({
      market: addr(0x1002).toLowerCase(),
      limit: 100,
    });

    clearCache();
    fetchFn.mockResolvedValueOnce(new Response("down", { status: 503 }));
    const fallback = await (
      await getTrades(req("/x"), addr(0x1002), deps({ indexerUrl: "https://indexer.example/v1/graphql" }))
    ).json();
    expect(fallback.source).toBe("logs");
    expect(fallback.note).toMatch(/The indexer failed \(The indexer answered HTTP 503\.\)/);
  });

  it("validates its query and caps the lookback", async () => {
    expect((await getTrades(req("/x?blocks=abc"), addr(0x1002), deps())).status).toBe(400);
    await getTrades(req("/x?blocks=999999"), addr(0x1002), deps());
    expect(getLogs).toHaveBeenCalledTimes(50);
    expect((await getTrades(req("/x?fromBlock=-1"), addr(0x1002), deps())).status).toBe(400);
  });

  it("reads an explicit range from the logs, even with an indexer configured", async () => {
    const body = await (
      await getTrades(
        req("/x?fromBlock=67858466&blocks=250"),
        addr(0x1002),
        deps({ indexerUrl: "https://indexer.example" }),
      )
    ).json();
    expect(fetchFn).not.toHaveBeenCalled();
    expect(getLogs).toHaveBeenCalledTimes(3);
    expect(
      getLogs.mock.calls.map((c) => [
        (c[0] as { fromBlock: bigint }).fromBlock,
        (c[0] as { toBlock: bigint }).toBlock,
      ]),
    ).toEqual([
      [67_858_466n, 67_858_565n],
      [67_858_566n, 67_858_665n],
      [67_858_666n, 67_858_715n],
    ]);
    expect(body).toMatchObject({
      source: "logs",
      fromBlock: "67858466",
      toBlock: "67858715",
      note: "Fills from Kuru's logs in blocks 67858466 to 67858715.",
    });
  });

  it("returns no trades for a market without a book", async () => {
    const body = await (await getTrades(req("/x"), addr(0x1001), deps())).json();
    expect(body).toMatchObject({ count: 0, note: "This market has no book yet." });
  });
});

describe("GET /api/v1/markets/{address}/evidence", () => {
  it("returns the verification with the settlement transaction and its link", async () => {
    const d = deps();
    const v = {
      market: addr(0x1003),
      marketId: 3,
      templateId: 1,
      template: "Perpl net funding",
      status: "settled",
      stored: { outcome: "yes", evidenceHash: TX },
      recomputed: { outcome: "yes", evidenceHash: TX, evidence: "0x", reads: { delta: 40n } },
      rerun: { outcome: "yes", evidenceHash: TX },
      rerunError: null,
      matches: { evidenceHash: true, outcome: true, rerun: true },
      verified: true,
      notes: [],
      settlement: {
        block: 9n,
        time: 1_791_000_000n,
        hash: TX,
        by: addr(1),
        kind: "settled",
        method: "settle",
        evidence: "0x",
      },
      plan: null,
      checkedAt: { block: HEAD, timestamp: 1_791_100_000n },
      rpc: testnet.rpc,
    } satisfies Verification;
    (d.sdk.settlement.verify as ReturnType<typeof vi.fn>).mockResolvedValueOnce(v);
    const res = await getEvidence(req("/x"), addr(0x1003), d);
    const body = await res.json();
    expect(body).toMatchObject({
      verified: true,
      recomputed: { reads: { delta: "40" } },
      settlementTx: { hash: TX, block: "9", explorer: `https://testnet.monadscan.com/tx/${TX}` },
      checkedAt: { block: String(HEAD) },
    });
    expect(res.headers.get("cache-control")).toBe(
      "public, max-age=60, s-maxage=60, stale-while-revalidate=600",
    );
  });
});

describe("GET /api/v1/settlements", () => {
  const verified = (m: MarketInfo, block: bigint, by: Address): Verification => ({
    market: m.address,
    marketId: m.id,
    templateId: 1,
    template: "Perpl net funding",
    status: m.phaseName === "voided" ? "voided" : "settled",
    stored: { outcome: "no", evidenceHash: TX },
    recomputed: { outcome: "no", evidenceHash: TX, evidence: "0x", reads: { delta: -31n } },
    rerun: { outcome: "no", evidenceHash: TX },
    rerunError: null,
    matches: { evidenceHash: true, outcome: true, rerun: true },
    verified: true,
    notes: [],
    settlement: {
      block,
      time: 1_791_000_000n,
      hash: TX,
      by,
      kind: "settled",
      method: "settle",
      evidence: "0x",
    },
    plan: null,
    checkedAt: { block: HEAD, timestamp: 1_791_100_000n },
    rpc: testnet.rpc,
  });

  beforeEach(() => {
    markets.push(
      market(4, "voided"),
      market(5, "settled", { outcome: Outcome.No, outcomeLabel: "no", templateId: 7, template: "Snapshot" }),
    );
  });

  it("lists every finished market with the read that settled it, newest settlement first", async () => {
    const d = deps();
    const verify = d.sdk.settlement.verify as ReturnType<typeof vi.fn>;
    verify.mockImplementation(async (m: MarketInfo) => {
      if (m.id === 4) throw new Error("rpc down");
      return verified(
        m,
        m.id === 3 ? 900n : 700n,
        m.id === 3 ? (testnet.wallets.keeper as Address) : addr(0xbeef),
      );
    });
    const res = await getSettlements(req("/api/v1/settlements"), d);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe(
      "public, max-age=300, s-maxage=300, stale-while-revalidate=3600",
    );
    const body = await res.json();
    expect(body.total).toBe(3);
    expect(body.settlements.map((r: { id: number }) => r.id)).toEqual([3, 5, 4]);
    const [first, second, failed] = body.settlements;
    expect(first).toMatchObject({
      status: "settled",
      outcome: "yes",
      settledAt: { block: "900" },
      settlementTx: {
        hash: TX,
        byHunch: true,
        method: "settle",
        explorer: `https://testnet.monadscan.com/tx/${TX}`,
      },
      reads: { delta: "-31" },
      verified: true,
      links: { verify: `https://book.playhunch.xyz/verify/${addr(0x1003)}` },
    });
    expect(second.settlementTx.byHunch).toBe(false);
    expect(failed).toMatchObject({ status: "voided", settledAt: null, verified: null });
    expect(failed.error).toContain("rpc down");
  });

  it("finds the settling transaction when the template's check did not need it", async () => {
    const d = deps();
    (d.sdk.settlement.verify as ReturnType<typeof vi.fn>).mockImplementation(async (m: MarketInfo) => ({
      ...verified(m, 1n, addr(1)),
      settlement: null,
    }));
    const find = d.sdk.settlement.findTransaction as ReturnType<typeof vi.fn>;
    find.mockImplementation(async (a: Address) =>
      a === addr(0x1003)
        ? {
            block: 42n,
            time: 1_791_000_000n,
            hash: TX,
            by: addr(7),
            kind: "settled",
            method: "settle",
            evidence: "0x",
          }
        : null,
    );
    const body = await (await getSettlements(req("/api/v1/settlements"), d)).json();
    const byId = new Map(body.settlements.map((r: { id: number }) => [r.id, r]));
    expect(byId.get(3)).toMatchObject({ settledAt: { block: "42" }, settlementTx: { hash: TX } });
    expect(byId.get(5)).toMatchObject({ settledAt: null, settlementTx: null });
  });

  it("filters by template, pages, and refuses bad queries", async () => {
    const d = deps();
    (d.sdk.settlement.verify as ReturnType<typeof vi.fn>).mockImplementation(async (m: MarketInfo) =>
      verified(m, 1n, addr(1)),
    );
    const snap = await (await getSettlements(req("/api/v1/settlements?template=7"), d)).json();
    expect(snap.settlements.map((r: { id: number }) => r.id)).toEqual([5]);
    const paged = await (await getSettlements(req("/api/v1/settlements?limit=1&offset=1"), d)).json();
    expect(paged).toMatchObject({ total: 3, limit: 1, offset: 1 });
    expect(paged.settlements).toHaveLength(1);
    for (const bad of ["limit=0", "limit=101", "offset=-1", "template=abc"]) {
      expect((await getSettlements(req(`/api/v1/settlements?${bad}`), d)).status).toBe(400);
    }
  });

  it("downloads as CSV with the reads as JSON", async () => {
    const d = deps();
    (d.sdk.settlement.verify as ReturnType<typeof vi.fn>).mockImplementation(async (m: MarketInfo) =>
      verified(m, 5n, addr(1)),
    );
    const res = await getSettlements(req("/api/v1/settlements?format=csv"), d);
    const lines = (await res.text()).trim().split("\r\n");
    expect(lines[0]).toBe(
      "id,market,template_id,template,asset,status,outcome,settled_block,settled_at,settle_tx,settled_by,settled_by_hunch,method,evidence,evidence_hash,reads,verified,rule,verify_url",
    );
    expect(lines).toHaveLength(4);
    expect(lines[1]).toContain('"{""delta"":""-31""}"');
  });
});

describe("GET /api/v1/stats", () => {
  it("counts markets by phase and template and checks the vault is solvent", async () => {
    const body = await (await getStats(req("/api/v1/stats"), deps())).json();
    expect(body).toMatchObject({
      markets: {
        total: 3,
        byPhase: { pool: 1, trading: 1, settled: 1, voided: 0 },
        byTemplate: { "1": 3 },
        graduatedEver: 1,
      },
      pools: { open: 1, stakedUsdc: "690" },
      vault: { usdcHeld: "700", owedUsdc: "690", surplusUsdc: "10", solvent: true, capUsdc: "50000" },
      activity: null,
    });
  });

  it("adds indexed activity with our maker's share labelled", async () => {
    fetchFn.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: {
            ProtocolStats_by_pk: {
              wallets: 14,
              ourWallets: 3,
              externalWallets: 11,
              stakeCount: 12,
              stakedUsdc: "700000000",
              stakeCountOurs: 11,
              stakedUsdcOurs: "690000000",
              fillCount: 10,
              fillCountOurMaker: 9,
              fillCountBetweenOthers: 1,
              volume: "50000000",
              volumeOurMaker: "45000000",
              volumeBetweenOthers: "5000000",
              ourMakerShareBps: 9000,
              ourMakerVolumeShareBps: 9000,
              routerTradeCount: 4,
              routerVolume: "20000000",
              redemptionCount: 0,
              redeemedUsdc: "0",
              updatedAtBlock: "68059000",
            },
          },
        }),
      ),
    );
    const body = await (
      await getStats(req("/api/v1/stats"), deps({ indexerUrl: "https://indexer.example" }))
    ).json();
    expect(body.activity).toMatchObject({
      wallets: { total: 14, ours: 3, others: 11 },
      fills: { count: 10, againstOurMaker: 9, betweenOthers: 1, ourMakerShare: "90%" },
      volume: { usdc: "50", againstOurMakerUsdc: "45" },
    });
  });
});

describe("GET /api/v1/feed", () => {
  it("lists open markets as cards, ending soonest first", async () => {
    const body = await (await getFeed(req("/api/v1/feed"), deps())).json();
    expect(body).toMatchObject({
      version: 1,
      source: "Hunch Book",
      network: "monad-testnet",
      count: 2,
      home: "https://book.playhunch.xyz",
    });
    expect(body.generatedAt).toBe(new Date(NOW).toISOString());
    expect(body.cards.map((c: { marketId: number }) => c.marketId)).toEqual([1, 2]);
    expect(body.cards[1]).toEqual({
      id: `hunch-book:monad-testnet:${addr(0x1002).toLowerCase()}`,
      marketId: 2,
      address: addr(0x1002),
      title: "Will MON longs pay more than $0.000015 per MON in funding on Perpl?",
      template: "Perpl net funding",
      asset: "MON",
      status: "trading",
      chance: { yes: 0.3835, bps: 3_835, source: "book" },
      pool: { totalUsdc: "690", stakers: 11 },
      book: { bid: "0.368", ask: "0.399" },
      endsAt: new Date(NOW + Number(68_264_005n - HEAD) * 400).toISOString(),
      endsAtEstimated: true,
      url: `https://book.playhunch.xyz/m/${addr(0x1002)}`,
      embedUrl: `https://book.playhunch.xyz/embed/m/${addr(0x1002)}`,
    });
    expect(body.cards[0]).toMatchObject({ status: "pool", book: null });
  });

  it("titles Perpl markets with estimated times instead of block numbers", async () => {
    markets[1] = market(2, "trading", {
      rule: "Will MON longs pay more than $0.000015 per MON in funding on Perpl (MON Perp, perp 64) between block 68058301 and block 68264005?",
    });
    const body = await (await getFeed(req("/api/v1/feed"), deps())).json();
    const title: string = body.cards[1].title;
    expect(title).toMatch(
      /^Will MON longs pay more than \$0\.000015 per MON in funding on Perpl between about .+ UTC\?$/,
    );
    expect(title).not.toContain("block");
    const html = await (await getEmbed(req("/embed/m/x"), addr(0x1002), deps())).text();
    expect(html).toContain("between about");
    expect(html).not.toContain("between block");
  });
});

describe("GET /embed/m/{address}", () => {
  it("renders a frameable card with no script, escaping what comes from the chain", async () => {
    markets[1] = market(2, "trading", { rule: 'Will <script>alert("x")</script> pay?' });
    const res = await getEmbed(req("/embed/m/x"), addr(0x1002), deps());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("frame-ancestors *");
    expect(csp).toContain("default-src 'none'");
    expect(res.headers.get("x-frame-options")).toBeNull();
    const html = await res.text();
    expect(html).not.toContain("<script");
    expect(html).toContain("Will &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; pay?");
    expect(html).toContain("38.35%");
    expect(html).toContain("chance of YES, Kuru book mid");
    expect(html).toContain(`href="https://book.playhunch.xyz/m/${addr(0x1002)}"`);
    expect(html).toContain("Trade on Hunch Book");
    expect(html).toContain("Bid 0.368");
  });

  it("shows a settled market's winner, and plain messages for unknown or bad addresses", async () => {
    const settled = await (await getEmbed(req("/x"), addr(0x1003), deps())).text();
    expect(settled).toContain(">YES<");
    expect(settled).toContain(">won<");
    const missing = await getEmbed(req("/x"), addr(0x9999), deps());
    expect(missing.status).toBe(404);
    expect(await missing.text()).toContain("Not a Hunch Book market");
    expect((await getEmbed(req("/x"), "nope", deps())).status).toBe(400);
  });

  it("escapes every HTML special character", () => {
    expect(escapeHtml(`<a href="x" onclick='y'>&</a>`)).toBe(
      "&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;",
    );
  });
});

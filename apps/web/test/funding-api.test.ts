import {
  decodeMarketParams,
  deployments,
  encodeMarketParams,
  type MarketInfo,
  Outcome,
  Phase,
  type PhaseName,
} from "@hunch-book/sdk";
import type { Address } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearCache } from "@/app/api/v1/_lib/cache";
import type { ApiDeps } from "@/app/api/v1/_lib/deps";
import { shortWindow } from "@/app/api/v1/_lib/embed";
import {
  durationWords,
  FUNDING_PICK,
  fundingCandidates,
  fundingClause,
  isOpenNow,
  knownAssets,
  periodWords,
  perpParam,
  pickFundingMarket,
  wholePercent,
} from "@/app/api/v1/_lib/funding";
import { getFunding, getFundingEmbed, getIndex } from "@/app/api/v1/_lib/handlers";
import type { ChainClock } from "@/app/api/v1/_lib/markets";
import nextConfig from "../next.config";

// GET /api/v1/funding/{asset} and /embed/funding/{asset} against a fake SDK and RPC: which market is
// picked, the no-market answer, unknown assets, the card's text and its escaping.

const testnet = deployments["monad-testnet"];
const NOW = 1_791_100_000_000;
const HEAD = 68_060_000n;
/** The fake chain measures 400 ms per block, so a week is 1,512,000 blocks. */
const WEEK_BLOCKS = 1_512_000n;
const BOOK = "0x0000000000000000000000000000000000003000" as Address;
const BTC = 16n;
const ETH = 32n;

const addr = (n: number): Address => `0x${n.toString(16).padStart(40, "0")}` as Address;

const ruleText = (start: bigint, end: bigint, threshold = "$12.04") =>
  `Will BTC longs pay more than ${threshold} per BTC in funding on Perpl (BTC Perp, perp 16) between block ${start} and block ${end}?`;

interface Opts {
  phaseName?: PhaseName;
  perpId?: bigint;
  start?: bigint;
  end?: bigint;
  templateId?: 1 | 4;
  overrides?: Partial<MarketInfo>;
}

function fundingMarket(id: number, opts: Opts = {}): MarketInfo {
  const phaseName = opts.phaseName ?? "pool";
  const start = opts.start ?? HEAD + 50_000n;
  const end = opts.end ?? start + WEEK_BLOCKS;
  const perpId = opts.perpId ?? BTC;
  const templateId = opts.templateId ?? 1;
  const raw = { perpId, startBlock: start, endBlock: end, threshold: 120_442n, expectedScalingExp: 0 };
  const params = encodeMarketParams(
    templateId === 1 ? { templateId: 1, params: raw } : { templateId: 4, params: raw },
  );
  const phase = {
    pool: Phase.Pool,
    "pool-locked": Phase.PoolLocked,
    trading: Phase.Graduated,
    closed: Phase.Closed,
    settled: Phase.Settled,
    voided: Phase.Voided,
  }[phaseName];
  const trading = phaseName === "trading";
  return {
    address: addr(0x1000 + id),
    id,
    templateId,
    template: templateId === 1 ? "Perpl net funding" : "Perpl funding spike",
    phase,
    phaseName,
    phaseLabel: trading ? "Trading" : phaseName === "pool" ? "Pool" : phaseName,
    outcome: Outcome.Unresolved,
    outcomeLabel: "unresolved",
    graduated: trading,
    pool: { yes: 410_000_000n, no: 280_000_000n, total: 690_000_000n, stakers: 11 },
    window: { blockClock: true, lock: start, close: end, settleDeadline: 1_792_049_704n },
    tokens: { yes: addr(0x2001), no: addr(0x2002) },
    book: trading ? BOOK : null,
    resolver: addr(0xaaa),
    creator: testnet.wallets.keeper as Address,
    params,
    decoded: decodeMarketParams(templateId, params),
    asset: perpId === BTC ? "BTC" : "ETH",
    rule: ruleText(start, end),
    graduationRule: { minPool: 500_000_000n, minStakers: 10, minChanceBps: 300, maxChanceBps: 9_700 },
    graduationRuleMet: true,
    caps: {
      poolCap: 5_000_000_000n,
      walletCap: 1_000_000_000n,
      minStake: 1_000_000n,
      creatorMinStake: 5_000_000n,
    },
    evidenceHash: `0x${"00".repeat(32)}`,
    prices: trading ? { bidE6: 610_000n, askE6: 630_000n } : null,
    chance: trading ? { bps: 6_200, source: "book" } : { bps: 5_942, source: "pool" },
    ...opts.overrides,
  };
}

/** This week's BTC market: graduated, its window running since 100,000 blocks ago. */
const running = () =>
  fundingMarket(5, { phaseName: "trading", start: HEAD - 100_000n, end: HEAD - 100_000n + WEEK_BLOCKS });

let markets: MarketInfo[];

function deps(overrides: Partial<ApiDeps> = {}): ApiDeps {
  const publicClient = {
    getBlock: vi.fn(async (args: { blockTag?: string; blockNumber?: bigint }) => {
      const number = args.blockNumber ?? HEAD;
      return { number, timestamp: BigInt(NOW / 1000) - ((HEAD - number) * 2n) / 5n };
    }),
  };
  return {
    sdk: {
      network: "monad-testnet",
      deployment: testnet,
      context: { publicClient, multicallAddress: "0xcA11bde05977b3631167028862bE2a173976CA11" },
      markets: { all: vi.fn(async () => markets), get: vi.fn(), book: vi.fn() },
      settlement: { plan: vi.fn(), verify: vi.fn() },
    } as unknown as ApiDeps["sdk"],
    network: "monad-testnet",
    deployment: testnet,
    siteUrl: "https://book.playhunch.xyz",
    indexerUrl: undefined,
    fetch: vi.fn() as unknown as typeof fetch,
    now: () => NOW,
    ...overrides,
  };
}

const req = (path: string): Request => new Request(`https://book.playhunch.xyz${path}`);
const clock: ChainClock = { block: HEAD, timestamp: NOW / 1000, msPerBlock: 400 };

beforeEach(() => {
  clearCache();
  markets = [
    running(),
    // Next week's pool, created before this week ends: newer, but its window has not started.
    fundingMarket(6, { overrides: { chance: { bps: 10_000, source: "pool" } } }),
    // Not candidates: another perp, a spike market, a finished window, a settled market, a pool past its lock.
    fundingMarket(7, { perpId: ETH }),
    fundingMarket(8, { templateId: 4 }),
    fundingMarket(9, { phaseName: "trading", start: HEAD - WEEK_BLOCKS, end: HEAD - 10n }),
    fundingMarket(10, { phaseName: "settled", start: HEAD - 3n * WEEK_BLOCKS, end: HEAD - 2n * WEEK_BLOCKS }),
    fundingMarket(11, { start: HEAD - 5n }),
  ];
});

describe("picking the market", () => {
  it("keeps only open template 1 markets on the perp, newest first", () => {
    expect(fundingCandidates(markets, BTC, clock).map((m) => m.id)).toEqual([6, 5]);
    expect(fundingCandidates(markets, ETH, clock).map((m) => m.id)).toEqual([7]);
    expect(fundingCandidates(markets, 48n, clock)).toEqual([]);
  });

  it("prefers the market whose window is running, even when a newer one is open", () => {
    const picked = pickFundingMarket(fundingCandidates(markets, BTC, clock), clock);
    expect(picked).toMatchObject({ matched: "running" });
    expect(picked?.market.id).toBe(5);
  });

  it("with none running, takes the newest one still to start", () => {
    markets = [fundingMarket(6), fundingMarket(12, { start: HEAD + 90_000n }), fundingMarket(3)];
    const picked = pickFundingMarket(fundingCandidates(markets, BTC, clock), clock);
    expect(picked).toMatchObject({ matched: "upcoming" });
    expect(picked?.market.id).toBe(12);
  });

  it("checks the chain head, not only the phase, and trusts the phase without a clock", () => {
    const lockPassed = fundingMarket(11, { start: HEAD - 5n });
    const ended = fundingMarket(9, { phaseName: "trading", start: HEAD - WEEK_BLOCKS, end: HEAD - 10n });
    expect(isOpenNow(lockPassed, clock)).toBe(false);
    expect(isOpenNow(ended, clock)).toBe(false);
    expect(isOpenNow(lockPassed, null)).toBe(true);
    expect(isOpenNow(fundingMarket(10, { phaseName: "pool-locked" }), null)).toBe(false);
    expect(
      pickFundingMarket(
        [running(), fundingMarket(6)].sort((a, b) => b.id - a.id),
        null,
      )?.market.id,
    ).toBe(5);
  });

  it("names the perp from the path in any case, and refuses anything else", () => {
    expect(perpParam("btc", testnet)).toEqual({ asset: "BTC", perpId: 16n });
    expect(perpParam("MON", testnet)).toEqual({ asset: "MON", perpId: 64n });
    expect(perpParam("DOGE", testnet)).toBe("unknown");
    expect(perpParam("BTC-USD", testnet)).toBe("bad");
    expect(perpParam("", testnet)).toBe("bad");
    expect(knownAssets(testnet)).toBe("BTC, ETH, SOL, MON");
  });
});

describe("the words", () => {
  it("reads what YES means from the resolver's sentence", () => {
    expect(fundingClause(ruleText(1n, 2n), "BTC", 1n)).toBe("BTC longs pay more than $12.04 per BTC");
    expect(
      fundingClause(
        "Will MON longs pay shorts on net in funding on Perpl (MON Perp, perp 64) between block 1 and block 2?",
        "MON",
        0n,
      ),
    ).toBe("MON longs pay shorts on net");
    expect(fundingClause(ruleText(1n, 2n, "-$5"), "BTC", -50n)).toBe(
      "BTC shorts pay longs less than $5 per BTC on net",
    );
    expect(fundingClause(ruleText(1n, 2n, "$1,250.5"), "BTC", 1n)).toBe(
      "BTC longs pay more than $1,250.5 per BTC",
    );
    // Market #7 on testnet, word for word.
    expect(
      fundingClause(
        "Will MON longs pay more than -$0.00000031 per MON in funding on Perpl (MON Perp, perp 64) between block 68713707 and block 68730849?",
        "MON",
        -31n,
      ),
    ).toBe("MON shorts pay longs less than $0.00000031 per MON on net");
  });

  it("falls back to the params when the resolver did not answer", () => {
    expect(fundingClause(null, "BTC", 0n)).toBe("BTC longs pay shorts on net");
    expect(fundingClause(null, "BTC", 120_442n)).toBe(
      "BTC longs pay more than 120442 raw Perpl funding units",
    );
  });

  it("names the period: this week, the coming week, or the window's length", () => {
    expect(periodWords(WEEK_BLOCKS, 400, true)).toBe("this week");
    expect(periodWords(WEEK_BLOCKS, 400, false)).toBe("in the coming week");
    expect(periodWords(216_000n, 400, true)).toBe("in this 24-hour window");
    expect(periodWords(648_000n, 400, false)).toBe("in the next 3-day window");
    // Two Perpl intervals at about 300 ms per block: 17,142 blocks, about 85 minutes.
    expect(periodWords(17_142n, 300, false)).toBe("in the next 85-minute window");
    expect(durationWords(60)).toBe("5-minute");
    expect(durationWords(2 * 3_600)).toBe("2-hour");
    expect(durationWords(3 * 86_400)).toBe("3-day");
  });

  it("shortens the window for the card", () => {
    expect(shortWindow("between about Oct 6, 14:40 and Oct 6, 16:05 UTC")).toBe(
      "about Oct 6, 14:40 to 16:05 UTC",
    );
    expect(shortWindow("between about Oct 6, 14:40 and Oct 13, 14:40 UTC")).toBe(
      "about Oct 6, 14:40 to Oct 13, 14:40 UTC",
    );
    expect(shortWindow("between block 68,713,707 and block 68,730,849")).toBe(
      "between block 68,713,707 and block 68,730,849",
    );
  });

  it("rounds the chance to a whole percent without ever rounding to a certainty", () => {
    expect(wholePercent(6_200)).toBe("62%");
    expect(wholePercent(6_249)).toBe("62%");
    expect(wholePercent(10_000)).toBe("100%");
    expect(wholePercent(0)).toBe("0%");
    expect(wholePercent(30)).toBe("under 1%");
    expect(wholePercent(9_960)).toBe("over 99%");
    expect(wholePercent(null)).toBeNull();
  });
});

describe("GET /api/v1/funding/{asset}", () => {
  it("answers with the running market, its chance, the rule that picked it and links", async () => {
    const res = await getFunding(req("/api/v1/funding/BTC"), "BTC", deps());
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("cache-control")).toBe(
      "public, max-age=15, s-maxage=15, stale-while-revalidate=60",
    );
    const body = await res.json();
    const a = addr(0x1005);
    expect(body).toMatchObject({
      network: "monad-testnet",
      asset: "BTC",
      perp: { id: "16", exchange: testnet.external.perpl.exchange },
      pick: { rule: FUNDING_PICK.rule, text: FUNDING_PICK.text, matched: "running", candidates: 2 },
      reason: null,
      asOf: { block: HEAD.toString(), time: new Date(NOW).toISOString() },
      links: {
        embed: "https://book.playhunch.xyz/embed/funding/BTC",
        calculator: "https://book.playhunch.xyz/calculator?perp=BTC",
        markets: "https://book.playhunch.xyz/api/v1/markets?template=1&asset=BTC&phase=open",
        create: "https://book.playhunch.xyz/create?template=1&asset=BTC",
      },
    });
    expect(body.market).toMatchObject({
      id: 5,
      address: a,
      phase: "trading",
      headline: "Market's chance BTC longs pay more than $12.04 per BTC this week: 62%",
      clause: "BTC longs pay more than $12.04 per BTC",
      period: "this week",
      rule: ruleText(HEAD - 100_000n, HEAD - 100_000n + WEEK_BLOCKS),
      chance: { yes: 0.62, bps: 6_200, percent: "62%", source: "book", words: "the Kuru book's mid" },
      window: {
        startBlock: (HEAD - 100_000n).toString(),
        endBlock: (HEAD - 100_000n + WEEK_BLOCKS).toString(),
        startAt: new Date(NOW - 100_000 * 400).toISOString(),
        endAt: new Date(NOW + Number(WEEK_BLOCKS - 100_000n) * 400).toISOString(),
        estimated: true,
        running: true,
      },
      threshold: { raw: "120442", expectedScalingExp: 0 },
      pool: { totalUsdc: "690", stakers: 11 },
      book: { bid: "0.61", ask: "0.63", mid: "0.62" },
      createdByHunch: true,
      links: {
        app: `https://book.playhunch.xyz/m/${a}`,
        verify: `https://book.playhunch.xyz/verify/${a}`,
        api: `https://book.playhunch.xyz/api/v1/markets/${a}`,
        evidence: `https://book.playhunch.xyz/api/v1/markets/${a}/evidence`,
        embed: `https://book.playhunch.xyz/embed/m/${a}`,
        explorer: `https://testnet.monadscan.com/address/${a}`,
      },
    });
    expect(body.market.question).toMatch(
      /^Will BTC longs pay more than \$12\.04 per BTC in funding on Perpl between about .+ UTC\?$/,
    );
    expect(body.market.window.words).toMatch(/^between about .+ UTC$/);
    expect(body.alsoOpen).toEqual([
      expect.objectContaining({
        id: 6,
        phase: "pool",
        chance: { bps: 10_000, percent: "100%", source: "pool" },
      }),
    ]);
  });

  it("uses the pool's split for a market still taking stakes", async () => {
    markets = [fundingMarket(6)];
    const body = await (await getFunding(req("/x"), "btc", deps())).json();
    expect(body.asset).toBe("BTC");
    expect(body.pick.matched).toBe("upcoming");
    expect(body.market).toMatchObject({
      id: 6,
      phase: "pool",
      headline: "Market's chance BTC longs pay more than $12.04 per BTC in the coming week: 59%",
      chance: { bps: 5_942, percent: "59.42%", source: "pool", words: "the pool's split" },
      book: null,
      window: { running: false },
    });
  });

  it("says why there is no market, with a link to start one", async () => {
    markets = markets.filter((m) => m.id !== 5 && m.id !== 6);
    const res = await getFunding(req("/x"), "BTC", deps());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.market).toBeNull();
    expect(body.pick).toMatchObject({ matched: null, candidates: 0 });
    expect(body.reason).toBe(
      "No template 1 (Perpl net funding) market on BTC is open right now: none is taking stakes before its window starts or trading before its window ends.",
    );
    expect(body.alsoOpen).toEqual([]);
    expect(body.links.create).toBe("https://book.playhunch.xyz/create?template=1&asset=BTC");
  });

  it("refuses an unknown or malformed asset, without caching the error", async () => {
    const unknown = await getFunding(req("/x"), "DOGE", deps());
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get("cache-control")).toBe("no-store");
    expect(await unknown.json()).toEqual({
      error: "DOGE is not a Perpl perp on monad-testnet. Known: BTC, ETH, SOL, MON.",
    });
    const bad = await getFunding(req("/x"), "BTC/USD", deps());
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe("BTC/USD is not an asset name such as BTC.");
  });

  it("answers 502 when the chain does not", async () => {
    const d = deps();
    (d.sdk.markets.all as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("rpc down"));
    const res = await getFunding(req("/x"), "BTC", d);
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/^Could not read the chain right now/);
  });

  it("writes CSV as field,value rows", async () => {
    const res = await getFunding(req("/api/v1/funding/BTC?format=csv"), "BTC", deps());
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="hunch-book-funding-BTC.csv"');
    const text = await res.text();
    expect(text).toContain(
      "market.headline,Market's chance BTC longs pay more than $12.04 per BTC this week: 62%",
    );
    expect(text).toContain("market.chance.bps,6200");
  });

  it("is listed in the API's index", async () => {
    const index = await getIndex(req("/api/v1"), deps()).json();
    expect(index.endpoints.funding).toBe("https://book.playhunch.xyz/api/v1/funding/{asset}");
    expect(index.endpoints.fundingEmbed).toBe("https://book.playhunch.xyz/embed/funding/{asset}");
  });
});

describe("GET /embed/funding/{asset}", () => {
  it("renders a frameable card with the chance and a link to the market", async () => {
    const res = await getFundingEmbed(req("/embed/funding/BTC"), "BTC", deps());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors *");
    expect(res.headers.get("cache-control")).toBe(
      "public, max-age=30, s-maxage=30, stale-while-revalidate=120",
    );
    const html = await res.text();
    expect(html).not.toContain("<script");
    expect(html).toContain("<h1>Market's chance BTC longs pay more than $12.04 per BTC this week</h1>");
    expect(html).toContain('<span class="value">62%</span>');
    expect(html).toContain("from the Kuru book&#39;s mid");
    expect(html).toContain("Bid 0.61 · Ask 0.63");
    expect(html).toContain(`href="https://book.playhunch.xyz/m/${addr(0x1005)}"`);
    expect(html).toContain("Trade on Hunch Book");
    expect(html).toMatch(/<p class="label">Funding window about [A-Z][a-z]{2} \d+, \d\d:\d\d to .+ UTC<\/p>/);
    expect(html).toContain(
      "<title>Market&#39;s chance BTC longs pay more than $12.04 per BTC this week: 62% | Hunch Book</title>",
    );
  });

  it("escapes text that comes from the chain", async () => {
    markets = [
      fundingMarket(6, {
        overrides: {
          rule: "Will <script>alert(1)</script> longs pay shorts on net in funding on Perpl (x, perp 16) between block 1 and block 2?",
          phaseLabel: '<img src=x onerror="y">',
        },
      }),
    ];
    const html = await (await getFundingEmbed(req("/x"), "BTC", deps())).text();
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).toContain(
      "&lt;script&gt;alert(1)&lt;/script&gt; longs pay shorts on net in the coming week",
    );
    expect(html).toContain("Stake on Hunch Book");
  });

  it("says when no market is open, and links to starting one", async () => {
    markets = [];
    const res = await getFundingEmbed(req("/x"), "eth", deps());
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<h1>No open market on ETH funding right now</h1>");
    expect(html).toContain('href="https://book.playhunch.xyz/create?template=1&amp;asset=ETH"');
    expect(html).toContain("Start one on Hunch Book");
  });

  it("answers unknown and malformed assets with a short card, never cached", async () => {
    const unknown = await getFundingEmbed(req("/x"), "doge", deps());
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get("cache-control")).toBe("no-store");
    expect(await unknown.text()).toContain(
      "DOGE is not a Perpl perp on monad-testnet. Known: BTC, ETH, SOL, MON.",
    );
    const bad = await getFundingEmbed(req("/x"), "<b>", deps());
    expect(bad.status).toBe(400);
    expect(await bad.text()).not.toContain("<b>");
    const d = deps();
    (d.sdk.markets.all as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("rpc down"));
    expect((await getFundingEmbed(req("/x"), "BTC", d)).status).toBe(502);
  });

  it("may be framed, like the market card, while the app may not", async () => {
    const rules = await nextConfig.headers?.();
    const app = rules?.find((r) => r.source === "/((?!embed/).*)");
    expect(app).toBeTruthy();
    const appRule = /^\/((?!embed\/).*)$/;
    expect(appRule.test("/embed/funding/BTC")).toBe(false);
    expect(appRule.test("/calculator")).toBe(true);
  });
});

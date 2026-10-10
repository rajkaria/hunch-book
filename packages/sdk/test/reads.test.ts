import { encodePerplFundingParams, marketAbi, Outcome, Phase, quoteTrade } from "@hunch-book/shared";
import type { Address } from "viem";
import { beforeEach, describe, expect, it } from "vitest";
import {
  bestPricesFromKuru,
  getMarket,
  getOrderBook,
  getPortfolio,
  getPosition,
  HunchError,
  listAllMarkets,
  listMarkets,
  marketChance,
  quote,
} from "../src/index.js";
import { FakeChain, Revert } from "./fake-chain.js";
import {
  addr,
  blockWindow,
  type FakeMarket,
  Ledger,
  registerBook,
  registerFactory,
  registerMarket,
  registerResolver,
  registerToken,
} from "./fixtures.js";

const params = (n: bigint) =>
  encodePerplFundingParams({
    perpId: 16n,
    startBlock: 2_000n + n,
    endBlock: 20_000n,
    threshold: 0n,
    expectedScalingExp: 2,
  });

function market(id: number, extra: Partial<FakeMarket> = {}): FakeMarket {
  return {
    address: addr(0x1000 + id),
    id,
    templateId: 1,
    params: params(BigInt(id)),
    phase: Phase.Pool,
    window: blockWindow(2_000n, 20_000n, 1_900_000_000n),
    pool: { yes: 300_000_000n, no: 100_000_000n, stakers: 4 },
    resolver: addr(0xaa),
    ...extra,
  };
}

const YES = addr(0x2001);
const NO = addr(0x2002);
const BOOK = addr(0x3000);
const USER = addr(0x4000);

let chain: FakeChain;
let markets: FakeMarket[];
const ledger = new Ledger();

beforeEach(() => {
  chain = new FakeChain();
  markets = [
    market(1),
    market(2, {
      phase: Phase.Graduated,
      graduated: true,
      book: BOOK,
      tokens: { yes: YES, no: NO },
    }),
    market(3, { phase: Phase.Settled, outcome: Outcome.No }),
  ];
  registerFactory(chain, markets);
  for (const m of markets) registerMarket(chain, m);
  registerResolver(chain, addr(0xaa), () => [0, `0x${"00".repeat(32)}`], {
    describe: "  YES if longs pay.  ",
  });
  registerBook(chain, BOOK, YES, {
    bids: [
      { price: 410_000n, size: 50_000_000n },
      { price: 400_000n, size: 100_000_000n },
    ],
    asks: [
      { price: 430_000n, size: 40_000_000n },
      { price: 450_000n, size: 200_000_000n },
    ],
  });
  registerToken(chain, YES, ledger);
  registerToken(chain, NO, ledger);
  ledger.set(YES, USER, 25_000_000n);
});

describe("markets", () => {
  it("lists newest first with pagination, and oldest first on request", async () => {
    const ctx = chain.context();
    const page = await listMarkets(ctx, { limit: 2 });
    expect(page.total).toBe(3);
    expect(page.markets.map((m) => m.id)).toEqual([3, 2]);
    const next = await listMarkets(ctx, { limit: 2, offset: 2 });
    expect(next.markets.map((m) => m.id)).toEqual([1]);
    const oldest = await listMarkets(ctx, { order: "oldest", limit: 5 });
    expect(oldest.markets.map((m) => m.id)).toEqual([1, 2, 3]);
    expect((await listAllMarkets(ctx)).length).toBe(3);
  });

  it("reads one market in full: decoded params, the rule sentence, prices and chance", async () => {
    const ctx = chain.context();
    const pool = await getMarket(ctx, markets[0]?.address as Address);
    expect(pool).toMatchObject({
      id: 1,
      templateId: 1,
      template: "Perpl net funding",
      phaseName: "pool",
      phaseLabel: "Pool",
      outcomeLabel: "unresolved",
      asset: "BTC",
      rule: "YES if longs pay.",
      pool: { yes: 300_000_000n, no: 100_000_000n, total: 400_000_000n, stakers: 4 },
      chance: { bps: 7_500, source: "pool" },
      prices: null,
      book: null,
    });
    expect(pool?.decoded.kind).toBe("perpl-funding");

    const trading = await getMarket(ctx, markets[1]?.address as Address);
    expect(trading?.prices).toEqual({ bidE6: 410_000n, askE6: 430_000n });
    expect(trading?.chance).toEqual({ bps: 4_200, source: "book" });
    expect(trading?.phaseName).toBe("trading");

    const settled = await getMarket(ctx, markets[2]?.address as Address);
    expect(settled?.chance).toEqual({ bps: 0, source: "settled" });
    expect(settled?.outcomeLabel).toBe("no");
  });

  it("returns null for an address the factory does not know", async () => {
    expect(await getMarket(chain.context(), addr(0xdead))).toBeNull();
  });

  it("works out the chance for every phase and book shape", () => {
    const pool = { yes: 1n, no: 3n, total: 4n };
    const base = { outcome: Outcome.Unresolved, pool, prices: null };
    expect(marketChance({ ...base, phase: Phase.Pool })).toEqual({ bps: 2_500, source: "pool" });
    expect(marketChance({ ...base, phase: Phase.Pool, pool: { yes: 0n, no: 0n, total: 0n } }).source).toBe(
      "empty",
    );
    expect(marketChance({ ...base, phase: Phase.Voided })).toEqual({ bps: 5_000, source: "voided" });
    expect(marketChance({ ...base, phase: Phase.Settled, outcome: Outcome.Yes })).toEqual({
      bps: 10_000,
      source: "settled",
    });
    const book = (bidE6: bigint | null, askE6: bigint | null) => ({
      ...base,
      phase: Phase.Graduated,
      prices: { bidE6, askE6 },
    });
    expect(marketChance(book(null, 600_000n))).toEqual({ bps: 6_000, source: "book-one-sided" });
    expect(marketChance(book(null, null))).toEqual({ bps: null, source: "book-empty" });
    expect(bestPricesFromKuru(2n ** 256n - 1n, 0n)).toEqual({ bidE6: null, askE6: null });
    expect(bestPricesFromKuru(410_000_000_000_000_001n, 430_000_000_000_000_001n)).toEqual({
      bidE6: 410_000n,
      askE6: 430_001n,
    });
  });

  it("reads a position and a portfolio, keeping only markets with something in them", async () => {
    const ctx = chain.context();
    const position = await getPosition(ctx, markets[1]?.address as Address, USER);
    expect(position.balances).toEqual({ yes: 25_000_000n, no: 0n });
    const portfolio = await getPortfolio(ctx, USER);
    expect(portfolio.map((p) => p.info.id)).toEqual([2]);
  });

  it("throws a plain error when a market read reverts", async () => {
    chain.register(markets[0]?.address as Address, marketAbi, {
      phase: () => {
        throw new Revert(marketAbi, "WrongPhase", [0]);
      },
    });
    await expect(getMarket(chain.context(), markets[0]?.address as Address)).rejects.toThrow(
      /Could not read market/,
    );
  });
});

describe("book and quotes", () => {
  it("reads the book with its params, mid, spread and depth", async () => {
    const book = await getOrderBook(chain.context(), markets[1]?.address as Address);
    expect(book.midE6).toBe(420_000n);
    expect(book.spreadE6).toBe(20_000n);
    expect(book.depth.askSize).toBe(240_000_000n);
    expect(book.params.pricePrecision).toBe(1_000_000n);
  });

  it("refuses a book read for a market without one", async () => {
    await expect(getOrderBook(chain.context(), markets[0]?.address as Address)).rejects.toThrow(
      /no order book yet/,
    );
  });

  it("quotes every kind with the shared math, a limit, an approval and an impact", async () => {
    const ctx = chain.context();
    const book = await getOrderBook(ctx, markets[1]?.address as Address);
    for (const [kind, amount] of [
      ["buyYes", 30_000_000n],
      ["sellYes", 60_000_000n],
      ["buyNo", 20_000_000n],
      ["sellNo", 20_000_000n],
    ] as const) {
      const q = await quote(ctx, markets[1]?.address as Address, kind, amount, { slippageBps: 50n });
      const expected = quoteTrade(kind, book, amount, book.params);
      expect(q).toMatchObject(expected);
      expect(q.slippageBps).toBe(50n);
      expect(q.approval.token).toBe(
        kind === "buyYes" || kind === "buyNo" ? "usdc" : kind === "sellYes" ? "yes" : "no",
      );
      expect(q.impactBps).not.toBeNull();
    }
    const buy = await quote(ctx, markets[1]?.address as Address, "buyYes", 30_000_000n);
    // 30 USDC: all 40 YES at 0.43 (17.2 USDC), then 12.799999 USDC at 0.45 is 28.444442 YES (Kuru truncates).
    expect(buy.tokens).toBe(68_444_442n);
    expect(buy.limit).toBe((68_444_442n * 9_900n) / 10_000n);
    expect(buy.touchPriceE6).toBe(430_000n);
  });

  it("flags a quote the book cannot fill", async () => {
    const q = await quote(chain.context(), markets[1]?.address as Address, "sellYes", 1_000_000_000n);
    expect(q.shortfall).toBe("liquidity");
  });

  it("wraps errors in plain words", () => {
    const e = HunchError.from(new Error("boom"));
    expect(e).toBeInstanceOf(HunchError);
    expect(e.message).toBe("boom");
  });
});

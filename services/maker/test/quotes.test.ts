import type { L2Book } from "@hunch-book/shared";
import { describe, expect, it } from "vitest";
import {
  affordableSize,
  type BookSpec,
  decideRequote,
  externalTopOfBook,
  maxSizeAt,
  minSizeAt,
  planFunding,
  priceLadder,
  type QuoteParams,
  type Quotes,
  quoteCostToPlace,
  quoteRefundOnCancel,
  sameQuotes,
  sizeQuotes,
  widenFactor,
} from "../src/quotes.js";

// Hunch Book's Kuru book parameters (docs/PROTOCOL.md §8.1): precisions 1e6/1e6, tick 0.001, min 1 YES.
const book: BookSpec = {
  pricePrecision: 1_000_000,
  sizePrecision: 1_000_000n,
  tickSize: 1_000,
  minSize: 1_000_000n,
  maxSize: 5_000_000_000n,
  baseDecimals: 6,
  quoteDecimals: 6,
};

const params: QuoteParams = {
  halfSpread: 0.015,
  minSpread: 0.02,
  skew: 0.02,
  levels: 1,
  levelStep: 0.01,
  orderSize: 20,
  inventoryCap: 100,
  minPrice: 0.01,
  maxPrice: 0.99,
};

const none = { bestBid: null, bestAsk: null };
const ladder = (fair: number, over: Partial<Parameters<typeof priceLadder>[0]> = {}) =>
  priceLadder({ fair, position: 0, widen: 1, params, book, external: none, ...over });
const USDC = 1_000_000n;

describe("priceLadder", () => {
  it("quotes fair ± half-spread, bids rounded down and asks up to the 0.001 tick", () => {
    expect(ladder(0.42)).toMatchObject({ bids: [405_000], asks: [435_000] });
    const off = ladder(0.4237);
    expect(off).toMatchObject({ bids: [408_000], asks: [439_000] });
    for (const p of [...off.bids, ...off.asks]) expect(p % book.tickSize).toBe(0);
  });

  it("never quotes a total spread under 2 cents", () => {
    const tight = { ...params, halfSpread: 0 };
    expect(ladder(0.5, { params: tight })).toMatchObject({ bids: [490_000], asks: [510_000] });
    const l = ladder(0.5004, { params: tight });
    expect((l.asks[0] as number) - (l.bids[0] as number)).toBeGreaterThanOrEqual(20_000);
  });

  it("clamps to [0.01, 0.99] and keeps the 2-cent spread at the edges", () => {
    expect(ladder(0.999)).toMatchObject({ bids: [970_000], asks: [990_000] });
    expect(ladder(0.001)).toMatchObject({ bids: [10_000], asks: [30_000] });
    expect(ladder(1)).toMatchObject({ bids: [970_000], asks: [990_000] });
    expect(ladder(0)).toMatchObject({ bids: [10_000], asks: [30_000] });
  });

  it("skews both sides against the inventory it holds", () => {
    expect(ladder(0.42, { position: 50 })).toMatchObject({ bids: [395_000], asks: [425_000] });
    expect(ladder(0.42, { position: -100 })).toMatchObject({ bids: [425_000], asks: [455_000] });
    // Beyond the cap the skew stops growing.
    expect(ladder(0.42, { position: -500 })).toMatchObject({ bids: [425_000], asks: [455_000] });
  });

  it("widens as close approaches", () => {
    expect(widenFactor(7_200, 3_600, 3)).toBe(1);
    expect(widenFactor(3_600, 3_600, 3)).toBe(1);
    expect(widenFactor(1_800, 3_600, 3)).toBe(2);
    expect(widenFactor(0, 3_600, 3)).toBe(3);
    expect(widenFactor(-5, 3_600, 3)).toBe(3);
    expect(widenFactor(10, 0, 3)).toBe(1);
    expect(ladder(0.5, { widen: 3 })).toMatchObject({ bids: [455_000], asks: [545_000] });
  });

  it("never crosses another trader's resting order (post-only)", () => {
    expect(ladder(0.42, { external: { bestBid: null, bestAsk: 400_000 } }).bids).toEqual([399_000]);
    expect(ladder(0.42, { external: { bestBid: 440_000, bestAsk: null } }).asks).toEqual([441_000]);
    // A cross that would push a side out of range drops that side.
    expect(ladder(0.02, { external: { bestBid: null, bestAsk: 10_000 } }).bids).toEqual([]);
  });

  it("places extra levels a step apart and drops those out of range", () => {
    const three = { ...params, levels: 3 };
    expect(ladder(0.42, { params: three })).toMatchObject({
      bids: [405_000, 395_000, 385_000],
      asks: [435_000, 445_000, 455_000],
    });
    expect(ladder(0.03, { params: three }).bids).toEqual([15_000]);
  });
});

describe("Kuru's rounding", () => {
  it("rounds the cost of a buy up and its refund down", () => {
    expect(quoteCostToPlace(405_000, 12_345_679n, book)).toBe(5_000_000n);
    expect(quoteRefundOnCancel(405_000, 12_345_679n, book)).toBe(4_999_999n);
    expect(quoteCostToPlace(405_000, 20_000_000n, book)).toBe(8_100_000n);
  });

  it("finds the largest size a budget can place", () => {
    const size = affordableSize(5n * USDC, 405_000, book);
    expect(quoteCostToPlace(405_000, size, book)).toBeLessThanOrEqual(5n * USDC);
    expect(quoteCostToPlace(405_000, size + 1n, book)).toBeGreaterThan(5n * USDC);
    expect(affordableSize(0n, 405_000, book)).toBe(0n);
  });
});

describe("sizeQuotes", () => {
  const l = ladder(0.42);
  const sized = (position: number, yesAvailable: bigint, usdcAvailable: bigint, p = params) =>
    sizeQuotes({
      ladder: priceLadder({ fair: 0.42, position, widen: 1, params: p, book, external: none }),
      params: p,
      book,
      position,
      yesAvailable,
      usdcAvailable,
    });

  it("mints the YES its asks need and bids with what is left", () => {
    const q = sizeQuotes({
      ladder: l,
      params,
      book,
      position: 0,
      yesAvailable: 0n,
      usdcAvailable: 1_000n * USDC,
    });
    expect(q.asks).toEqual([{ price: 435_000, size: 20_000_000n }]);
    expect(q.bids).toEqual([{ price: 405_000, size: 20_000_000n }]);
    expect(q.mint).toBe(20n * USDC);
  });

  it("caps each side by the per-market inventory cap", () => {
    expect(sized(-90, 0n, 1_000n * USDC).asks[0]?.size).toBe(10_000_000n);
    expect(sized(-100, 0n, 1_000n * USDC).asks).toEqual([]);
    expect(sized(100, 200n * USDC, 1_000n * USDC).bids).toEqual([]);
    expect(sized(95, 200n * USDC, 1_000n * USDC).bids[0]?.size).toBe(5_000_000n);
  });

  it("caps sizes by the inventory it holds and can fund", () => {
    const thin = sized(0, 0n, 5n * USDC);
    expect(thin.asks[0]?.size).toBe(5_000_000n);
    expect(thin.mint).toBe(5n * USDC);
    expect(thin.bids).toEqual([]);
    const held = sized(0, 20n * USDC, 5n * USDC);
    expect(held.mint).toBe(0n);
    expect(held.bids[0]?.size).toBe(12_345_679n);
  });

  it("drops levels below the book's minimum size", () => {
    expect(sized(0, 0n, 300_000n).bids).toEqual([]);
    expect(sized(0, 0n, 300_000n).asks).toEqual([]);
  });

  it("spreads size over levels until a limit is reached", () => {
    const three = { ...params, levels: 3 };
    const q = sized(-60, 0n, 1_000n * USDC, three);
    expect(q.asks.map((o) => o.size)).toEqual([20_000_000n, 20_000_000n]);
    expect(q.bids.map((o) => o.size)).toEqual([20_000_000n, 20_000_000n, 20_000_000n]);
  });
});

describe("planFunding", () => {
  const quotes: Quotes = {
    bids: [{ price: 405_000, size: 20_000_000n }],
    asks: [{ price: 435_000, size: 20_000_000n }],
  };
  const empty = { marginYes: 0n, marginUsdc: 0n, lockedYes: 0n, lockedUsdc: 0n, walletYes: 0n };

  it("mints and deposits everything on the first quote", () => {
    expect(planFunding({ quotes, book, ...empty, walletUsdc: 100n * USDC })).toEqual({
      mint: 20n * USDC,
      depositYes: 20n * USDC,
      depositUsdc: 8_100_000n,
    });
  });

  it("needs nothing when the cancelled orders refund enough", () => {
    expect(
      planFunding({
        quotes,
        book,
        marginYes: 0n,
        marginUsdc: 0n,
        lockedYes: 20n * USDC,
        lockedUsdc: 8_100_000n,
        walletYes: 0n,
        walletUsdc: 0n,
      }),
    ).toEqual({ mint: 0n, depositYes: 0n, depositUsdc: 0n });
  });

  it("uses wallet YES before minting", () => {
    expect(
      planFunding({ quotes, book, ...empty, walletYes: 15n * USDC, walletUsdc: 100n * USDC }),
    ).toMatchObject({
      mint: 5n * USDC,
      depositYes: 20n * USDC,
    });
  });

  it("refuses a plan the wallet cannot pay for", () => {
    expect(() => planFunding({ quotes, book, ...empty, walletUsdc: 10n * USDC })).toThrow(/wallet/);
  });
});

describe("externalTopOfBook", () => {
  const l2: L2Book = {
    block: 1n,
    bids: [
      { price: 405_000n, size: 20_000_000n },
      { price: 400_000n, size: 7_000_000n },
    ],
    asks: [
      { price: 435_000n, size: 25_000_000n },
      { price: 440_000n, size: 3_000_000n },
    ],
  };

  it("removes the bot's own resting size", () => {
    const own = { bids: new Map([[405_000, 20_000_000n]]), asks: new Map([[435_000, 20_000_000n]]) };
    expect(externalTopOfBook(l2, own)).toEqual({ bestBid: 400_000, bestAsk: 435_000 });
    expect(externalTopOfBook({ block: 1n, bids: [], asks: [] }, own)).toEqual({
      bestBid: null,
      bestAsk: null,
    });
  });
});

describe("decideRequote", () => {
  const live: Quotes = {
    bids: [{ price: 405_000, size: 20_000_000n }],
    asks: [{ price: 435_000, size: 20_000_000n }],
  };
  const base = {
    live,
    desired: live,
    fair: 0.42,
    lastFair: 0.42,
    filled: false,
    now: 1_000,
    lastQuoteAt: 900,
    heartbeatSeconds: 300,
    threshold: 0.005,
    pricePrecision: 1_000_000,
  };
  const shifted: Quotes = { bids: [{ price: 406_000, size: 20_000_000n }], asks: live.asks };

  it("does nothing while the book already shows the desired quotes", () => {
    expect(decideRequote({ ...base, fair: 0.9, filled: true, lastQuoteAt: null })).toBeNull();
    expect(sameQuotes(live, { bids: [...live.bids], asks: [...live.asks] })).toBe(true);
  });

  it("names each reason to requote", () => {
    expect(decideRequote({ ...base, live: { bids: [], asks: [] } })).toBe("no-orders");
    expect(decideRequote({ ...base, desired: { bids: [], asks: [] } })).toBe("pull");
    expect(decideRequote({ ...base, desired: shifted, filled: true })).toBe("fill");
    expect(decideRequote({ ...base, desired: shifted, fair: 0.426 })).toBe("fair-moved");
    expect(
      decideRequote({ ...base, desired: { bids: live.bids, asks: [{ price: 441_000, size: 20_000_000n }] } }),
    ).toBe("quotes-moved");
    expect(decideRequote({ ...base, desired: shifted, lastQuoteAt: 600 })).toBe("heartbeat");
  });

  it("waits for the heartbeat when the change is small", () => {
    expect(decideRequote({ ...base, desired: shifted, fair: 0.4231 })).toBeNull();
  });
});

describe("Kuru v2 books: limits by notional", () => {
  // A v2 Hunch book: no size limits, but every order between 1 and 2,000 USDC of notional.
  const v2: BookSpec = {
    ...book,
    minSize: 1n,
    maxSize: 2n ** 96n - 1n,
    minQuoteNotional: USDC,
    maxQuoteNotional: 2_000n * USDC,
  };

  it("turns the notional limits into sizes at each price", () => {
    expect(minSizeAt(500_000, v2)).toBe(2n * USDC); // 2 YES at 0.50 is 1 USDC
    expect(minSizeAt(30_000, v2)).toBe(33_333_334n); // rounded up so the notional reaches 1 USDC
    expect(maxSizeAt(500_000, v2)).toBe(4_000n * USDC);
    expect(minSizeAt(500_000, book)).toBe(book.minSize); // v1: the book's own sizes
    expect(maxSizeAt(500_000, book)).toBe(book.maxSize);
  });

  it("drops levels whose notional is below the minimum, even when the size is fine", () => {
    // 3 YES per level: about 1.5 USDC around 0.50, only 0.09 USDC at 0.03.
    const small = { ...params, orderSize: 3, levels: 1 };
    const atHalf = sizeQuotes({
      ladder: priceLadder({ fair: 0.5, position: 0, widen: 1, params: small, book: v2, external: none }),
      params: small,
      book: v2,
      position: 0,
      yesAvailable: 100n * USDC,
      usdcAvailable: 100n * USDC,
    });
    expect(atHalf.bids).toHaveLength(1);
    expect(atHalf.asks).toHaveLength(1);
    const cheap = sizeQuotes({
      ladder: { bids: [30_000], asks: [], reservation: 0.04, halfSpread: 0.01 },
      params: small,
      book: v2,
      position: 0,
      yesAvailable: 0n,
      usdcAvailable: 100n * USDC,
    });
    expect(cheap.bids).toHaveLength(0);
  });

  it("caps a level at the maximum notional", () => {
    const tiny: BookSpec = { ...v2, maxQuoteNotional: 5n * USDC };
    const big = { ...params, orderSize: 100, levels: 1 };
    const q = sizeQuotes({
      ladder: { bids: [500_000], asks: [], reservation: 0.51, halfSpread: 0.01 },
      params: big,
      book: tiny,
      position: 0,
      yesAvailable: 0n,
      usdcAvailable: 1_000n * USDC,
    });
    expect(q.bids[0]?.size).toBe(10n * USDC); // 10 YES at 0.50 = 5 USDC
  });
});

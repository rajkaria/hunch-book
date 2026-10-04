import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  bookDepth,
  decodeL2Book,
  HUNCH_BOOK_PARAMS,
  type KuruMatchParams,
  type L2Level,
  maxTradeAmount,
  midPrice,
  priceImpactBps,
  quoteBuyNo,
  quoteBuyYes,
  quoteForExactBase,
  quoteSellNo,
  quoteSellYes,
  quoteTrade,
  simulateMarketBuy,
  simulateMarketSell,
  touchPrice,
  tradeApproval,
  tradeLimit,
  withCumulative,
} from "@hunch-book/shared";
import { describe, expect, it } from "vitest";

// The quote math against the numbers HunchRouter produced on a fork of Kuru's real testnet book
// (contracts/test/fork/KuruRouter.fork.t.sol). Same book: asks 100 YES at 0.40 and 200 at 0.45,
// bids 100 YES at 0.35 and 300 at 0.30, fees 0/0.

const lvl = (price: number, size: bigint): L2Level => ({ price: BigInt(price), size });
const forkBook = {
  asks: [lvl(400_000, 100_000_000n), lvl(450_000, 200_000_000n)],
  bids: [lvl(350_000, 100_000_000n), lvl(300_000, 300_000_000n)],
};
const p = HUNCH_BOOK_PARAMS;
const withFee: KuruMatchParams = { ...p, takerFeeBps: 30n };

describe("router paths on the fork book (values from the fork suite)", () => {
  it("buyYes 100 USDC: 100 at 0.40, then floor(60e6 / 0.45) at 0.45 = 233,333,333 YES", () => {
    const q = quoteBuyYes(forkBook, 100_000_000n, p);
    expect(q.tokens).toBe(233_333_333n);
    expect(q.usdc).toBe(100_000_000n);
    expect(q.returned).toEqual({ usdc: 0n, yes: 0n });
    expect(q.levels).toBe(2);
    expect(q.shortfall).toBeNull();
    // The router's minYesOut: 233,333,333 passes on the fork, 233,333,334 reverts.
    expect(tradeLimit(q, 0n)).toBe(233_333_333n);
  });

  it("sellYes 150 YES: 100 at 0.35 + 50 at 0.30 = 50 USDC", () => {
    const q = quoteSellYes(forkBook, 150_000_000n, p);
    expect(q.usdc).toBe(50_000_000n);
    expect(q.tokens).toBe(150_000_000n);
    expect(q.shortfall).toBeNull();
  });

  it("buyNo 100: mint 100 sets, sell the YES into the 0.35 bid, pay 65 USDC", () => {
    const q = quoteBuyNo(forkBook, 100_000_000n, p);
    expect(q.usdc).toBe(65_000_000n);
    expect(q.tokens).toBe(100_000_000n);
    // maxUsdcIn 65 passes on the fork, 64 reverts.
    expect(tradeLimit(q, 0n)).toBe(65_000_000n);
  });

  it("sellNo 100: borrow Q = 40 USDC for 100 YES at 0.40, merge, receive 60 USDC", () => {
    expect(quoteForExactBase(forkBook.asks, 100_000_000n, p)).toBe(40_000_000n);
    const q = quoteSellNo(forkBook, 100_000_000n, p);
    expect(q.usdc).toBe(60_000_000n);
    expect(q.returned.yes).toBe(0n);
    // minUsdcOut 60 passes on the fork, 60 + 1 reverts.
    expect(tradeLimit(q, 0n)).toBe(60_000_000n);
  });

  it("sellNo 250 across both ask levels: Q = 107.5, receive 142.5", () => {
    expect(quoteForExactBase(forkBook.asks, 250_000_000n, p)).toBe(107_500_000n);
    expect(quoteSellNo(forkBook, 250_000_000n, p).usdc).toBe(142_500_000n);
  });

  it("quoteTrade dispatches to the four paths", () => {
    expect(quoteTrade("buyYes", forkBook, 20_000_000n, p).tokens).toBe(50_000_000n);
    expect(quoteTrade("sellYes", forkBook, 50_000_000n, p).usdc).toBe(17_500_000n);
    expect(quoteTrade("buyNo", forkBook, 40_000_000n, p).usdc).toBe(26_000_000n);
    expect(quoteTrade("sellNo", forkBook, 50_000_000n, p).usdc).toBe(30_000_000n);
  });
});

describe("taker fees (the fork suite's 30 bps book)", () => {
  const feeBook = { asks: [lvl(400_000, 1_000_000_000n)], bids: [lvl(350_000, 100_000_000n)] };

  it("sellNo 100: Q = 40,120,362, receive 59,879,638 and 2 extra YES from rounding", () => {
    expect(quoteForExactBase(feeBook.asks, 100_000_000n, withFee)).toBe(40_120_362n);
    const q = quoteSellNo(feeBook, 100_000_000n, withFee);
    expect(q.usdc).toBe(59_879_638n);
    expect(q.returned.yes).toBe(2n);
  });

  it("buyYes 10 USDC: 25 YES minus ceil(25e6 * 30 / 1e4) = 24,925,000", () => {
    expect(quoteBuyYes(feeBook, 10_000_000n, withFee).tokens).toBe(24_925_000n);
  });

  it("sellYes 10 YES: 3.5 USDC minus the fee = 3,489,500", () => {
    expect(quoteSellYes(feeBook, 10_000_000n, withFee).usdc).toBe(3_489_500n);
  });

  it("buyNo 20: proceeds 6,979,000, cost 13,021,000", () => {
    expect(quoteBuyNo(feeBook, 20_000_000n, withFee).usdc).toBe(13_021_000n);
  });
});

describe("the sellNo quote is exact and minimal (as the fork fuzz test checks)", () => {
  // The fork suite's uneven three-level ask side with a 30 bps taker fee.
  const asks = [lvl(333_000, 37_123_456n), lvl(417_000, 12_500_000n), lvl(583_000, 80_000_000n)];
  let seed = 7n;
  const next = (): bigint => {
    seed = (seed * 6_364_136_223_846_793_005n + 1_442_695_040_888_963_407n) % 2n ** 64n;
    return seed;
  };
  const cases = [1n, 2n, 999n, 37_123_456n, 37_123_457n, 49_623_456n, 128_999_999n];
  for (let i = 0; i < 300; i++) cases.push((next() % 129_000_000n) + 1n);

  it("credits at least noIn for Q and fewer for Q - 1, for 307 sizes", () => {
    for (const noIn of cases) {
      const q = quoteForExactBase(asks, noIn, withFee);
      expect(q, `noIn ${noIn}`).not.toBeNull();
      const got = simulateMarketBuy(asks, q as bigint, withFee).baseOut;
      const less = simulateMarketBuy(asks, (q as bigint) - 1n, withFee).baseOut;
      expect(got >= noIn, `Q enough for ${noIn}`).toBe(true);
      expect(less < noIn, `Q - 1 short for ${noIn}`).toBe(true);
    }
  });

  it("returns null when the asks cannot supply the size", () => {
    expect(quoteForExactBase(asks, 200_000_000n, withFee)).toBeNull();
    expect(quoteForExactBase([], 1n, p)).toBeNull();
    expect(quoteForExactBase(asks, 0n, p)).toBeNull();
  });
});

describe("partial liquidity", () => {
  it("buyNo above the bids (fill-or-kill) is a liquidity shortfall: 401 > 400", () => {
    expect(quoteBuyNo(forkBook, 401_000_000n, p).shortfall).toBe("liquidity");
    expect(quoteBuyNo(forkBook, 400_000_000n, p).shortfall).toBeNull();
  });

  it("sellNo above the asks is a liquidity shortfall: only 300 YES rest", () => {
    expect(quoteSellNo(forkBook, 301_000_000n, p).shortfall).toBe("liquidity");
    expect(quoteSellNo(forkBook, 300_000_000n, p).shortfall).toBeNull();
  });

  it("buyYes past the asks returns the unspent USDC, less Kuru's per-level rounding", () => {
    const q = quoteBuyYes(forkBook, 200_000_000n, p);
    expect(q.shortfall).toBe("liquidity");
    expect(q.tokens).toBe(300_000_000n);
    // After 100 at 0.40, 160 USDC is left: floor(160e6 / 0.45) = 355,555,555 fillable, 200e6 filled,
    // and Kuru refunds floor(0.45 * 155,555,555) = 69,999,999. One base unit stays with Kuru.
    expect(q.returned.usdc).toBe(69_999_999n);
    expect(q.usdc).toBe(130_000_001n);
  });

  it("sellYes past the bids returns the unsold YES", () => {
    const q = quoteSellYes(forkBook, 500_000_000n, p);
    expect(q.shortfall).toBe("liquidity");
    expect(q.returned.yes).toBe(100_000_000n);
    expect(q.usdc).toBe(35_000_000n + 90_000_000n);
  });

  it("empty sides and dust", () => {
    const empty = { asks: [], bids: [] };
    expect(quoteBuyYes(empty, 1_000_000n, p).shortfall).toBe("empty");
    expect(quoteSellYes(empty, 1_000_000n, p).shortfall).toBe("empty");
    expect(quoteBuyNo(empty, 1_000_000n, p).shortfall).toBe("empty");
    expect(quoteSellNo(empty, 1_000_000n, p).shortfall).toBe("empty");
    // Less than one YES base unit at 0.40 fills nothing.
    expect(quoteBuyYes(forkBook, 0n, p).shortfall).toBe("dust");
    expect(simulateMarketBuy(forkBook.asks, 1n, p).baseOut).toBe(2n);
  });

  it("selling NO when the asks sit above 1 USDC pays nothing", () => {
    const silly = { asks: [lvl(1_200_000, 100_000_000n)], bids: [] };
    expect(quoteSellNo(silly, 10_000_000n, p).shortfall).toBe("price");
  });
});

describe("slippage bounds", () => {
  const buy = quoteBuyYes(forkBook, 100_000_000n, p);
  const no = quoteBuyNo(forkBook, 100_000_000n, p);
  const sell = quoteSellYes(forkBook, 150_000_000n, p);

  it("minimum out rounds down, maximum in rounds up", () => {
    expect(tradeLimit(buy, 100n)).toBe((233_333_333n * 9_900n) / 10_000n);
    expect(tradeLimit(sell, 50n)).toBe(49_750_000n);
    expect(tradeLimit(no, 200n)).toBe(66_300_000n);
    const odd = { ...no, usdc: 3n };
    expect(tradeLimit(odd, 100n)).toBe(4n);
  });

  it("clamps the allowance to 0% to 100%", () => {
    expect(tradeLimit(sell, -5n)).toBe(sell.usdc);
    expect(tradeLimit(sell, 20_000n)).toBe(0n);
  });

  it("approves exactly what the router pulls", () => {
    expect(tradeApproval("buyYes", 100n, 90n)).toEqual({ token: "usdc", amount: 100n });
    expect(tradeApproval("buyNo", 100n, 66n)).toEqual({ token: "usdc", amount: 66n });
    expect(tradeApproval("sellYes", 100n, 30n)).toEqual({ token: "yes", amount: 100n });
    expect(tradeApproval("sellNo", 100n, 55n)).toEqual({ token: "no", amount: 100n });
  });
});

describe("prices, impact and max", () => {
  it("reads the touch for each path and the mid", () => {
    expect(touchPrice("buyYes", forkBook, p)).toBe(400_000n);
    expect(touchPrice("sellYes", forkBook, p)).toBe(350_000n);
    expect(touchPrice("buyNo", forkBook, p)).toBe(650_000n);
    expect(touchPrice("sellNo", forkBook, p)).toBe(600_000n);
    expect(midPrice(forkBook)).toBe(375_000n);
    expect(midPrice({ asks: [], bids: forkBook.bids })).toBeNull();
    expect(touchPrice("buyYes", { asks: [], bids: [] }, p)).toBeNull();
  });

  it("measures price impact against the mid, for YES and for NO", () => {
    const buy = quoteBuyYes(forkBook, 100_000_000n, p);
    expect(buy.avgPriceE6).toBe(428_571n);
    expect(priceImpactBps(buy, forkBook, p)).toBe(1_428n);
    const buyNo = quoteBuyNo(forkBook, 100_000_000n, p);
    // NO mid 0.625; paid 0.65 per NO.
    expect(priceImpactBps(buyNo, forkBook, p)).toBe(400n);
    const sellNo = quoteSellNo(forkBook, 100_000_000n, p);
    // Received 0.60 per NO against a 0.625 mid.
    expect(priceImpactBps(sellNo, forkBook, p)).toBe(400n);
    expect(priceImpactBps(buy, { asks: forkBook.asks, bids: [] }, p)).toBeNull();
  });

  it("finds the largest amount the book fills in full and the wallet can pay", () => {
    const rich = { usdc: 1_000_000_000n, yes: 1_000_000_000n, no: 1_000_000_000n };
    // 40 + 90 USDC buys every ask with nothing refunded.
    const maxBuy = maxTradeAmount("buyYes", forkBook, p, rich);
    expect(maxBuy).toBe(130_000_000n);
    expect(quoteBuyYes(forkBook, maxBuy, p)).toMatchObject({ shortfall: null, tokens: 300_000_000n });
    expect(quoteBuyYes(forkBook, 130_000_003n, p).shortfall).toBe("liquidity");
    expect(maxTradeAmount("sellYes", forkBook, p, rich)).toBe(400_000_000n);
    expect(maxTradeAmount("sellNo", forkBook, p, rich)).toBe(300_000_000n);
    expect(maxTradeAmount("buyNo", forkBook, p, rich)).toBe(400_000_000n);
    // 100 USDC buys 150 NO: 65 for the first 100, then 0.70 each for 50 more.
    expect(maxTradeAmount("buyNo", forkBook, p, { ...rich, usdc: 100_000_000n })).toBe(150_000_000n);
    expect(maxTradeAmount("sellYes", forkBook, p, { ...rich, yes: 12n })).toBe(12n);
    expect(maxTradeAmount("buyYes", forkBook, p, { ...rich, usdc: 5n })).toBe(5n);
  });

  it("totals and cumulative depth", () => {
    expect(bookDepth(forkBook, p)).toEqual({
      askSize: 300_000_000n,
      askCost: 130_000_000n,
      bidSize: 400_000_000n,
      bidValue: 125_000_000n,
    });
    expect(withCumulative(forkBook.bids).map((r) => r.cumulative)).toEqual([100_000_000n, 400_000_000n]);
  });
});

describe("generic precisions: Kuru's live MON/USDC book (maker fixture)", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const fx = JSON.parse(
    readFileSync(join(here, "../../../services/maker/test/fixtures/kuru-l2-mon-usdc.json"), "utf8"),
  ) as { l2: `0x${string}`; pricePrecision: number; sizePrecision: string };
  const book = decodeL2Book(fx.l2);
  const mon: KuruMatchParams = {
    pricePrecision: BigInt(fx.pricePrecision),
    sizePrecision: BigInt(fx.sizePrecision),
    baseDecimals: 18,
    quoteDecimals: 6,
    takerFeeBps: 0n,
  };

  it("sells the best bid's size for floor(size · price / sP) in USDC base units", () => {
    const best = book.bids[0] as L2Level;
    const fill = simulateMarketSell(book.bids, best.size, mon);
    const quote = (best.size * best.price) / mon.sizePrecision;
    expect(fill.quoteOut).toBe((quote * 1_000_000n) / mon.pricePrecision);
    expect(fill.exhausted).toBe(false);
    expect(fill.levels).toBe(1);
  });

  it("credits MON in 18 decimals for a buy, and a round trip loses the spread", () => {
    const usdc = 100n * mon.pricePrecision; // 100 USDC in pricePrecision units
    const buy = simulateMarketBuy(book.asks, usdc, mon);
    expect(buy.baseOut).toBe((buy.filled * 10n ** 18n) / mon.sizePrecision);
    const back = simulateMarketSell(book.bids, buy.filled, mon);
    expect(back.quoteOut).toBeLessThan(100_000_000n);
  });
});

import type { Address } from "viem";
import { describe, expect, it } from "vitest";
import { type BookTrade, matchTrades, PaperAccount, type PaperOrder, tradePrice } from "../src/paper.js";
import type { BookSpec } from "../src/quotes.js";
import { tradesFixture } from "./fixtures.js";

// Paper fills against real trades: Kuru's MON-USDC Trade events recorded from Monad mainnet
// (test/fixtures/kuru-trades-mon-usdc.json), replayed in order against paper quotes around the book
// as it stood just before them.

const fx = tradesFixture();
const trades: BookTrade[] = fx.trades.map((t) => ({
  takerBuysYes: t.takerBuysYes,
  priceE18: BigInt(t.priceE18),
  size: BigInt(t.filledSize),
  block: BigInt(t.block),
  hash: t.tx,
}));
const pp = fx.pricePrecision;
const book: BookSpec = {
  pricePrecision: pp,
  sizePrecision: BigInt(fx.sizePrecision),
  tickSize: fx.tickSize,
  minSize: BigInt(fx.minSize),
  maxSize: 10n ** 30n,
  baseDecimals: fx.baseDecimals,
  quoteDecimals: fx.quoteDecimals,
};
const bestBid = Number((BigInt(fx.bestBidAsk[0]) * BigInt(pp)) / 10n ** 18n);
const bestAsk = Number((BigInt(fx.bestBidAsk[1]) * BigInt(pp)) / 10n ** 18n);
const MARKET = "0x00000000000000000000000000000000000000e1" as Address;

/** The same rule, written out trade by trade, for the cross-check. */
function bruteForce(orders: PaperOrder[], list: BookTrade[]) {
  const book = orders.map((o) => ({ ...o }));
  const fills: { isBuy: boolean; price: number; size: bigint }[] = [];
  for (const t of list) {
    const p = tradePrice(t, pp);
    let left = t.size;
    const side = book
      .filter((o) => (t.takerBuysYes ? !o.isBuy && o.price < p : o.isBuy && o.price > p) && o.remaining > 0n)
      .sort((a, b) => (t.takerBuysYes ? a.price - b.price : b.price - a.price));
    for (const o of side) {
      const size = o.remaining < left ? o.remaining : left;
      if (size <= 0n) break;
      o.remaining -= size;
      left -= size;
      fills.push({ isBuy: o.isBuy, price: o.price, size });
    }
  }
  return fills;
}

describe("paper fills against recorded Kuru trades", () => {
  it("has both takers who bought and takers who sold in the recording", () => {
    expect(trades.length).toBeGreaterThanOrEqual(60);
    expect(trades.some((t) => t.takerBuysYes)).toBe(true);
    expect(trades.some((t) => !t.takerBuysYes)).toBe(true);
    expect(bestAsk).toBeGreaterThan(bestBid);
  });

  it("fills paper quotes inside the spread from the trades that went through them, best price first", () => {
    const size = 50_000n * book.sizePrecision; // 50,000 MON per level
    const orders: PaperOrder[] = [
      { isBuy: true, price: bestBid + fx.tickSize, remaining: size },
      { isBuy: true, price: bestBid - 20 * fx.tickSize, remaining: size },
      { isBuy: false, price: bestAsk - fx.tickSize, remaining: size },
      { isBuy: false, price: bestAsk + 20 * fx.tickSize, remaining: size },
    ];
    const fills = matchTrades(orders, trades, pp);
    expect(fills.map((f) => [f.isBuy, f.price, f.size])).toEqual(
      bruteForce(orders, trades).map((f) => [f.isBuy, f.price, f.size]),
    );
    expect(fills.length).toBeGreaterThan(0);
    // Every fill is at our price, strictly better for the taker than the real trade it matched.
    for (const f of fills) expect(f.isBuy ? f.price > f.tradePrice : f.price < f.tradePrice).toBe(true);
    // The input orders are left as they were.
    expect(orders[0]?.remaining).toBe(size);
  });

  it("never assumes queue priority: a quote at a traded price is not filled by that trade", () => {
    const t = trades[0] as BookTrade;
    const p = tradePrice(t, pp);
    const atPrice: PaperOrder[] = [{ isBuy: !t.takerBuysYes, price: p, remaining: t.size }];
    expect(matchTrades(atPrice, [t], pp)).toEqual([]);
    const better: PaperOrder[] = [
      {
        isBuy: !t.takerBuysYes,
        price: t.takerBuysYes ? p - fx.tickSize : p + fx.tickSize,
        remaining: t.size * 2n,
      },
    ];
    expect(matchTrades(better, [t], pp)).toMatchObject([{ size: t.size }]);
  });
});

describe("the paper account", () => {
  // A Hunch Book book: YES and USDC with 6 decimals, prices and sizes in 1e6.
  const hunch: BookSpec = {
    pricePrecision: 1_000_000,
    sizePrecision: 1_000_000n,
    tickSize: 1_000,
    minSize: 1_000_000n,
    maxSize: 5_000_000_000n,
    baseDecimals: 6,
    quoteDecimals: 6,
  };

  it("mints sets for asks, books fills at the quote, merges pairs and marks to fair value", () => {
    const account = new PaperAccount(1_000_000_000n); // 1,000 USDC
    account.mint(MARKET, 20_000_000n); // 20 YES + 20 NO for 20 USDC
    expect(account.usdc).toBe(980_000_000n);
    // Our ask at 0.42 sells 10 YES; our bid at 0.38 buys 5 YES.
    account.applyFill(
      MARKET,
      { isBuy: false, price: 420_000, size: 10_000_000n, block: 1n, tradePrice: 430_000 },
      hunch,
    );
    account.applyFill(
      MARKET,
      { isBuy: true, price: 380_000, size: 5_000_000n, block: 2n, tradePrice: 370_000 },
      hunch,
    );
    expect(account.usdc).toBe(980_000_000n + 4_200_000n - 1_900_000n);
    expect(account.position(MARKET)).toMatchObject({ yes: 15_000_000n, no: 20_000_000n, fills: 2 });
    expect(account.merge(MARKET)).toBe(15_000_000n);
    expect(account.position(MARKET)).toMatchObject({ yes: 0n, no: 5_000_000n });
    // Short 5 YES (holding 5 NO) at a fair value of 0.40: worth 3 USDC.
    const v = account.valuation(new Map([[MARKET, 0.4]]));
    expect(v.value).toBe(account.usdc + 3_000_000n);
    // Around a 0.40 mark: 10 sold 0.02 above it (0.2 USDC) and 5 bought 0.02 below it (0.1 USDC).
    expect(v.pnl).toBe(300_000n);
  });

  it("redeems after settlement at what the vault pays", () => {
    const account = new PaperAccount(100_000_000n);
    account.mint(MARKET, 10_000_000n);
    account.applyFill(
      MARKET,
      { isBuy: false, price: 500_000, size: 10_000_000n, block: 1n, tradePrice: 510_000 },
      hunch,
    );
    // NO won; the redemption fee is 0.008 per token.
    expect(account.redeem(MARKET, 0n, 992_000n)).toBe(9_920_000n);
    expect(account.valuation(new Map()).pnl).toBe(5_000_000n - 80_000n);
  });
});

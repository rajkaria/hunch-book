import type { Address } from "viem";
import { describe, expect, it } from "vitest";
import {
  bestBidAskV2AsV1,
  bestPrices,
  bestPricesV1,
  bestPricesV2,
  type Deployment,
  decodeBestBidAsk,
  deploymentForStack,
  deployments,
  HUNCH_BOOK_PARAMS,
  hunchBookParamsV2,
  isV2Match,
  KURU_EMPTY_ASK,
  KURU_EMPTY_BID,
  kuruV2OrderBookAbi,
  kuruVersionOf,
  l2BookFromV2,
  quoteForExactBase,
  requireStackContract,
  simulateMarketBuy,
  simulateMarketSell,
  stackForFactory,
  stackForRouter,
  stackNamed,
  stacksOf,
  takerFee,
} from "../src/index.js";

// Read from Kuru's live v2 USDT/USDC book on Monad testnet (0x4a0888c502e64aeae11115508ec0955c70293dba)
// at block 68,899,942: precisions 1e6/1e6, taker fee 7000 pps, and what its estimateSwap returned.
const LIVE = {
  bids: [
    { price: 998_955n, size: 8_225_374n },
    { price: 998_755n, size: 15_018_699n },
  ],
  asks: [
    { price: 1_000_555n, size: 7_986_357n },
    { price: 1_000_755n, size: 14_988_684n },
  ],
  buy: [
    [1_000_000n, 998_745n],
    [5_000_000n, 4_993_730n],
    [8_000_000n, 7_989_967n],
  ],
  sell: [
    [1_000_000n, 998_255n],
    [8_225_374n, 8_211_026n],
    [9_000_000n, 8_984_145n],
  ],
} as const;

const V2 = hunchBookParamsV2(7000n);

describe("Kuru v2 matching (checked against estimateSwap on Kuru's testnet)", () => {
  it("v2 params select v2 matching and pps fees", () => {
    expect(isV2Match(V2)).toBe(true);
    expect(isV2Match(HUNCH_BOOK_PARAMS)).toBe(false);
    expect(takerFee(1_000_000n, V2)).toBe(700n);
    expect(takerFee(999_445n, V2)).toBe(700n); // 699.6, rounded up
    expect(takerFee(1_000_000n, { ...HUNCH_BOOK_PARAMS, takerFeeBps: 30n })).toBe(3_000n);
  });

  // That book also has passive liquidity bands (passiveSpreadTicks 100), which getL2Book does not list,
  // so buys can differ from the resting-order model by a few units; the router enforces limits onchain.
  it("buys match Kuru to within a few units", () => {
    expect(simulateMarketBuy(LIVE.asks, 1_000_000n, V2).baseOut).toBe(998_745n);
    for (const [quoteIn, out] of LIVE.buy) {
      const got = simulateMarketBuy(LIVE.asks, quoteIn, V2).baseOut;
      expect(got <= out && out - got <= 10n).toBe(true);
    }
  });

  it("sells match Kuru exactly, across levels too", () => {
    for (const [sizeIn, out] of LIVE.sell) {
      expect(simulateMarketSell(LIVE.bids, sizeIn, V2).quoteOut).toBe(out);
    }
  });

  it("a multi-level buy is within a few units of Kuru (passive bands)", () => {
    // Kuru: 8,010,000 quote -> 7,999,953 base.
    const out = simulateMarketBuy(LIVE.asks, 8_010_000n, V2).baseOut;
    expect(out > 7_999_953n - 20n && out < 7_999_953n + 20n).toBe(true);
  });

  it("stops at dust and returns it", () => {
    // One base unit after the first bid level is worth less than one quote unit at 0.50.
    const bids = [
      { price: 600_000n, size: 10_000_000n },
      { price: 500_000n, size: 100_000_000n },
    ];
    const fill = simulateMarketSell(bids, 10_000_001n, hunchBookParamsV2(0n));
    expect(fill.quoteOut).toBe(6_000_000n);
    expect(fill.refund).toBe(1n);
    expect(fill.filled).toBe(10_000_000n);
  });

  it("buys spend ceil(take x price) per level", () => {
    const asks = [
      { price: 400_000n, size: 50_000_000n },
      { price: 500_000n, size: 1_000_000_000n },
    ];
    const fill = simulateMarketBuy(asks, 50_000_000n, hunchBookParamsV2(0n));
    expect(fill.baseOut).toBe(110_000_000n);
    expect(fill.refund).toBe(0n);
  });

  it("quoteForExactBase finds the least quote under v2 matching", () => {
    const asks = [{ price: 400_000n, size: 1_000_000_000n }];
    expect(quoteForExactBase(asks, 100_000_000n, hunchBookParamsV2(0n))).toBe(40_000_000n);
    const q = quoteForExactBase(asks, 100_000_000n, V2);
    if (q === null) throw new Error("expected a quote");
    expect(simulateMarketBuy(asks, q, V2).baseOut >= 100_000_000n).toBe(true);
    expect(simulateMarketBuy(asks, q - 1n, V2).baseOut < 100_000_000n).toBe(true);
    expect(quoteForExactBase(LIVE.asks, 10_000_000_000n, V2)).toBeNull();
  });
});

describe("Kuru v2 reads", () => {
  it("best prices: either sentinel is empty on either side", () => {
    const max = 2n ** 32n - 1n;
    expect(bestPricesV2(420_000n, 440_000n)).toEqual({ bid: 420_000n, ask: 440_000n });
    expect(bestPricesV2(0n, max)).toEqual({ bid: null, ask: null });
    expect(bestPricesV2(max, 0n)).toEqual({ bid: null, ask: null });
    expect(bestPricesV2(2n ** 40n, 500_000n)).toEqual({ bid: null, ask: 500_000n });
  });

  it("best prices of either version land in pricePrecision units", () => {
    const pp = 1_000_000n;
    expect(bestPrices(2, 420_000n, 440_000n, pp)).toEqual({ bid: 420_000n, ask: 440_000n });
    expect(bestPrices(1, 420_000n * 10n ** 12n, 440_000n * 10n ** 12n, pp)).toEqual({
      bid: 420_000n,
      ask: 440_000n,
    });
    expect(bestPricesV1(KURU_EMPTY_BID, KURU_EMPTY_ASK, pp)).toEqual({ bid: null, ask: null });
    // v1 rounds against the reader: bid down, ask up.
    expect(bestPricesV1(420_000n * 10n ** 12n + 5n, 440_000n * 10n ** 12n + 5n, pp)).toEqual({
      bid: 420_000n,
      ask: 440_001n,
    });
  });

  it("v2 best prices convert to v1's 1e18 shape and sentinels", () => {
    const [bid, ask] = bestBidAskV2AsV1(420_000n, 440_000n, 1_000_000n);
    expect(bid).toBe(420_000n * 10n ** 12n);
    expect(ask).toBe(440_000n * 10n ** 12n);
    const [eb, ea] = bestBidAskV2AsV1(0n, 2n ** 32n - 1n, 1_000_000n);
    expect(decodeBestBidAsk(eb, ea)).toEqual({ bid: null, ask: null });
  });

  it("decodes getL2Book(levels) arrays, dropping empty levels", () => {
    const book = l2BookFromV2(
      [
        [998_955, 998_755],
        [8_225_374n, 0n],
        [1_000_555, 1_000_755],
        [7_986_357n, 14_988_684n],
      ],
      123n,
    );
    expect(book.block).toBe(123n);
    expect(book.bids).toEqual([{ price: 998_955n, size: 8_225_374n }]);
    expect(book.asks).toHaveLength(2);
    expect(() => l2BookFromV2([[1], [], [], []], 0n)).toThrow(/counts differ/);
  });

  it("the v2 ABI names what the router and maker use", () => {
    const names = kuruV2OrderBookAbi.map((e) => e.name);
    for (const n of [
      "swap",
      "estimateSwap",
      "bestBidAsk",
      "getL2Book",
      "batch",
      "cancelAllOrders",
      "SpotSwap",
    ]) {
      expect(names).toContain(n);
    }
  });
});

describe("stacks", () => {
  const a = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
  const d: Deployment = {
    ...deployments["monad-testnet"],
    hunchBook: { factory: a(1), router: a(2) },
    stacks: { kuruV2: { factory: a(3), router: a(4), kuruVersion: 2 }, empty: {} },
  };

  it("lists every deployed stack, primary first", () => {
    const s = stacksOf(d);
    expect(s.map((x) => x.name)).toEqual(["primary", "kuruV2"]);
    expect(s.map((x) => x.kuruVersion)).toEqual([1, 2]);
    expect(s[0]?.primary).toBe(true);
  });

  it("finds a stack by factory, router or name", () => {
    expect(stackForFactory(d, a(3))?.name).toBe("kuruV2");
    expect(stackForFactory(d, a(9))).toBeUndefined();
    expect(stackForRouter(d, a(2))?.name).toBe("primary");
    expect(stackNamed(d, "kuruV2")?.kuruVersion).toBe(2);
    expect(kuruVersionOf({ kuruVersion: 2 })).toBe(2);
    expect(kuruVersionOf({})).toBe(1);
  });

  it("gives single-stack services a view of one stack", () => {
    const v2 = stackNamed(d, "kuruV2");
    if (!v2) throw new Error("missing stack");
    const view = deploymentForStack(d, v2);
    expect(view.hunchBook.factory).toBe(a(3));
    expect(view.external).toBe(d.external);
    expect(requireStackContract(v2, "router")).toBe(a(4));
    expect(() => requireStackContract(v2, "vault")).toThrow(/vault is not deployed on stack kuruV2/);
  });

  it("the testnet file carries Kuru's v2 addresses", () => {
    const k = deployments["monad-testnet"].external.kuruV2;
    expect(k?.accountCore).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(k?.spotRouter).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(stacksOf(deployments["monad-testnet"])[0]?.name).toBe("primary");
  });
});

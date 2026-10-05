import {
  encodePerplFundingParams,
  encodePerplFundingSpikeParams,
  Outcome,
  Phase,
  TemplateId,
} from "@hunch-book/shared";
import { type Address, getAddress } from "viem";
import { describe, expect, it } from "vitest";
import {
  type BasketCandidate,
  type BasketLeg,
  basketKey,
  basketValue,
  COVER_MAX,
  COVER_MIN,
  candidateOf,
  clampCover,
  eventsInAnyWindow,
  legValue,
  legWins,
  planBasket,
  SCENARIOS,
  scenarioTable,
  sizeBasket,
  startedWindowStarts,
} from "../src/lib/hedge/basket";
import {
  eventsBetween,
  type LegPricing,
  type PerpMeta,
  proposeHedges,
  sizeLeg,
  sizePoolHedge,
} from "../src/lib/hedge/math";
import {
  BASKET_SCHEMA_VERSION,
  BASKET_STORAGE_KEY,
  LEGACY_HEDGE_STORAGE_KEY,
  loadBaskets,
  migrateV0,
  type TrackedBasket,
  type TrackedHedgeV0,
  trackBasket,
  untrackBasket,
} from "../src/lib/hedge/tracking";
import { makeMarket, USDC } from "./fixtures";

const BTC: PerpMeta = {
  perpId: 16n,
  name: "Bitcoin",
  symbol: "BTC",
  priceDecimals: 1,
  lotDecimals: 5,
  scalingExp: 0,
  markPNS: 850_138n,
};

const INTERVAL = 8_571n;
const A1 = getAddress("0x00000000000000000000000000000000000000a1");
const A2 = getAddress("0x00000000000000000000000000000000000000a2");
const A3 = getAddress("0x00000000000000000000000000000000000000a3");

const onMicro = (n: number) => Math.abs(n * 1e6 - Math.round(n * 1e6)) < 1e-6;

const POOL: LegPricing = { mode: "pool", sideTotal: 300, otherTotal: 100, room: 1_000, minStake: 1 };
const BOOK: LegPricing = { mode: "book", price: 0.4, feePerToken: 0.0068 };

function candidate(overrides: Partial<BasketCandidate> = {}): BasketCandidate {
  return {
    market: A1,
    kind: "net",
    buy: "yes",
    pricing: POOL,
    from: 1_000n,
    to: 1_100n,
    eventsLeft: 10,
    thresholdRaw: 50,
    accruedRaw: 0,
    ...overrides,
  };
}

describe("cover ratio", () => {
  it("defaults to 100% and stays between 10% and 200%", () => {
    expect(clampCover(undefined)).toBe(1);
    expect(clampCover(Number.NaN)).toBe(1);
    expect(clampCover(Number.POSITIVE_INFINITY)).toBe(1);
    expect(clampCover(0.75)).toBe(0.75);
    expect(clampCover(0)).toBe(COVER_MIN);
    expect(clampCover(-3)).toBe(COVER_MIN);
    expect(clampCover(5)).toBe(COVER_MAX);
    expect([COVER_MIN, COVER_MAX]).toEqual([0.1, 2]);
  });
});

describe("funding events the legs watch", () => {
  // Events on the grid every 100 blocks from block 1,000.
  const count = (windows: { from: bigint; to: bigint }[]) => eventsInAnyWindow(windows, 1_000n, 100n);

  it("counts overlapping and nested windows once, and nothing for a gap", () => {
    expect(count([])).toBe(0);
    expect(count([{ from: 1_000n, to: 1_500n }])).toBe(5);
    // (1000, 1500] and (1300, 1800]: events 1100 to 1800.
    expect(
      count([
        { from: 1_300n, to: 1_800n },
        { from: 1_000n, to: 1_500n },
      ]),
    ).toBe(8);
    // Nested.
    expect(
      count([
        { from: 1_000n, to: 2_000n },
        { from: 1_200n, to: 1_400n },
      ]),
    ).toBe(10);
    // Back to back.
    expect(
      count([
        { from: 1_000n, to: 1_500n },
        { from: 1_500n, to: 1_700n },
      ]),
    ).toBe(7);
    // A gap of three events between the windows counts nothing.
    expect(
      count([
        { from: 1_000n, to: 1_200n },
        { from: 1_500n, to: 1_700n },
      ]),
    ).toBe(4);
    // An empty window counts nothing.
    expect(count([{ from: 1_500n, to: 1_500n }])).toBe(0);
  });
});

describe("basket sizing: the even split", () => {
  it("a one-leg basket at 100% is the single-market hedge", () => {
    for (const pricing of [POOL, BOOK]) {
      const basket = sizeBasket({ cost: 12, candidates: [candidate({ pricing })], rawPerInterval: 8 });
      expect(basket.ok).toBe(true);
      if (!basket.ok) return;
      const single = sizeLeg(pricing, 12);
      expect(basket.legs[0]?.sizing).toEqual(single);
      expect(basket.target).toBe(12);
      expect(basket.share).toBe(12);
      expect(basket.totalCost).toBe(single.ok ? single.cost : Number.NaN);
    }
  });

  it("splits the cover evenly: each leg's win adds its share, all of them add the target", () => {
    const basket = sizeBasket({
      cost: 30,
      candidates: [
        candidate({ market: A1, pricing: POOL }),
        candidate({ market: A2, pricing: BOOK }),
        candidate({ market: A3, pricing: { mode: "book", price: 0.25, feePerToken: 0.01 } }),
      ],
      rawPerInterval: 8,
    });
    expect(basket.ok).toBe(true);
    if (!basket.ok) return;
    expect(basket.target).toBe(30);
    expect(basket.share).toBe(10);
    expect(basket.legs).toHaveLength(3);
    for (const leg of basket.legs) {
      expect(leg.sizing.netIfWin).toBeGreaterThanOrEqual(10 - 2e-6);
      expect(leg.sizing.netIfWin).toBeLessThan(10 + 1e-4);
    }
    expect(basket.netIfAllWin).toBeCloseTo(30, 4);
    expect(basket.covered).toBe(1);
    const sum = (f: (l: BasketLeg) => number) => basket.legs.reduce((total, l) => total + f(l), 0);
    expect(basket.totalCost).toBeCloseTo(
      sum((l) => l.sizing.cost),
      9,
    );
    expect(basket.payoutIfAllWin).toBeCloseTo(
      sum((l) => l.sizing.payoutIfWin),
      9,
    );
  });

  it("scales with the cover ratio and keeps it in bounds", () => {
    const half = sizeBasket({ cost: 20, cover: 0.5, candidates: [candidate()], rawPerInterval: 8 });
    expect(half.ok && half.target).toBe(10);
    expect(half.ok && half.cover).toBe(0.5);
    const tiny = sizeBasket({ cost: 20, cover: 0, candidates: [candidate()], rawPerInterval: 8 });
    expect(tiny.ok && tiny.target).toBe(2);
    const huge = sizeBasket({ cost: 20, cover: 9, candidates: [candidate()], rawPerInterval: 8 });
    expect(huge.ok && huge.target).toBe(40);
  });

  it("rounds every amount to USDC's 6 decimals, the share up", () => {
    const basket = sizeBasket({
      cost: 10,
      candidates: [
        candidate({ market: A1 }),
        candidate({ market: A2 }),
        candidate({ market: A3, pricing: BOOK }),
      ],
      rawPerInterval: 8,
    });
    expect(basket.ok).toBe(true);
    if (!basket.ok) return;
    expect(basket.share).toBe(3.333334);
    expect(basket.share * 3).toBeGreaterThanOrEqual(basket.target);
    for (const leg of basket.legs) {
      expect(
        [leg.sizing.cost, leg.sizing.payoutIfWin, leg.sizing.netIfWin, leg.sizing.tokens ?? 0].every(onMicro),
      ).toBe(true);
    }
    expect([basket.totalCost, basket.payoutIfAllWin, basket.netIfAllWin, basket.target].every(onMicro)).toBe(
      true,
    );
    // A cost under one micro-USDC still sizes: the target rounds up to one micro-USDC.
    const dust = sizeBasket({ cost: 1e-9, candidates: [candidate({ pricing: BOOK })], rawPerInterval: 8 });
    expect(dust.ok && dust.target).toBe(0.000001);
    const less = sizeBasket({ cost: 1e-12, candidates: [candidate({ pricing: BOOK })], rawPerInterval: 8 });
    expect(!less.ok && less.reason).toMatch(/rounds to zero/);
  });

  it("refuses a zero, negative or unknown funding cost, and an empty basket", () => {
    for (const cost of [0, -5, Number.NaN]) {
      const r = sizeBasket({ cost, candidates: [candidate()], rawPerInterval: 8 });
      expect(r.ok).toBe(false);
      expect(!r.ok && r.reason).toMatch(/no funding cost/);
    }
    const empty = sizeBasket({ cost: 10, candidates: [], rawPerInterval: 8 });
    expect(!empty.ok && empty.reason).toMatch(/Add a market/);
  });

  it("leaves out a leg priced at 0 or 1 and splits over the rest", () => {
    const basket = sizeBasket({
      cost: 12,
      candidates: [
        candidate({ market: A1, pricing: { mode: "book", price: 0, feePerToken: 0.01 } }),
        candidate({ market: A2, pricing: BOOK }),
        candidate({ market: A3, pricing: { mode: "book", price: 1, feePerToken: 0.01 } }),
      ],
      rawPerInterval: 8,
    });
    expect(basket.ok).toBe(true);
    if (!basket.ok) return;
    expect(basket.legs.map((l) => l.candidate.market)).toEqual([A2]);
    expect(basket.share).toBe(12);
    expect(basket.dropped.map((d) => d.candidate.market)).toEqual([A1, A3]);
    expect(basket.dropped[0]?.reason).toMatch(/no usable price/);
    // A pool whose hedge side holds everything (chance 1) has nothing to win; one with an empty hedge
    // side (chance 0) needs only the minimum stake.
    const pools = sizeBasket({
      cost: 12,
      candidates: [
        candidate({ market: A1, pricing: { ...POOL, otherTotal: 0 } }),
        candidate({ market: A2, pricing: { ...POOL, sideTotal: 0 } }),
      ],
      rawPerInterval: 8,
    });
    expect(pools.ok && pools.legs.map((l) => l.sizing.cost)).toEqual([1]);
    expect(pools.ok && pools.dropped[0]?.reason).toMatch(/Nobody has staked on the other side/);
  });

  it("says so when no leg can be sized, and when a full pool limits the cover", () => {
    const none = sizeBasket({
      cost: 12,
      candidates: [candidate({ pricing: { mode: "book", price: Number.NaN, feePerToken: 0 } })],
      rawPerInterval: 8,
    });
    expect(none.ok).toBe(false);
    expect(!none.ok && none.dropped).toHaveLength(1);
    const capped = sizeBasket({
      cost: 50,
      candidates: [
        candidate({ market: A1, pricing: { ...POOL, room: 20 } }),
        candidate({ market: A2, pricing: BOOK }),
      ],
      rawPerInterval: 8,
    });
    expect(capped.ok && capped.legs[0]?.sizing.limitedBy).toBe("cap");
    expect(capped.ok && capped.covered).toBeLessThan(1);
    expect(capped.ok && capped.covered).toBeGreaterThan(0.5);
  });
});

describe("scenarios", () => {
  it("runs the four funding cases in order", () => {
    expect(SCENARIOS.map((x) => x.multiplier)).toEqual([-1, 0.5, 1, 2]);
  });

  it("template 1: YES wins when the window's net funding is more than the threshold", () => {
    const leg = candidate({ thresholdRaw: 50, eventsLeft: 10 });
    expect(legWins(leg, 8)).toBe(true); // 80 > 50
    expect(legWins(leg, 5)).toBe(false); // 50 is not more than 50
    expect(legWins(leg, -8)).toBe(false);
    expect(legWins({ ...leg, buy: "no" }, 5)).toBe(true);
    // What a started window has already counted adds in; unknown counts as nothing.
    expect(legWins({ ...leg, accruedRaw: 30 }, 4)).toBe(true); // 30 + 40 > 50
    expect(legWins({ ...leg, accruedRaw: null }, 4)).toBe(false);
  });

  it("template 4: YES wins when one event is more than the threshold, if an event is left", () => {
    const spike = candidate({ kind: "spike", thresholdRaw: 10, eventsLeft: 3 });
    expect(legWins(spike, 12)).toBe(true);
    expect(legWins(spike, 10)).toBe(false);
    expect(legWins({ ...spike, eventsLeft: 0 }, 12)).toBe(false);
  });

  it("a ladder of thresholds pays more as funding rises", () => {
    // A long at 8 raw per interval over 10 events: 80 at the rate as it is.
    const basket = sizeBasket({
      cost: 40,
      candidates: [
        candidate({ market: A1, thresholdRaw: 30 }),
        candidate({ market: A2, thresholdRaw: 70 }),
        candidate({ market: A3, thresholdRaw: 120, pricing: BOOK }),
      ],
      rawPerInterval: 8,
    });
    expect(basket.ok).toBe(true);
    if (!basket.ok) return;
    const winners = basket.scenarios.map((r) => r.wins.filter(Boolean).length);
    expect(winners).toEqual([0, 1, 2, 3]);
    const payouts = basket.scenarios.map((r) => r.payout);
    expect(payouts[0]).toBe(0);
    expect(payouts[1]).toBeLessThan(payouts[2] ?? 0);
    expect(payouts[2]).toBeLessThan(payouts[3] ?? 0);
  });

  it("states funding paid, payout, net and the unhedged net for each case", () => {
    const leg = candidate({ thresholdRaw: 50, eventsLeft: 10 });
    const sizing = sizePoolHedge({ target: 20, sideTotal: 300, otherTotal: 100, room: 1_000, minStake: 1 });
    if (!sizing.ok) throw new Error("sizing");
    const rows = scenarioTable({ legs: [{ candidate: leg, sizing }], cost: 20, rawPerInterval: 8 });
    const byKey = Object.fromEntries(rows.map((r) => [r.scenario.key, r]));
    // Flip: the long is paid 20 and the YES leg loses its stake.
    expect(byKey.flip?.fundingPaid).toBe(-20);
    expect(byKey.flip?.payout).toBe(0);
    expect(byKey.flip?.net).toBeCloseTo(20 - sizing.cost, 6);
    expect(byKey.flip?.unhedged).toBe(20);
    // Half: 40 is not more than 50, so the leg loses while the long still pays 10.
    expect(byKey.half?.wins).toEqual([false]);
    expect(byKey.half?.net).toBeCloseTo(-10 - sizing.cost, 6);
    // Holds: the leg wins its share back, so the net is the cost of the cover, about zero.
    expect(byKey.hold?.wins).toEqual([true]);
    expect(byKey.hold?.payout).toBe(sizing.payoutIfWin);
    expect(byKey.hold?.net).toBeCloseTo(sizing.netIfWin - 20, 6);
    expect(byKey.hold?.unhedged).toBe(-20);
    // Doubles: the leg pays the same, the funding doubles.
    expect(byKey.double?.fundingPaid).toBe(40);
    expect(byKey.double?.net).toBeCloseTo(sizing.netIfWin - 40, 6);
    for (const r of rows) expect(r.cost).toBe(sizing.cost);
  });

  it("a short holds NO, which wins while funding stays negative", () => {
    const leg = candidate({ buy: "no", thresholdRaw: -20, eventsLeft: 10 });
    expect(legWins(leg, -8)).toBe(true); // -80 is not more than -20
    expect(legWins(leg, 8)).toBe(false);
    const basket = sizeBasket({ cost: 16, candidates: [leg], rawPerInterval: -8 });
    expect(basket.ok && basket.scenarios.map((r) => r.wins[0])).toEqual([false, true, true, true]);
  });
});

function fundingMarket(
  overrides: {
    kind?: "net" | "spike";
    start?: bigint;
    end?: bigint;
    threshold?: bigint;
    scalingExp?: number;
  } & Parameters<typeof makeMarket>[0] = {},
) {
  const {
    kind = "net",
    start = 1_100_000n,
    end = 1_200_000n,
    threshold = 20n,
    scalingExp = 0,
    ...rest
  } = overrides;
  const p = { perpId: 16n, startBlock: start, endBlock: end, threshold, expectedScalingExp: scalingExp };
  return makeMarket({
    templateId: kind === "net" ? TemplateId.PerplFunding : TemplateId.PerplFundingSpike,
    params: kind === "net" ? encodePerplFundingParams(p) : encodePerplFundingSpikeParams(p),
    ...rest,
  });
}

describe("a basket from the page's proposals", () => {
  const base = {
    side: "long" as const,
    units: 0.5,
    meta: BTC,
    rawPerInterval: 8,
    head: 1_000_000n,
    lastEvent: 999_999n,
    interval: INTERVAL,
  };

  it("one proposal at 100% gives the proposal's own sizing", () => {
    const { proposals } = proposeHedges({ ...base, markets: [fundingMarket()] });
    const plan = planBasket({ ...base, chosen: proposals, lastSum: 0n, cover: 1 });
    const p = proposals[0];
    expect(plan.events).toBe(p?.intervals);
    expect(plan.cost).toBeCloseTo(p?.target ?? 0, 9);
    const leg = plan.basket.ok ? plan.basket.legs[0]?.sizing : undefined;
    expect(leg?.mode).toBe("pool");
    expect(leg?.cost).toBeCloseTo(p?.sizing.ok ? p.sizing.cost : Number.NaN, 5);
    expect(leg?.payoutIfWin).toBeCloseTo(p?.sizing.ok ? p.sizing.payoutIfWin : Number.NaN, 5);
    expect(plan.from).toBe(1_100_000n);
    expect(plan.to).toBe(1_200_000n);
  });

  it("covers the events inside any leg's window once, across both templates", () => {
    const { proposals } = proposeHedges({
      ...base,
      markets: [
        fundingMarket({ address: A1 }),
        fundingMarket({ address: A2, kind: "spike", start: 1_150_000n, end: 1_300_000n, threshold: 9n }),
      ],
    });
    expect(proposals).toHaveLength(2);
    const plan = planBasket({ ...base, chosen: proposals, lastSum: 0n, cover: 1 });
    const events = eventsBetween(999_999n, INTERVAL, 1_100_000n, 1_300_000n);
    expect(plan.events).toBe(events);
    expect(plan.cost).toBeCloseTo(0.8 * events * 0.5, 9);
    expect(plan.basket.ok && plan.basket.legs).toHaveLength(2);
    expect(plan.candidates.map((c) => c.kind).sort()).toEqual(["net", "spike"]);
  });

  it("counts what a started window has already paid, once its start is read", () => {
    const started = fundingMarket({
      phase: Phase.Graduated,
      graduated: true,
      book: "0x00000000000000000000000000000000000000bb",
      quote: { bid: 350_000_000_000_000_000n, ask: 400_000_000_000_000_000n },
      start: 990_000n,
      end: 1_100_000n,
    });
    const { proposals } = proposeHedges({ ...base, markets: [started] });
    expect(startedWindowStarts(proposals, base.lastEvent)).toEqual([990_000n]);
    const p = proposals[0];
    if (!p) throw new Error("no proposal");
    const read = candidateOf(p, {
      head: base.head,
      lastEvent: base.lastEvent,
      lastSum: 5_000n,
      scalingExp: 0,
      sumAtStart: 4_900n,
    });
    expect(read.accruedRaw).toBe(100);
    expect(read.from).toBe(base.head);
    const unread = candidateOf(p, {
      head: base.head,
      lastEvent: base.lastEvent,
      lastSum: 5_000n,
      scalingExp: 0,
    });
    expect(unread.accruedRaw).toBeNull();
    const plan = planBasket({
      ...base,
      chosen: proposals,
      lastSum: 5_000n,
      cover: 1,
      sumsAtStart: { "990000": 4_900n },
    });
    expect(plan.candidates[0]?.accruedRaw).toBe(100);
    // A window that has not started has counted nothing.
    const later = proposeHedges({ ...base, markets: [fundingMarket()] }).proposals;
    expect(startedWindowStarts(later, base.lastEvent)).toEqual([]);
  });

  it("puts a threshold on the perp's own funding scale", () => {
    const { proposals } = proposeHedges({
      ...base,
      markets: [fundingMarket({ threshold: 20n, scalingExp: 0 })],
    });
    const p = proposals[0];
    if (!p) throw new Error("no proposal");
    expect(candidateOf(p, { head: base.head, lastEvent: 0n, lastSum: 0n, scalingExp: 2 }).thresholdRaw).toBe(
      2_000,
    );
  });

  it("names a basket by its markets, in any order", () => {
    expect(basketKey(16n, "long", [A2, A1])).toBe(basketKey("16", "long", [A1, A2]));
    expect(basketKey(16n, "long", [A1])).not.toBe(basketKey(16n, "short", [A1]));
  });
});

// ---------------------------------------------------------------- storage

function memoryStore() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    map,
  };
}

const v0 = (overrides: Partial<TrackedHedgeV0> = {}): TrackedHedgeV0 => ({
  id: "h1",
  network: "monad-testnet",
  createdAt: 1,
  perpId: "16",
  symbol: "BTC",
  side: "long",
  units: 0.5,
  startBlock: "1000",
  startSum: "100",
  market: A1,
  buy: "yes",
  mode: "book",
  cost: 40,
  tokens: 100,
  payoutIfWin: 99,
  ...overrides,
});

const stored = (overrides: Partial<TrackedBasket> = {}): TrackedBasket => ({
  id: "b1",
  network: "monad-testnet",
  createdAt: 10,
  perpId: "16",
  symbol: "BTC",
  side: "long",
  units: 0.5,
  startBlock: "2000",
  startSum: "300",
  cover: 0.75,
  legs: [
    { market: A1, buy: "yes", mode: "pool", cost: 12.5, tokens: null, payoutIfWin: 20 },
    { market: A2, buy: "yes", mode: "book", cost: 8, tokens: 20, payoutIfWin: 19.8 },
  ],
  ...overrides,
});

describe("tracked baskets: schema v1", () => {
  it("stores under a versioned payload, lists by network and removes", () => {
    const store = memoryStore();
    expect(trackBasket(stored(), store)).toBe(true);
    expect(trackBasket(stored({ id: "b2", network: "monad-mainnet", createdAt: 11 }), store)).toBe(true);
    const payload = JSON.parse(store.map.get(BASKET_STORAGE_KEY) ?? "{}");
    expect(payload.version).toBe(BASKET_SCHEMA_VERSION);
    expect(payload.baskets).toHaveLength(2);
    expect(loadBaskets("monad-testnet", store)).toEqual([stored()]);
    expect(untrackBasket("b1", store)).toBe(true);
    expect(loadBaskets("monad-testnet", store)).toEqual([]);
    expect(loadBaskets("monad-mainnet", store).map((b) => b.id)).toEqual(["b2"]);
  });

  it("refuses a basket with no legs or a bad leg, and drops such entries when reading", () => {
    const store = memoryStore();
    expect(trackBasket(stored({ legs: [] }), store)).toBe(false);
    store.setItem(
      BASKET_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        baskets: [
          { id: "x" },
          stored({ id: "bad-leg", legs: [{ ...stored().legs[0], market: "nope" } as never] }),
          stored({ id: "no-cover", cover: 0 }),
          stored(),
        ],
      }),
    );
    expect(loadBaskets("monad-testnet", store).map((b) => b.id)).toEqual(["b1"]);
    store.setItem(BASKET_STORAGE_KEY, "{");
    expect(loadBaskets("monad-testnet", store)).toEqual([]);
  });

  it("survives a store that throws", () => {
    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };
    expect(loadBaskets("monad-testnet", broken)).toEqual([]);
    expect(trackBasket(stored(), broken)).toBe(false);
    expect(untrackBasket("b1", broken)).toBe(false);
    expect(loadBaskets("monad-testnet", null)).toEqual([]);
  });

  it("never overwrites what a newer version of the page stored", () => {
    const store = memoryStore();
    const newer = JSON.stringify({ version: BASKET_SCHEMA_VERSION + 1, baskets: [{ anything: true }] });
    store.setItem(BASKET_STORAGE_KEY, newer);
    expect(loadBaskets("monad-testnet", store)).toEqual([]);
    expect(trackBasket(stored(), store)).toBe(false);
    expect(store.map.get(BASKET_STORAGE_KEY)).toBe(newer);
  });
});

describe("tracked baskets: migrating v0 single hedges", () => {
  it("turns each v0 hedge into a one-leg basket with the same id and numbers", () => {
    expect(migrateV0(v0())).toEqual({
      id: "h1",
      network: "monad-testnet",
      createdAt: 1,
      perpId: "16",
      symbol: "BTC",
      side: "long",
      units: 0.5,
      startBlock: "1000",
      startSum: "100",
      cover: 1,
      legs: [{ market: A1, buy: "yes", mode: "book", cost: 40, tokens: 100, payoutIfWin: 99 }],
    });
    expect(migrateV0({ id: "x" })).toBeNull();
    expect(migrateV0(v0({ market: "nope" as Address }))).toBeNull();
  });

  it("moves v0 records on the first read, keeps every valid one and retires the old key", () => {
    const store = memoryStore();
    store.setItem(
      LEGACY_HEDGE_STORAGE_KEY,
      JSON.stringify([
        v0(),
        v0({ id: "h2", createdAt: 2, mode: "pool", tokens: null, cost: 30, buy: "no", side: "short" }),
        v0({ id: "h3", network: "monad-mainnet", createdAt: 3 }),
        { id: "broken" },
      ]),
    );
    const loaded = loadBaskets("monad-testnet", store);
    expect(loaded.map((b) => b.id)).toEqual(["h2", "h1"]);
    expect(loaded.every((b) => b.legs.length === 1 && b.cover === 1)).toBe(true);
    expect(loaded[0]?.legs[0]).toMatchObject({ mode: "pool", tokens: null, cost: 30, buy: "no" });
    expect(store.map.has(LEGACY_HEDGE_STORAGE_KEY)).toBe(false);
    const payload = JSON.parse(store.map.get(BASKET_STORAGE_KEY) ?? "{}");
    expect(payload.version).toBe(1);
    expect(payload.baskets.map((b: TrackedBasket) => b.id).sort()).toEqual(["h1", "h2", "h3"]);
    // A second read changes nothing.
    expect(loadBaskets("monad-testnet", store)).toEqual(loaded);
    expect(loadBaskets("monad-mainnet", store).map((b) => b.id)).toEqual(["h3"]);
  });

  it("merges with baskets already stored, without doubling an id", () => {
    const store = memoryStore();
    expect(trackBasket(stored(), store)).toBe(true);
    store.setItem(LEGACY_HEDGE_STORAGE_KEY, JSON.stringify([v0(), v0({ id: "b1", createdAt: 5 })]));
    const loaded = loadBaskets("monad-testnet", store);
    expect(loaded.map((b) => b.id)).toEqual(["b1", "h1"]);
    expect(loaded[0]?.legs).toHaveLength(2);
  });

  it("loses nothing when the write fails: the old records stay until a write succeeds", () => {
    const store = memoryStore();
    store.setItem(LEGACY_HEDGE_STORAGE_KEY, JSON.stringify([v0()]));
    let full = true;
    const flaky = {
      ...store,
      setItem: (k: string, v: string) => {
        if (full) throw new Error("quota");
        store.setItem(k, v);
      },
    };
    expect(loadBaskets("monad-testnet", flaky).map((b) => b.id)).toEqual(["h1"]);
    expect(store.map.has(LEGACY_HEDGE_STORAGE_KEY)).toBe(true);
    expect(store.map.has(BASKET_STORAGE_KEY)).toBe(false);
    full = false;
    expect(loadBaskets("monad-testnet", flaky).map((b) => b.id)).toEqual(["h1"]);
    expect(store.map.has(LEGACY_HEDGE_STORAGE_KEY)).toBe(false);
  });

  it("untracking a migrated hedge keeps it gone", () => {
    const store = memoryStore();
    store.setItem(LEGACY_HEDGE_STORAGE_KEY, JSON.stringify([v0()]));
    expect(untrackBasket("h1", store)).toBe(true);
    expect(loadBaskets("monad-testnet", store)).toEqual([]);
  });
});

// ---------------------------------------------------------------- value

describe("what a tracked basket is worth", () => {
  const pool = { yes: USDC(410), no: USDC(280), total: USDC(690), stakers: 11 };
  const bookLeg = {
    market: A1,
    buy: "yes" as const,
    mode: "book" as const,
    cost: 40,
    tokens: 100,
    payoutIfWin: 99,
  };
  const poolLeg = {
    market: A2,
    buy: "yes" as const,
    mode: "pool" as const,
    cost: 30,
    tokens: null,
    payoutIfWin: 39,
  };

  it("values one leg: settled, voided, and open at the market's price", () => {
    const won = makeMarket({ phase: Phase.Settled, outcome: Outcome.Yes, graduated: true, pool });
    expect(legValue(bookLeg, won).value).toBeCloseTo(100 * (1 - (0.02 * 280) / 690));
    expect(legValue(bookLeg, won).won).toBe(true);
    const lost = makeMarket({ phase: Phase.Settled, outcome: Outcome.No, graduated: true, pool });
    expect(legValue(bookLeg, lost)).toMatchObject({ value: 0, final: true, won: false });
    const voided = makeMarket({ phase: Phase.Voided, graduated: true, pool });
    expect(legValue(bookLeg, voided)).toMatchObject({ value: 50, final: true, won: null });
    expect(legValue({ ...bookLeg, mode: "pool", tokens: null }, voided).value).toBe(40);
    const open = makeMarket({
      phase: Phase.Graduated,
      graduated: true,
      pool,
      quote: { bid: 600_000_000_000_000_000n, ask: 700_000_000_000_000_000n },
    });
    expect(legValue(bookLeg, open)).toMatchObject({ final: false, won: null });
    expect(legValue(bookLeg, open).value).toBeCloseTo(65);
    const poolWon = makeMarket({
      phase: Phase.Settled,
      outcome: Outcome.Yes,
      pool: { yes: USDC(300), no: USDC(100), total: USDC(400), stakers: 4 },
    });
    expect(legValue(poolLeg, poolWon).value).toBeCloseTo(30 + (0.98 * 30 * 100) / 300);
  });

  it("adds the legs up once every market is read, and counts the settled ones", () => {
    const tracked = stored({ legs: [bookLeg, poolLeg] });
    const settled = fundingMarket({ phase: Phase.Settled, outcome: Outcome.No, end: 1_150_000n, pool });
    const open = fundingMarket({
      phase: Phase.Graduated,
      graduated: true,
      end: 1_300_000n,
      pool,
      quote: { bid: 600_000_000_000_000_000n, ask: 700_000_000_000_000_000n },
    });
    const reading = basketValue(tracked, [settled, null]);
    expect(reading.value).toBeNull();
    expect(reading.endBlock).toBeNull();
    expect(reading.final).toBe(1);
    expect(reading.cost).toBe(70);
    const both = basketValue(tracked, [settled, open]);
    expect(both.legs[0]).toMatchObject({ value: 0, won: false });
    expect(both.value).toBeCloseTo(0 + (legValue(poolLeg, open).value ?? 0));
    expect(both.allFinal).toBe(false);
    expect(both.endBlock).toBe(1_300_000n);
    const done = basketValue(tracked, [settled, { ...settled, address: A2 }]);
    expect(done.allFinal).toBe(true);
    expect(done.endBlock).toBe(1_150_000n);
  });
});

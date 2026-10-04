import {
  encodePerplFundingParams,
  encodePerplFundingSpikeParams,
  Outcome,
  Phase,
  TemplateId,
} from "@hunch-book/shared";
import { BaseError, ContractFunctionRevertedError } from "viem";
import { describe, expect, it, vi } from "vitest";
import { hedgeValue } from "../src/components/hedge/TrackedHedges";
import { perplReadAbi } from "../src/lib/hedge/abi";
import {
  averageStep,
  createPrefillUrl,
  eventsBetween,
  formatUsdNumber,
  fundingMarketOf,
  fundingPaidUsd,
  fundingSteps,
  intervalsIn,
  lotsFromUnits,
  type PerpMeta,
  poolNetGain,
  projectFunding,
  proposeHedges,
  ratePercent,
  rawFromUsdPerUnit,
  sizeBookHedge,
  sizePoolHedge,
  sizeUnits,
  suggestNewMarket,
  thresholdText,
  usdPerUnit,
} from "../src/lib/hedge/math";
import { perpIdsFromBanks, readFundingHistory, readPerplPositions } from "../src/lib/hedge/perpl";
import {
  HEDGE_STORAGE_KEY,
  loadHedges,
  type TrackedHedge,
  trackHedge,
  untrackHedge,
} from "../src/lib/hedge/tracking";
import { makeMarket, USDC } from "./fixtures";

// BTC on Perpl's testnet Exchange, as read on 2026-10-04: one decimal of price, five of size, scaling 0.
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

describe("Perpl units", () => {
  it("turns raw funding into USD per unit, and back", () => {
    expect(usdPerUnit(8n, BTC)).toBeCloseTo(0.8);
    expect(usdPerUnit(-120_442, BTC)).toBeCloseTo(-12_044.2);
    expect(rawFromUsdPerUnit(0.85, BTC)).toBe(8n);
    expect(rawFromUsdPerUnit(-1.25, BTC)).toBe(-12n);
    expect(sizeUnits(5_978n, BTC)).toBeCloseTo(0.05978);
    expect(lotsFromUnits(0.05978, BTC)).toBe(5_978n);
  });

  it("matches Perpl's own premium PnL for a real testnet position", () => {
    // Account 12 on testnet: short 5,978 lots of BTC. F went from 0 at entry to 120,442; Perpl's
    // premiumPnlCNS for it reads 720,002,276 (720.002276 USDC received).
    const received = fundingPaidUsd({
      sumFrom: 0n,
      sumTo: 120_442n,
      side: "short",
      units: 0.05978,
      meta: BTC,
    });
    expect(received).toBeCloseTo(-720.002276, 6);
    // Account 13: long 5,659 lots over the same span paid 681.581278.
    expect(
      fundingPaidUsd({ sumFrom: 0n, sumTo: 120_442n, side: "long", units: 0.05659, meta: BTC }),
    ).toBeCloseTo(681.581278, 6);
  });

  it("states the rate as a percent of the mark price", () => {
    expect(ratePercent(8, BTC)).toBeCloseTo((0.8 / 85_013.8) * 100);
    expect(ratePercent(8, { ...BTC, markPNS: 0n })).toBeNull();
  });

  it("formats small and large USD amounts", () => {
    expect(formatUsdNumber(1234.567)).toBe("$1,234.57");
    expect(formatUsdNumber(0.8)).toBe("$0.80");
    expect(formatUsdNumber(0.004213)).toBe("$0.004213");
    expect(formatUsdNumber(-3.1)).toBe("-$3.10");
    expect(formatUsdNumber(Number.NaN)).toBe("n/a");
  });
});

describe("the position bitmap", () => {
  it("lists the perps an account holds, bank by bank", () => {
    // Account 227 on testnet holds ETH (32) and SOL (48).
    expect(perpIdsFromBanks({ bank1: 281_479_271_677_952n, bank2: 0n, bank3: 0n, bank4: 0n })).toEqual([
      32n,
      48n,
    ]);
    expect(perpIdsFromBanks({ bank1: 0n, bank2: 8n, bank3: 0n, bank4: 1n })).toEqual([259n, 768n]);
  });
});

describe("funding history", () => {
  const sample = (block: bigint, sum: bigint, eventBlock = block) => ({ block, sum, eventBlock });

  it("takes the change per interval, skipping the time before funding started", () => {
    const steps = fundingSteps([
      sample(100n, 0n, 0n),
      sample(200n, 10n),
      sample(300n, 18n),
      sample(400n, 18n, 300n), // same event as the previous read: nothing new
      sample(500n, 25n),
    ]);
    expect(steps).toEqual([
      { block: 300n, raw: 8n },
      { block: 500n, raw: 7n },
    ]);
    expect(averageStep(steps, 10)).toBe(7.5);
    expect(averageStep(steps, 1)).toBe(7);
    expect(averageStep([], 3)).toBeNull();
  });

  it("counts funding events on the grid", () => {
    expect(eventsBetween(1_000n, 100n, 1_000n, 1_500n)).toBe(5);
    expect(eventsBetween(1_000n, 100n, 1_050n, 1_500n)).toBe(5);
    expect(eventsBetween(1_000n, 100n, 1_100n, 1_499n)).toBe(3);
    expect(eventsBetween(1_000n, 100n, 1_500n, 1_000n)).toBe(0);
    expect(intervalsIn(86_400, 300, 8_571)).toBeCloseTo(33.6, 1);
    expect(intervalsIn(86_400, 0, 8_571)).toBe(0);
  });

  it("projects funding with the rate held, signed by side", () => {
    const long = projectFunding({ rawPerInterval: 8, intervals: 33.6, units: 0.5, side: "long", meta: BTC });
    expect(long.perIntervalUsdPerUnit).toBeCloseTo(0.8);
    expect(long.positionUsd).toBeCloseTo(0.8 * 33.6 * 0.5);
    const short = projectFunding({
      rawPerInterval: 8,
      intervals: 33.6,
      units: 0.5,
      side: "short",
      meta: BTC,
    });
    expect(short.positionUsd).toBeCloseTo(-0.8 * 33.6 * 0.5);
  });
});

describe("hedge sizing", () => {
  it("pool: the stake whose winnings equal the target", () => {
    const r = sizePoolHedge({ target: 10, sideTotal: 300, otherTotal: 100, room: 1_000, minStake: 1 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.cost).toBeCloseTo((10 * 300) / (98 - 10));
    expect(r.netIfWin).toBeCloseTo(10);
    expect(r.payoutIfWin).toBeCloseTo(r.cost + 10);
    expect(r.covered).toBeCloseTo(1);
    expect(poolNetGain(r.cost, 300, 100)).toBeCloseTo(10);
  });

  it("pool: an empty side needs only the minimum stake, and a target past the pool is covered in part", () => {
    const empty = sizePoolHedge({ target: 10, sideTotal: 0, otherTotal: 100, room: 1_000, minStake: 1 });
    expect(empty.ok && empty.cost).toBe(1);
    expect(empty.ok && empty.netIfWin).toBeCloseTo(98);
    const huge = sizePoolHedge({ target: 500, sideTotal: 300, otherTotal: 100, room: 1_000, minStake: 1 });
    expect(huge.ok && huge.limitedBy).toBe("pool");
    expect(huge.ok && huge.cost).toBe(1_000);
    expect(huge.ok && huge.covered).toBeLessThan(1);
    const capped = sizePoolHedge({ target: 50, sideTotal: 300, otherTotal: 100, room: 20, minStake: 1 });
    expect(capped.ok && capped.limitedBy).toBe("cap");
    expect(capped.ok && capped.cost).toBe(20);
  });

  it("pool: refuses what cannot work", () => {
    expect(sizePoolHedge({ target: 0, sideTotal: 1, otherTotal: 1, room: 9, minStake: 1 }).ok).toBe(false);
    expect(sizePoolHedge({ target: 5, sideTotal: 1, otherTotal: 0, room: 9, minStake: 1 }).ok).toBe(false);
    expect(sizePoolHedge({ target: 5, sideTotal: 1, otherTotal: 9, room: 0.5, minStake: 1 }).ok).toBe(false);
  });

  it("book: tokens = target / (1 − fee − price)", () => {
    const r = sizeBookHedge({ target: 12, price: 0.4, feePerToken: 0.0068 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.tokens).toBeCloseTo(12 / (1 - 0.0068 - 0.4));
    expect(r.cost).toBeCloseTo((r.tokens ?? 0) * 0.4);
    expect(r.payoutIfWin - r.cost).toBeCloseTo(12);
    expect(r.fee).toBe(0.0068);
    expect(sizeBookHedge({ target: 12, price: 0.995, feePerToken: 0.01 }).ok).toBe(false);
    expect(sizeBookHedge({ target: 12, price: Number.NaN, feePerToken: 0.01 }).ok).toBe(false);
  });
});

function fundingMarket(
  overrides: {
    kind?: "net" | "spike";
    perpId?: bigint;
    start?: bigint;
    end?: bigint;
    threshold?: bigint;
  } & Parameters<typeof makeMarket>[0] = {},
) {
  const {
    kind = "net",
    perpId = 16n,
    start = 1_100_000n,
    end = 1_200_000n,
    threshold = 20n,
    ...rest
  } = overrides;
  const p = { perpId, startBlock: start, endBlock: end, threshold, expectedScalingExp: 0 };
  return makeMarket({
    templateId: kind === "net" ? TemplateId.PerplFunding : TemplateId.PerplFundingSpike,
    params: kind === "net" ? encodePerplFundingParams(p) : encodePerplFundingSpikeParams(p),
    ...rest,
  });
}

describe("hedge proposals", () => {
  const base = {
    units: 0.5,
    meta: BTC,
    rawPerInterval: 8,
    head: 1_000_000n,
    lastEvent: 999_999n,
    interval: INTERVAL,
  };

  it("decodes templates 1 and 4 and nothing else", () => {
    expect(fundingMarketOf(fundingMarket())?.kind).toBe("net");
    expect(fundingMarketOf(fundingMarket({ kind: "spike" }))?.kind).toBe("spike");
    expect(fundingMarketOf(makeMarket())).toBeNull();
  });

  it("proposes YES for a long, on both funding templates, sized to the funding left in each window", () => {
    const pool = fundingMarket();
    const spike = fundingMarket({
      kind: "spike",
      end: 1_150_000n,
      address: "0x00000000000000000000000000000000000000a2",
    });
    const other = fundingMarket({ perpId: 32n, address: "0x00000000000000000000000000000000000000a3" });
    const { proposals } = proposeHedges({ ...base, side: "long", markets: [pool, spike, other] });
    expect(proposals.map((p) => p.fm.kind)).toEqual(["spike", "net"]);
    const net = proposals[1];
    expect(net?.buy).toBe("yes");
    const events = eventsBetween(999_999n, INTERVAL, 1_100_000n, 1_200_000n);
    expect(net?.intervals).toBe(events);
    expect(net?.target).toBeCloseTo(0.8 * events * 0.5);
    expect(net?.thresholdUsdPerUnit).toBeCloseTo(2);
    expect(net?.sizing.ok && net.sizing.mode).toBe("pool");
    expect(net?.chance).toBeCloseTo(0.75);
    expect(net?.pays).toMatch(/YES pays if BTC longs pay more than \$2.00 per BTC/);
  });

  it("proposes NO for a short when funding is negative, and skips spike markets", () => {
    const { proposals, skipped } = proposeHedges({
      ...base,
      side: "short",
      rawPerInterval: -8,
      markets: [
        fundingMarket(),
        fundingMarket({ kind: "spike", address: "0x00000000000000000000000000000000000000a2" }),
      ],
    });
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.buy).toBe("no");
    expect(proposals[0]?.chance).toBeCloseTo(0.25);
    expect(skipped[0]?.why).toMatch(/does not cover a short/);
  });

  it("skips windows where the position earns funding, and closed or ended markets", () => {
    const earning = proposeHedges({ ...base, side: "short", markets: [fundingMarket()] });
    expect(earning.proposals).toHaveLength(0);
    expect(earning.skipped[0]?.why).toMatch(/receives funding/);
    const ended = proposeHedges({ ...base, side: "long", head: 1_300_000n, markets: [fundingMarket()] });
    expect(ended.proposals).toHaveLength(0);
    const locked = proposeHedges({
      ...base,
      side: "long",
      markets: [fundingMarket({ phase: Phase.PoolLocked })],
    });
    expect(locked.proposals).toHaveLength(0);
  });

  it("prices a graduated market from the book: YES at the ask, NO at one minus the bid", () => {
    const book = fundingMarket({
      phase: Phase.Graduated,
      graduated: true,
      book: "0x00000000000000000000000000000000000000bb",
      quote: { bid: 350_000_000_000_000_000n, ask: 400_000_000_000_000_000n },
      pool: { yes: USDC(410), no: USDC(280), total: USDC(690), stakers: 11 },
    });
    const long = proposeHedges({ ...base, side: "long", markets: [book] }).proposals[0];
    expect(long?.sizing.ok && long.sizing.mode).toBe("book");
    expect(long?.sizing.ok && long.sizing.price).toBeCloseTo(0.4);
    // The YES fee is φ × NO pool / pool.
    expect(long?.sizing.ok && long.sizing.fee).toBeCloseTo((0.02 * 280) / 690);
    const short = proposeHedges({ ...base, side: "short", rawPerInterval: -8, markets: [book] }).proposals[0];
    expect(short?.sizing.ok && short.sizing.price).toBeCloseTo(0.65);
  });
});

describe("a new market when none fits", () => {
  it("starts on the funding grid after the lead time and spans the horizon", () => {
    const s = suggestNewMarket({
      side: "long",
      rawPerInterval: 8,
      head: 1_000_000n,
      lastEvent: 999_999n,
      interval: INTERVAL,
      intervals: 33.6,
      leadBlocks: 6_000n,
      choice: "half",
    });
    expect((s.startBlock - 999_999n) % INTERVAL).toBe(0n);
    expect(s.startBlock).toBeGreaterThanOrEqual(1_006_000n);
    expect(s.intervals).toBe(34);
    expect(s.endBlock - s.startBlock).toBe(34n * INTERVAL);
    expect(s.thresholdRaw).toBe(BigInt(Math.floor(8 * 34 * 0.5)));
    expect(s.buy).toBe("yes");
  });

  it("gives a short a NO on a negative threshold", () => {
    const s = suggestNewMarket({
      side: "short",
      rawPerInterval: -8,
      head: 1_000_000n,
      lastEvent: 999_999n,
      interval: INTERVAL,
      intervals: 10,
      leadBlocks: 6_000n,
      choice: "full",
    });
    expect(s.thresholdRaw).toBe(-80n);
    expect(s.buy).toBe("no");
    expect(
      suggestNewMarket({
        ...{
          side: "short" as const,
          rawPerInterval: -8,
          head: 1n,
          lastEvent: 1n,
          interval: INTERVAL,
          intervals: 1,
          leadBlocks: 1n,
        },
        choice: "zero",
      }).thresholdRaw,
    ).toBe(0n);
  });

  it("builds the create link in the create form's terms", () => {
    expect(
      createPrefillUrl({ asset: "BTC", startUnix: 1_800_000_000.4, endUnix: 1_800_086_400, threshold: "-0.5", side: "no" }),
    ).toBe("/create?template=1&asset=BTC&start=1800000000&end=1800086400&threshold=-0.5&side=no");
  });

  it("writes raw thresholds as exact USD per unit", () => {
    expect(thresholdText(134n, BTC)).toBe("13.4");
    expect(thresholdText(130n, BTC)).toBe("13");
    expect(thresholdText(-5n, BTC)).toBe("-0.5");
    expect(thresholdText(0n, BTC)).toBe("0");
    expect(thresholdText(120n, { priceDecimals: 0, scalingExp: 0 })).toBe("120");
    expect(thresholdText(1_234n, { priceDecimals: 2, scalingExp: 1 })).toBe("1.234");
  });
});

describe("Perpl reads", () => {
  const revert = () => {
    const inner = new ContractFunctionRevertedError({ abi: perplReadAbi, functionName: "getAccountByAddr" });
    return new BaseError("reverted", { cause: inner });
  };

  it("reports an address with no Perpl account", async () => {
    const client = {
      readContract: vi.fn(async () => Promise.reject(revert())),
      multicall: vi.fn(),
      getBlock: vi.fn(),
    };
    expect(
      await readPerplPositions(
        client as never,
        "0x1964C32f0bE608E7D29302AFF5E61268E72080cc",
        "0x00000000000000000000000000000000000000b0",
      ),
    ).toEqual({
      status: "no-account",
    });
  });

  it("rethrows RPC failures instead of calling them 'no account'", async () => {
    const client = {
      readContract: vi.fn(async () => Promise.reject(new Error("fetch failed"))),
      multicall: vi.fn(),
      getBlock: vi.fn(),
    };
    await expect(
      readPerplPositions(
        client as never,
        "0x1964C32f0bE608E7D29302AFF5E61268E72080cc",
        "0x00000000000000000000000000000000000000b0",
      ),
    ).rejects.toThrow(/fetch failed/);
  });

  it("reads the account's positions from its bitmap and drops empty ones", async () => {
    const info = {
      name: "Bitcoin",
      symbol: "BTC",
      priceDecimals: 1n,
      lotDecimals: 5n,
      markPNS: 850_138n,
      fundingSumScalingExp: 0n,
    };
    const client = {
      readContract: vi.fn(async () => ({
        accountId: 12n,
        positions: { bank1: (1n << 16n) | (1n << 32n), bank2: 0n, bank3: 0n, bank4: 0n },
      })),
      multicall: vi.fn(async () => [
        [
          {
            accountId: 12n,
            positionType: 1,
            pricePNS: 670_804n,
            lotLNS: 5_978n,
            entryBlock: 12_285_766n,
            premiumPnlCNS: 720_002_276n,
          },
          850_076n,
          true,
        ],
        info,
        [
          { accountId: 0n, positionType: 0, pricePNS: 0n, lotLNS: 0n, entryBlock: 0n, premiumPnlCNS: 0n },
          0n,
          false,
        ],
        { ...info, symbol: "ETH" },
      ]),
      getBlock: vi.fn(),
    };
    const r = await readPerplPositions(
      client as never,
      "0x1964C32f0bE608E7D29302AFF5E61268E72080cc",
      "0x00000000000000000000000000000000000000b0",
    );
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.positions).toHaveLength(1);
    expect(r.positions[0]).toMatchObject({
      perpId: 16n,
      side: "short",
      lots: 5_978n,
      premiumPnlCNS: 720_002_276n,
    });
    expect(r.metas[0]?.symbol).toBe("BTC");
  });

  it("reads funding history at grid blocks ending at the last event", async () => {
    const client = {
      readContract: vi.fn(async ({ functionName }: { functionName: string }) =>
        functionName === "getFundingInterval" ? 100n : [50, 1_000n],
      ),
      multicall: vi.fn(async ({ contracts }: { contracts: { args: [bigint, bigint] }[] }) =>
        contracts.map((c) => [Number(c.args[1]) / 100, c.args[1]]),
      ),
      getBlock: vi.fn(),
    };
    const h = await readFundingHistory(
      client as never,
      "0x1964C32f0bE608E7D29302AFF5E61268E72080cc",
      16n,
      1_050n,
      3,
    );
    expect(h.lastEvent).toBe(1_000n);
    expect(h.samples.map((x) => x.block)).toEqual([700n, 800n, 900n, 1_000n]);
    expect(fundingSteps(h.samples).map((x) => x.raw)).toEqual([1n, 1n, 41n]);
  });
});

function memoryStore() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    map,
  };
}

const hedge = (overrides: Partial<TrackedHedge> = {}): TrackedHedge => ({
  id: "h1",
  network: "monad-testnet",
  createdAt: 1,
  perpId: "16",
  symbol: "BTC",
  side: "long",
  units: 0.5,
  startBlock: "1000",
  startSum: "100",
  market: "0x00000000000000000000000000000000000000a1",
  buy: "yes",
  mode: "book",
  cost: 40,
  tokens: 100,
  payoutIfWin: 99,
  ...overrides,
});

describe("tracked hedges", () => {
  it("stores, lists by network and removes", () => {
    const store = memoryStore();
    expect(trackHedge(hedge(), store)).toBe(true);
    expect(trackHedge(hedge({ id: "h2", network: "monad-mainnet", createdAt: 2 }), store)).toBe(true);
    expect(loadHedges("monad-testnet", store).map((h) => h.id)).toEqual(["h1"]);
    expect(untrackHedge("h1", store)).toBe(true);
    expect(loadHedges("monad-testnet", store)).toEqual([]);
  });

  it("ignores bad entries and survives a store that throws", () => {
    const store = memoryStore();
    store.setItem(
      HEDGE_STORAGE_KEY,
      JSON.stringify([{ id: "x" }, hedge({ market: "nope" as never }), hedge()]),
    );
    expect(loadHedges("monad-testnet", store)).toHaveLength(1);
    store.setItem(HEDGE_STORAGE_KEY, "{");
    expect(loadHedges("monad-testnet", store)).toEqual([]);
    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(loadHedges("monad-testnet", broken)).toEqual([]);
    expect(trackHedge(hedge(), broken)).toBe(false);
  });

  it("values a hedge: settled, voided, and open at the market's price", () => {
    const pool = { yes: USDC(410), no: USDC(280), total: USDC(690), stakers: 11 };
    const won = makeMarket({ phase: Phase.Settled, outcome: Outcome.Yes, graduated: true, pool });
    expect(hedgeValue(hedge(), won).value).toBeCloseTo(100 * (1 - (0.02 * 280) / 690));
    const lost = makeMarket({ phase: Phase.Settled, outcome: Outcome.No, graduated: true, pool });
    expect(hedgeValue(hedge(), lost)).toMatchObject({ value: 0, final: true });
    const voided = makeMarket({ phase: Phase.Voided, graduated: true, pool });
    expect(hedgeValue(hedge(), voided).value).toBe(50);
    expect(hedgeValue(hedge({ mode: "pool", tokens: null }), voided).value).toBe(40);
    const open = makeMarket({
      phase: Phase.Graduated,
      graduated: true,
      pool,
      quote: { bid: 600_000_000_000_000_000n, ask: 700_000_000_000_000_000n },
    });
    expect(hedgeValue(hedge(), open).value).toBeCloseTo(65);
    const poolWon = makeMarket({
      phase: Phase.Settled,
      outcome: Outcome.Yes,
      pool: { yes: USDC(300), no: USDC(100), total: USDC(400), stakers: 4 },
    });
    expect(hedgeValue(hedge({ mode: "pool", tokens: null, cost: 30 }), poolWon).value).toBeCloseTo(
      30 + (0.98 * 30 * 100) / 300,
    );
  });
});

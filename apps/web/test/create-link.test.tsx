import {
  deployments,
  encodeChainlinkTouchParams,
  encodeParlayParams,
  encodePerplFundingParams,
  encodePerplFundingSpikeParams,
  encodePriceAtTimeParams,
  encodePriceRangeParams,
  encodeSnapshotParams,
  Phase,
  PriceSource,
  TemplateId,
  TouchDirection,
} from "@hunch-book/shared";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { type Address, type Hex, zeroAddress, zeroHash } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";
import CreatePage from "../src/app/create/page";
import { CreateFlow } from "../src/components/create/CreateFlow";
import { buildPerplParams, defaultPerplDraft } from "../src/lib/create/build";
import { fromLocalInput, toLocalInput } from "../src/lib/create/clock";
import {
  decodeLinkedParams,
  type LinkSource,
  lockLeadOf,
  parseLinkSource,
  toExactLocalInput,
} from "../src/lib/create/linked";
import { parseCreateLink } from "../src/lib/create/prefill";
import { chainlinkOption, pythOption } from "../src/lib/create/price";
import { createPrefillPath } from "../src/lib/ladder/prefill";
import { parseSource } from "../src/lib/snapshot";
import { makeMarket, USDC } from "./fixtures";
import { renderWithProviders } from "./render";

// A link can carry a market's exact parameters (the ladder's "missing strike" and the parlay builder's
// "create this parlay"). The create form decodes them and fills every field; the strongest check is that
// the form then produces exactly the params the link carried.

const NOW = 1_791_090_000;
const DAY = 86_400;
const INTERVAL = 8_571n;
const HEAD = { number: 68_036_598n, timestamp: NOW };
const RESOLVER = "0x00000000000000000000000000000000000000e1" as Address;
const BTC_FEED = "0x12C0F44368a02081ce58a936d1C1F606BB301715" as Address;
const SOL_PYTH = "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d" as Hex;
const testnet = deployments["monad-testnet"];

type QueryState = { data?: unknown; error?: boolean };

const state = vi.hoisted(() => ({
  templates: [] as number[],
  markets: {} as { data?: unknown },
  /** The params the form last handed the preview. */
  previewed: [] as (string | null)[],
}));

const query = (q: QueryState) => ({
  isPending: !q.error && q.data === undefined,
  isError: Boolean(q.error),
  isFetching: false,
  data: q.data,
  error: null,
  refetch: vi.fn(),
});

const RULE = { minPool: USDC(500), minStakers: 10, minChanceBps: 300, maxChanceBps: 9_700 };
const CAPS = { poolCap: USDC(5_000), walletCap: USDC(1_000), minStake: USDC(1), creatorMinStake: USDC(5) };

/** One object per read, made once: the forms' effects compare data by reference. */
const fixed = vi.hoisted(() => {
  const interval = 8_571n;
  const head = { number: 68_036_598n, timestamp: 1_791_090_000 };
  return {
    clock: { data: { head, pace: { msPerBlock: 300, drift: 0.02, measured: true } } },
    perp: {
      data: {
        info: {
          perpId: 64n,
          name: "MON Perp",
          symbol: "MON",
          priceDecimals: 5,
          scalingExp: 3,
          status: 4,
          fundingStartBlock: 12_179_391n,
          markPrice: 3_468n,
        },
        interval,
        anchor: 0n,
        history: {
          interval,
          lastEvent: head.number,
          samples: Array.from({ length: 40 }, (_, i) => ({
            block: head.number - BigInt(39 - i) * interval,
            sum: BigInt(i * 100),
          })),
        },
      },
    },
    challenge: { data: 288_000n },
    fast: { data: 200 },
    spot: { data: { priceE8: 8_472_106_882_025n, updatedAt: 1_791_086_400 } },
    existing: { data: null },
    usdc: { data: { balance: 100_000_000n, allowance: 0n } },
  };
});

const FEEDS = { data: [chainlinkOption("BTC/USD", BTC_FEED), pythOption("SOL/USD", SOL_PYTH)] };

const SOURCES = {
  data: [
    parseSource(0, {
      label: "Perpl's BTC open interest (perp 16)",
      unit: "BTC",
      decimals: 5,
      target: "0x1964C32f0bE608E7D29302AFF5E61268E72080cc",
      callData: "0x12345678",
      tuple: true,
      valueWord: 17,
      signed: false,
      timestampWord: 0,
      maxAge: 0,
    }),
    parseSource(1, {
      label: "Perpl's BTC mark price (perp 16)",
      unit: "USD",
      decimals: 1,
      target: "0x1964C32f0bE608E7D29302AFF5E61268E72080cc",
      callData: "0x12345678",
      tuple: true,
      valueWord: 3,
      signed: false,
      timestampWord: 0,
      maxAge: 120,
    }),
  ],
};

vi.mock("@/lib/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/config")>();
  return {
    ...actual,
    appDeployment: {
      ...actual.appDeployment,
      // One stack, so the links' legs are on the stack new markets go to.
      stacks: undefined,
      defaultStack: undefined,
      hunchBook: { ...actual.appDeployment.hunchBook, factory: "0x00000000000000000000000000000000000000f1" },
    },
  };
});

vi.mock("@/lib/create/hooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/create/hooks")>();
  return {
    ...actual,
    useCreateConfig: () =>
      query({
        data: {
          factory: "0x00000000000000000000000000000000000000f1",
          vault: "0x00000000000000000000000000000000000000aa",
          usdc: "0x00000000000000000000000000000000000000ab",
          paused: false,
          caps: CAPS,
          templates: Object.fromEntries(
            state.templates.map((id) => [id, { resolver: RESOLVER, rule: RULE }]),
          ),
        },
      }),
    useCreateClock: () => query(fixed.clock),
    usePerpContext: () => query(fixed.perp),
    useChallengeBlocks: () => query(fixed.challenge),
    usePriceFeeds: () => query(FEEDS),
    useSpotPrice: () => query(fixed.spot),
    useFastBlockTime: () => query(fixed.fast),
    usePreview: (_resolver: Address | undefined, params: Hex | null) => {
      state.previewed.push(params);
      return { ...query({}), settling: false };
    },
    useExistingMarket: () => ({ ...query(fixed.existing), key: null }),
  };
});

vi.mock("@/lib/snapshot/hooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/snapshot/hooks")>();
  return {
    ...actual,
    useSnapshotSources: () => query(SOURCES),
    useSnapshotCurrentValue: () => query({ data: 1_234_567n }),
  };
});

vi.mock("@/lib/hooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/hooks")>();
  return {
    ...actual,
    useNow: () => NOW,
    useUsdcState: () => query(fixed.usdc),
    useMarkets: () => query(state.markets),
    useTestUsdcFaucet: () => query({}),
  };
});

beforeEach(() => {
  state.templates = [1, 2, 3, 4, 5, 6, 7];
  state.markets = { data: { status: "ok", data: { markets: [], total: 0 } } };
  state.previewed = [];
});

/** Renders the form for a link and waits until it hands the preview exactly `params`. */
async function expectRoundTrip(templateId: number, params: Hex, from: LinkSource = "ladder") {
  await renderWithProviders(<CreateFlow initialTemplate={templateId} link={{ templateId, params, from }} />);
  expect(screen.getByText("Prefilled from a link: check every field")).toBeTruthy();
  await waitFor(() => expect(state.previewed.at(-1)).toBe(params));
}

const value = (label: RegExp | string) => (screen.getByLabelText(label) as HTMLInputElement).value;

describe("reading a link", () => {
  it("parses template, params and source from the query string", () => {
    const params = encodeSnapshotParams({
      sourceId: 0,
      threshold: 1n,
      comparator: 0,
      lockTime: 1n,
      closeTime: 2n,
      snapshotWindow: 600,
    });
    expect(parseCreateLink({ template: "7", params, from: "ladder" })).toEqual({
      templateId: 7,
      params,
      from: "ladder",
    });
    expect(parseCreateLink({ template: ["6", "1"], params: [params], from: "elsewhere" })?.from).toBe("link");
    expect(parseCreateLink({ template: "7" })).toBeUndefined();
    expect(parseCreateLink({ template: "99", params })).toBeUndefined();
    expect(parseCreateLink({ template: "7", params: "0x123" })).toBeUndefined();
    expect(parseLinkSource("parlay")).toBe("parlay");
    expect(parseLinkSource(null)).toBe("link");
  });

  it("decodes each template's params for its form, and nothing that does not decode", () => {
    const perpl = {
      perpId: 64n,
      startBlock: 10n,
      endBlock: 20n,
      threshold: -5n,
      expectedScalingExp: 3,
    };
    expect(decodeLinkedParams(1, encodePerplFundingParams(perpl), testnet)).toEqual({
      kind: "perpl",
      asset: "MON",
      perpId: 64n,
      startBlock: 10n,
      endBlock: 20n,
      threshold: -5n,
    });
    expect(
      decodeLinkedParams(4, encodePerplFundingSpikeParams({ ...perpl, perpId: 999n }), testnet),
    ).toMatchObject({ kind: "perpl", asset: null, perpId: 999n });
    expect(
      decodeLinkedParams(
        2,
        encodePriceAtTimeParams({
          source: PriceSource.Pyth,
          feed: zeroAddress,
          pythId: SOL_PYTH,
          strikeE8: 7n,
          lockTime: 100n,
          closeTime: 200n,
        }),
        testnet,
      ),
    ).toEqual({
      kind: "price",
      feedKey: `pyth:${SOL_PYTH}`,
      strikeE8: 7n,
      lowerE8: null,
      upperE8: null,
      lockTime: 100,
      closeTime: 200,
    });
    expect(
      decodeLinkedParams(
        3,
        encodeChainlinkTouchParams({
          feed: BTC_FEED,
          strikeE8: 9n,
          direction: TouchDirection.AtOrBelow,
          lockTime: 1n,
          startTime: 2n,
          endTime: 3n,
        }),
        testnet,
      ),
    ).toMatchObject({ kind: "touch", feedKey: `chainlink:${BTC_FEED.toLowerCase()}`, direction: "below" });
    // Bytes that are not this template's params, or a template the form does not know.
    expect(decodeLinkedParams(2, "0x1234", testnet)).toBeNull();
    expect(decodeLinkedParams(99, encodePerplFundingParams(perpl), testnet)).toBeNull();
  });

  it("names a lock lead only when it matches a preset exactly", () => {
    expect(lockLeadOf(1_000, 1_000 + DAY)).toBe("day");
    expect(lockLeadOf(1_000, 4_600)).toBe("hour");
    expect(lockLeadOf(1_000, 4_601)).toBe("custom");
  });

  it("keeps seconds in a linked time, so it goes back into the params exactly", () => {
    expect(toExactLocalInput(NOW)).toBe(toLocalInput(NOW));
    expect(toExactLocalInput(NOW + 37)).toMatch(/:37$/);
    expect(fromLocalInput(toExactLocalInput(NOW + 37))).toBe(NOW + 37);
  });

  it("builds Perpl params from a link's exact blocks, ignoring the grid", () => {
    const ctx = {
      perpId: 64n,
      info: fixed.perp.data.info,
      interval: INTERVAL,
      anchor: 0n,
      head: HEAD,
      pace: { msPerBlock: 300, drift: 0.02, measured: true },
      now: NOW,
      rule: "window" as const,
    };
    // Off the grid on purpose: a ladder's market keeps its window exactly, snapped or not.
    const pinned = { startBlock: HEAD.number + 100_001n, endBlock: HEAD.number + 400_003n };
    const draft = { ...defaultPerplDraft(NOW, "MON"), start: "", end: "", threshold: "0.00002", pinned };
    const build = buildPerplParams(draft, ctx);
    expect(build.issues).toEqual([]);
    expect(build.startBlock).toBe(pinned.startBlock);
    expect(build.endBlock).toBe(pinned.endBlock);
    // A window that has already started is still refused.
    const late = buildPerplParams(
      { ...draft, pinned: { startBlock: HEAD.number - 10n, endBlock: pinned.endBlock } },
      ctx,
    );
    expect(late.issues.map((i) => i.field)).toContain("start");
  });
});

describe("the create form, filled from a link", () => {
  it("template 1: the exact blocks, the threshold in USD and the perp", async () => {
    const params = encodePerplFundingParams({
      perpId: 64n,
      startBlock: HEAD.number + 100_001n,
      endBlock: HEAD.number + 400_003n,
      threshold: 1_500n,
      expectedScalingExp: 3,
    });
    await expectRoundTrip(TemplateId.PerplFunding, params);
    expect((screen.getByRole("radio", { name: "MON" }) as HTMLInputElement).checked).toBe(true);
    expect(value(/Threshold: funding paid by longs/)).toBe("0.000015");
    expect(value(/Window starts/)).not.toBe("");
    expect(screen.getByText(/The link's exact blocks: 68,136,599 to 68,436,601/)).toBeTruthy();
    expect(screen.getByText(/The ladder page sent this market's parameters/)).toBeTruthy();
    // Editing a time hands the window back to the clock.
    fireEvent.change(screen.getByLabelText(/Window starts/), {
      target: { value: toLocalInput(NOW + 2 * DAY) },
    });
    expect(screen.queryByText(/The link's exact blocks/)).toBeNull();
  });

  it("template 4: a spike's window and threshold", async () => {
    const params = encodePerplFundingSpikeParams({
      perpId: 64n,
      startBlock: HEAD.number + 50_000n,
      endBlock: HEAD.number + 350_000n,
      threshold: 2_000n,
      expectedScalingExp: 3,
    });
    await expectRoundTrip(TemplateId.PerplFundingSpike, params);
    expect(value(/Threshold: what one funding event charges longs/)).toBe("0.00002");
  });

  it("template 2: the feed, strike and times, to the second", async () => {
    const close = NOW + 3 * DAY + 37;
    const params = encodePriceAtTimeParams({
      source: PriceSource.Chainlink,
      feed: BTC_FEED,
      pythId: zeroHash,
      strikeE8: 90_500_00000000n,
      lockTime: BigInt(close - DAY),
      closeTime: BigInt(close),
    });
    await expectRoundTrip(TemplateId.PriceAtTime, params);
    expect(value("Price level (strike), in USD")).toBe("90500");
    expect(value("Close: when the price is read")).toBe(toExactLocalInput(close));
  });

  it("template 5: a Pyth range with its own lock time", async () => {
    const close = NOW + 2 * DAY;
    const params = encodePriceRangeParams({
      source: PriceSource.Pyth,
      feed: zeroAddress,
      pythId: SOL_PYTH,
      lowerE8: 150_00000000n,
      upperE8: 160_50000000n,
      lockTime: BigInt(close - 7_200),
      closeTime: BigInt(close),
    });
    await expectRoundTrip(TemplateId.PriceRange, params);
    expect(value("Bottom of the range, in USD")).toBe("150");
    expect(value("Top of the range, in USD")).toBe("160.5");
    expect(value("Lock time")).toBe(toExactLocalInput(close - 7_200));
  });

  it("template 3: direction, level and window, with a lock before the start", async () => {
    const start = NOW + DAY;
    const params = encodeChainlinkTouchParams({
      feed: BTC_FEED,
      strikeE8: 80_000_00000000n,
      direction: TouchDirection.AtOrBelow,
      lockTime: BigInt(start - 3_600),
      startTime: BigInt(start),
      endTime: BigInt(start + 5 * DAY),
    });
    await expectRoundTrip(TemplateId.ChainlinkTouch, params);
    expect((screen.getByRole("radio", { name: /Falls to/ }) as HTMLInputElement).checked).toBe(true);
    expect(value("Price level, in USD")).toBe("80000");
    expect(value("Lock: when staking stops")).toBe(toExactLocalInput(start - 3_600));
  });

  it("template 6: the legs and times", async () => {
    const leg = (i: number, phase: Phase = Phase.Pool) =>
      makeMarket({
        address: `0x${(0xa0 + i).toString(16).padStart(40, "0")}` as Address,
        marketId: BigInt(i),
        description: `Leg question ${i}`,
        phase,
        window: {
          blockClock: false,
          lock: BigInt(NOW + DAY + i),
          close: BigInt(NOW + 2 * DAY),
          settleDeadline: 0n,
        },
      });
    const legs = [leg(1), leg(2), leg(3, Phase.Settled)];
    state.markets = { data: { status: "ok", data: { markets: legs, total: legs.length } } };
    const window = { lockTime: BigInt(NOW + DAY - 120), closeTime: BigInt(NOW + 2 * DAY) };
    const params = encodeParlayParams({ legs: [legs[1]?.address, legs[0]?.address] as Address[], ...window });
    await expectRoundTrip(TemplateId.Parlay, params, "parlay");
    expect(screen.getByText(/The parlay page sent this parlay's legs and times/)).toBeTruthy();
    expect(screen.getByText("Legs: 2 of 2 to 5 chosen")).toBeTruthy();
    expect(screen.queryByText(/can no longer be a leg/)).toBeNull();
  });

  it("template 6: drops a leg that can no longer be one", async () => {
    const leg = (i: number, phase: Phase) =>
      makeMarket({
        address: `0x${(0xa0 + i).toString(16).padStart(40, "0")}` as Address,
        marketId: BigInt(i),
        description: `Leg question ${i}`,
        phase,
        window: {
          blockClock: false,
          lock: BigInt(NOW + DAY + i),
          close: BigInt(NOW + 2 * DAY),
          settleDeadline: 0n,
        },
      });
    const legs = [leg(1, Phase.Pool), leg(2, Phase.Pool), leg(3, Phase.Settled)];
    state.markets = { data: { status: "ok", data: { markets: legs, total: legs.length } } };
    const params = encodeParlayParams({
      legs: legs.map((l) => l.address),
      lockTime: BigInt(NOW + DAY - 120),
      closeTime: BigInt(NOW + 2 * DAY),
    });
    await renderWithProviders(
      <CreateFlow initialTemplate={6} link={{ templateId: 6, params, from: "parlay" }} />,
    );
    expect(await screen.findByText(/can no longer be a leg/)).toBeTruthy();
    expect(screen.getByText(/: #3\./)).toBeTruthy();
    expect(screen.getByText("Legs: 2 of 2 to 5 chosen")).toBeTruthy();
  });

  it("template 7: the source, comparator, level, window and lock", async () => {
    const close = NOW + 2 * DAY;
    const params = encodeSnapshotParams({
      sourceId: 1,
      threshold: 812_345n,
      comparator: 3,
      lockTime: BigInt(close - 3_600),
      closeTime: BigInt(close),
      snapshotWindow: 120,
    });
    await expectRoundTrip(TemplateId.Snapshot, params, "link");
    const source = within(screen.getByRole("group", { name: "What to read" }));
    expect((source.getByRole("radio", { name: /mark price/ }) as HTMLInputElement).checked).toBe(true);
    expect(value("Level, in USD")).toBe("81234.5");
    // A window that is not one of the usual lengths is offered as its own choice.
    expect((screen.getByRole("radio", { name: "2 minutes" }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText(/A link sent these values/)).toBeTruthy();
  });

  it("says when the link's params do not read as the template's, and starts from the defaults", async () => {
    await renderWithProviders(
      <CreateFlow initialTemplate={2} link={{ templateId: 2, params: "0x1234", from: "ladder" }} />,
    );
    expect(screen.getByText(/do not read as this template's/)).toBeTruthy();
    await waitFor(() => expect(value("Price level (strike), in USD")).toBe("84700"));
  });

  it("is wired from the page's query string, and the ladder's links land on it", async () => {
    const params = encodePriceAtTimeParams({
      source: PriceSource.Chainlink,
      feed: BTC_FEED,
      pythId: zeroHash,
      strikeE8: 91_000_00000000n,
      lockTime: BigInt(NOW + 2 * DAY),
      closeTime: BigInt(NOW + 3 * DAY),
    });
    const search = new URL(createPrefillPath(2, params, "ladder"), "https://x").searchParams;
    await renderWithProviders(
      await CreatePage({ searchParams: Promise.resolve(Object.fromEntries(search.entries())) }),
    );
    await waitFor(() => expect(state.previewed.at(-1)).toBe(params));
    expect(value("Price level (strike), in USD")).toBe("91000");
  });
});

import {
  deployments,
  encodeParlayParams,
  encodePriceAtTimeParams,
  Phase,
  PriceSource,
  TemplateId,
} from "@hunch-book/shared";
import { fireEvent, screen, within } from "@testing-library/react";
import { type Address, getAddress, type Hex } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";
import FeedPage from "../src/app/feed/page";
import LadderPage from "../src/app/ladder/page";
import ParlayRoute from "../src/app/parlay/page";
import ReferralPage from "../src/app/r/[address]/page";
import { AutoRedeemPanel } from "../src/components/autoredeem/AutoRedeemPanel";
import { OrdersPanel } from "../src/components/orders/OrdersPanel";
import { ReferralBindPrompt } from "../src/components/referral/ReferralBindPrompt";
import { ReferralPanel } from "../src/components/referral/ReferralPanel";
import { ShareMarket } from "../src/components/referral/ShareMarket";
import { RewardsView } from "../src/components/rewards/RewardsView";
import { Condition, OrderKind, OrderStatus } from "../src/lib/orders/form";
import { REFERRER_KEY } from "../src/lib/referral/storage";
import { buildTree, leafHash } from "../src/lib/rewards/epochs";
import { serializeEpoch } from "../src/lib/rewards/load";
import { makeBalances, makeBook, makeEntry, makeMarket, USDC, USER } from "./fixtures";
import { renderWithProviders } from "./render";

// The periphery features against mocked reads and a mocked transaction runner: what each page and panel
// shows, and the exact contract call each button sends. Addresses are the real testnet deployment's.

const ME = getAddress(USER);
const periphery = deployments["monad-testnet"].hunchBook.periphery as Record<string, Address>;
const ORDERS = periphery.conditionalOrders as Address;
const REDEEMER = periphery.autoRedeemer as Address;
const REGISTRY = periphery.referralRegistry as Address;
const DISTRIBUTOR = periphery.merkleDistributor as Address;
const ROUTER = deployments["monad-testnet"].hunchBook.router as Address;
const USDC_TOKEN = "0x00000000000000000000000000000000000000ab" as Address;
const REFERRER = getAddress("0x00000000000000000000000000000000000000d7");
const NOW = 1_799_000_000;

type Q = { data?: unknown; isPending?: boolean; isError?: boolean };
const state = vi.hoisted(() => ({
  markets: {} as Q,
  book: {} as Q,
  balances: {} as Q,
  orders: {} as Q,
  funds: {} as Q,
  binding: {} as Q,
  binds: {} as Q,
  fees: {} as Q,
  redeemer: {} as Q,
  onchainEpochs: {} as Q,
  run: vi.fn(async () => true),
  runAll: vi.fn(async (steps: unknown[]) => steps.length),
  readContract: vi.fn(async (_args: { functionName: string }): Promise<unknown> => "0x"),
}));

const q = (s: Q) => ({
  data: s.data,
  isPending: s.isPending ?? s.data === undefined,
  isError: s.isError ?? false,
  isFetching: false,
  refetch: vi.fn(),
});

vi.mock("@/lib/hooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/hooks")>();
  return {
    ...actual,
    useMarkets: () => q(state.markets),
    useBook: () => q(state.book),
    useWalletBalances: () => q(state.balances),
    useUserPosition: () => q({}),
    useUsdcState: () => q({ data: { balance: USDC(500), allowance: 0n } }),
    useTestUsdcFaucet: () => q({}),
    useChainClock: () => null,
    useNow: () => 1_799_000_000,
    useProtocolAddresses: () =>
      q({
        data: {
          vault: "0x00000000000000000000000000000000000000aa",
          usdc: "0x00000000000000000000000000000000000000ab",
        },
      }),
  };
});

vi.mock("@/lib/orders/hooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/orders/hooks")>();
  return { ...actual, useOwnerOrders: () => q(state.orders), useOrderFunds: () => q(state.funds) };
});

vi.mock("@/lib/referral/hooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/referral/hooks")>();
  return {
    ...actual,
    useBinding: () => q(state.binding),
    useReferralBinds: () => ({
      ...q(state.binds),
      hasNextPage: false,
      isFetchingNextPage: false,
      fetchNextPage: vi.fn(),
    }),
    useReferralFees: () => q(state.fees),
  };
});

vi.mock("@/lib/autoredeem/hooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/autoredeem/hooks")>();
  return { ...actual, useRedeemerState: () => q(state.redeemer) };
});

vi.mock("@/lib/rewards/hooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/rewards/hooks")>();
  return {
    ...actual,
    useRemoteEpochs: () => q({}),
    useEpochCount: () => q({ data: 1n }),
    useOnchainEpochs: () => q(state.onchainEpochs),
    useTokenInfo: () => q({ data: new Map([[USDC_TOKEN, { symbol: "USDC", decimals: 6 }]]) }),
  };
});

vi.mock("@/lib/chain/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/chain/client")>();
  return {
    ...actual,
    getPublicClient: () => ({
      getBlock: async () => ({ timestamp: BigInt(Math.floor(Date.now() / 1000)) }),
      readContract: state.readContract,
    }),
  };
});

vi.mock("@/lib/wallet/useTxRunner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/wallet/useTxRunner")>();
  return {
    ...actual,
    useTxRunner: () => ({
      run: state.run,
      runAll: state.runAll,
      txs: [],
      error: null,
      stage: "idle",
      progress: null,
      busy: false,
    }),
  };
});

let id = 0;
const nextAddress = (): Address => getAddress(`0x${(0xe000 + ++id).toString(16).padStart(40, "0")}`);
const btcFeed = deployments["monad-testnet"].external.chainlink["BTC/USD"] as Address;

function priceMarket(strike: bigint, yesBps: number): ReturnType<typeof makeMarket> {
  const yes = BigInt(yesBps) * 1_000n;
  const no = BigInt(10_000 - yesBps) * 1_000n;
  return makeMarket({
    address: nextAddress(),
    marketId: BigInt(id),
    templateId: TemplateId.PriceAtTime,
    params: encodePriceAtTimeParams({
      source: PriceSource.Chainlink,
      feed: btcFeed,
      pythId: `0x${"00".repeat(32)}` as Hex,
      strikeE8: strike * 100_000_000n,
      lockTime: 1_800_000_000n,
      closeTime: 1_800_086_400n,
    }),
    description: `Will BTC/USD be at or above $${strike.toLocaleString("en-US")}?`,
    pool: { yes, no, total: yes + no, stakers: 4 },
  });
}

const trading = makeMarket({
  phase: Phase.Graduated,
  graduated: true,
  book: "0x00000000000000000000000000000000000000bb",
  quote: { bid: 350_000_000_000_000_000n, ask: 400_000_000_000_000_000n },
});

const literal = (text: string): RegExp => new RegExp(text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&"));

const listOf = (markets: unknown[]) => ({ data: { status: "ok", data: { markets, total: markets.length } } });

beforeEach(() => {
  state.markets = {};
  state.book = { data: makeBook() };
  state.balances = { data: makeBalances() };
  state.orders = { data: { orders: [], total: 0n, complete: true } };
  state.funds = {
    data: {
      balances: { usdc: USDC(1_000), yes: USDC(50), no: USDC(80) },
      allowances: { usdc: 0n, yes: 0n, no: 0n },
    },
  };
  state.binding = {
    data: {
      referrer: "0x0000000000000000000000000000000000000000",
      boundAt: 0n,
      expiresAt: 0n,
      active: false,
    },
  };
  state.binds = { data: { pages: [] } };
  state.fees = {};
  state.redeemer = {};
  state.onchainEpochs = {};
  state.run.mockClear();
  state.runAll.mockClear();
  state.readContract.mockReset();
  state.readContract.mockImplementation(async () => "0x");
  window.localStorage.clear();
});

describe("/feed", () => {
  it("deals open markets one card at a time; YES opens the stake ticket, closing it moves on", async () => {
    const first = priceMarket(120_000n, 4_000);
    const second = priceMarket(125_000n, 3_000);
    state.markets = listOf([second, first]);
    await renderWithProviders(<FeedPage />, { connected: true });
    expect(screen.getByRole("heading", { level: 1, name: "Feed" })).toBeTruthy();
    expect(screen.getByText("Market 1 of 2")).toBeTruthy();
    const card = screen.getByRole("article");
    expect(card.getAttribute("aria-roledescription")).toBe("market card");
    fireEvent.keyDown(card, { key: "ArrowRight" });
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: "Stake on YES" })).toBeTruthy();
    expect(within(dialog).getByText("Ticket")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("Market 2 of 2")).toBeTruthy();
  });

  it("skips with the button, then says the deck is done and can start over", async () => {
    state.markets = listOf([priceMarket(120_000n, 4_000)]);
    await renderWithProviders(<FeedPage />);
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    expect(await screen.findByRole("heading", { name: "You have seen every open market" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Start over" }));
    expect(screen.getByText("Market 1 of 1")).toBeTruthy();
  });

  it("says when nothing is open", async () => {
    state.markets = listOf([makeMarket({ phase: Phase.Settled })]);
    await renderWithProviders(<FeedPage />);
    expect(screen.getByRole("heading", { name: "No open markets right now" })).toBeTruthy();
  });
});

describe("/ladder", () => {
  it("draws the curve, lists every rung and links the missing strikes into /create", async () => {
    state.markets = listOf([
      priceMarket(110_000n, 7_000),
      priceMarket(120_000n, 4_000),
      priceMarket(130_000n, 1_500),
    ]);
    await renderWithProviders(<LadderPage />);
    expect(screen.getByRole("heading", { level: 1, name: "Ladders" })).toBeTruthy();
    const points = screen.getAllByRole("link", {
      name: /chance of YES, from the pool split\. Open the market\.$/,
    });
    expect(points).toHaveLength(3);
    expect(points[0]?.getAttribute("aria-label")).toBe(
      "$110,000: 70.0% chance of YES, from the pool split. Open the market.",
    );
    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("row")).toHaveLength(4);
    const add = screen.getByRole("link", { name: "+ $140,000" });
    expect(add.getAttribute("href")).toMatch(/^\/create\?template=2&params=0x[0-9a-f]+&from=ladder$/);
  });

  it("warns when two rungs are priced the wrong way round", async () => {
    state.markets = listOf([priceMarket(110_000n, 4_000), priceMarket(120_000n, 6_000)]);
    await renderWithProviders(<LadderPage />);
    expect(screen.getByText("The curve runs the wrong way here")).toBeTruthy();
  });

  it("explains ladders when there are none, and can show single markets to start one", async () => {
    state.markets = listOf([priceMarket(110_000n, 4_000)]);
    await renderWithProviders(<LadderPage />);
    expect(screen.getByRole("heading", { name: "No ladders yet" })).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: /Show single markets too/ }));
    expect(screen.getByRole("link", { name: "+ $115,000" })).toBeTruthy();
  });
});

describe("/parlay", () => {
  it("multiplies the picked legs' chances and prefills a template 6 market", async () => {
    const a = priceMarket(110_000n, 5_000);
    const b = priceMarket(120_000n, 4_000);
    state.markets = listOf([a, b]);
    await renderWithProviders(<ParlayRoute />);
    fireEvent.click(screen.getByRole("checkbox", { name: literal(a.description as string) }));
    expect(screen.getByText("pick at least 2 legs")).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: literal(b.description as string) }));
    expect(screen.getByText("20.0%")).toBeTruthy();
    expect(screen.getByText(/implied chance that all 2 legs settle YES, about 1 in 5/)).toBeTruthy();
    expect(screen.getByText(/assumes the legs are independent/)).toBeTruthy();
    const create = screen.getByRole("link", { name: /Create this parlay/ });
    expect(create.getAttribute("href")).toMatch(/^\/create\?template=6&params=0x[0-9a-f]+&from=parlay$/);
  });

  it("lists existing parlays with each leg's state", async () => {
    const a = priceMarket(110_000n, 5_000);
    const b = priceMarket(120_000n, 4_000);
    const parlay = makeMarket({
      address: nextAddress(),
      templateId: TemplateId.Parlay,
      params: encodeParlayParams({ legs: [a.address, b.address], lockTime: 1n, closeTime: 2n }),
      description: "Will both BTC markets settle YES?",
    });
    state.markets = listOf([a, b, parlay]);
    await renderWithProviders(<ParlayRoute />);
    expect(screen.getByRole("heading", { name: "Parlays · 1" })).toBeTruthy();
    expect(screen.getByText(/legs imply 20\.0%, assuming they are independent/)).toBeTruthy();
    expect(screen.getAllByText("Open").length).toBeGreaterThanOrEqual(2);
  });
});

describe("/r/[address]", () => {
  it("remembers the referrer, explains referrals and continues to the shared market", async () => {
    const market = "0x00000000000000000000000000000000000000a1";
    await renderWithProviders(
      await ReferralPage({
        params: Promise.resolve({ address: REFERRER.toLowerCase() }),
        searchParams: Promise.resolve({ next: `/m/${market}` }),
      }),
    );
    expect(screen.getByRole("heading", { level: 1, name: "You are invited to Hunch Book" })).toBeTruthy();
    expect(screen.getByText(/Remembered in this browser/)).toBeTruthy();
    expect(JSON.parse(window.localStorage.getItem(REFERRER_KEY) ?? "{}").referrer).toBe(REFERRER);
    expect(screen.getByRole("link", { name: /Continue/ }).getAttribute("href")).toBe(`/m/${market}`);
  });

  it("drops a next page that leaves the site, and 404s a bad address", async () => {
    await renderWithProviders(
      await ReferralPage({
        params: Promise.resolve({ address: REFERRER }),
        searchParams: Promise.resolve({ next: "https://evil.example" }),
      }),
    );
    expect(screen.getByRole("link", { name: /Browse markets/ }).getAttribute("href")).toBe("/markets");
    await expect(
      ReferralPage({ params: Promise.resolve({ address: "nope" }), searchParams: Promise.resolve({}) }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
  });
});

describe("referral prompt and panel", () => {
  it("offers to bind the remembered referrer, sends bind, and can be dismissed", async () => {
    window.localStorage.setItem(
      REFERRER_KEY,
      JSON.stringify({ referrer: REFERRER, savedAt: Date.now(), dismissed: false }),
    );
    await renderWithProviders(<ReferralBindPrompt />, { connected: true });
    fireEvent.click(await screen.findByRole("button", { name: "Bind referrer" }));
    expect(state.run).toHaveBeenCalledWith(
      "Bind your referrer",
      expect.objectContaining({ address: REGISTRY, functionName: "bind", args: [REFERRER] }),
      ME,
    );
    fireEvent.click(screen.getByRole("button", { name: "No thanks" }));
    expect(screen.queryByRole("button", { name: "Bind referrer" })).toBeNull();
    expect(JSON.parse(window.localStorage.getItem(REFERRER_KEY) ?? "{}").dismissed).toBe(true);
  });

  it("shows nothing once the wallet is bound, or without a remembered referrer", async () => {
    const first = await renderWithProviders(<ReferralBindPrompt />, { connected: true });
    expect(first.container.textContent).toBe("");
    first.unmount();
    window.localStorage.setItem(REFERRER_KEY, JSON.stringify({ referrer: REFERRER, savedAt: Date.now() }));
    state.binding = { data: { referrer: USER, boundAt: 1n, expiresAt: 9_999_999_999n, active: true } };
    const second = await renderWithProviders(<ReferralBindPrompt />, { connected: true });
    expect(second.container.textContent).toBe("");
  });

  it("shows the wallet's link, who bound to it, and that earnings need the indexer", async () => {
    state.binds = {
      data: {
        pages: [
          {
            binds: [
              {
                user: REFERRER,
                referrer: ME,
                boundAt: BigInt(NOW - 100),
                expiresAt: BigInt(NOW + 1_000),
                relayer: REFERRER,
                block: 68_100_000n,
                tx: `0x${"ab".repeat(32)}`,
              },
            ],
            scannedFrom: 68_046_179n,
            scannedTo: 68_100_100n,
            complete: true,
          },
        ],
      },
    };
    await renderWithProviders(<ReferralPanel user={ME} />, { connected: true });
    const link = screen.getByRole("textbox", { name: "Your referral link" }) as HTMLInputElement;
    expect(link.value.endsWith(`/r/${ME}`)).toBe(true);
    expect(screen.getByText("Binds found").nextSibling?.textContent).toBe("1");
    expect(screen.getByText("Active")).toBeTruthy();
    expect(screen.getByText("needs the indexer")).toBeTruthy();
    expect(screen.getByText(/back to the registry's deployment/)).toBeTruthy();
  });
});

describe("Share", () => {
  it("opens the card preview with a link that carries the referral, or not", async () => {
    await renderWithProviders(<ShareMarket m={trading} />, { connected: true });
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    const dialog = await screen.findByRole("dialog", { name: "Share this market" });
    expect(within(dialog).getByRole("img").getAttribute("src")).toBe(`/m/${trading.address}/opengraph-image`);
    const link = within(dialog).getByRole("textbox", { name: "Link to share" }) as HTMLInputElement;
    expect(link.value).toContain(`/r/${ME}?next=${encodeURIComponent(`/m/${trading.address}`)}`);
    fireEvent.click(within(dialog).getByRole("checkbox"));
    expect(link.value.endsWith(`/m/${trading.address}`)).toBe(true);
    expect(
      within(dialog)
        .getByRole("link", { name: /Post on X/ })
        .getAttribute("href"),
    ).toContain(encodeURIComponent(`/m/${trading.address}`));
  });
});

describe("Orders panel", () => {
  it("closes a whole YES position: an exact router approval, then sellYes with a minimum out", async () => {
    state.balances = { data: makeBalances({ yes: USDC(50), no: 0n }) };
    const first = await renderWithProviders(<OrdersPanel m={trading} />, { connected: true });
    fireEvent.click(screen.getByRole("button", { name: "Step 1 of 2: approve 50.00 YES" }));
    expect(state.run).toHaveBeenCalledWith(
      "Approve 50.00 YES for the Hunch router",
      expect.objectContaining({
        address: trading.tokens.yes,
        functionName: "approve",
        args: [ROUTER, USDC(50)],
      }),
      ME,
    );
    first.unmount();
    state.balances = {
      data: makeBalances({
        yes: USDC(50),
        no: 0n,
        allowance: { usdcToRouter: 0n, usdcToVault: 0n, yesToRouter: USDC(50), noToRouter: 0n },
      }),
    };
    await renderWithProviders(<OrdersPanel m={trading} />, { connected: true });
    fireEvent.click(screen.getByRole("button", { name: "Close YES" }));
    await vi.waitFor(() => expect(state.run).toHaveBeenCalledTimes(2));
    const [, request] = state.run.mock.calls.at(-1) as unknown as [
      string,
      { functionName: string; args: bigint[] },
    ];
    expect(request.functionName).toBe("sellYes");
    expect(request.args.slice(0, 3)).toEqual([trading.address, USDC(50), USDC(17.325)]);
  });

  it("places a take-profit: approves ConditionalOrders for exactly the order, then sends place", async () => {
    state.balances = { data: makeBalances({ yes: 0n, no: 0n }) };
    const first = await renderWithProviders(<OrdersPanel m={trading} />, { connected: true });
    fireEvent.change(screen.getByLabelText(/Trigger price/), { target: { value: "0.65" } });
    fireEvent.change(screen.getByLabelText(/^Sell/), { target: { value: "50" } });
    expect(screen.getByText(/Sell 50\.00 YES once the YES bid is at or above 0\.650 USDC/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Step 1 of 2: approve 50.00 YES" }));
    expect(state.run).toHaveBeenCalledWith(
      "Approve 50.00 YES for conditional orders",
      expect.objectContaining({
        address: trading.tokens.yes,
        functionName: "approve",
        args: [ORDERS, USDC(50)],
      }),
      ME,
    );
    first.unmount();

    state.funds = {
      data: {
        balances: { usdc: USDC(1_000), yes: USDC(50), no: USDC(80) },
        allowances: { usdc: 0n, yes: USDC(50), no: 0n },
      },
    };
    await renderWithProviders(<OrdersPanel m={trading} />, { connected: true });
    fireEvent.change(screen.getByLabelText(/Trigger price/), { target: { value: "0.65" } });
    fireEvent.change(screen.getByLabelText(/^Sell/), { target: { value: "50" } });
    fireEvent.click(screen.getByRole("button", { name: "Place take-profit" }));
    await vi.waitFor(() => expect(state.run).toHaveBeenCalledTimes(2));
    const [label, request] = state.run.mock.calls.at(-1) as unknown as [
      string,
      { address: Address; functionName: string; args: [Record<string, unknown>] },
    ];
    expect(label).toBe("Place take-profit on YES at 0.650");
    expect(request.address).toBe(ORDERS);
    expect(request.functionName).toBe("place");
    expect(request.args[0]).toMatchObject({
      market: trading.address,
      kind: OrderKind.SellYes,
      condition: Condition.AtOrAbove,
      triggerPriceE6: 650_000,
      executorTipBps: 10,
      amountIn: USDC(50),
      limit: 31_818_150n,
    });
  });

  it("lists open orders with cancel, and keeps past ones under history", async () => {
    const order = {
      id: 7n,
      owner: ME,
      expiry: BigInt(NOW + 3_600),
      triggerPriceE6: 300_000n,
      market: trading.address,
      kind: OrderKind.SellYes,
      condition: Condition.AtOrBelow,
      status: OrderStatus.Open,
      executorTipBps: 0,
      amountIn: USDC(10),
      limit: USDC(2.9),
    };
    state.orders = {
      data: {
        orders: [order, { ...order, id: 6n, status: OrderStatus.Executed }],
        total: 7n,
        complete: true,
      },
    };
    await renderWithProviders(<OrdersPanel m={trading} />, { connected: true });
    expect(screen.getAllByText("Stop-loss YES at or below 0.300")).toHaveLength(2);
    expect(screen.getByText("Past orders (1)")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(state.run).toHaveBeenCalledWith(
      "Cancel order #7",
      expect.objectContaining({ address: ORDERS, functionName: "cancel", args: [7n] }),
      ME,
    );
  });

  it("renders nothing for a market that has not graduated", async () => {
    const r = await renderWithProviders(<OrdersPanel m={makeMarket()} />, { connected: true });
    expect(r.container.textContent).toBe("");
  });
});

describe("Auto-redeem panel", () => {
  const entry = makeEntry({
    market: makeMarket({ graduated: true, phase: Phase.Graduated }),
    balances: { yes: USDC(10), no: 0n },
  });

  it("turns on with the opt-in and one approval per token when the permit domain does not match", async () => {
    state.redeemer = { data: { optedIn: false, markets: new Map() } };
    state.readContract.mockImplementation(async (args: { functionName: string }) =>
      args.functionName === "name"
        ? "Some token"
        : args.functionName === "nonces"
          ? 0n
          : `0x${"12".repeat(32)}`,
    );
    await renderWithProviders(<AutoRedeemPanel entries={[entry]} />, { connected: true });
    const toggle = screen.getByRole("switch", { name: "Redeem my winnings automatically" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    await vi.waitFor(() => expect(state.runAll).toHaveBeenCalledTimes(1));
    const [steps] = state.runAll.mock.calls[0] as unknown as [
      { request: { address: Address; functionName: string; args: unknown[] } }[],
    ];
    expect(steps.map((s) => s.request.functionName)).toEqual(["setOptIn", "approve"]);
    expect(steps[0]?.request).toMatchObject({ address: REDEEMER, args: [true] });
    expect(steps[1]?.request).toMatchObject({ address: entry.market.tokens.yes });
    expect(steps[1]?.request.args[0]).toBe(REDEEMER);
  });

  it("shows coverage per market, turns off, and switches one market out", async () => {
    state.redeemer = {
      data: {
        optedIn: true,
        markets: new Map([
          [entry.market.address.toLowerCase(), { optedOut: false, allowance: { yes: USDC(10), no: 0n } }],
        ]),
      },
    };
    await renderWithProviders(<AutoRedeemPanel entries={[entry]} />, { connected: true });
    expect(screen.getByText("Covered")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Leave this market out" }));
    expect(state.run).toHaveBeenCalledWith(
      `Switch off auto-redeem on #${entry.market.marketId}`,
      expect.objectContaining({ functionName: "setMarketOptOut", args: [entry.market.address, true] }),
      ME,
    );
    fireEvent.click(screen.getByRole("switch"));
    expect(state.run).toHaveBeenCalledWith(
      "Turn off auto-redeem",
      expect.objectContaining({ address: REDEEMER, functionName: "setOptIn", args: [false] }),
      ME,
    );
    expect(screen.getByRole("button", { name: "Revoke approvals" })).toBeTruthy();
  });
});

describe("Rewards", () => {
  const amount = 250_000n;
  const leaves = [leafHash(3n, ME, amount), leafHash(3n, REFERRER, 750_000n)];
  const tree = buildTree(leaves);
  const file = serializeEpoch({
    epoch: 3n,
    token: USDC_TOKEN,
    total: 1_000_000n,
    root: tree.root,
    claimDeadline: null,
    kind: "maker",
    claims: [
      { account: ME, amount, proof: tree.proofs[0] ?? [] },
      { account: REFERRER, amount: 750_000n, proof: tree.proofs[1] ?? [] },
    ],
    source: "rewards/3.json",
  });

  it("claims a verified epoch from the distributor with the wallet's proof", async () => {
    state.onchainEpochs = {
      data: [
        {
          epoch: {
            token: USDC_TOKEN,
            claimDeadline: BigInt(NOW + 86_400),
            swept: false,
            root: tree.root,
            total: 1_000_000n,
            claimed: 0n,
          },
          claimed: false,
        },
      ],
    };
    await renderWithProviders(<RewardsView published={[file]} errors={[]} />, { connected: true });
    expect(screen.getAllByText("Ready to claim")).toHaveLength(2);
    expect(screen.getAllByText("0.25 USDC").length).toBeGreaterThan(0);
    fireEvent.click(screen.getAllByRole("button", { name: "Claim" })[1] as HTMLElement);
    expect(state.run).toHaveBeenCalledWith(
      "Claim epoch 3: 0.25 USDC",
      expect.objectContaining({
        address: DISTRIBUTOR,
        functionName: "claim",
        args: [3n, ME, amount, tree.proofs[0]],
      }),
      ME,
    );
  });

  it("says when an epoch is published but not funded, and when nothing is published", async () => {
    state.onchainEpochs = {
      data: [
        {
          epoch: {
            token: USDC_TOKEN,
            claimDeadline: 0n,
            swept: false,
            root: `0x${"00".repeat(32)}`,
            total: 0n,
            claimed: 0n,
          },
          claimed: false,
        },
      ],
    };
    const first = await renderWithProviders(
      <RewardsView published={[file]} errors={["rewards/x.json: not valid JSON."]} />,
      {
        connected: true,
      },
    );
    expect(screen.getByText("Not funded yet")).toBeTruthy();
    expect(screen.getByText("rewards/x.json: not valid JSON.")).toBeTruthy();
    first.unmount();
    await renderWithProviders(<RewardsView published={[]} errors={[]} />);
    expect(screen.getByRole("heading", { name: "No reward epochs are published yet" })).toBeTruthy();
    expect(screen.getByText(/Connect a wallet to see what it can claim/)).toBeTruthy();
  });
});

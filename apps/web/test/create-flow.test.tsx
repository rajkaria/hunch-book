import { Phase } from "@hunch-book/shared";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { Address } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";
import CreatePage from "../src/app/create/page";
import { CreateFlow } from "../src/components/create/CreateFlow";
import { CREATE_WILL_SHOW } from "../src/lib/create/copy";
import { chainlinkOption, pythOption } from "../src/lib/create/price";
import { FACTORY, makeMarket, RESOLVER, USDC } from "./fixtures";
import { renderWithProviders } from "./render";

// The create flow's steps against mocked reads: the hooks are replaced, so nothing touches a network.

type QueryState = { data?: unknown; error?: boolean };
const NOW = 1_791_090_000;
const INTERVAL = 8_571n;
const HEAD = { number: 68_036_598n, timestamp: NOW };
const RULE = { minPool: USDC(500), minStakers: 10, minChanceBps: 300, maxChanceBps: 9_700 };
const CAPS = { poolCap: USDC(5_000), walletCap: USDC(1_000), minStake: USDC(1), creatorMinStake: USDC(5) };
const EXISTING = "0x2A44B99014cF73065BFb89197a08DE09D18d3982" as Address;

const state = vi.hoisted(() => ({
  deployed: true,
  config: {} as { data?: unknown; error?: boolean },
  clock: {} as { data?: unknown; error?: boolean },
  perp: {} as { data?: unknown; error?: boolean },
  challenge: {} as { data?: unknown; error?: boolean },
  feeds: {} as { data?: unknown; error?: boolean },
  spot: {} as { data?: unknown; error?: boolean },
  fast: {} as { data?: unknown; error?: boolean },
  preview: {} as { data?: unknown; error?: boolean },
  existing: {} as { data?: unknown; error?: boolean },
  usdc: {} as { data?: unknown; error?: boolean },
  markets: {} as { data?: unknown; error?: boolean },
}));

const query = (q: QueryState) => ({
  isPending: !q.error && q.data === undefined,
  isError: Boolean(q.error),
  isFetching: false,
  data: q.data,
  refetch: vi.fn(),
});

vi.mock("@/lib/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/config")>();
  // A fixed two-stack deployment: new markets go to the `hunch` stack, on Hunch Book's own order book.
  const own = "0x00000000000000000000000000000000000000f2";
  const withFactory = {
    ...actual.appDeployment,
    hunchBook: { ...actual.appDeployment.hunchBook, factory: "0x00000000000000000000000000000000000000f1" },
    stacks: {
      hunch: {
        factory: own,
        vault: own,
        router: own,
        graduator: own,
        venue: { kind: "hunch", bookFactory: own, marginAccount: own, bookImplementation: own },
      },
    },
    defaultStack: "hunch",
  };
  const without = { ...actual.appDeployment, hunchBook: {}, stacks: undefined };
  return {
    ...actual,
    get appDeployment() {
      return state.deployed ? withFactory : without;
    },
  };
});

vi.mock("@/lib/create/hooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/create/hooks")>();
  return {
    ...actual,
    useCreateConfig: () => query(state.config),
    useCreateClock: () => query(state.clock),
    usePerpContext: () => query(state.perp),
    useChallengeBlocks: () => query(state.challenge),
    usePriceFeeds: () => query(state.feeds),
    useSpotPrice: () => query(state.spot),
    useFastBlockTime: () => query(state.fast),
    usePreview: () => ({ ...query(state.preview), settling: false }),
    useExistingMarket: () => ({
      ...query(state.existing),
      key: "0x306f22ab64e0f9fd35eae199a64c97ac194e1beec2b52fa40fc14b8fd15f683f",
    }),
  };
});

vi.mock("@/lib/hooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/hooks")>();
  return {
    ...actual,
    useNow: () => NOW,
    useUsdcState: () => query(state.usdc),
    useMarkets: () => query(state.markets),
    useTestUsdcFaucet: () => query({}),
  };
});

const config = (templates: number[], over: Record<string, unknown> = {}) => ({
  data: {
    factory: FACTORY,
    vault: "0x00000000000000000000000000000000000000aa",
    usdc: "0x00000000000000000000000000000000000000ab",
    paused: false,
    caps: CAPS,
    templates: Object.fromEntries(templates.map((id) => [id, { resolver: RESOLVER, rule: RULE }])),
    ...over,
  },
});

/** Ten funding events, each charging longs 1,000 raw units more than the last. */
const perpContext = {
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
  interval: INTERVAL,
  anchor: 0n,
  history: {
    interval: INTERVAL,
    lastEvent: HEAD.number,
    samples: Array.from({ length: 80 }, (_, i) => ({
      block: HEAD.number - BigInt(79 - i) * INTERVAL,
      sum: BigInt(i * 100 + (i % 3) * 10),
    })),
  },
};

const sentence =
  "Will MON longs pay more than $0.00001 per MON in funding on Perpl (MON Perp, perp 64) between block 1 and block 2?";
const previewOk = {
  data: {
    window: {
      blockClock: true,
      lock: HEAD.number + 290_000n,
      close: HEAD.number + 580_000n,
      settleDeadline: 1_792_000_000n,
    },
    sentence,
    error: null,
  },
};

beforeEach(() => {
  state.deployed = true;
  state.config = config([1, 2]);
  state.clock = { data: { head: HEAD, pace: { msPerBlock: 300, drift: 0.02, measured: true } } };
  state.perp = { data: perpContext };
  state.challenge = { data: 288_000n };
  state.feeds = {
    data: [
      chainlinkOption("BTC/USD", "0x12C0F44368a02081ce58a936d1C1F606BB301715"),
      pythOption("SOL/USD", "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d"),
    ],
  };
  state.spot = { data: { priceE8: 8_472_106_882_025n, updatedAt: NOW - 3_600 } };
  state.fast = { data: 200 };
  state.preview = previewOk;
  state.existing = { data: null };
  state.usdc = { data: { balance: USDC(100), allowance: 0n } };
  state.markets = { data: { status: "ok", data: { markets: [], total: 0 } } };
});

describe("/create", () => {
  it("says what it will show before the contracts are deployed", async () => {
    state.deployed = false;
    await renderWithProviders(await CreatePage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByRole("heading", { level: 1, name: "Create a market" })).toBeTruthy();
    for (const line of CREATE_WILL_SHOW) expect(screen.getByText(line)).toBeTruthy();
  });

  it("opens on the template named in the address", async () => {
    await renderWithProviders(await CreatePage({ searchParams: Promise.resolve({ template: "1" }) }));
    expect(screen.getByRole("radio", { name: "Perpl funding over a window" })).toHaveProperty(
      "checked",
      true,
    );
    expect(screen.getByRole("heading", { name: "Step 2: parameters" })).toBeTruthy();
  });
});

describe("step 1: pick a template", () => {
  it("shows a loading state, then an error with a retry", async () => {
    state.config = {};
    const { unmount } = await renderWithProviders(<CreateFlow initialTemplate={null} />);
    expect(screen.getByRole("status").textContent).toContain("Reading the factory");
    unmount();
    state.config = { error: true };
    await renderWithProviders(<CreateFlow initialTemplate={null} />);
    expect(screen.getByRole("heading", { name: "Could not read the factory" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("offers only the templates the factory has registered", async () => {
    await renderWithProviders(<CreateFlow initialTemplate={null} />);
    const group = screen.getByRole("group", { name: "Template" });
    const names = within(group)
      .getAllByRole("radio")
      .map((r) => r.getAttribute("aria-labelledby"));
    expect(names).toEqual(["template-1-title", "template-2-title"]);
    expect(screen.queryByText("Parlay")).toBeNull();
    expect(screen.getByText(/Will MON longs pay more than \$0.00001 per MON/)).toBeTruthy();
    expect(screen.getAllByText("Source").length).toBe(2);
    const current = screen.getByRole("listitem", { current: "step" });
    expect(current.textContent).toContain("Template");
  });

  it("says so when nothing is registered, and when creation is paused", async () => {
    state.config = config([]);
    const { unmount } = await renderWithProviders(<CreateFlow initialTemplate={null} />);
    expect(screen.getByRole("heading", { name: "No templates are registered yet" })).toBeTruthy();
    unmount();
    state.config = config([1], { paused: true });
    await renderWithProviders(<CreateFlow initialTemplate={1} />);
    expect(screen.getAllByText("Creation is paused").length).toBeGreaterThan(0);
  });
});

describe("step 2 and the preview: Perpl funding", () => {
  it("shows recent funding, fills a balanced threshold and converts times to blocks", async () => {
    await renderWithProviders(<CreateFlow initialTemplate={null} />);
    fireEvent.click(screen.getByRole("radio", { name: "Perpl funding over a window" }));
    expect(screen.getByRole("heading", { name: "Step 2: parameters" })).toBeTruthy();
    expect(screen.getByText("Recent funding on MON Perp")).toBeTruthy();
    const threshold = screen.getByLabelText(/Threshold: funding paid by longs/) as HTMLInputElement;
    await waitFor(() => expect(threshold.value).not.toBe(""));
    expect(screen.getByText(/in Perpl's raw units/)).toBeTruthy();
    expect(screen.getAllByText(/^Block \d/).length).toBeGreaterThan(0);
    expect(screen.getByText(/funding events? in the window/)).toBeTruthy();
    expect(screen.getAllByText(/of \d+ cases/).length).toBeGreaterThan(0);
  });

  it("shows the resolver's own rule, the window, graduation, limits, fees and void terms", async () => {
    await renderWithProviders(<CreateFlow initialTemplate={1} />);
    await waitFor(() => expect(screen.getByText(sentence)).toBeTruthy());
    const preview = screen.getByRole("region", { name: "Preview" });
    expect(within(preview).getByText("Lock")).toBeTruthy();
    expect(within(preview).getByText("Settlement deadline")).toBeTruthy();
    expect(within(preview).getByText("A pool of at least 500.00 USDC")).toBeTruthy();
    expect(within(preview).getByText("5,000.00 USDC")).toBeTruthy();
    expect(within(preview).getByText(/2% of their winnings/)).toBeTruthy();
    expect(within(preview).getByText(/Perpl upgrades its Exchange/)).toBeTruthy();
    expect(screen.getByRole("listitem", { current: "step" }).textContent).toContain("First stake");
  });

  it("shows the resolver's refusal in plain words", async () => {
    state.preview = {
      data: {
        window: null,
        sentence,
        error: "Perpl has paused this perp, so it cannot be used for a new market.",
      },
    };
    await renderWithProviders(<CreateFlow initialTemplate={1} />);
    await waitFor(() => expect(screen.getByText("The resolver would refuse this market")).toBeTruthy());
    expect(
      screen.getByText("Perpl has paused this perp, so it cannot be used for a new market."),
    ).toBeTruthy();
    expect(screen.getByRole("listitem", { current: "step" }).textContent).toContain("Parameters");
  });

  it("links to the market that already exists instead of offering a copy", async () => {
    state.existing = { data: EXISTING };
    await renderWithProviders(<CreateFlow initialTemplate={1} />, { connected: true });
    await waitFor(() => expect(screen.getByText("This exact market already exists")).toBeTruthy());
    expect(screen.getByRole("link", { name: /Open the market/ }).getAttribute("href")).toBe(`/m/${EXISTING}`);
    expect(screen.getByRole("button", { name: "This market already exists" })).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("asks for a one-interval window and a plain threshold", async () => {
    await renderWithProviders(<CreateFlow initialTemplate={1} />);
    const threshold = screen.getByLabelText(/Threshold: funding paid by longs/);
    fireEvent.change(threshold, { target: { value: "0.000000001" } });
    expect(await screen.findByText(/at most 8 decimal places/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Use 0: longs pay on net" }));
    expect((threshold as HTMLInputElement).value).toBe("0");
  });

  it("labels template 4 as a single-event spike with a challenge period", async () => {
    state.config = config([4]);
    await renderWithProviders(<CreateFlow initialTemplate={4} />);
    expect(screen.getByLabelText(/what one funding event charges longs/)).toBeTruthy();
    await waitFor(() => expect(screen.getByText("Challenge period ends")).toBeTruthy());
    expect(screen.getByText(/one honest prover/)).toBeTruthy();
  });
});

describe("step 2: price templates", () => {
  it("prefills the strike from the feed's current price", async () => {
    state.config = config([2]);
    await renderWithProviders(<CreateFlow initialTemplate={2} />);
    expect(screen.getByText(/BTC\/USD now:/)).toBeTruthy();
    const strike = screen.getByLabelText("Price level (strike), in USD") as HTMLInputElement;
    await waitFor(() => expect(strike.value).toBe("84700"));
    expect(screen.getByRole("button", { name: /Use the current price: \$84,700.00/ })).toBeTruthy();
    expect(screen.getByText(/update about once a day/)).toBeTruthy();
  });

  it("asks for two bounds on template 5 and a direction on template 3", async () => {
    state.config = config([3, 5]);
    const { unmount } = await renderWithProviders(<CreateFlow initialTemplate={5} />);
    const lower = screen.getByLabelText("Bottom of the range, in USD") as HTMLInputElement;
    await waitFor(() => expect(lower.value).toBe("83000"));
    expect((screen.getByLabelText("Top of the range, in USD") as HTMLInputElement).value).toBe("86400");
    unmount();
    await renderWithProviders(<CreateFlow initialTemplate={3} />);
    expect(screen.getByRole("group", { name: "Direction" })).toBeTruthy();
    const level = screen.getByLabelText("Price level, in USD") as HTMLInputElement;
    await waitFor(() => expect(level.value).toBe("89000"));
  });

  it("shows a retry when the feeds cannot be read", async () => {
    state.config = config([2]);
    state.feeds = { error: true };
    await renderWithProviders(<CreateFlow initialTemplate={2} />);
    expect(screen.getByText("Could not read the price feeds")).toBeTruthy();
  });
});

describe("step 2: parlay", () => {
  it("lists open markets of the stack new markets go to as legs, and caps the choice at five", async () => {
    state.config = config([6]);
    const leg = (i: number, over: Partial<ReturnType<typeof makeMarket>> = {}) =>
      makeMarket({
        address: `0x${(0xa0 + i).toString(16).padStart(40, "0")}` as Address,
        marketId: BigInt(i),
        description: `Leg question ${i}`,
        phase: Phase.Pool,
        window: {
          blockClock: false,
          lock: BigInt(NOW + 86_400 + i),
          close: BigInt(NOW + 172_800),
          settleDeadline: 0n,
        },
        stack: "hunch",
        kuruVersion: 1,
        venue: "hunch",
        ...over,
      });
    const legs = [1, 2, 3, 4, 5, 6].map((i) => leg(i));
    // An open market of the primary (Kuru) stack: the new parlay's resolver would refuse it as a leg.
    const elsewhere = leg(7, { stack: undefined, kuruVersion: undefined, venue: undefined });
    state.markets = { data: { status: "ok", data: { markets: [...legs, elsewhere], total: 7 } } };
    await renderWithProviders(<CreateFlow initialTemplate={6} />);
    expect(screen.getByText("Leg question 1")).toBeTruthy();
    expect(screen.queryByText("Leg question 7")).toBeNull();
    const boxes = screen.getAllByRole("checkbox");
    for (const box of boxes.slice(0, 5)) fireEvent.click(box);
    expect(screen.getByText("Legs: 5 of 2 to 5 chosen")).toBeTruthy();
    expect(boxes[5]).toHaveProperty("disabled", true);
    const lock = screen.getByLabelText("Lock: when staking stops") as HTMLInputElement;
    await waitFor(() => expect(lock.value).not.toBe(""));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search open markets" }), {
      target: { value: "#6" },
    });
    expect(screen.queryByText("Leg question 1")).toBeNull();
    expect(screen.getByText("Leg question 6")).toBeTruthy();
  });
});

describe("the preview names the venue of the stack new markets go to", () => {
  it("says graduation opens Hunch Book's own order book, with no third party", async () => {
    state.config = config([1], { stack: "hunch", venue: "hunch", kuruVersion: 1 });
    state.preview = previewOk;
    await renderWithProviders(<CreateFlow initialTemplate={1} />);
    expect(
      await screen.findByText(
        /The same transaction opens its own YES\/USDC book on Hunch Book's onchain order book, so graduation waits on no third party/,
      ),
    ).toBeTruthy();
  });

  it("says a Kuru stack's market graduates to its own Kuru order book", async () => {
    state.config = config([1], { stack: "primary", venue: "kuru", kuruVersion: 1 });
    state.preview = previewOk;
    await renderWithProviders(<CreateFlow initialTemplate={1} />);
    expect(
      await screen.findByText(/tokens on its own Kuru order book\. If not, it settles as a pool\./),
    ).toBeTruthy();
  });
});

describe("step 3: first stake", () => {
  it("asks to connect a wallet first", async () => {
    await renderWithProviders(<CreateFlow initialTemplate={1} />);
    expect(screen.getByText("Connect a browser wallet to make the first stake.")).toBeTruthy();
  });

  it("checks the amount, then approves the vault, then creates", async () => {
    await renderWithProviders(<CreateFlow initialTemplate={1} />, { connected: true });
    const amount = screen.getByLabelText("Amount");
    expect(screen.getByText("Wallet 100.00 USDC")).toBeTruthy();
    fireEvent.change(amount, { target: { value: "4" } });
    expect(await screen.findByText("The first stake must be at least 5.00 USDC.")).toBeTruthy();
    fireEvent.change(amount, { target: { value: "25" } });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Step 1 of 2: approve USDC" })).toBeTruthy(),
    );
  });

  it("offers the create transaction once the vault is approved, on the chosen side", async () => {
    state.usdc = { data: { balance: USDC(100), allowance: USDC(1_000_000) } };
    await renderWithProviders(<CreateFlow initialTemplate={1} />, { connected: true });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "25" } });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Create the market with 25.00 USDC on YES" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("radio", { name: "NO" }));
    expect(screen.getByRole("button", { name: "Create the market with 25.00 USDC on NO" })).toBeTruthy();
  });

  it("will not create while the resolver refuses the parameters", async () => {
    state.usdc = { data: { balance: USDC(100), allowance: USDC(1_000_000) } };
    state.preview = { data: { window: null, sentence: null, error: "The lock time has already passed." } };
    await renderWithProviders(<CreateFlow initialTemplate={1} />, { connected: true });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "25" } });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Fix the parameters first" })).toBeTruthy(),
    );
  });
});

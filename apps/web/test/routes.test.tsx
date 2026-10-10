import { Outcome, Phase } from "@hunch-book/shared";
import { fireEvent, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import CreatorPage from "../src/app/creator/[address]/page";
import ErrorPage from "../src/app/error";
import MarketPage from "../src/app/m/[address]/page";
import MarketsPage from "../src/app/markets/page";
import NotFound from "../src/app/not-found";
import Home from "../src/app/page";
import PortfolioPage from "../src/app/portfolio/page";
import ProofPage from "../src/app/proof/page";
import TapePage from "../src/app/tape/page";
import VerifyPage from "../src/app/verify/[address]/page";
import { Footer } from "../src/components/layout/Footer";
import { Header } from "../src/components/layout/Header";
import { FACTORY, MARKET, makeEntry, makeMarket, USDC, USER } from "./fixtures";
import { renderWithProviders } from "./render";

// Every route renders against mocked chain data: the hooks are replaced, and the deployment is
// switched between "not deployed" and "deployed" per test.

type QueryState = { data?: unknown; error?: boolean };
const state = vi.hoisted(() => ({
  deployed: false,
  markets: {} as QueryState,
  market: {} as QueryState,
  portfolio: {} as QueryState,
  position: {} as QueryState,
  tape: {} as QueryState,
  proof: {} as QueryState,
  creator: {} as QueryState,
  creatorFees: {} as QueryState,
}));

vi.mock("@/lib/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/config")>();
  // One stack each way, so the routes do not move when deployments/*.json gains a stack.
  const withFactory = {
    ...actual.appDeployment,
    stacks: undefined,
    hunchBook: {
      factory: "0x00000000000000000000000000000000000000f1",
      vault: "0x00000000000000000000000000000000000000aa",
    },
  };
  const without = { ...actual.appDeployment, hunchBook: {}, stacks: undefined };
  return {
    ...actual,
    get appDeployment() {
      return state.deployed ? withFactory : without;
    },
  };
});

// The landing page reads the chain on the server; here it gets the not-deployed answer without a network call.
vi.mock("@/lib/chain/landing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/chain/landing")>();
  return {
    ...actual,
    readLandingSnapshot: vi.fn(async () =>
      state.deployed ? { status: "error" } : { status: "not-deployed" },
    ),
  };
});

vi.mock("@/lib/hooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/hooks")>();
  const query = (q: QueryState) => ({
    isPending: !q.error && q.data === undefined,
    isError: Boolean(q.error),
    data: q.data,
    refetch: vi.fn(),
  });
  return {
    ...actual,
    useMarkets: () => query(state.markets),
    useMarket: () => query(state.market),
    usePortfolio: () => query(state.portfolio),
    useUserPosition: () => query(state.position),
    useProtocolAddresses: () => query({}),
    useUsdcState: () => query({}),
    useChainClock: () => null,
    useNow: () => 1_799_000_000,
    // The verifier's own reads stay idle here: no test talks to a real RPC.
    useVerification: () => query({}),
    useSettlementTx: () => query({}),
    useBook: () => query({}),
    useWalletBalances: () => query({}),
    useMonBalance: () => query({}),
    useSettlePlan: () => query({}),
    useTestUsdcFaucet: () => query({}),
  };
});

// The tape polls the chain or the indexer; here it gets fixed data.
vi.mock("@/lib/tape/hooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/tape/hooks")>();
  return {
    ...actual,
    useTape: () => ({
      isPending: !state.tape.error && state.tape.data === undefined,
      isError: Boolean(state.tape.error),
      data: state.tape.data,
      refetch: vi.fn(),
      loadOlder: vi.fn(),
      extending: false,
    }),
  };
});

// The proof page reads the indexer or the chain; here it gets fixed data.
vi.mock("@/lib/proof/hooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/proof/hooks")>();
  return {
    ...actual,
    useProof: () => ({
      isPending: !state.proof.error && state.proof.data === undefined,
      isError: Boolean(state.proof.error),
      data: state.proof.data,
      dataUpdatedAt: 1_799_000_000_000,
      refetch: vi.fn(),
    }),
    useChainTimings: () => ({ started: false, start: vi.fn(), isPending: true, isError: false }),
  };
});

// The creator page reads the indexer or the chain, and the vault's fees; here they are fixed.
vi.mock("@/lib/creator/hooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/creator/hooks")>();
  const fixed = (q: QueryState) => ({
    isPending: !q.error && q.data === undefined,
    isError: Boolean(q.error),
    data: q.data,
    refetch: vi.fn(),
  });
  return {
    ...actual,
    useCreator: () => fixed(state.creator),
    useCreatorFees: () => fixed(state.creatorFees),
  };
});

const ok = <T,>(data: T) => ({ data: { status: "ok", data } });
const params = (address: string) => ({ params: Promise.resolve({ address }) });
const noSearch = { searchParams: Promise.resolve({}) };

beforeEach(() => {
  state.deployed = false;
  state.markets = {};
  state.market = {};
  state.portfolio = {};
  state.position = {};
  state.tape = {};
  state.proof = {};
  state.creator = {};
  state.creatorFees = {};
});

describe("with no contracts deployed", () => {
  it("/ is the landing page, and says plainly that nothing is deployed", async () => {
    await renderWithProviders(await Home());
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "Start as a pool. Graduate to a book. Settle from the chain.",
    );
    expect(screen.getByText("Monad testnet: not deployed yet")).toBeTruthy();
    expect(screen.getByText("The contracts are not deployed on Monad testnet yet.")).toBeTruthy();
    expect(screen.getByText("Contracts are not deployed on Monad testnet yet.")).toBeTruthy();
    expect(screen.getAllByRole("link", { name: "Browse markets" })[0]?.getAttribute("href")).toBe("/markets");
    // With nothing deployed, no stage claims to be live.
    expect(screen.getAllByText("Building")).toHaveLength(3);
    expect(screen.queryByText(/^Live on/)).toBeNull();
  });

  it("/markets explains what will appear", async () => {
    await renderWithProviders(await MarketsPage(noSearch));
    expect(screen.getByRole("heading", { name: "Contracts not deployed on Monad testnet yet" })).toBeTruthy();
    expect(screen.getByText(/Every market from the factory/)).toBeTruthy();
  });

  it("/m/[address] shows the not-deployed state for a well-formed address", async () => {
    await renderWithProviders(await MarketPage(params("0x0000000000000000000000000000000000000001")));
    expect(screen.getByRole("heading", { name: /Contracts not deployed/ })).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toBeTruthy();
  });

  it("/m/[address] is a 404 for anything that is not an address", async () => {
    await expect(MarketPage(params("not-an-address"))).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("/portfolio and /verify show the not-deployed state", async () => {
    await renderWithProviders(<PortfolioPage />);
    expect(screen.getByText(/YES and NO tokens you can claim/)).toBeTruthy();
    await renderWithProviders(await VerifyPage(params("0x0000000000000000000000000000000000000001")));
    expect(screen.getAllByRole("heading", { name: /Contracts not deployed/ }).length).toBe(2);
  });

  it("/proof says what it will measure until the contracts are deployed", async () => {
    await renderWithProviders(<ProofPage />);
    expect(screen.getByRole("heading", { name: "Contracts not deployed on Monad testnet yet" })).toBeTruthy();
    expect(screen.getByText(/Distinct wallets that staked or traded/)).toBeTruthy();
    expect(screen.getByText(/fills against Hunch's maker and fills between other parties/)).toBeTruthy();
  });

  it("the header offers a wallet and the main links, and the footer says the factory is not deployed", async () => {
    await renderWithProviders(
      <>
        <Header />
        <Footer />
      </>,
    );
    const header = within(screen.getByRole("banner"));
    expect(header.getByRole("link", { name: "Hunch Book on testnet, home" }).getAttribute("href")).toBe("/");
    const nav = within(header.getByRole("navigation", { name: "Main" }));
    // Hedge (the trader's weekly job) and Status (is it solvent now?) sit in the bar; the swipe feed is
    // for phones, so only the mobile menu lists it.
    expect(nav.getAllByRole("link").map((a) => a.textContent)).toEqual([
      "Markets",
      "Create",
      "Hedge",
      "Portfolio",
      "Proof",
      "Tape",
      "Status",
      "Docs↗",
    ]);
    expect(nav.queryByRole("link", { name: "Feed" })).toBeNull();
    expect(nav.getByRole("link", { name: "Markets" }).getAttribute("aria-current")).toBe("page");
    expect(nav.getByRole("link", { name: "Create" }).getAttribute("href")).toBe("/create");
    expect(nav.getByRole("link", { name: "Docs" }).getAttribute("href")).toMatch(/docs\/PROTOCOL\.md$/);
    expect(nav.getByRole("link", { name: "Docs" }).getAttribute("target")).toBe("_blank");

    const footer = within(screen.getByRole("contentinfo"));
    expect(footer.getByText("Factory: not deployed yet")).toBeTruthy();
    expect(footer.getByText("Monad testnet: live")).toBeTruthy();
    expect(footer.getByText("Monad mainnet: planned")).toBeTruthy();
    expect(
      footer.getByText(
        "Built on Monad, trades on onchain order books (Hunch Book's own and Kuru's), settles from Perpl and Chainlink.",
      ),
    ).toBeTruthy();
    expect(footer.getByRole("link", { name: "MIT licensed" }).getAttribute("href")).toMatch(/LICENSE$/);

    fireEvent.click(header.getByRole("button", { name: "Connect wallet" }));
    expect(screen.getByText("Browser wallets")).toBeTruthy();
  });

  it("the mobile menu opens a sheet that keeps focus inside and closes on Escape", async () => {
    await renderWithProviders(<Header />);
    const menu = screen.getByRole("button", { name: "Menu" });
    expect(menu.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(menu);
    const dialog = screen.getByRole("dialog", { name: "Menu" });
    expect(menu.getAttribute("aria-expanded")).toBe("true");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    const sheet = within(dialog);
    expect(sheet.getByRole("link", { name: "Markets" }).getAttribute("aria-current")).toBe("page");
    expect(
      Array.from(sheet.getByRole("navigation", { name: "Main" }).querySelectorAll("a"), (a) =>
        a.textContent?.replace(/[→↗]/g, ""),
      ),
    ).toEqual(["Markets", "Feed", "Create", "Hedge", "Portfolio", "Proof", "Tape", "Status", "Docs"]);
    expect(sheet.getByText("Monad testnet: not deployed yet")).toBeTruthy();
    // Focus starts inside the sheet, and Tab from the last item wraps to the first.
    const close = sheet.getByRole("button", { name: "Close" });
    expect(document.activeElement).toBe(close);
    const items = dialog.querySelectorAll<HTMLElement>("a[href], button");
    const last = items[items.length - 1] as HTMLElement;
    last.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
    expect(document.body.style.overflow).toBe("hidden");

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(menu);
    expect(document.body.style.overflow).toBe("");

    // The close button and a tap outside close it too.
    fireEvent.click(menu);
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(menu);
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("the 404 and error boundaries speak plainly", async () => {
    await renderWithProviders(<NotFound />);
    expect(screen.getByRole("heading", { level: 1, name: "This page does not exist" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Browse markets" }).getAttribute("href")).toBe("/markets");
    expect(screen.getByRole("link", { name: "Go home" }).getAttribute("href")).toBe("/");
    const retry = vi.fn();
    await renderWithProviders(
      <ErrorPage error={Object.assign(new Error("boom"), { digest: "abc" })} retry={retry} />,
    );
    expect(screen.getByText(/not with your funds/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalled();
  });
});

describe("with contracts deployed", () => {
  beforeEach(() => {
    state.deployed = true;
  });

  const pool = makeMarket();
  const trading = makeMarket({
    address: "0x00000000000000000000000000000000000000a2",
    marketId: 8n,
    phase: Phase.Graduated,
    graduated: true,
    book: "0x00000000000000000000000000000000000000bb",
    quote: { bid: 600_000_000_000_000_000n, ask: 640_000_000_000_000_000n },
    description: "Will BTC longs pay shorts on net this week?",
  });

  it("/markets lists markets with chance, pool and countdown, and filters by phase", async () => {
    state.markets = ok({ markets: [pool, trading], total: 2 });
    await renderWithProviders(await MarketsPage(noSearch));
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(within(items[0] as HTMLElement).getByText("75.0%")).toBeTruthy();
    expect(within(items[0] as HTMLElement).getByText(/Locks in 11d 13h/)).toBeTruthy();
    expect(within(items[0] as HTMLElement).getByText(/Pool 400.00 USDC · 4 stakers/)).toBeTruthy();
    expect(within(items[1] as HTMLElement).getByText("62.0%")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Trading/ }).textContent).toBe("Trading1");

    await renderWithProviders(await MarketsPage({ searchParams: Promise.resolve({ phase: "trading" }) }));
    const lists = screen.getAllByRole("list");
    expect(within(lists[lists.length - 1] as HTMLElement).getAllByRole("listitem")).toHaveLength(1);
  });

  it("/markets has empty, loading and error states", async () => {
    state.markets = ok({ markets: [], total: 0 });
    const empty = await renderWithProviders(await MarketsPage(noSearch));
    expect(screen.getByRole("heading", { name: "Nobody has created a market yet" })).toBeTruthy();
    empty.unmount();

    state.markets = {};
    const loading = await renderWithProviders(await MarketsPage(noSearch));
    expect(screen.getByRole("status").textContent).toContain("Loading markets");
    loading.unmount();

    state.markets = { error: true };
    await renderWithProviders(await MarketsPage(noSearch));
    expect(screen.getByRole("heading", { name: "Could not load markets" })).toBeTruthy();
  });

  it("/m/[address] shows a pool market and a working stake preview", async () => {
    state.market = ok(pool);
    await renderWithProviders(await MarketPage(params(MARKET)));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(pool.description);
    for (const title of [
      "Implied chance",
      "Graduation rule",
      "Timeline",
      "Source",
      "If there is no answer",
    ]) {
      expect(screen.getByRole("heading", { name: title })).toBeTruthy();
    }
    // Testnet deployments list no Chainlink feeds, so the feed is shown by address, not by name.
    expect(screen.getByText("Chainlink price feed")).toBeTruthy();
    expect(screen.getByText(/refunds every stake in full/)).toBeTruthy();
    expect(screen.getByText("Connect a browser wallet to stake.")).toBeTruthy();

    fireEvent.change(screen.getByLabelText(/Amount/), { target: { value: "100" } });
    // 100 on YES into 400 YES / 100 NO: gross 25, 2% fee 0.50, paid 124.50.
    expect(screen.getByText("If YES wins you get")).toBeTruthy();
    expect(screen.getByText("124.50 USDC")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^NO/ }));
    expect(screen.getByText("If NO wins you get")).toBeTruthy();
  });

  it("/m/[address] shows a graduated market's book and a trade ticket that waits for a wallet", async () => {
    state.market = ok(trading);
    await renderWithProviders(await MarketPage(params(trading.address)));
    expect(screen.getByText("Best bid (Kuru)")).toBeTruthy();
    expect(screen.getByText("0.600 USDC")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Order book" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Trade" }).getAttribute("aria-selected")).toBe("true");
    expect((screen.getByRole("button", { name: "Buy YES" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Connect a browser wallet to trade.")).toBeTruthy();
  });

  it("/m/[address] says when an address is not a market", async () => {
    state.market = { data: { status: "not-market" } };
    await renderWithProviders(await MarketPage(params("0x1111111111111111111111111111111111111111")));
    expect(screen.getByRole("heading", { name: "This address is not a Hunch Book market" })).toBeTruthy();
  });

  it("/portfolio asks for a wallet, then lists positions", async () => {
    const first = await renderWithProviders(<PortfolioPage />);
    expect(screen.getByRole("heading", { name: "Connect a wallet to see your positions" })).toBeTruthy();
    first.unmount();

    state.portfolio = ok([makeEntry({ claimablePool: { paid: USDC(40), fee: USDC(0.5) } })]);
    await renderWithProviders(<PortfolioPage />, { connected: true });
    expect(screen.getByText("Staked YES")).toBeTruthy();
    expect(screen.getAllByText("25.00").length).toBeGreaterThan(0);
    expect(screen.getAllByText("40.00").length).toBeGreaterThan(0);
  });

  it("/portfolio works out profit and loss from chain state, with a CSV of the history", async () => {
    state.portfolio = ok([makeEntry()]);
    await renderWithProviders(<PortfolioPage />, { connected: true });
    expect(await screen.findByText("Rebuilt from chain state")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Profit and loss" })).toBeTruthy();
    expect(screen.getAllByText("Live from chain").length).toBeGreaterThan(0);
    // An open pool has no price yet.
    expect(screen.getByText("1 without a price left out")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Download history (CSV)" })).toBeTruthy();
  });

  it("/portfolio says when the wallet has nothing", async () => {
    state.portfolio = ok([]);
    await renderWithProviders(<PortfolioPage />, { connected: true });
    expect(screen.getByRole("heading", { name: /No positions for/ })).toBeTruthy();
  });

  it("/verify shows what settled a market, and waits for one that has not settled", async () => {
    state.market = ok(
      makeMarket({ phase: Phase.Settled, outcome: Outcome.Yes, evidenceHash: `0x${"ab".repeat(32)}` }),
    );
    const settled = await renderWithProviders(await VerifyPage(params(MARKET)));
    expect(screen.getByRole("heading", { name: "What the market stored" })).toBeTruthy();
    expect(screen.getByText("YES")).toBeTruthy();
    expect(screen.getByText(`0x${"ab".repeat(32)}`)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Re-run this read from your browser" })).toBeTruthy();
    settled.unmount();

    state.market = ok(pool);
    await renderWithProviders(await VerifyPage(params(MARKET)));
    expect(screen.getByText("Not settled yet")).toBeTruthy();
  });

  it("the footer links the factory once deployed", async () => {
    await renderWithProviders(<Footer />);
    expect(screen.getByTitle(FACTORY)).toBeTruthy();
    expect(screen.getByRole("link", { name: /^Factory/ }).getAttribute("href")).toMatch(
      new RegExp(`${FACTORY}$`),
    );
  });

  it("/tape lists fills live from chain, with our maker labelled and the blocks it read", async () => {
    state.markets = ok({ markets: [trading], total: 1 });
    state.tape = {
      data: {
        source: "chain",
        data: {
          fills: [
            {
              id: "68000000-1",
              book: "0x00000000000000000000000000000000000000bb",
              market: trading.address,
              marketNumber: 8,
              question: trading.description,
              block: 68_000_000n,
              logIndex: 1,
              time: 1_798_999_990,
              tx: `0x${"cd".repeat(32)}`,
              priceE6: 620_000n,
              size: USDC(10),
              notional: USDC(6.2),
              takerBuysYes: true,
              maker: "0x0f1156Eb25DBebee5386EC80F1EB0B85C7dD232A",
              makerKnown: true,
              trader: "0x1111111111111111111111111111111111111111",
              viaRouter: true,
              makerIsOurMaker: true,
              makerIsOurs: true,
              traderIsOurs: false,
            },
          ],
          window: { from: 67_999_001n, to: 68_000_000n },
          books: 1,
        },
      },
    };
    await renderWithProviders(await TapePage(noSearch));
    expect(screen.getByRole("heading", { level: 1, name: "Trade tape" })).toBeTruthy();
    expect(screen.getByText("Live from chain")).toBeTruthy();
    expect(screen.getByText("Hunch maker (ours)")).toBeTruthy();
    expect(screen.getByText("0.620")).toBeTruthy();
    expect(screen.getByText(/Read from blocks 67,999,001 to 68,000,000/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Look further back" })).toBeTruthy();
  });

  const proofBase = {
    markets: { created: 12, graduated: 7, settled: 4, voided: 1, pools: 4, trading: 3, covered: 12 },
    settlements: [],
    perMarket: [
      {
        market: trading.address,
        number: 8,
        question: null,
        stage: "Trading",
        owed: USDC(400),
        pool: 0n,
        sets: USDC(400),
        collateralIn: USDC(400),
        collateralOut: 0n,
        fees: 0n,
        margin: 0n,
        yesSupply: USDC(400),
        noSupply: USDC(400),
        backed: true,
      },
    ],
    daily: [],
    negative: [],
    vault: { balance: USDC(400.5), obligations: USDC(400), margin: USDC(0.5) },
    liveVault: { balance: USDC(400.5), obligations: USDC(400), margin: USDC(0.5) },
  };

  it("/proof shows every figure from the indexer, with our maker's share apart and sources linked", async () => {
    state.proof = {
      data: {
        source: "indexer",
        indexedBlock: 68_000_000n,
        data: {
          ...proofBase,
          listed: null,
          wallets: { total: 40, ours: 13, external: 27, stakers: 35, traders: 9 },
          trades: {
            fills: 200,
            fillsOurMaker: 150,
            fillsOurTrader: 10,
            fillsBetweenOthers: 45,
            volume: USDC(50_000),
            volumeOurMaker: USDC(40_000),
            volumeBetweenOthers: USDC(9_000),
            ourMakerShareBps: 7_500,
            ourMakerVolumeShareBps: 8_000,
            routerTrades: 60,
            routerVolume: USDC(20_000),
          },
          timing: {
            avgSettleSeconds: 42n,
            settlementsTimed: 3,
            avgSettleBlocks: 150n,
            settlementsBlockClock: 1,
            earlySettlements: 1,
            avgFirstRedemptionSeconds: 600n,
            marketsRedeemed: 4,
          },
        },
      },
    };
    await renderWithProviders(<ProofPage />);
    expect(screen.getByText("From the indexer")).toBeTruthy();
    expect(screen.getByText("indexed to block 68,000,000")).toBeTruthy();
    expect(screen.getByText("75.0%")).toBeTruthy();
    expect(screen.getByText("Fills between other parties")).toBeTruthy();
    expect(screen.getByText("Against our maker (ours)")).toBeTruthy();
    expect(screen.getByText("42s")).toBeTruthy();
    expect(screen.getByText("10m 0s")).toBeTruthy();
    expect(screen.getByRole("link", { name: /indexer: ProtocolStats.wallets/ }).getAttribute("href")).toMatch(
      /lib\/indexer\/queries\.ts$/,
    );
    expect(screen.getByText("Maker bot (ours)")).toBeTruthy();
    expect(screen.queryByText(/needs the indexer/)).toBeNull();
  });

  it("/proof falls back to the chain and says what needs the indexer", async () => {
    state.proof = {
      data: {
        source: "chain",
        fallback: "The indexer did not answer, so this reads the chain directly.",
        data: { ...proofBase, listed: [], wallets: null, trades: null, timing: null },
      },
    };
    await renderWithProviders(<ProofPage />);
    expect(screen.getByText("Live from chain")).toBeTruthy();
    expect(screen.getByText("The indexer did not answer, so this reads the chain directly.")).toBeTruthy();
    expect(screen.getByText("Distinct wallets that staked or traded: needs the indexer")).toBeTruthy();
    expect(screen.getByText("All-time fills, volume and our maker's share: needs the indexer")).toBeTruthy();
    expect(screen.getByRole("link", { name: /factory.marketCount/ }).getAttribute("href")).toMatch(
      /address\/0x/,
    );
    expect(screen.getByText("sets = YES = NO")).toBeTruthy();
    expect(screen.getAllByText("0.50").length).toBeGreaterThan(0);
  });

  it("/m/[address] links the market's creator page", async () => {
    state.market = ok(pool);
    await renderWithProviders(await MarketPage(params(MARKET)));
    expect(screen.getByRole("link", { name: /Created by/ }).getAttribute("href")).toBe(
      `/creator/${pool.creator}`,
    );
  });

  const creatorData = (over: Record<string, unknown> = {}) => ({
    source: "chain",
    data: {
      creator: USER,
      isOurs: false,
      markets: [
        {
          market: MARKET,
          number: 7,
          question: pool.description,
          stage: "Pool",
          pool: USDC(400),
          stakers: 4,
          volume: null,
          fills: null,
          earned: null,
          createdAt: null,
          createdTx: null,
        },
      ],
      scanned: { covered: 1, total: 1 },
      earned: null,
      withdrawn: null,
      withdrawals: null,
      ...over,
    },
  });

  it("/creator/[address] shows the markets, live fees and a withdraw button for the creator", async () => {
    state.creator = { data: creatorData() };
    state.creatorFees = {
      data: [
        {
          stack: "primary",
          label: "Kuru",
          vault: "0x00000000000000000000000000000000000000aa",
          fees: USDC(1.5),
        },
      ],
    };
    await renderWithProviders(await CreatorPage(params(USER)), { connected: true });
    expect(screen.getByRole("heading", { level: 1 }).textContent).toMatch(/^Creator 0x/);
    expect(screen.getByText("1.50")).toBeTruthy();
    expect(screen.getByRole("link", { name: /vault.creatorFees/ })).toBeTruthy();
    expect(screen.getAllByText("needs the indexer")).toHaveLength(2);
    expect(screen.getByText(/The list of past withdrawals needs the indexer/)).toBeTruthy();
    expect(screen.getByRole("link", { name: /#7/ }).getAttribute("href")).toBe(`/m/${MARKET}`);
    const withdraw = screen.getByRole("button", { name: "Withdraw my fees" }) as HTMLButtonElement;
    expect(withdraw.disabled).toBe(false);
  });

  it("/creator/[address] offers no withdraw button to anyone else, and lists indexed withdrawals", async () => {
    state.creator = {
      data: creatorData({
        creator: "0x00000000000000000000000000000000000000d1",
        scanned: null,
        earned: USDC(2.5),
        withdrawn: USDC(1),
        withdrawals: [{ amount: USDC(1), time: 1_799_000_000, block: 100n, tx: `0x${"77".repeat(32)}` }],
      }),
    };
    state.creatorFees = {
      data: [
        { stack: "primary", label: "Kuru", vault: "0x00000000000000000000000000000000000000aa", fees: 0n },
      ],
    };
    await renderWithProviders(await CreatorPage(params("0x00000000000000000000000000000000000000d1")), {
      connected: true,
    });
    expect(screen.queryByRole("button", { name: "Withdraw my fees" })).toBeNull();
    expect(screen.getByText("2.50")).toBeTruthy();
    expect(screen.getAllByText("1.00").length).toBeGreaterThan(0);
  });

  it("/creator/[address] offers one withdraw per stack vault that owes fees", async () => {
    state.creator = { data: creatorData() };
    state.creatorFees = {
      data: [
        {
          stack: "primary",
          label: "Kuru",
          vault: "0x00000000000000000000000000000000000000aa",
          fees: USDC(1),
        },
        { stack: "kuruV2", label: "Kuru v2", vault: "0x00000000000000000000000000000000000000ad", fees: 0n },
        {
          stack: "hunch",
          label: "Hunch order book",
          vault: "0x00000000000000000000000000000000000000ac",
          fees: USDC(0.5),
        },
      ],
    };
    await renderWithProviders(await CreatorPage(params(USER)), { connected: true });
    // The total adds every vault.
    expect(screen.getByText("1.50")).toBeTruthy();
    expect(screen.getByText(/from 2 vaults: one transaction each/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Withdraw my fees from the Kuru vault" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Withdraw my fees from the Hunch order book vault" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Kuru v2 vault/ })).toBeNull();
    expect(screen.getByRole("link", { name: /on each stack's vault/ }).getAttribute("href")).toBe("/status");
  });

  it("/creator/[address] is a 404 for anything that is not an address", async () => {
    await expect(CreatorPage(params("nope"))).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("/ says when live figures cannot be read, and the menu says the contracts are live", async () => {
    await renderWithProviders(await Home());
    expect(screen.getByText("Could not reach Monad testnet just now.")).toBeTruthy();
    await renderWithProviders(<Header />);
    fireEvent.click(screen.getByRole("button", { name: "Menu" }));
    expect(within(screen.getByRole("dialog")).getByText("Monad testnet: live")).toBeTruthy();
  });
});

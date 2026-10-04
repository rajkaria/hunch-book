import { Outcome, Phase } from "@hunch-book/shared";
import { fireEvent, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ErrorPage from "../src/app/error";
import MarketPage from "../src/app/m/[address]/page";
import MarketsPage from "../src/app/markets/page";
import NotFound from "../src/app/not-found";
import Home from "../src/app/page";
import PortfolioPage from "../src/app/portfolio/page";
import ProofPage from "../src/app/proof/page";
import VerifyPage from "../src/app/verify/[address]/page";
import { Footer } from "../src/components/layout/Footer";
import { Header } from "../src/components/layout/Header";
import { FACTORY, MARKET, makeEntry, makeMarket, USDC } from "./fixtures";
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
}));

vi.mock("@/lib/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/config")>();
  const withFactory = {
    ...actual.appDeployment,
    hunchBook: { factory: "0x00000000000000000000000000000000000000f1" },
  };
  const without = { ...actual.appDeployment, hunchBook: {} };
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
});

describe("with no contracts deployed", () => {
  it("/ is the landing page, and says plainly that nothing is deployed", async () => {
    await renderWithProviders(await Home());
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "Prediction markets that start as pools and graduate to an onchain order book.",
    );
    expect(screen.getByText("Monad testnet: not deployed yet")).toBeTruthy();
    expect(screen.getByText("The contracts are not deployed on Monad testnet yet.")).toBeTruthy();
    expect(screen.getAllByRole("link", { name: "Open markets" })[0]?.getAttribute("href")).toBe("/markets");
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

  it("/proof lists what will be measured, no numbers, and labels our wallets", async () => {
    await renderWithProviders(<ProofPage />);
    expect(screen.getByText("No numbers yet")).toBeTruthy();
    expect(screen.getByText("Maker share")).toBeTruthy();
    expect(screen.getByText("Maker bot (ours)")).toBeTruthy();
    expect(screen.getByText("Keeper (ours)")).toBeTruthy();
  });

  it("the header offers a wallet and the footer says the factory is not deployed", async () => {
    await renderWithProviders(
      <>
        <Header />
        <Footer />
      </>,
    );
    expect(screen.getByRole("button", { name: "Connect wallet" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Markets" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByText("Status: building")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Connect wallet" }));
    expect(screen.getByText("Browser wallets")).toBeTruthy();
  });

  it("the 404 and error boundaries speak plainly", async () => {
    await renderWithProviders(<NotFound />);
    expect(screen.getByRole("heading", { name: "This page does not exist" })).toBeTruthy();
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
  });
});

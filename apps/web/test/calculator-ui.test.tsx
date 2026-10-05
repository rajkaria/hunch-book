import { encodePerplFundingParams, TemplateId } from "@hunch-book/shared";
import { fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CalculatorPage from "../src/app/calculator/page";
import { CalculatorView } from "../src/components/calculator/CalculatorView";
import { HedgeView } from "../src/components/hedge/HedgeView";
import { MORE_LINKS, NAV_LINKS, SHEET_LINKS } from "../src/components/layout/nav";
import type { FundingSample, PerpMeta } from "../src/lib/hedge/math";
import { makeMarket } from "./fixtures";
import { renderWithProviders } from "./render";

// The funding-cost calculator, and the hedge page's prefill from a link, against mocked Perpl and
// market reads (the same mocks as hedge-ui.test.tsx).

const BTC: PerpMeta = {
  perpId: 16n,
  name: "Bitcoin",
  symbol: "BTC",
  priceDecimals: 1,
  lotDecimals: 5,
  scalingExp: 0,
  markPNS: 850_138n, // $85,013.80
};

const INTERVAL = 8_571n;
const LAST = 68_045_169n;

function history(perInterval: bigint, count = 48): FundingSample[] {
  const out: FundingSample[] = [];
  for (let k = count; k >= 0; k--) {
    const block = LAST - BigInt(k) * INTERVAL;
    out.push({ block, sum: 100_000n + BigInt(count - k) * perInterval, eventBlock: block });
  }
  return out;
}

type Q = { data?: unknown };
const state = vi.hoisted(() => ({ markets: {} as Q, rate: 8n, history: null as FundingSample[] | null }));

vi.mock("@/lib/hedge/hooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/hedge/hooks")>();
  return {
    ...actual,
    usePerplPositions: () => ({ data: undefined, isPending: false, isError: false, refetch: vi.fn() }),
    usePerpMeta: (perpId: bigint | undefined) => ({
      data: perpId === undefined ? undefined : BTC,
      isPending: false,
      isError: false,
      refetch: vi.fn(),
    }),
    useFundingHistory: (perpId: bigint | undefined) => {
      if (perpId === undefined) return { data: undefined, isPending: true, isError: false, refetch: vi.fn() };
      const s = state.history ?? history(state.rate);
      return {
        data: {
          head: LAST + 100n,
          interval: INTERVAL,
          lastEvent: LAST,
          lastSum: s.at(-1)?.sum ?? 0n,
          samples: s,
        },
        isPending: false,
        isError: false,
        refetch: vi.fn(),
      };
    },
    useFundingSumNow: () => ({ data: { head: LAST + 100n, sum: 100_400n, eventBlock: LAST } }),
  };
});

vi.mock("@/lib/hooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/hooks")>();
  return {
    ...actual,
    useMarkets: () => ({ data: state.markets.data, isPending: false, isError: false }),
    useChainClock: () => ({
      blockNumber: LAST + 100n,
      timestamp: 1_799_000_000,
      msPerBlock: 300,
      measured: true,
    }),
    useMarket: () => ({ data: undefined }),
    useTestUsdcFaucet: () => ({ data: undefined }),
  };
});

const fundingPool = makeMarket({
  templateId: TemplateId.PerplFunding,
  params: encodePerplFundingParams({
    perpId: 16n,
    startBlock: LAST + 8_571n,
    endBlock: LAST + 8_571n * 20n,
    threshold: 50n,
    expectedScalingExp: 0,
  }),
  description: "Will BTC longs pay more than $5.00 per BTC in funding on Perpl?",
});

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
  state.markets = { data: { status: "ok", data: { markets: [fundingPool], total: 1 } } };
  state.rate = 8n;
  state.history = null;
});

afterEach(() => {
  window.history.replaceState(null, "", "/");
});

const result = () => screen.getByRole("region", { name: /^Funding over/ });
const hedgePanel = () => screen.getByRole("region", { name: "Hedge it on Hunch Book" });

describe("funding-cost calculator", () => {
  it("renders its page with the inputs from the address", async () => {
    const ui = await CalculatorPage({
      searchParams: Promise.resolve({
        perp: "btc",
        side: "short",
        size: "0.5",
        unit: "units",
        horizon: "24h",
      }),
    });
    await renderWithProviders(ui);
    expect(screen.getByRole("heading", { level: 1, name: "Funding-cost calculator" })).toBeTruthy();
    expect(screen.getByText("building")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Funding over the next 24 hours" })).toBeTruthy();
    expect(within(result()).getByText("This short receives")).toBeTruthy();
    expect((screen.getByLabelText("Size") as HTMLInputElement).value).toBe("0.5");
  });

  it("prices $10,000 of BTC long over 7 days by default, and shows the math and the chart", async () => {
    await renderWithProviders(<CalculatorView />);
    const r = within(result());
    expect(screen.getByRole("heading", { name: "Funding over the next 7 days" })).toBeTruthy();
    expect(r.getByText("This long pays")).toBeTruthy();
    // $0.80 per BTC per event × 235.2 events × 0.117628 BTC.
    expect(r.getByText("$22.13")).toBeTruthy();
    expect(r.getByText("0.117628 BTC")).toBeTruthy();
    expect(r.getByText("235.2")).toBeTruthy();
    expect(
      r.getByText(/^This assumes the funding rate of the last interval \(\$0\.80 per BTC per event\)/),
    ).toBeTruthy();
    expect(r.getByText(/not a forecast/)).toBeTruthy();
    expect(r.getByRole("img", { name: /Funding per interval for the last 48 intervals/ })).toBeTruthy();
  });

  it("lists the open markets that would hedge it, and links into the hedge assistant prefilled", async () => {
    await renderWithProviders(<CalculatorView />);
    const panel = within(hedgePanel());
    const card = panel.getByText(fundingPool.description as string).closest("article") as HTMLElement;
    expect(within(card).getByText(/YES pays if BTC longs pay more than \$5.00 per BTC/)).toBeTruthy();
    expect(within(card).getByText("$1.79")).toBeTruthy(); // $0.80 × 19 events left × 0.117628 BTC
    expect(
      within(card)
        .getByRole("link", { name: /Open the market/ })
        .getAttribute("href"),
    ).toBe(`/m/${fundingPool.address}`);
    expect(panel.getByRole("link", { name: /Open in the hedge assistant/ }).getAttribute("href")).toBe(
      "/hedge?perp=BTC&side=long&size=0.11763",
    );
  });

  it("hedges a short that pays with NO, keeping a small threshold's digits", async () => {
    state.rate = -8n; // shorts pay longs
    state.markets = {
      data: {
        status: "ok",
        data: {
          total: 1,
          markets: [
            makeMarket({
              templateId: TemplateId.PerplFunding,
              params: encodePerplFundingParams({
                perpId: 16n,
                startBlock: LAST + 8_571n,
                endBlock: LAST + 8_571n * 20n,
                threshold: -3n,
                expectedScalingExp: 0,
              }),
              description: "Will BTC longs pay more than -$0.30 per BTC in funding on Perpl?",
            }),
          ],
        },
      },
    };
    await renderWithProviders(<CalculatorView initial={{ side: "short" }} />);
    expect(within(result()).getByText("This short pays")).toBeTruthy();
    const panel = within(hedgePanel());
    expect(
      panel.getByText(/NO pays if BTC longs pay no more than -\$0\.30 per BTC over the window\./),
    ).toBeTruthy();
    expect(panel.getByText("Stake on NO")).toBeTruthy();
    expect(panel.getByRole("link", { name: /Open in the hedge assistant/ }).getAttribute("href")).toBe(
      "/hedge?perp=BTC&side=short&size=0.11763",
    );
  });

  it("says when no market fits, and still links to the hedge assistant", async () => {
    state.markets = { data: { status: "ok", data: { markets: [], total: 0 } } };
    await renderWithProviders(<CalculatorView />);
    const panel = within(hedgePanel());
    expect(panel.getByText("No open market on BTC funding covers this position right now")).toBeTruthy();
    expect(panel.getByRole("link", { name: /Open in the hedge assistant/ })).toBeTruthy();
  });

  it("turns a short into funding received, with nothing to hedge", async () => {
    await renderWithProviders(<CalculatorView />);
    fireEvent.click(screen.getByRole("radio", { name: "Short" }));
    expect(within(result()).getByText("This short receives")).toBeTruthy();
    expect(within(hedgePanel()).getByText(/there is no funding cost to hedge/)).toBeTruthy();
    expect(window.location.search).toBe("?perp=BTC&side=short&size=10000&unit=usd&horizon=7d&rate=last");
  });

  it("takes a size in units and a custom horizon, and keeps the address in step", async () => {
    await renderWithProviders(<CalculatorView />);
    fireEvent.click(screen.getByRole("radio", { name: "BTC" }));
    fireEvent.change(screen.getByLabelText("Size"), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("radio", { name: "Custom" }));
    expect(screen.getByRole("heading", { name: "Funding over the next 3 days" })).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "Hours" }));
    fireEvent.change(screen.getByLabelText("Custom horizon"), { target: { value: "36" } });
    expect(screen.getByRole("heading", { name: "Funding over the next 36 hours" })).toBeTruthy();
    expect(within(result()).getByText("2 BTC")).toBeTruthy();
    expect(window.location.pathname).toBe("/calculator");
    expect(window.location.search).toBe("?perp=BTC&side=long&size=2&unit=units&horizon=36h&rate=last");
  });

  it("explains a size or horizon it cannot use", async () => {
    await renderWithProviders(<CalculatorView />);
    fireEvent.change(screen.getByLabelText("Size"), { target: { value: "abc" } });
    expect(screen.getByText("Enter a size above zero.")).toBeTruthy();
    expect(within(result()).getByText(/Enter a size and a horizon/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Size"), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("radio", { name: "Custom" }));
    fireEvent.change(screen.getByLabelText("Custom horizon"), { target: { value: "400" } });
    expect(screen.getByText("Enter a number of hours or days, up to 365 days.")).toBeTruthy();
  });

  it("projects nothing paid at a zero rate", async () => {
    state.rate = 0n;
    await renderWithProviders(<CalculatorView />);
    expect(within(result()).getByText("Funding")).toBeTruthy();
    expect(within(result()).getByText("Nobody")).toBeTruthy();
    expect(within(hedgePanel()).getByText(/no funding cost to hedge/)).toBeTruthy();
  });

  it("says so when the perp has no funding history yet", async () => {
    state.history = [];
    await renderWithProviders(<CalculatorView />);
    expect(within(result()).getByText(/has no funding history yet/)).toBeTruthy();
    expect(within(hedgePanel()).getByText(/show here once the cost is in/)).toBeTruthy();
  });

  it("sits in the footer's tools, so the bar and the mobile menu keep their length", () => {
    expect(MORE_LINKS.map((l) => l.href)).toContain("/calculator");
    expect(NAV_LINKS.map((l) => l.href)).not.toContain("/calculator");
    expect(SHEET_LINKS.map((l) => l.href)).not.toContain("/calculator");
  });
});

describe("hedge page prefill", () => {
  it("adds the position a link names, as one typed in by hand", async () => {
    window.history.replaceState(null, "", "/hedge?perp=btc&side=short&size=0.25");
    await renderWithProviders(<HedgeView />);
    expect(await screen.findByText("BTC short, 0.25 BTC")).toBeTruthy();
    expect(screen.getAllByText("entered by hand")).toHaveLength(1);
    expect(screen.queryByText("Start with a wallet or a position")).toBeNull();
  });

  it("ignores a link it cannot use", async () => {
    window.history.replaceState(null, "", "/hedge?perp=DOGE&size=1");
    await renderWithProviders(<HedgeView />);
    expect(screen.getByText("Start with a wallet or a position")).toBeTruthy();
  });
});

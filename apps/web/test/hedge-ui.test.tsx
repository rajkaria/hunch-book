import { encodePerplFundingParams, TemplateId } from "@hunch-book/shared";
import { fireEvent, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import HedgePage from "../src/app/hedge/page";
import { HedgeView } from "../src/components/hedge/HedgeView";
import type { FundingSample, PerpMeta, PerpPosition } from "../src/lib/hedge/math";
import { HEDGE_STORAGE_KEY } from "../src/lib/hedge/tracking";
import { makeMarket } from "./fixtures";
import { renderWithProviders } from "./render";

// The hedge page against mocked Perpl and market reads.

const BTC: PerpMeta = {
  perpId: 16n,
  name: "Bitcoin",
  symbol: "BTC",
  priceDecimals: 1,
  lotDecimals: 5,
  scalingExp: 0,
  markPNS: 850_138n,
};

const LONG: PerpPosition = {
  perpId: 16n,
  side: "long",
  lots: 50_000n, // 0.5 BTC
  entryPricePNS: 670_844n,
  entryBlock: 12_286_099n,
  premiumPnlCNS: -681_581_278n,
  source: "chain",
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
const state = vi.hoisted(() => ({
  positions: {} as Q,
  markets: {} as Q,
  rate: 8n,
}));

vi.mock("@/lib/hedge/hooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/hedge/hooks")>();
  const samples = () => history(state.rate);
  return {
    ...actual,
    usePerplPositions: (owner: string | undefined) => ({
      data: owner ? state.positions.data : undefined,
      isPending: Boolean(owner) && state.positions.data === undefined,
      isError: false,
      refetch: vi.fn(),
    }),
    usePerpMeta: (perpId: bigint | undefined) => ({
      data: perpId === undefined ? undefined : BTC,
      isPending: false,
      isError: false,
      refetch: vi.fn(),
    }),
    useFundingHistory: () => {
      const s = samples();
      const last = s.at(-1) as FundingSample;
      return {
        data: { head: LAST + 100n, interval: INTERVAL, lastEvent: LAST, lastSum: last.sum, samples: s },
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
  state.positions = { data: { status: "ok", accountId: 13n, positions: [LONG], metas: [BTC] } };
  state.markets = { data: { status: "ok", data: { markets: [fundingPool], total: 1 } } };
  state.rate = 8n;
});

async function readFor(address: string) {
  await renderWithProviders(<HedgeView />);
  fireEvent.change(screen.getByLabelText("Wallet"), { target: { value: address } });
  fireEvent.click(screen.getByRole("button", { name: "Read positions" }));
}

describe("hedge page", () => {
  it("renders its header, the help and the empty start", async () => {
    await renderWithProviders(<HedgePage />);
    expect(screen.getByRole("heading", { level: 1, name: "Hedge your funding" })).toBeTruthy();
    expect(screen.getByText("building")).toBeTruthy();
    expect(screen.getByText("Start with a wallet or a position")).toBeTruthy();
  });

  it("refuses a bad address", async () => {
    await readFor("0x1234");
    expect(screen.getByRole("alert").textContent).toMatch(/Enter a wallet address/);
  });

  it("shows a position's funding, the projection math and a sized hedge", async () => {
    await readFor("0x58369AAED363a59022c98CD457Ea5e320Df395EB");
    expect(screen.getByText("BTC long, 0.5 BTC")).toBeTruthy();
    expect(screen.getByText("paid $681.58")).toBeTruthy();
    expect(screen.getByText(/If the rate holds, this long/).textContent).toMatch(/pays \$/);
    expect(screen.getByRole("img", { name: /Funding per interval for the last 48 intervals/ })).toBeTruthy();
    const card = screen.getByText(fundingPool.description as string).closest("article") as HTMLElement;
    expect(within(card).getByText(/YES pays if BTC longs pay more than \$5.00 per BTC/)).toBeTruthy();
    expect(
      within(card)
        .getByRole("link", { name: /Stake YES on the market page/ })
        .getAttribute("href"),
    ).toBe(`/m/${fundingPool.address}`);
    fireEvent.click(within(card).getByRole("button", { name: "Track this hedge" }));
    expect(screen.getByText(/Tracking. It is listed under Tracked hedges below./)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Tracked hedges" })).toBeTruthy();
    expect(JSON.parse(window.localStorage.getItem(HEDGE_STORAGE_KEY) ?? "[]")).toHaveLength(1);
  });

  it("offers a new market, prefilled, when no market fits", async () => {
    state.markets = { data: { status: "ok", data: { markets: [], total: 0 } } };
    await readFor("0x58369AAED363a59022c98CD457Ea5e320Df395EB");
    expect(screen.getByText("No open market covers BTC funding for this position")).toBeTruthy();
    const link = screen.getByRole("link", { name: /Create this market/ });
    expect(link.getAttribute("href")).toMatch(
      /^\/create\?template=1&asset=BTC&start=\d+&end=\d+&threshold=[\d.]+&side=yes$/,
    );
  });

  it("says so when the address has no Perpl account", async () => {
    state.positions = { data: { status: "no-account" } };
    await readFor("0x58369AAED363a59022c98CD457Ea5e320Df395EB");
    expect(screen.getByText("No Perpl account for this address")).toBeTruthy();
  });

  it("says there is nothing to hedge when the position is paid funding", async () => {
    state.rate = -8n;
    await readFor("0x58369AAED363a59022c98CD457Ea5e320Df395EB");
    expect(screen.getByText(/receives \$/)).toBeTruthy();
    expect(screen.getByText(/there is no funding cost to hedge/)).toBeTruthy();
  });
});

import { encodePerplFundingParams, Outcome, Phase, TemplateId } from "@hunch-book/shared";
import { fireEvent, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import HedgePage from "../src/app/hedge/page";
import { HedgeView } from "../src/components/hedge/HedgeView";
import type { FundingSample, PerpMeta, PerpPosition } from "../src/lib/hedge/math";
import { BASKET_STORAGE_KEY, LEGACY_HEDGE_STORAGE_KEY } from "../src/lib/hedge/tracking";
import type { MarketView } from "../src/lib/market/types";
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
  /** Markets the tracked baskets read, by lower-case address. */
  legMarkets: {} as Record<string, unknown>,
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
    useFundingSumsAt: () => ({ data: undefined }),
    useLegMarkets: (addresses: readonly string[]) =>
      addresses.map((a) => state.legMarkets[a.toLowerCase()] ?? null),
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

// A second market on the same perp: a later, longer window with a higher threshold.
const laterPool = makeMarket({
  address: "0x00000000000000000000000000000000000000a2",
  templateId: TemplateId.PerplFunding,
  params: encodePerplFundingParams({
    perpId: 16n,
    startBlock: LAST + 8_571n * 10n,
    endBlock: LAST + 8_571n * 40n,
    threshold: 200n,
    expectedScalingExp: 0,
  }),
  description: "Will BTC longs pay more than $20.00 per BTC in funding on Perpl?",
});

beforeEach(() => {
  window.localStorage.clear();
  state.positions = { data: { status: "ok", accountId: 13n, positions: [LONG], metas: [BTC] } };
  state.markets = { data: { status: "ok", data: { markets: [fundingPool], total: 1 } } };
  state.rate = 8n;
  state.legMarkets = {};
});

const basketSection = () => screen.getByRole("region", { name: "Your basket" });
/** The proposal card of a market: its question also shows in the basket, so find the article. */
const cardOf = (m: MarketView) =>
  screen
    .getAllByText(m.description as string)
    .map((e) => e.closest("article"))
    .find((e): e is HTMLElement => e !== null) as HTMLElement;

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
    const card = cardOf(fundingPool);
    expect(within(card).getByText(/YES pays if BTC longs pay more than \$5.00 per BTC/)).toBeTruthy();
    expect(
      within(card)
        .getByRole("link", { name: /Stake YES on the market page/ })
        .getAttribute("href"),
    ).toBe(`/m/${fundingPool.address}`);
    // The first market that can be sized starts in the basket.
    expect(within(card).getByText("In the basket")).toBeTruthy();
    expect(within(card).getByRole("button", { name: "Remove from basket" })).toBeTruthy();
    const basket = basketSection();
    expect(within(basket).getByText(/each leg's share = .* ÷ 1 leg =/)).toBeTruthy();
    expect(
      within(basket)
        .getByRole("link", { name: fundingPool.description as string })
        .getAttribute("href"),
    ).toBe(`/m/${fundingPool.address}`);
    fireEvent.click(within(basket).getByRole("button", { name: "Track this basket" }));
    expect(screen.getByText(/Tracking. It is listed under Tracked hedges below./)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Tracked hedges" })).toBeTruthy();
    expect(within(basket).getByRole("button", { name: "Tracking this basket" })).toHaveProperty(
      "disabled",
      true,
    );
    const stored = JSON.parse(window.localStorage.getItem(BASKET_STORAGE_KEY) ?? "{}");
    expect(stored.version).toBe(1);
    expect(stored.baskets).toHaveLength(1);
    expect(stored.baskets[0].legs).toHaveLength(1);
    expect(stored.baskets[0].cover).toBe(1);
  });

  it("builds a basket across two markets, with the split, the scenarios and per-leg links", async () => {
    state.markets = { data: { status: "ok", data: { markets: [fundingPool, laterPool], total: 2 } } };
    await readFor("0x58369AAED363a59022c98CD457Ea5e320Df395EB");
    const later = cardOf(laterPool);
    fireEvent.click(within(later).getByRole("button", { name: "Add to basket" }));
    expect(within(later).getByText("In the basket")).toBeTruthy();
    expect(within(later).queryByRole("button", { name: "Add to basket" })).toBeNull();
    const basket = basketSection();
    expect(within(basket).getByText(/each leg's share = .* ÷ 2 legs =/)).toBeTruthy();
    for (const m of [fundingPool, laterPool]) {
      expect(
        within(basket)
          .getByRole("link", { name: m.description as string })
          .getAttribute("href"),
      ).toBe(`/m/${m.address}`);
    }
    const scenarios = within(basket).getByRole("table", {
      name: /What the position pays in funding and what the basket pays out/,
    });
    const rows = within(scenarios).getAllByRole("row").slice(1);
    expect(rows.map((r) => within(r).getByRole("rowheader").textContent)).toEqual([
      "Funding flips sign",
      "Half the rate",
      "The rate holds",
      "Twice the rate",
    ]);
    // Flipped, the long is paid and no leg wins.
    expect(rows[0]?.textContent).toMatch(/receives \$/);
    expect(rows[0]?.textContent).toMatch(/0 of 2/);
    // At twice the rate both thresholds are passed.
    expect(rows[3]?.textContent).toMatch(/2 of 2/);
    // Half the cover halves the target.
    fireEvent.click(within(basket).getByRole("radio", { name: "50%" }));
    expect(within(basket).getByText(/to cover = 50% ×/)).toBeTruthy();
    // Remove a leg from the basket itself.
    const legs = within(basket).getByRole("table", { name: /The legs of the basket/ });
    fireEvent.click(within(legs).getAllByRole("button", { name: "Remove" })[0] as HTMLElement);
    expect(within(basket).getByText(/÷ 1 leg =/)).toBeTruthy();
  });

  it("moves a hedge tracked before baskets into a one-leg basket and shows each leg's status", async () => {
    window.localStorage.setItem(
      LEGACY_HEDGE_STORAGE_KEY,
      JSON.stringify([
        {
          id: "old",
          network: "monad-testnet",
          createdAt: 1,
          perpId: "16",
          symbol: "BTC",
          side: "long",
          units: 0.5,
          startBlock: String(LAST - 8_571n),
          startSum: "100000",
          market: fundingPool.address,
          buy: "yes",
          mode: "pool",
          cost: 10,
          tokens: null,
          payoutIfWin: 13,
        },
      ]),
    );
    const settled: MarketView = { ...fundingPool, phase: Phase.Settled, outcome: Outcome.Yes };
    state.legMarkets = { [fundingPool.address.toLowerCase()]: settled };
    await renderWithProviders(<HedgeView />);
    const tracked = screen.getByRole("region", { name: "Tracked hedges" });
    expect(within(tracked).getByText(/BTC long, 0.5 BTC: a basket of 1 leg/)).toBeTruthy();
    expect(within(tracked).getByText("every leg settled")).toBeTruthy();
    expect(within(tracked).getByText("Settled YES")).toBeTruthy();
    expect(within(tracked).getByText("won")).toBeTruthy();
    expect(within(tracked).getByText("Basket paid")).toBeTruthy();
    expect(window.localStorage.getItem(LEGACY_HEDGE_STORAGE_KEY)).toBeNull();
    expect(JSON.parse(window.localStorage.getItem(BASKET_STORAGE_KEY) ?? "{}").baskets[0].id).toBe("old");
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

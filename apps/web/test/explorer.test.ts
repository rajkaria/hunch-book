import { type Deployment, deployments, Outcome, Phase, stacksOf } from "@hunch-book/shared";
import type { Address } from "viem";
import { describe, expect, it } from "vitest";
import {
  activeFilterCount,
  cardBody,
  cardTiles,
  compactUsdc,
  explorerCounts,
  explorerHref,
  explorerStats,
  filterMarkets,
  isOneSidedLockedPool,
  isUrgent,
  KURU_PRESET,
  matchesSearch,
  matchesVenue,
  milestoneShort,
  parseVenueFilter,
  priceCents,
  searchTerms,
  searchText,
  URGENT_SECONDS,
  wholePercent,
} from "../src/lib/market/explorer";
import type { Milestone } from "../src/lib/market/logic";
import { marketVenue, venueChipLabel } from "../src/lib/stacks";
import { deployed } from "./chain";
import { makeMarket, USDC } from "./fixtures";

// The markets list's filters and cards as pure logic: which venue a market's book is on, the ?venue=
// filter, the counts and links between filters, the search box and what each card shows.

const addr = (n: number): Address => `0x${n.toString(16).padStart(40, "0")}` as Address;

/** Three stacks, as on testnet: Kuru v1 (primary), Kuru v2, and Hunch Book's own order book. */
const threeStacks: Deployment = {
  ...deployed,
  stacks: {
    kuruV2: { factory: addr(0xf2), vault: addr(0xa2), kuruVersion: 2 },
    hunch: {
      factory: addr(0xf3),
      vault: addr(0xa3),
      kuruVersion: 1,
      venue: {
        kind: "hunch",
        bookFactory: addr(0xe1),
        marginAccount: addr(0xe2),
        bookImplementation: addr(0xe3),
      },
    },
  },
};

/** A network whose primary stack is itself a Hunch venue, and no others. */
const hunchPrimary: Deployment = {
  ...deployed,
  hunchBook: {
    ...deployed.hunchBook,
    venue: {
      kind: "hunch",
      bookFactory: addr(0xe1),
      marginAccount: addr(0xe2),
      bookImplementation: addr(0xe3),
    },
  },
};

const onPrimary = makeMarket({ address: addr(0xa1), marketId: 1n });
const onKuruV2 = makeMarket({ address: addr(0xa2), marketId: 1n, stack: "kuruV2", kuruVersion: 2 });
const onHunch = makeMarket({
  address: addr(0xa3),
  marketId: 1n,
  stack: "hunch",
  kuruVersion: 1,
  venue: "hunch",
  phase: Phase.Graduated,
  graduated: true,
  quote: { bid: 600_000_000_000_000_000n, ask: 640_000_000_000_000_000n },
});

describe("parseVenueFilter", () => {
  it("reads kuru and hunch, in any case and with spaces around", () => {
    expect(parseVenueFilter("kuru")).toBe("kuru");
    expect(parseVenueFilter("hunch")).toBe("hunch");
    expect(parseVenueFilter(" KURU ")).toBe("kuru");
    expect(parseVenueFilter("Hunch")).toBe("hunch");
  });

  it("takes the first value when the param repeats", () => {
    expect(parseVenueFilter(["hunch", "kuru"])).toBe("hunch");
    expect(parseVenueFilter(["nope", "kuru"])).toBe("all");
  });

  it("falls back to all for anything else", () => {
    for (const value of [undefined, "", "all", "kuruV2", "kuru v2", "primary", "0x2c30", []]) {
      expect(parseVenueFilter(value as string | string[] | undefined)).toBe("all");
    }
  });
});

describe("the venue of a market", () => {
  it("reads it from the market's stack: Kuru v1, Kuru v2 or Hunch Book's own book", () => {
    expect(marketVenue(onPrimary, threeStacks)).toEqual({ venue: "kuru", kuruVersion: 1 });
    expect(marketVenue(onKuruV2, threeStacks)).toEqual({ venue: "kuru", kuruVersion: 2 });
    expect(marketVenue(onHunch, threeStacks)).toEqual({ venue: "hunch", kuruVersion: 1 });
    expect(venueChipLabel(onPrimary, threeStacks)).toBe("Kuru");
    expect(venueChipLabel(onKuruV2, threeStacks)).toBe("Kuru v2");
    expect(venueChipLabel(onHunch, threeStacks)).toBe("Hunch book");
  });

  it("names the venue a pool's book will open on before it graduates", () => {
    const pool = makeMarket({ stack: "hunch", phase: Phase.Pool, graduated: false, book: null });
    expect(venueChipLabel(pool, threeStacks)).toBe("Hunch book");
    const v2Pool = makeMarket({ stack: "kuruV2", phase: Phase.Pool, book: null });
    expect(venueChipLabel(v2Pool, threeStacks)).toBe("Kuru v2");
  });

  it("follows the stack, not the fields the market happens to carry", () => {
    // A market tagged with the hunch stack name is on that stack's venue, whatever else it says.
    const mislabelled = makeMarket({ stack: "hunch", venue: "kuru", kuruVersion: 2 });
    expect(marketVenue(mislabelled, threeStacks)).toEqual({ venue: "hunch", kuruVersion: 1 });
  });

  it("reads a primary stack that is itself a Hunch venue", () => {
    expect(venueChipLabel(onPrimary, hunchPrimary)).toBe("Hunch book");
    expect(matchesVenue(onPrimary, "hunch", hunchPrimary)).toBe(true);
  });

  it("falls back to the market's own fields when its stack is not in the deployment", () => {
    expect(marketVenue(makeMarket({ stack: "gone", venue: "hunch" }), deployed).venue).toBe("hunch");
    expect(marketVenue(makeMarket({ stack: "gone", kuruVersion: 2 }), deployed)).toEqual({
      venue: "kuru",
      kuruVersion: 2,
    });
    expect(marketVenue(makeMarket({ stack: "gone" }), deployed)).toEqual({ venue: "kuru", kuruVersion: 1 });
  });

  it("gives every stack on the real testnet deployment a label from the three", () => {
    const testnet = deployments["monad-testnet"];
    for (const stack of stacksOf(testnet)) {
      const m = makeMarket({ stack: stack.name });
      const label = venueChipLabel(m, testnet);
      expect(["Kuru", "Kuru v2", "Hunch book"]).toContain(label);
      expect(label === "Hunch book").toBe(stack.venue === "hunch");
    }
  });
});

describe("filters, counts and links", () => {
  const settled = makeMarket({
    address: addr(0xa4),
    stack: "kuruV2",
    kuruVersion: 2,
    phase: Phase.Settled,
    outcome: Outcome.Yes,
  });
  const all = [onPrimary, onKuruV2, onHunch, settled];

  it("keeps Kuru v1 and v2 under kuru, and the rest under hunch", () => {
    expect(filterMarkets(all, { phase: "all", venue: "kuru" }, threeStacks)).toEqual([
      onPrimary,
      onKuruV2,
      settled,
    ]);
    expect(filterMarkets(all, { phase: "all", venue: "hunch" }, threeStacks)).toEqual([onHunch]);
    expect(filterMarkets(all, { phase: "all", venue: "all" }, threeStacks)).toEqual(all);
  });

  it("combines the phase and venue filters", () => {
    expect(filterMarkets(all, { phase: "pools", venue: "kuru" }, threeStacks)).toEqual([onPrimary, onKuruV2]);
    expect(filterMarkets(all, { phase: "settled", venue: "kuru" }, threeStacks)).toEqual([settled]);
    expect(filterMarkets(all, { phase: "pools", venue: "hunch" }, threeStacks)).toEqual([]);
  });

  it("counts each filter's options given the other filter", () => {
    const none = explorerCounts(all, { phase: "all", venue: "all" }, threeStacks);
    expect(none.phase).toEqual({ all: 4, pools: 2, trading: 1, settling: 0, settled: 1 });
    expect(none.venue).toEqual({ all: 4, kuru: 3, hunch: 1 });

    const kuruOnly = explorerCounts(all, { phase: "all", venue: "kuru" }, threeStacks);
    expect(kuruOnly.phase).toEqual({ all: 3, pools: 2, trading: 0, settling: 0, settled: 1 });
    expect(kuruOnly.venue).toEqual({ all: 4, kuru: 3, hunch: 1 });

    const trading = explorerCounts(all, { phase: "trading", venue: "all" }, threeStacks);
    expect(trading.venue).toEqual({ all: 1, kuru: 0, hunch: 1 });
  });

  it("links to /markets with only the params that are set", () => {
    expect(explorerHref({ phase: "all", venue: "all" })).toBe("/markets");
    expect(explorerHref({ phase: "trading", venue: "all" })).toBe("/markets?phase=trading");
    expect(explorerHref({ phase: "all", venue: "kuru" })).toBe("/markets?venue=kuru");
    expect(explorerHref({ phase: "settled", venue: "hunch" })).toBe("/markets?phase=settled&venue=hunch");
  });

  it("stays on /kuru for the Kuru venue and goes back to /markets for any other", () => {
    expect(explorerHref({ phase: "all", venue: "kuru" }, KURU_PRESET)).toBe("/kuru");
    expect(explorerHref({ phase: "pools", venue: "kuru" }, KURU_PRESET)).toBe("/kuru?phase=pools");
    expect(explorerHref({ phase: "pools", venue: "all" }, KURU_PRESET)).toBe("/markets?phase=pools");
    expect(explorerHref({ phase: "all", venue: "hunch" }, KURU_PRESET)).toBe("/markets?venue=hunch");
  });

  it("counts the filters that differ from the page's own default", () => {
    expect(activeFilterCount({ phase: "all", venue: "all" })).toBe(0);
    expect(activeFilterCount({ phase: "trading", venue: "kuru" })).toBe(2);
    expect(activeFilterCount({ phase: "all", venue: "kuru" }, KURU_PRESET)).toBe(0);
    expect(activeFilterCount({ phase: "pools", venue: "kuru" }, KURU_PRESET)).toBe(1);
  });
});

describe("one-sided locked pools", () => {
  const locked = (yes: number, no: number) =>
    makeMarket({ phase: Phase.PoolLocked, pool: { yes: USDC(yes), no: USDC(no), total: 0n, stakers: 2 } });

  it("are pools that locked without graduating at 0% or 100%", () => {
    expect(isOneSidedLockedPool(locked(50, 0))).toBe(true);
    expect(isOneSidedLockedPool(locked(0, 50))).toBe(true);
  });

  it("leave out two-sided, empty, open and graduated markets", () => {
    expect(isOneSidedLockedPool(locked(50, 1))).toBe(false);
    expect(isOneSidedLockedPool(locked(0, 0))).toBe(false);
    expect(isOneSidedLockedPool(makeMarket({ pool: { yes: USDC(50), no: 0n, total: 0n, stakers: 1 } }))).toBe(
      false,
    );
    expect(isOneSidedLockedPool({ ...locked(50, 0), graduated: true })).toBe(false);
    expect(isOneSidedLockedPool(makeMarket({ phase: Phase.Settled, outcome: Outcome.Yes }))).toBe(false);
  });
});

describe("search", () => {
  it("splits the query into lower case words", () => {
    expect(searchTerms("  BTC   Funding ")).toEqual(["btc", "funding"]);
    expect(searchTerms("   ")).toEqual([]);
  });

  it("looks through the title, template, number, venue and phase", () => {
    const text = searchText(onKuruV2, "Will BTC be above $120,000?", threeStacks);
    expect(matchesSearch(text, searchTerms("btc 120,000"))).toBe(true);
    expect(matchesSearch(text, searchTerms("price at a time"))).toBe(true);
    expect(matchesSearch(text, searchTerms("#1"))).toBe(true);
    expect(matchesSearch(text, searchTerms("kuru v2"))).toBe(true);
    expect(matchesSearch(text, searchTerms("pool"))).toBe(true);
    expect(matchesSearch(text, searchTerms("btc eth"))).toBe(false);
    expect(matchesSearch(text, [])).toBe(true);
  });
});

describe("one card", () => {
  const milestone = (label: string, time: number): Milestone => ({
    label,
    moment: { time, estimated: false },
  });

  it("is urgent under a day before a lock or close, never for a settlement deadline", () => {
    const now = 1_000_000;
    expect(isUrgent(milestone("Closes in", now + URGENT_SECONDS), now)).toBe(true);
    expect(isUrgent(milestone("Locks in", now + 60), now)).toBe(true);
    expect(isUrgent(milestone("Closes in", now + URGENT_SECONDS + 1), now)).toBe(false);
    expect(isUrgent(milestone("Closes in", now - 1), now)).toBe(false);
    expect(isUrgent(milestone("Settle within", now + 60), now)).toBe(false);
    expect(isUrgent(null, now)).toBe(false);
  });

  it("shortens the countdown to fit the chip, with ~ for a block-clock estimate", () => {
    const now = 1_000_000;
    const day = 86_400;
    expect(milestoneShort(milestone("Locks in", now + 2 * day + 4 * 3_600), now)).toBe("Locks 2d 4h");
    expect(
      milestoneShort({ label: "Closes in", moment: { time: now + 3 * 3_600 + 720, estimated: true } }, now),
    ).toBe("Closes ~3h 12m");
    expect(milestoneShort(milestone("Settle within", now + 6 * day), now)).toBe("Settle within 6d 0h");
    expect(milestoneShort(milestone("Locks in", now), now)).toBe("Locking now");
    expect(milestoneShort(milestone("Closes in", now - 5), now)).toBe("Closing now");
    expect(milestoneShort(milestone("Settle within", now - 5), now)).toBe("Past deadline");
  });

  it("writes footer amounts whole from 100 USDC up, with cents below", () => {
    expect(compactUsdc(USDC(120))).toBe("120");
    expect(compactUsdc(USDC(1_240.99))).toBe("1,240");
    expect(compactUsdc(USDC(100))).toBe("100");
    expect(compactUsdc(USDC(99.5))).toBe("99.50");
    expect(compactUsdc(USDC(5))).toBe("5.00");
    expect(compactUsdc(0n)).toBe("0.00");
  });

  it("writes 1e18 prices as cents to a tenth", () => {
    expect(priceCents(640_000_000_000_000_000n)).toBe("64c");
    expect(priceCents(645_000_000_000_000_000n)).toBe("64.5c");
    expect(priceCents(6_000_000_000_000_000n)).toBe("0.6c");
    expect(priceCents(10n ** 18n)).toBe("100c");
    expect(priceCents(0n)).toBe("0c");
  });

  it("shows a pool's stakes per side, and a book's price to buy each side", () => {
    expect(cardTiles(onPrimary)).toEqual([
      { label: "Yes pool", value: "300.00", unit: "USDC" },
      { label: "No pool", value: "100.00", unit: "USDC" },
    ]);
    // YES at the best ask (0.64), NO at one minus the best bid (1 - 0.60).
    expect(cardTiles(onHunch)).toEqual([
      { label: "Yes", value: "64c" },
      { label: "No", value: "40c" },
    ]);
    expect(cardTiles({ ...onHunch, quote: { bid: null, ask: 640_000_000_000_000_000n } })?.[1].value).toBe(
      "n/a",
    );
    expect(cardTiles({ ...onHunch, phase: Phase.Closed })).toBeNull();
    expect(cardTiles({ ...onPrimary, phase: Phase.PoolLocked })).toBeNull();
  });

  it("puts the result, a note, or the chance between the title and the footer", () => {
    expect(cardBody(makeMarket({ phase: Phase.Settled, outcome: Outcome.Yes }))).toEqual({
      kind: "outcome",
      text: "Settled YES",
      side: "yes",
    });
    expect(cardBody(makeMarket({ phase: Phase.Settled, outcome: Outcome.No }))).toMatchObject({ side: "no" });
    expect(cardBody(makeMarket({ phase: Phase.Voided }))).toEqual({
      kind: "outcome",
      text: "Voided",
      side: null,
    });
    expect(cardBody(makeMarket({ pool: { yes: 0n, no: 0n, total: 0n, stakers: 0 } }))).toEqual({
      kind: "note",
      text: "No stakes yet",
    });
    expect(cardBody({ ...onHunch, quote: { bid: null, ask: null } })).toMatchObject({ kind: "note" });
    expect(cardBody(onPrimary)).toMatchObject({ kind: "chance", bps: 7_500n });
    expect(cardBody(onHunch)).toMatchObject({ kind: "chance", bps: 6_200n });
  });

  it("averages YES over the markets that have a chance, and counts pools and books as open", () => {
    const empty = makeMarket({ pool: { yes: 0n, no: 0n, total: 0n, stakers: 0 } });
    const settled = makeMarket({ phase: Phase.Settled, outcome: Outcome.Yes });
    const locked = makeMarket({
      phase: Phase.PoolLocked,
      pool: { yes: USDC(50), no: USDC(50), total: 0n, stakers: 2 },
    });
    expect(explorerStats([onPrimary, onHunch, empty, settled, locked])).toEqual({
      open: 3,
      avgYesBps: Math.round((7_500 + 6_200 + 5_000) / 3),
    });
    expect(explorerStats([settled])).toEqual({ open: 0, avgYesBps: null });
    expect(wholePercent(6_233)).toBe("62%");
    expect(wholePercent(4_850)).toBe("49%");
  });
});

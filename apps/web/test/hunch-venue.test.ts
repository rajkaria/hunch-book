import { type Deployment, deployments, Phase } from "@hunch-book/shared";
import { type Address, zeroAddress } from "viem";
import { describe, expect, it } from "vitest";
import { chanceWords } from "../src/app/api/v1/_lib/funding";
import { BookState } from "../src/lib/chain/kuru";
import { listMarkets, readMarket } from "../src/lib/chain/reads";
import { readCreateConfig } from "../src/lib/create/reads";
import { lifecycleActions } from "../src/lib/market/actions";
import { marketChance } from "../src/lib/market/logic";
import type { MarketView } from "../src/lib/market/types";
import {
  bookName,
  defaultStack,
  deployBlockOf,
  marketTag,
  marketVenueLabel,
  onDefaultStack,
  routerOf,
  stackOf,
  vaultOf,
  venueSentences,
  venueShort,
  venueWords,
} from "../src/lib/stacks";
import { fillFromLog } from "../src/lib/tape/fills";
import { booksOf } from "../src/lib/tape/hooks";
import { evaluateTicket, inactiveBookWords } from "../src/lib/trade/ticket";
import { BOOK, deployed, marketAddr, marketHandlers, stubClient } from "./chain";
import { makeBalances, makeBook, makeMarket, USDC } from "./fixtures";

// The app on a deployment whose default stack trades on Hunch Book's own order book (docs/PROTOCOL.md
// §8.1, "Hunch order book"): its books speak Kuru v1's interface, so every v1 read and trade path runs
// on them, read from the market's own stack.

const FACTORY3 = "0x00000000000000000000000000000000000000f6" as Address;
const VAULT3 = "0x00000000000000000000000000000000000000f7" as Address;
const ROUTER3 = "0x00000000000000000000000000000000000000f8" as Address;
const GRAD3 = "0x00000000000000000000000000000000000000f9" as Address;
const BOOK_FACTORY = "0x00000000000000000000000000000000000000e7" as Address;
const MARGIN = "0x00000000000000000000000000000000000000e8" as Address;
const OWN_BOOK = "0x00000000000000000000000000000000000000b3" as Address;

const withHunch: Deployment = {
  ...deployed,
  hunchBook: {
    ...deployed.hunchBook,
    router: "0x00000000000000000000000000000000000000a9",
    deployBlock: 100,
  },
  stacks: {
    hunch: {
      factory: FACTORY3,
      vault: VAULT3,
      router: ROUTER3,
      graduator: GRAD3,
      usdc: deployed.hunchBook.usdc,
      kuruVersion: 1,
      deployBlock: 5_000,
      venue: { kind: "hunch", bookFactory: BOOK_FACTORY, marginAccount: MARGIN, bookImplementation: MARGIN },
    },
  },
  defaultStack: "hunch",
};

// Primary stack: market 0 (pool). Hunch stack: market 7 (pool) and 8 (trading on OWN_BOOK).
const own = [marketAddr(7), marketAddr(8)];
const client = () =>
  stubClient(
    marketHandlers(1, {
      marketCount: (a) => (a === FACTORY3 ? 2n : 1n),
      marketAt: (a, args) => (a === FACTORY3 ? own[Number(args?.[0])] : marketAddr(0)),
      isMarket: (a, args) =>
        a === FACTORY3 ? own.includes(args?.[0] as Address) : args?.[0] === marketAddr(0),
      phase: (a) => (a === marketAddr(8) ? Phase.Graduated : Phase.Pool),
      graduated: (a) => a === marketAddr(8),
      book: (a) => (a === marketAddr(8) ? OWN_BOOK : zeroAddress),
      // Hunch Book's books answer Kuru v1's bestBidAsk at the 1e18 scale.
      bestBidAsk: () => [410_000_000_000_000_000n, 430_000_000_000_000_000n],
      // Both numbered from 1 on their own factory: market 8 is #1 on the hunch stack, like market 0's #1.
      marketId: (a) => (a === marketAddr(8) || a === marketAddr(0) ? 1n : 2n),
    }),
  );

describe("markets on Hunch Book's own order book", () => {
  it("reads every stack, tags the hunch stack's markets with their venue and reads the book at 1e18", async () => {
    const result = await listMarkets(client(), withHunch);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.data.total).toBe(3);
    const trading = result.data.markets.find((m) => m.address === marketAddr(8));
    const primary = result.data.markets.find((m) => m.address === marketAddr(0));
    expect(trading).toMatchObject({ stack: "hunch", kuruVersion: 1, venue: "hunch", book: OWN_BOOK });
    expect(trading?.quote).toEqual({ bid: 410_000_000_000_000_000n, ask: 430_000_000_000_000_000n });
    // A Hunch book is never waiting on anyone: no Kuru v2 readiness read.
    expect(trading?.bookReady).toBeUndefined();
    expect(primary?.venue).toBeUndefined();
    // The same number on two stacks reads apart.
    expect(trading && marketTag(trading)).toBe("#1");
    expect(primary && marketTag(primary)).toBe("#1 · Kuru");
  });

  it("finds a hunch-stack market through its own factory", async () => {
    const r = await readMarket(client(), withHunch, marketAddr(8));
    expect(r.status).toBe("ok");
    if (r.status === "ok") expect(r.data).toMatchObject({ stack: "hunch", venue: "hunch" });
  });

  it("trades, stakes and scans through the market's own stack", () => {
    const m = { stack: "hunch" } as Pick<MarketView, "stack">;
    expect(routerOf(m, withHunch)).toBe(ROUTER3);
    expect(vaultOf(m, withHunch)).toBe(VAULT3);
    expect(stackOf(m, withHunch)?.venue).toBe("hunch");
    expect(deployBlockOf(m, withHunch)).toBe(5_000n);
    expect(deployBlockOf({}, withHunch)).toBe(100n);
    expect(defaultStack(withHunch)?.name).toBe("hunch");
    expect(onDefaultStack(m, withHunch)).toBe(true);
    expect(onDefaultStack({}, withHunch)).toBe(false);
  });
});

describe("venue words", () => {
  const hunch = { venue: "hunch" as const, kuruVersion: 1 as const };
  const v2 = { kuruVersion: 2 as const };
  it("names each venue in labels and sentences", () => {
    expect([marketVenueLabel(hunch), marketVenueLabel({}), marketVenueLabel(v2)]).toEqual([
      "Hunch order book",
      "Kuru",
      "Kuru v2",
    ]);
    expect([bookName(hunch), bookName({}), bookName(v2)]).toEqual([
      "Hunch order book",
      "Kuru book",
      "Kuru v2 book",
    ]);
    expect(venueWords(hunch)).toBe("Hunch Book's own order book");
    expect(venueShort(hunch)).toBe("the order book");
    expect(venueShort({})).toBe("Kuru");
    expect(marketTag({ marketId: 3n, ...v2 })).toBe("#3 · Kuru v2");
  });

  it("says where testnet's markets trade, new ones first, without claiming more", () => {
    expect(venueSentences(deployments["monad-testnet"])).toEqual([
      "New markets graduate to Hunch Book's own onchain order book, so graduation waits on no third party.",
      "Kuru is supported too: markets created on a Kuru stack graduate to Kuru's books.",
      "Kuru v2 is supported: pools on a Kuru v2 stack graduate once Kuru creates their books.",
    ]);
    expect(venueSentences({ ...deployed })).toEqual(["New markets graduate to Kuru's onchain order book."]);
    expect(venueSentences({ ...deployed, hunchBook: {} })).toEqual([]);
  });

  it("puts the venue in the chance note, the graduate action and the API's words", () => {
    const m = makeMarket({
      phase: Phase.Graduated,
      quote: { bid: 4n * 10n ** 17n, ask: 5n * 10n ** 17n },
      ...hunch,
    });
    expect(marketChance(m).note).toBe("Mid price on the order book");
    expect(marketChance({ ...m, venue: undefined }).note).toBe("Mid price on Kuru");
    const pool = makeMarket({ ruleMet: true, ...hunch });
    const graduate = lifecycleActions(pool, null, null).find((a) => a.id === "graduate");
    expect(graduate).toMatchObject({ label: "Graduate to the order book", enabled: true });
    expect(graduate?.reason).toMatch(/opens its book on Hunch Book's own order book/);
    expect(lifecycleActions({ ...pool, venue: undefined }, null, null)[0]?.label).toBe("Graduate to Kuru");
    expect(chanceWords("book", "Hunch order book")).toBe("the Hunch order book's mid");
    expect(chanceWords("book")).toBe("the Kuru book's mid");
  });
});

describe("trading a hunch-stack market", () => {
  const ticket = {
    kind: "buyYes" as const,
    amount: USDC(10),
    slippageBps: 100n,
    phase: Phase.Graduated,
    router: ROUTER3,
    wallet: { connected: true, onAppChain: true },
    balances: makeBalances(),
  };

  it("quotes on the book like any v1 book", () => {
    const state = evaluateTicket({ ...ticket, book: makeBook(), venue: { venue: "hunch" } });
    expect(state.blocker).toBeNull();
    expect(state.quote?.tokens).toBeGreaterThan(0n);
  });

  it("says a Hunch book outside trading takes cancels only, never that Kuru paused it", () => {
    const closed = makeBook({ state: BookState.SoftPaused });
    expect(evaluateTicket({ ...ticket, book: closed, venue: { venue: "hunch" } }).blocker).toBe(
      "This book matches only while the market is trading, so it cannot trade right now.",
    );
    expect(evaluateTicket({ ...ticket, book: closed }).blocker).toMatch(/Kuru has paused/);
    expect(inactiveBookWords({ venue: "hunch" })).toMatch(/accepts cancels only/);
    expect(inactiveBookWords(undefined)).toMatch(/Kuru has paused/);
  });

  it("reads its fills from Kuru v1's Trade event and names the market by its tag", () => {
    const m = makeMarket({
      address: marketAddr(8),
      marketId: 1n,
      graduated: true,
      book: OWN_BOOK,
      stack: "hunch",
      kuruVersion: 1,
      venue: "hunch",
    });
    const [info] = booksOf([m, makeMarket({ graduated: true, book: BOOK })]);
    expect(info).toMatchObject({ book: OWN_BOOK, kuruVersion: 1, tag: "#1" });
    const fill = fillFromLog(
      {
        address: OWN_BOOK,
        blockNumber: 10n,
        logIndex: 2,
        transactionHash: `0x${"cd".repeat(32)}`,
        args: {
          orderId: 1,
          makerAddress: "0x0000000000000000000000000000000000000555",
          isBuy: true,
          price: 420_000_000_000_000_000n,
          updatedSize: 0n,
          takerAddress: ROUTER3,
          txOrigin: "0x0000000000000000000000000000000000000666",
          filledSize: USDC(5),
        },
      },
      withHunch,
      new Map([[OWN_BOOK.toLowerCase(), info as NonNullable<typeof info>]]),
    );
    // The hunch stack's router counts as Hunch Book's router: the trader is the transaction's sender.
    expect(fill).toMatchObject({
      market: marketAddr(8),
      marketTag: "#1",
      priceE6: 420_000n,
      viaRouter: true,
      trader: "0x0000000000000000000000000000000000000666",
    });
  });
});

describe("creating on the default stack", () => {
  it("reads the default stack's factory, vault and templates, and says its venue", async () => {
    const asked: Address[] = [];
    const base = stubClient({
      creationPaused: () => false,
      caps: () => ({
        poolCap: USDC(5_000),
        walletCap: USDC(1_000),
        minStake: USDC(1),
        creatorMinStake: USDC(5),
      }),
      templateOf: () => ({
        resolver: "0x00000000000000000000000000000000000000e5",
        rule: { minPool: USDC(100), minStakers: 3, minChanceBps: 300, maxChanceBps: 9_700 },
      }),
    });
    const spy = {
      ...base,
      multicall: async (args: { contracts: readonly { address: Address }[] }) => {
        for (const c of args.contracts) asked.push(c.address);
        return (base.multicall as (a: unknown) => Promise<unknown>)(args);
      },
    };
    const config = await readCreateConfig(spy as never, withHunch);
    expect(config).toMatchObject({
      stack: "hunch",
      venue: "hunch",
      kuruVersion: 1,
      factory: FACTORY3,
      vault: VAULT3,
      usdc: deployed.hunchBook.usdc,
    });
    expect(config?.templates[1]?.rule.minPool).toBe(USDC(100));
    expect(new Set(asked)).toEqual(new Set([FACTORY3]));
    // Without a defaultStack, new markets go to the primary stack.
    const primary = await readCreateConfig(base, { ...withHunch, defaultStack: undefined });
    expect(primary).toMatchObject({ stack: "primary", venue: "kuru", factory: deployed.hunchBook.factory });
  });
});

import { Outcome, Phase, poolPayout } from "@hunch-book/shared";
import type { Address, Hex } from "viem";
import { describe, expect, it } from "vitest";
import type { HistoryResult } from "../src/lib/indexer/queries";
import { csvCell, csvFilename, historyCsv } from "../src/lib/pnl/csv";
import {
  emptyEntry,
  eventsFromChain,
  eventsFromHistory,
  markOf,
  missingMarkets,
} from "../src/lib/pnl/history";
import { type MarketMark, marketPnl, type PnlEvent, pnlTotals, tokenValue } from "../src/lib/pnl/ledger";
import { MARKET, makeEntry, makeMarket, USDC } from "./fixtures";

const TX = `0x${"ab".repeat(32)}` as Hex;
let n = 0;
/** An event at the next block, so the order is the order written. */
const ev = (e: Partial<PnlEvent> & Pick<PnlEvent, "kind">): PnlEvent => {
  n += 1;
  return {
    market: MARKET,
    tokens: 0n,
    usdc: 0n,
    fee: 0n,
    via: "router",
    time: 1_800_000_000 + n,
    block: BigInt(1_000 + n),
    logIndex: 0,
    tx: TX,
    ...e,
  };
};

/** A market with 300 YES and 100 NO staked, graduated and trading at a 0.62 mid. */
const trading = (over: Partial<MarketMark> = {}): MarketMark => ({
  phase: Phase.Graduated,
  outcome: Outcome.Unresolved,
  graduated: true,
  pool: { yes: USDC(300), no: USDC(100), total: USDC(400) },
  midE6: 620_000n,
  balances: { yes: 0n, no: 0n },
  claimableTokens: { yes: 0n, no: 0n },
  claimablePool: 0n,
  ...over,
});

describe("marketPnl", () => {
  it("a staker who graduated, sold a quarter and holds the rest at mid", () => {
    // 100 USDC on YES into 300 YES / 100 NO: 100 · 400 / 300 = 133.333333 YES at graduation.
    const events = [
      ev({ kind: "stake", side: "yes", usdc: USDC(100), via: "pool" }),
      ev({ kind: "claim", side: "yes", tokens: 133_333_333n, via: "pool" }),
      ev({ kind: "sell", side: "yes", tokens: 33_333_333n, usdc: USDC(20) }),
    ];
    const r = marketPnl(MARKET, events, trading({ balances: { yes: USDC(100), no: 0n } }));
    // Cost out at the average: 100 · 33.333333 / 133.333333 = 24.999999.
    expect(r.realised).toBe(USDC(20) - 24_999_999n);
    expect(r.costBasis).toBe(75_000_001n);
    expect(r.value).toBe(USDC(62));
    expect(r.unrealised).toBe(USDC(62) - 75_000_001n);
    // Realised plus unrealised is what came back plus what is held, minus what went in.
    expect(r.total).toBe(USDC(20) + USDC(62) - USDC(100));
    expect(r).toMatchObject({ spent: USDC(100), received: USDC(20), complete: true, notes: [] });
  });

  it("orders events by block whatever order they arrive in", () => {
    const events = [
      ev({ kind: "stake", side: "yes", usdc: USDC(100), via: "pool" }),
      ev({ kind: "claim", side: "yes", tokens: 133_333_333n, via: "pool" }),
      ev({ kind: "sell", side: "yes", tokens: 33_333_333n, usdc: USDC(20) }),
    ];
    const mark = trading({ balances: { yes: USDC(100), no: 0n } });
    expect(marketPnl(MARKET, [...events].reverse(), mark)).toEqual(marketPnl(MARKET, events, mark));
  });

  it("counts claimable tokens as held, at the cost of their stake", () => {
    const r = marketPnl(
      MARKET,
      [ev({ kind: "stake", side: "no", usdc: USDC(50), via: "pool" })],
      trading({ claimableTokens: { yes: 0n, no: USDC(200) } }),
    );
    // 200 NO at 1 − 0.62 = 76 USDC, against a 50 USDC stake.
    expect(r).toMatchObject({
      costBasis: USDC(50),
      value: USDC(76),
      unrealised: USDC(26),
      held: { yes: 0n, no: USDC(200) },
    });
  });

  it("a pool that settled without graduating: claimed, unclaimed, and lost", () => {
    const mark: MarketMark = {
      ...trading(),
      phase: Phase.Settled,
      outcome: Outcome.Yes,
      graduated: false,
      midE6: null,
    };
    const { paid } = poolPayout(USDC(100), USDC(300), USDC(100));
    const stake = ev({ kind: "stake", side: "yes", usdc: USDC(100), via: "pool" });
    const claimed = marketPnl(MARKET, [stake, ev({ kind: "poolPayout", usdc: paid, via: "pool" })], mark);
    expect(claimed).toMatchObject({ realised: paid - USDC(100), costBasis: 0n, unrealised: 0n });

    const waiting = marketPnl(MARKET, [stake], { ...mark, claimablePool: paid });
    expect(waiting).toMatchObject({ realised: 0n, value: paid, unrealised: paid - USDC(100) });

    const lost = marketPnl(MARKET, [ev({ kind: "stake", side: "no", usdc: USDC(40), via: "pool" })], mark);
    expect(lost).toMatchObject({ realised: -USDC(40), costBasis: 0n, unrealised: 0n, total: -USDC(40) });
  });

  it("an open pool has no price", () => {
    const r = marketPnl(MARKET, [ev({ kind: "stake", side: "yes", usdc: USDC(10), via: "pool" })], {
      ...trading(),
      phase: Phase.Pool,
      graduated: false,
      midE6: null,
    });
    expect(r.value).toBeNull();
    expect(r.unrealised).toBeNull();
    expect(r.total).toBeNull();
    expect(r.notes.join(" ")).toMatch(/no price until it graduates or settles/);
  });

  it("a settled book: winners count at their redemption, losers as a realised loss", () => {
    const events = [
      ev({ kind: "buy", side: "yes", tokens: USDC(100), usdc: USDC(75) }),
      ev({ kind: "buy", side: "no", tokens: USDC(50), usdc: USDC(30) }),
    ];
    const r = marketPnl(MARKET, events, {
      ...trading(),
      phase: Phase.Settled,
      outcome: Outcome.Yes,
      balances: { yes: USDC(100), no: USDC(50) },
    });
    // 100 YES redeem for 100 minus ⌈100 · 2% · 100 / 400⌉ = 99.50.
    expect(tokenValue({ ...trading(), phase: Phase.Settled, outcome: Outcome.Yes }, "yes", USDC(100))).toBe(
      USDC(99.5),
    );
    expect(r).toMatchObject({
      realised: -USDC(30),
      costBasis: USDC(75),
      value: USDC(99.5),
      unrealised: USDC(24.5),
    });

    const redeemed = marketPnl(
      MARKET,
      [...events, ev({ kind: "redeem", side: "yes", tokens: USDC(100), usdc: USDC(99.5), via: "vault" })],
      {
        ...trading(),
        phase: Phase.Settled,
        outcome: Outcome.Yes,
        balances: { yes: 0n, no: USDC(50) },
      },
    );
    expect(redeemed).toMatchObject({ realised: USDC(24.5) - USDC(30), costBasis: 0n, unrealised: 0n });
  });

  it("a voided book redeems each token for half a USDC", () => {
    const r = marketPnl(MARKET, [ev({ kind: "buy", side: "yes", tokens: USDC(10), usdc: USDC(6) })], {
      ...trading(),
      phase: Phase.Voided,
      balances: { yes: USDC(10), no: 0n },
    });
    expect(r).toMatchObject({ value: USDC(5), unrealised: -USDC(1) });
  });

  it("mints split their cost evenly, and a merge closes both sides", () => {
    const events = [ev({ kind: "mint", tokens: USDC(10), usdc: USDC(10), via: "vault" })];
    const held = marketPnl(MARKET, events, trading({ balances: { yes: USDC(10), no: USDC(10) } }));
    // 10 YES at 0.62 plus 10 NO at 0.38 is worth exactly the 10 USDC paid.
    expect(held).toMatchObject({ costBasis: USDC(10), value: USDC(10), unrealised: 0n });
    const merged = marketPnl(
      MARKET,
      [...events, ev({ kind: "merge", tokens: USDC(10), usdc: USDC(10), via: "vault" })],
      trading(),
    );
    expect(merged).toMatchObject({ realised: 0n, costBasis: 0n, spent: USDC(10), received: USDC(10) });
  });

  it("says when the history cannot explain the tokens", () => {
    const bought = [ev({ kind: "buy", side: "yes", tokens: USDC(10), usdc: USDC(5) })];
    const movedOut = marketPnl(MARKET, bought, trading({ balances: { yes: USDC(4), no: 0n } }));
    expect(movedOut.costBasis).toBe(USDC(2));
    expect(movedOut.complete).toBe(true);
    expect(movedOut.notes.join(" ")).toMatch(/left the wallet by plain transfer/);

    const extra = marketPnl(MARKET, bought, trading({ balances: { yes: USDC(15), no: 0n } }));
    expect(extra).toMatchObject({ costBasis: USDC(5), complete: false });
    expect(extra.notes.join(" ")).toMatch(/does not explain/);

    const oversold = marketPnl(
      MARKET,
      [ev({ kind: "sell", side: "no", tokens: USDC(5), usdc: USDC(2) })],
      trading(),
    );
    expect(oversold).toMatchObject({ realised: USDC(2), complete: false });
  });

  it("a one-sided book leaves held tokens without a price", () => {
    const r = marketPnl(
      MARKET,
      [ev({ kind: "buy", side: "yes", tokens: USDC(1), usdc: USDC(1) })],
      trading({
        midE6: null,
        balances: { yes: USDC(1), no: 0n },
      }),
    );
    expect(r.unrealised).toBeNull();
  });
});

describe("pnlTotals", () => {
  it("adds realised and priced unrealised, and counts what it left out", () => {
    const a = marketPnl(
      MARKET,
      [ev({ kind: "buy", side: "yes", tokens: USDC(10), usdc: USDC(5) })],
      trading({ balances: { yes: USDC(10), no: 0n } }),
    );
    const b = marketPnl(MARKET, [ev({ kind: "stake", side: "yes", usdc: USDC(3), via: "pool" })], {
      ...trading(),
      phase: Phase.Pool,
      graduated: false,
    });
    expect(pnlTotals([a, b])).toEqual({
      spent: USDC(8),
      received: 0n,
      realised: 0n,
      unrealised: USDC(1.2),
      markets: 2,
      unpriced: 1,
      incomplete: 0,
    });
  });
});

const row = (id: string) => ({
  id,
  block: id.split("-")[0] as string,
  timestamp: "1800000000",
  tx: TX,
  market: { id: MARKET.toLowerCase() },
});

describe("eventsFromHistory", () => {
  it("turns each indexer row into the right event", () => {
    const h: HistoryResult = {
      stakes: [{ ...row("10-1"), side: "Yes", amount: "100000000" }],
      claims: [{ ...row("20-0"), side: "Yes", amount: "133333333" }],
      payouts: [{ ...row("90-0"), kind: "Refund", paid: "5000000", fee: "0" }],
      routerTrades: [
        { ...row("30-2"), kind: "SellYes", usdc: "20000000", tokens: "33333333", priceE6: "600000" },
        { ...row("31-0"), kind: "BuyNo", usdc: "4000000", tokens: "10000000", priceE6: "400000" },
      ],
      setFlows: [{ ...row("40-0"), kind: "Mint", amount: "7000000" }],
      redemptions: [
        { ...row("50-0"), side: "No", amount: "10000000", paid: "9900000", fee: "100000", voided: false },
      ],
      makerFills: [
        { ...row("60-0"), takerBuysYes: true, size: "1000000", notional: "620000", priceE6: "620000" },
      ],
      takerFills: [
        { ...row("61-0"), takerBuysYes: false, size: "2000000", notional: "1200000", priceE6: "600000" },
      ],
    };
    const events = eventsFromHistory(h);
    const pick = (e: PnlEvent) => [e.kind, e.side ?? "", e.tokens, e.usdc, e.via];
    expect(events.map(pick)).toEqual([
      ["stake", "yes", 0n, USDC(100), "pool"],
      ["claim", "yes", 133_333_333n, 0n, "pool"],
      ["poolPayout", "", 0n, USDC(5), "pool"],
      ["sell", "yes", 33_333_333n, USDC(20), "router"],
      ["buy", "no", USDC(10), USDC(4), "router"],
      ["mint", "", USDC(7), USDC(7), "vault"],
      ["redeem", "no", USDC(10), USDC(9.9), "vault"],
      // As the maker, a taker buying YES is this wallet selling it.
      ["sell", "yes", USDC(1), USDC(0.62), "book (maker)"],
      ["sell", "yes", USDC(2), USDC(1.2), "book"],
    ]);
    expect(events[3]).toMatchObject({ block: 30n, logIndex: 2, time: 1_800_000_000, tx: TX });
  });
});

describe("eventsFromChain", () => {
  it("rebuilds stakes and claimed tokens exactly, and leaves unclaimed ones to the ledger", () => {
    const graduated = makeMarket({
      phase: Phase.Graduated,
      graduated: true,
      quote: { bid: 600_000_000_000_000_000n, ask: 640_000_000_000_000_000n },
    });
    const claimed = makeEntry({
      market: graduated,
      stake: { yes: USDC(100), no: 0n },
      balances: { yes: 133_333_333n, no: 0n },
    });
    const events = eventsFromChain([claimed]);
    expect(events.map((e) => [e.kind, e.side, e.tokens, e.usdc, e.derived])).toEqual([
      ["stake", "yes", 0n, USDC(100), true],
      ["claim", "yes", 133_333_333n, 0n, true],
    ]);
    // A pure staker's P&L is exact from chain state alone.
    const r = marketPnl(graduated.address, events, markOf(claimed));
    expect(r.complete).toBe(true);
    expect(r.value).toBe((133_333_333n * 620_000n) / 1_000_000n);

    const unclaimed = makeEntry({
      market: graduated,
      stake: { yes: USDC(100), no: 0n },
      claimableTokens: { yes: 133_333_333n, no: 0n },
    });
    expect(eventsFromChain([unclaimed]).map((e) => e.kind)).toEqual(["stake"]);
    expect(marketPnl(graduated.address, eventsFromChain([unclaimed]), markOf(unclaimed)).costBasis).toBe(
      USDC(100),
    );

    // Someone who also traded holds tokens the stake cannot explain.
    const traded = makeEntry({
      market: graduated,
      stake: { yes: USDC(100), no: 0n },
      balances: { yes: USDC(150), no: 0n },
    });
    expect(marketPnl(graduated.address, eventsFromChain([traded]), markOf(traded)).complete).toBe(false);
  });

  it("rebuilds a claimed pool payout with the contract's math, and a void's refund", () => {
    const settled = makeMarket({ phase: Phase.Settled, outcome: Outcome.Yes });
    const won = eventsFromChain([makeEntry({ market: settled, stake: { yes: USDC(30), no: 0n } })]);
    expect(won[1]).toMatchObject({
      kind: "poolPayout",
      usdc: poolPayout(USDC(30), USDC(300), USDC(100)).paid,
    });

    const voided = makeMarket({ phase: Phase.Voided });
    const refund = eventsFromChain([makeEntry({ market: voided, stake: { yes: USDC(30), no: USDC(5) } })]);
    expect(refund.at(-1)).toMatchObject({ kind: "poolPayout", usdc: USDC(35) });

    // Lost: nothing to rebuild beyond the stake; the ledger books the loss.
    const lost = makeEntry({ market: settled, stake: { yes: 0n, no: USDC(20) } });
    expect(eventsFromChain([lost]).map((e) => e.kind)).toEqual(["stake"]);
    expect(marketPnl(settled.address, eventsFromChain([lost]), markOf(lost)).realised).toBe(-USDC(20));

    // Not claimed yet: the payout is still to come.
    const waiting = makeEntry({
      market: settled,
      stake: { yes: USDC(30), no: 0n },
      claimablePool: { paid: USDC(39), fee: 1n },
    });
    expect(eventsFromChain([waiting]).map((e) => e.kind)).toEqual(["stake"]);
  });

  it("finds markets in the history that the portfolio does not list", () => {
    const other = "0x00000000000000000000000000000000000000a9" as Address;
    const events = [
      ev({ kind: "stake", usdc: 1n }),
      ev({ kind: "buy", market: other, usdc: 1n, tokens: 1n }),
    ];
    expect(missingMarkets(events, [makeEntry()])).toEqual([other]);
    expect(emptyEntry(makeMarket()).balances).toEqual({ yes: 0n, no: 0n });
  });
});

describe("history CSV", () => {
  it("writes one row per event, oldest first, with plain decimals and the price", () => {
    const events = [
      ev({ kind: "sell", side: "yes", tokens: USDC(10), usdc: USDC(6.2), block: 50n }),
      ev({ kind: "stake", side: "yes", usdc: USDC(100), via: "pool", block: 10n }),
      {
        ...ev({ kind: "stake", side: "no", usdc: USDC(1), via: "pool" }),
        time: null,
        block: null,
        tx: null,
        derived: true,
      },
    ];
    const csv = historyCsv(
      events,
      new Map([[MARKET.toLowerCase(), { number: 7, question: '=HYPERLINK("x"), or "y"' }]]),
      "indexer",
    );
    const lines = csv.trim().split("\n");
    expect(lines[0]).toBe(
      "time_utc,block,transaction,market_number,market,question,event,side,tokens,usdc,fee_usdc,price_usdc,via,source",
    );
    expect(lines).toHaveLength(4);
    // The chain-state row has no block, so it comes first; then block 10, then block 50.
    expect(lines[1]).toMatch(/^,,,7,0x0+a1,.*,stake,NO,,1,,,pool,chain state$/);
    expect(lines[2]).toMatch(/,stake,YES,,100,,,pool,indexer$/);
    expect(lines[3]).toMatch(/,sell,YES,10,6\.2,,0\.62,router,indexer$/);
    // A question that looks like a formula is defused and quoted.
    expect(lines[2]).toContain('"\'=HYPERLINK(""x""), or ""y"""');
    expect(lines[2]?.startsWith(new Date((1_800_000_000 + n - 1) * 1000).toISOString().slice(0, 4))).toBe(
      true,
    );
  });

  it("escapes cells and names the file", () => {
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell("-1", true)).toBe("'-1");
    expect(csvCell("-1")).toBe("-1");
    expect(csvFilename("monad-testnet", MARKET, new Date("2026-10-04T12:00:00Z"))).toBe(
      "hunch-book-history-monad-testnet-0x000000-2026-10-04.csv",
    );
  });
});

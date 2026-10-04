import { Phase, Side } from "@hunch-book/shared";
import type { Address } from "viem";
import { describe, expect, it } from "vitest";
import { BookState } from "../src/lib/chain/kuru";
import {
  amountUnit,
  evaluateTicket,
  formatBps,
  formatPriceE6,
  parseSlippagePercent,
  quoteLines,
  type TicketContext,
  tradeDeadline,
  tradeKindOf,
} from "../src/lib/trade/ticket";
import { makeBalances, makeBook, USDC } from "./fixtures";

const ROUTER = "0x00000000000000000000000000000000000000ee" as Address;

const ctx = (overrides: Partial<TicketContext> = {}): TicketContext => ({
  kind: "buyYes",
  amount: USDC(20),
  slippageBps: 100n,
  phase: Phase.Graduated,
  router: ROUTER,
  book: makeBook(),
  wallet: { connected: true, onAppChain: true },
  balances: makeBalances(),
  ...overrides,
});

describe("ticket inputs", () => {
  it("maps tab and side to the router path and its unit", () => {
    expect(tradeKindOf("buy", Side.Yes)).toBe("buyYes");
    expect(tradeKindOf("buy", Side.No)).toBe("buyNo");
    expect(tradeKindOf("sell", Side.Yes)).toBe("sellYes");
    expect(tradeKindOf("sell", Side.No)).toBe("sellNo");
    expect(amountUnit("buyYes")).toBe("USDC");
    expect(amountUnit("buyNo")).toBe("NO");
    expect(amountUnit("sellYes")).toBe("YES");
    expect(amountUnit("sellNo")).toBe("NO");
  });

  it("parses custom slippage from 0.01% to 50%", () => {
    expect(parseSlippagePercent("0.5")).toBe(50n);
    expect(parseSlippagePercent("1")).toBe(100n);
    expect(parseSlippagePercent(" 2.25 % ")).toBe(225n);
    expect(parseSlippagePercent("0.01")).toBe(1n);
    expect(parseSlippagePercent("50")).toBe(5_000n);
    for (const bad of ["", ".", "0", "0.001", "50.01", "-1", "abc", "1.234"]) {
      expect(parseSlippagePercent(bad), bad).toBeNull();
    }
  });

  it("formats basis points, prices and the five-minute deadline", () => {
    expect(formatBps(50n)).toBe("0.5%");
    expect(formatBps(100n)).toBe("1%");
    expect(formatBps(1_428n)).toBe("14.28%");
    expect(formatBps(-25n)).toBe("-0.25%");
    expect(formatPriceE6(416_000n)).toBe("0.416");
    expect(formatPriceE6(428_571n, 4)).toBe("0.4285");
    expect(tradeDeadline(1_800_000_000)).toBe(1_800_000_300n);
  });
});

describe("evaluateTicket", () => {
  it("quotes a buy, sets the limit and asks for an exact USDC approval", () => {
    const state = evaluateTicket(ctx());
    expect(state.blocker).toBeNull();
    expect(state.quote?.tokens).toBe(USDC(50));
    expect(state.limit).toBe(49_500_000n);
    expect(state.approval).toEqual({ token: "usdc", amount: USDC(20), needed: true });
    expect(state.max).toBe(130_000_000n);
  });

  it("skips the approval once the allowance covers it", () => {
    const balances = makeBalances({
      allowance: { usdcToRouter: USDC(20), usdcToVault: 0n, yesToRouter: 0n, noToRouter: 0n },
    });
    expect(evaluateTicket(ctx({ balances })).approval?.needed).toBe(false);
  });

  it("approves the maximum paid for buy NO, and the tokens for sells", () => {
    const buyNo = evaluateTicket(ctx({ kind: "buyNo", amount: USDC(100) }));
    expect(buyNo.quote?.usdc).toBe(USDC(65));
    expect(buyNo.approval).toEqual({ token: "usdc", amount: 65_650_000n, needed: true });
    expect(evaluateTicket(ctx({ kind: "sellYes", amount: USDC(10) })).approval).toEqual({
      token: "yes",
      amount: USDC(10),
      needed: true,
    });
    expect(evaluateTicket(ctx({ kind: "sellNo", amount: USDC(10) })).approval?.token).toBe("no");
  });

  it("explains every reason the trade cannot go", () => {
    const cases: [Partial<TicketContext>, RegExp][] = [
      [{ router: undefined }, /router is not deployed/],
      [{ phase: Phase.Pool }, /only after its pool graduates/],
      [{ phase: Phase.Closed }, /stopped at close/],
      [{ book: null }, /Reading the book/],
      [{ book: makeBook({ state: BookState.SoftPaused }) }, /Kuru has paused/],
      [{ book: makeBook({ asks: [] }) }, /Nobody is selling YES/],
      [{ kind: "sellNo", book: makeBook({ asks: [] }) }, /buys YES from the asks/],
      [{ kind: "sellYes", book: makeBook({ bids: [] }) }, /Nobody is bidding/],
      [{ kind: "buyNo", book: makeBook({ bids: [] }) }, /sells YES into the bids/],
      [{ wallet: { connected: false, onAppChain: false } }, /Connect a browser wallet/],
      [{ wallet: { connected: true, onAppChain: false } }, /Switch your wallet/],
      [{ amount: null }, /Enter an amount/],
      [{ kind: "buyNo", amount: USDC(401) }, /cannot fill that amount\. The bids take 400\.00 YES/],
      [{ kind: "sellNo", amount: USDC(301) }, /The asks hold 300\.00 YES to buy back/],
      [{ amount: USDC(200) }, /cannot fill that amount/],
      [{ amount: 0n }, /Enter an amount/],
      [{ kind: "sellYes", amount: USDC(60) }, /That needs 60\.00 YES\. Your wallet holds 50\.00 YES/],
      [{ amount: USDC(20), balances: makeBalances({ usdc: USDC(5) }) }, /holds 5\.00 USDC/],
      [
        { kind: "buyNo", amount: USDC(100), balances: makeBalances({ usdc: USDC(65) }) },
        /can cost up to 65\.65 USDC/,
      ],
      [{ balances: null }, /Reading your balances/],
    ];
    for (const [overrides, reason] of cases) {
      expect(evaluateTicket(ctx(overrides)).blocker, String(reason)).toMatch(reason);
    }
  });

  it("quotes and offers Max before a wallet connects, from the book alone", () => {
    const state = evaluateTicket(ctx({ wallet: { connected: false, onAppChain: false }, balances: null }));
    expect(state.max).toBe(130_000_000n);
    expect(state.quote?.tokens).toBe(USDC(50));
    expect(state.blocker).toBe("Connect a browser wallet to trade.");
    expect(state.approval).toBeNull();
    // A book problem still comes first.
    const short = evaluateTicket(ctx({ wallet: { connected: false, onAppChain: false }, amount: USDC(200) }));
    expect(short.blocker).toMatch(/cannot fill/);
  });

  it("caps Max by the wallet", () => {
    expect(evaluateTicket(ctx({ kind: "sellYes" })).max).toBe(USDC(50));
    expect(evaluateTicket(ctx({ kind: "buyNo", balances: makeBalances({ usdc: USDC(100) }) })).max).toBe(
      USDC(150),
    );
  });

  it("warns on a large price impact", () => {
    const state = evaluateTicket(ctx({ amount: USDC(100) }));
    expect(state.impactBps).toBe(1_428n);
    // 0.4285 on average against a 0.40 best ask.
    expect(state.warning).toMatch(/7\.14% worse than the best price/);
    expect(evaluateTicket(ctx({ amount: USDC(1) })).warning).toBeNull();
  });
});

describe("quoteLines", () => {
  it("shows what you pay, get, the average, impact and the limit for each path", () => {
    const buy = evaluateTicket(ctx({ amount: USDC(100) }));
    expect(quoteLines(buy, 100n)).toEqual([
      { label: "You pay", value: "100.00 USDC" },
      { label: "You get", value: "233.333333 YES" },
      { label: "Average price per YES", value: "0.4285 USDC" },
      { label: "Price impact vs mid", value: "14.28%" },
      { label: "Minimum received (1%)", value: "230.999999 YES" },
    ]);
    const buyNo = evaluateTicket(ctx({ kind: "buyNo", amount: USDC(100) }));
    expect(quoteLines(buyNo, 100n).map((l) => l.label)).toContain("Maximum paid (1%)");
    const sellNo = evaluateTicket(ctx({ kind: "sellNo", amount: USDC(10), slippageBps: 50n }));
    expect(quoteLines(sellNo, 50n)).toContainEqual({ label: "Minimum received (0.5%)", value: "5.97 USDC" });
    expect(quoteLines(evaluateTicket(ctx({ amount: null })), 100n)).toEqual([]);
  });
});

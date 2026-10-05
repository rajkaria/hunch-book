import { screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ArchiveBody,
  readPairs,
  SettlementsView,
  verifiedText,
} from "../src/components/settlements/SettlementsView";
import { renderWithProviders } from "./render";

const MARKET = "0x2A44B99014cF73065BFb89197a08DE09D18d3982";
const TX = `0x${"2d".repeat(32)}`;

const body: ArchiveBody = {
  network: "monad-testnet",
  total: 2,
  settlements: [
    {
      id: 1,
      market: MARKET,
      title: "Will MON longs pay more than $0.0000015 per MON?",
      template: { id: 1, name: "Perpl net funding" },
      status: "settled",
      outcome: "no",
      settledAt: { block: "68488249", time: "2026-10-05T19:45:55.000Z" },
      settlementTx: {
        hash: TX,
        explorer: `https://testnet.monadscan.com/tx/${TX}`,
        by: "0x1f5AC9bB0DF7d0E0DD133cBd71388e1078475569",
        byHunch: true,
        method: "settle",
      },
      evidence: "0x",
      reads: { delta: "-31", startBlock: "68058301", nested: { skip: true } },
      verified: true,
      error: null,
      links: {
        app: `https://book.playhunch.xyz/m/${MARKET}`,
        verify: `https://book.playhunch.xyz/verify/${MARKET}`,
        evidence: `https://book.playhunch.xyz/api/v1/markets/${MARKET}/evidence`,
        explorer: `https://testnet.monadscan.com/address/${MARKET}`,
      },
    },
    {
      id: 9,
      market: "0x0000000000000000000000000000000000000009",
      title: "A voided market",
      template: { id: 7, name: "Snapshot" },
      status: "voided",
      outcome: "unresolved",
      settledAt: null,
      settlementTx: null,
      evidence: null,
      reads: null,
      verified: null,
      error: "Could not verify this one right now: timeout",
      links: { app: "", verify: "", evidence: "https://example.invalid/e", explorer: "" },
    },
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("settlement archive page", () => {
  it("lists each settlement with its result, transaction, reads and a way to re-run the read", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })),
    );
    await renderWithProviders(<SettlementsView />);
    expect(await screen.findByText("2 finished markets")).toBeTruthy();
    expect(screen.getByText("NO")).toBeTruthy();
    expect(screen.getByText("Voided")).toBeTruthy();
    expect(screen.getByText("Read reproduced")).toBeTruthy();
    expect(screen.getByText("Not checked")).toBeTruthy();
    expect(screen.getByText(/68,488,249/)).toBeTruthy();
    expect(screen.getByText(/\(ours\)/)).toBeTruthy();
    expect(screen.getByText("Transaction not found yet")).toBeTruthy();
    expect(screen.getByText(/timeout/)).toBeTruthy();
    expect(screen.getAllByRole("link", { name: "Re-run the read" })[0]?.getAttribute("href")).toBe(
      `/verify/${MARKET}`,
    );
    expect(screen.getByRole("link", { name: "Download CSV" }).getAttribute("href")).toContain("format=csv");
  });

  it("says when the archive does not answer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: "Could not read the chain right now" }), { status: 502 }),
      ),
    );
    await renderWithProviders(<SettlementsView />);
    expect(await screen.findByText("Could not load the archive")).toBeTruthy();
    expect(screen.getByText(/Could not read the chain right now/)).toBeTruthy();
  });

  it("words the check and keeps only simple reads", () => {
    expect(verifiedText(false).text).toBe("Read does not match");
    expect(readPairs({ a: 1, b: "x", c: { d: 1 } })).toEqual([
      ["a", "1"],
      ["b", "x"],
    ]);
  });
});

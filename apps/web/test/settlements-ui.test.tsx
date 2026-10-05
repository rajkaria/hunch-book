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
      complete: false,
      error: "Could not verify this one right now: timeout",
      links: { app: "", verify: "", evidence: "https://example.invalid/e", explorer: "" },
    },
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

const list = {
  markets: [
    {
      id: 1,
      address: MARKET,
      rule: "Rule one",
      template: { id: 1, name: "Perpl net funding" },
      phase: "settled",
      outcome: "no",
    },
    {
      id: 7,
      address: "0x0000000000000000000000000000000000000007",
      rule: "Still open",
      template: { id: 1, name: "Perpl net funding" },
      phase: "pool",
      outcome: "unresolved",
    },
    {
      id: 9,
      address: "0x0000000000000000000000000000000000000009",
      rule: "A voided market",
      template: { id: 7, name: "Snapshot" },
      phase: "voided",
      outcome: "unresolved",
    },
  ],
};

function stubApi(record: (address: string) => Response | Promise<Response>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/api/v1/markets")) return new Response(JSON.stringify(list), { status: 200 });
    const market = new URL(url, "https://x").searchParams.get("market") ?? "";
    return record(market);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const one = (r: unknown) =>
  new Response(JSON.stringify({ network: "monad-testnet", total: 1, settlements: [r] }), { status: 200 });

describe("settlement archive page", () => {
  it("lists finished markets at once, then fills in each record from its own request", async () => {
    const fetchMock = stubApi((market) =>
      market.toLowerCase() === MARKET.toLowerCase() ? one(body.settlements[0]) : one(body.settlements[1]),
    );
    await renderWithProviders(<SettlementsView />);
    expect(await screen.findByText("2 finished markets")).toBeTruthy();
    expect(await screen.findByText("Read reproduced")).toBeTruthy();
    expect(screen.getByText("NO")).toBeTruthy();
    expect(screen.getByText("Voided")).toBeTruthy();
    expect(screen.getByText(/68,488,249/)).toBeTruthy();
    expect(screen.getByText(/\(ours\)/)).toBeTruthy();
    expect(screen.getByText(/Not found on this load/)).toBeTruthy();
    expect(screen.getByText(/timeout/)).toBeTruthy();
    const verifyLinks = screen
      .getAllByRole("link", { name: "Re-run the read" })
      .map((a) => a.getAttribute("href"));
    // Newest first: market #9, then market #1.
    expect(verifyLinks).toEqual(["/verify/0x0000000000000000000000000000000000000009", `/verify/${MARKET}`]);
    expect(screen.getByRole("link", { name: "Download CSV" }).getAttribute("href")).toContain("format=csv");
    const asked = fetchMock.mock.calls.map(([u]) => String(u)).filter((u) => u.includes("market="));
    expect(asked).toHaveLength(2);
    expect(asked.some((u) => u.includes("0x0000000000000000000000000000000000000007"))).toBe(false);
  });

  it("shows each row while its check is still running", async () => {
    stubApi(() => new Promise<Response>(() => undefined));
    await renderWithProviders(<SettlementsView />);
    expect(await screen.findByText("2 finished markets")).toBeTruthy();
    expect(screen.getAllByText("Checking the read...")).toHaveLength(2);
    expect(screen.getByText("Rule one")).toBeTruthy();
  });

  it("says when the market list does not answer", async () => {
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

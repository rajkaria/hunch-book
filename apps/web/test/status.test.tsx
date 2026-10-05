import { deployments } from "@hunch-book/shared";
import { screen } from "@testing-library/react";
import type { Address } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";
import StatusPage from "../src/app/status/page";
import { contractGroups } from "../src/components/status/ContractLinks";
import {
  checkGas,
  checkGraduation,
  checkGuardian,
  checkObligations,
  checkService,
  checkSettlement,
  checkSolvency,
  checkSupply,
  evaluateChain,
  obligationsBreakdown,
  overall,
  PHASE,
} from "../src/lib/status/checks";
import { fetchServiceHealth, healthUrl, sanitizeHealth } from "../src/lib/status/health";
import { readIncidentLog } from "../src/lib/status/incidentLog";
import { hasIncidents, parseIncidents, parseInline } from "../src/lib/status/incidents";
import { lifecycleFromKeeper, readLifecycleFromIndexer } from "../src/lib/status/lifecycle";
import { readStatusSnapshot, type StatusMarket, type StatusSnapshot } from "../src/lib/status/reads";
import { USDC } from "./fixtures";
import { renderWithProviders } from "./render";

const NOW = 1_800_000_000;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const MON = 10n ** 18n;

function market(over: Partial<StatusMarket> = {}): StatusMarket {
  return {
    address: "0x00000000000000000000000000000000000000a1",
    marketId: 1n,
    templateId: 1,
    phase: PHASE.Graduated,
    outcome: 0,
    graduated: true,
    ruleMet: true,
    window: { blockClock: true, lock: 900n, close: 2_000n, settleDeadline: BigInt(NOW + 7 * 86_400) },
    creator: "0x00000000000000000000000000000000000000c1",
    ledger: { status: 1, pool: 0n, sets: USDC(690) },
    yesSupply: USDC(690),
    noSupply: USDC(690),
    ...over,
  };
}

function snapshot(over: Partial<StatusSnapshot> = {}): StatusSnapshot {
  return {
    block: 1_000n,
    timestamp: NOW,
    secondsPerBlock: 0.4,
    vault: {
      address: "0x00000000000000000000000000000000000000aa",
      usdc: "0x00000000000000000000000000000000000000ab",
      balance: USDC(700),
      totalObligations: USDC(695),
      surplus: USDC(5),
      protocolFees: USDC(3),
      totalCollateral: USDC(690),
      collateralCap: USDC(50_000),
    },
    factory: {
      address: "0x00000000000000000000000000000000000000f1",
      guardian: "0x00000000000000000000000000000000000000d1",
      pendingGuardian: ZERO,
      feeRecipient: "0x00000000000000000000000000000000000000d1",
      creationPaused: false,
      graduationPaused: false,
      marketCount: 1,
    },
    markets: [market()],
    partial: false,
    creatorFees: [{ creator: "0x00000000000000000000000000000000000000c1", fees: USDC(2) }],
    wallets: { keeper: 5n * MON, maker: 5n * MON },
    ...over,
  };
}

describe("chain checks", () => {
  it("solvency: green with a surplus, red when the vault holds less than it owes", () => {
    expect(checkSolvency(snapshot()).level).toBe("ok");
    const short = checkSolvency(
      snapshot({ vault: { ...snapshot().vault, balance: USDC(690), surplus: -USDC(5) } }),
    );
    expect(short.level).toBe("fail");
    expect(short.summary).toMatch(/short by 5.00 USDC/);
  });

  it("obligations: the market ledgers and fee balances add up to the vault's total", () => {
    expect(obligationsBreakdown(snapshot()).total).toBe(USDC(695));
    expect(checkObligations(snapshot()).level).toBe("ok");
    const off = snapshot({ vault: { ...snapshot().vault, totalObligations: USDC(700) } });
    expect(checkObligations(off).level).toBe("fail");
    expect(checkObligations({ ...off, partial: true }).level).toBe("warn");
  });

  it("supply: YES = NO = sets before settlement, and nothing to compare after", () => {
    expect(checkSupply(snapshot()).level).toBe("ok");
    const bad = snapshot({ markets: [market({ noSupply: USDC(689) })] });
    expect(checkSupply(bad).level).toBe("fail");
    expect(checkSupply(bad).details?.[0]).toMatch(/NO supply 689000000/);
    const settled = snapshot({ markets: [market({ phase: PHASE.Settled, outcome: 1, noSupply: 0n })] });
    expect(checkSupply(settled).level).toBe("ok");
  });

  it("settlement: amber after 2 hours, red after 24, red past the deadline", () => {
    const at = (secondsAgo: number) =>
      snapshot({
        markets: [
          market({
            window: {
              blockClock: false,
              lock: 0n,
              close: BigInt(NOW - secondsAgo),
              settleDeadline: BigInt(NOW + 1),
            },
          }),
        ],
      });
    expect(checkSettlement(at(3_600)).level).toBe("ok");
    expect(checkSettlement(at(3 * 3_600)).level).toBe("warn");
    expect(checkSettlement(at(25 * 3_600)).level).toBe("fail");
    const touch = snapshot({
      markets: [
        market({
          templateId: 3,
          window: {
            blockClock: false,
            lock: 0n,
            close: BigInt(NOW - 25 * 3_600),
            settleDeadline: BigInt(NOW + 1),
          },
        }),
      ],
    });
    expect(checkSettlement(touch).level).toBe("ok");
    const expired = snapshot({
      markets: [
        market({ window: { blockClock: false, lock: 0n, close: 0n, settleDeadline: BigInt(NOW - 60) } }),
      ],
    });
    expect(checkSettlement(expired).details?.[0]).toMatch(/not voided/);
  });

  it("graduation: amber when a pool meets its rule and locks within 30 minutes", () => {
    const pool = (lockIn: number) =>
      snapshot({
        markets: [
          market({
            phase: PHASE.Pool,
            graduated: false,
            window: {
              blockClock: false,
              lock: BigInt(NOW + lockIn),
              close: BigInt(NOW + 9e5),
              settleDeadline: BigInt(NOW + 1e6),
            },
          }),
        ],
      });
    expect(checkGraduation(pool(600)).level).toBe("warn");
    expect(checkGraduation(pool(7_200)).level).toBe("ok");
  });

  it("pauses and a pending guardian transfer", () => {
    expect(checkGuardian(snapshot()).level).toBe("ok");
    const paused = checkGuardian(snapshot({ factory: { ...snapshot().factory, graduationPaused: true } }));
    expect(paused.level).toBe("warn");
    expect(paused.summary).toBe("The guardian has paused graduation.");
    const pending = checkGuardian(
      snapshot({
        factory: { ...snapshot().factory, pendingGuardian: "0x00000000000000000000000000000000000000e9" },
      }),
    );
    expect(pending.details?.[0]).toMatch(/waiting to be accepted/);
  });

  it("gas: the watchdog's thresholds", () => {
    expect(checkGas("keeper", 2n * MON).level).toBe("ok");
    expect(checkGas("keeper", MON / 2n).level).toBe("warn");
    expect(checkGas("keeper", MON / 10n).level).toBe("fail");
    expect(checkGas("maker", MON).level).toBe("warn");
  });

  it("the headline is the worst level, ignoring unknowns", () => {
    expect(overall(evaluateChain(snapshot()))).toBe("ok");
    expect(
      overall([
        ...evaluateChain(snapshot()),
        checkService("keeper", { service: "keeper", configured: false, reachable: false }, NOW),
      ]),
    ).toBe("ok");
    expect(overall([checkGas("maker", 0n), checkGas("keeper", MON / 2n)])).toBe("fail");
  });
});

describe("service health", () => {
  const healthy = {
    updatedAt: new Date((NOW - 30) * 1000).toISOString(),
    lastCycleAt: new Date((NOW - 30) * 1000).toISOString(),
    enabled: true,
    keeper: "0x1f5AC9bB0DF7d0E0DD133cBd71388e1078475569",
    monBalance: "12.5",
    secretish: "should not pass",
    jobs: {
      settle: {
        lastActionAt: "2026-10-04T10:00:00.000Z",
        lastAction: {
          at: "2026-10-04T10:00:00.000Z",
          market: "0x2A44B99014cF73065BFb89197a08DE09D18d3982",
          action: "settle",
          status: "success",
          hash: `0x${"ab".repeat(32)}`,
          url: `https://testnet.monadscan.com/tx/0x${"ab".repeat(32)}`,
        },
      },
      bogus: { lastError: "x" },
    },
  };

  it("passes on only known, well-typed fields", () => {
    const view = sanitizeHealth("keeper", healthy);
    expect(view).toMatchObject({ service: "keeper", reachable: true, enabled: true, monBalance: "12.5" });
    expect(JSON.stringify(view)).not.toMatch(/secretish|bogus/);
    expect(view.jobs?.settle?.lastAction?.status).toBe("success");
    expect(sanitizeHealth("keeper", [1, 2]).reachable).toBe(false);
    expect(sanitizeHealth("maker", { monBalance: "lots", openOrders: 4 })).toMatchObject({ openOrders: 4 });
    expect(sanitizeHealth("maker", { monBalance: "lots" }).monBalance).toBeUndefined();
  });

  it("green when the last cycle is recent, red when stale, amber when unreachable or dry run", () => {
    expect(checkService("keeper", sanitizeHealth("keeper", healthy), NOW).level).toBe("ok");
    expect(checkService("keeper", sanitizeHealth("keeper", healthy), NOW + 3_600).level).toBe("fail");
    expect(checkService("keeper", sanitizeHealth("keeper", { ...healthy, enabled: false }), NOW).level).toBe(
      "warn",
    );
    expect(checkService("maker", { service: "maker", configured: true, reachable: false }, NOW).level).toBe(
      "warn",
    );
    expect(checkService("maker", { service: "maker", configured: false, reachable: false }, NOW).level).toBe(
      "unknown",
    );
    expect(checkService("maker", undefined, NOW).summary).toMatch(/maker/);
  });

  it("reads the URL from the public or server-only variable", () => {
    expect(healthUrl("keeper", { NEXT_PUBLIC_KEEPER_HEALTH_URL: "https://k.example/health" })).toBe(
      "https://k.example/health",
    );
    expect(healthUrl("maker", { MAKER_HEALTH_URL: "https://m.example/health" })).toBe(
      "https://m.example/health",
    );
    expect(healthUrl("maker", { MAKER_HEALTH_URL: "ftp://m" })).toBeUndefined();
    expect(healthUrl("keeper", {})).toBeUndefined();
  });

  it("fetches without throwing", async () => {
    expect(await fetchServiceHealth("keeper", undefined)).toEqual({
      service: "keeper",
      configured: false,
      reachable: false,
    });
    const ok = await fetchServiceHealth(
      "keeper",
      "https://k",
      async () => new Response(JSON.stringify(healthy)),
    );
    expect(ok.reachable).toBe(true);
    const down = await fetchServiceHealth(
      "keeper",
      "https://k",
      async () => new Response("no", { status: 503 }),
    );
    expect(down).toMatchObject({ reachable: false, error: "The endpoint answered 503." });
    const dead = await fetchServiceHealth("keeper", "https://k", async () => {
      throw new TypeError("fetch failed");
    });
    expect(dead.error).toBe("The endpoint could not be reached.");
  });

  it("finds the last settlement and graduation in the keeper's health or the indexer", async () => {
    const life = lifecycleFromKeeper(sanitizeHealth("keeper", healthy));
    expect(life?.settlement).toMatchObject({ source: "keeper", tx: `0x${"ab".repeat(32)}` });
    expect(life?.graduation).toBeNull();
    const fromIndexer = await readLifecycleFromIndexer(
      "https://indexer/v1/graphql",
      async () =>
        new Response(
          JSON.stringify({
            data: { settled: [{ id: "0xa1", settledAt: "1799990000", settleTx: "0xtx" }], graduated: [] },
          }),
        ),
    );
    expect(fromIndexer).toEqual({
      settlement: { at: 1_799_990_000, market: "0xa1", tx: "0xtx", source: "indexer" },
      graduation: null,
    });
    expect(await readLifecycleFromIndexer(undefined)).toBeNull();
    expect(
      await readLifecycleFromIndexer("https://i", async () => new Response(JSON.stringify({ errors: [{}] }))),
    ).toBeNull();
  });
});

describe("incident log", () => {
  it("parses headings, paragraphs, lists and links, and nothing else", () => {
    const blocks = parseIncidents(
      "# Incident log\n\nNo incidents so far.\n\n## 2026-10-12: settlement delayed\n\nThe keeper stalled. **Fixed** in\n[tx](https://testnet.monadscan.com/tx/0x1).\n\n- first\n- second <b>x</b>\n",
    );
    expect(blocks.map((b) => b.kind)).toEqual(["paragraph", "heading", "paragraph", "list"]);
    expect(hasIncidents(blocks)).toBe(true);
    expect(parseInline("see [tx](https://x/y) now")).toEqual([
      { kind: "text", text: "see " },
      { kind: "link", text: "tx", href: "https://x/y" },
      { kind: "text", text: " now" },
    ]);
    expect(parseInline("[bad](javascript:alert(1))")).toEqual([
      { kind: "text", text: "[bad](javascript:alert(1))" },
    ]);
  });

  it("reads docs/INCIDENTS.md, with the 2026-10-05 outage as an entry", () => {
    const blocks = readIncidentLog();
    expect(blocks[0]?.kind).toBe("paragraph");
    expect(blocks).toContainEqual({
      kind: "heading",
      text: "2026-10-05: keeper and maker stopped for 22 hours, market #1 settled late",
    });
    expect(hasIncidents(blocks)).toBe(true);
  });
});

describe("contract links", () => {
  it("lists every address in the testnet deployment, ours labelled", () => {
    const groups = contractGroups(deployments["monad-testnet"]);
    const labels = groups.flatMap((g) => g.items.map((i) => i.label));
    expect(labels).toContain("Factory");
    expect(labels).toContain("Resolver 6: parlay");
    expect(labels).toContain("Auto-redeemer");
    expect(labels).toContain("Keeper (ours)");
    expect(labels).toContain("Perpl Exchange");
    expect(groups.flatMap((g) => g.items).every((i) => /^0x[0-9a-fA-F]{40}$/.test(i.address))).toBe(true);
  });
});

describe("chain reads", () => {
  it("reads the vault, the factory, every market and the creators at one block", async () => {
    const calls: { functionName: string }[][] = [];
    const client = {
      getBlock: vi.fn(async ({ blockNumber }: { blockNumber?: bigint } = {}) =>
        blockNumber
          ? { number: blockNumber, timestamp: BigInt(NOW - 4_000) }
          : { number: 50_000n, timestamp: BigInt(NOW) },
      ),
      getBalance: vi.fn(async () => 3n * MON),
      multicall: vi.fn(async ({ contracts }: { contracts: { functionName: string }[] }) => {
        calls.push(contracts);
        return contracts.map((c) => {
          switch (c.functionName) {
            case "balanceOf":
              return USDC(700);
            case "totalObligations":
              return USDC(695);
            case "surplus":
              return USDC(5);
            case "marketCount":
              return 1n;
            case "marketAt":
              return "0x00000000000000000000000000000000000000a1";
            case "tokens":
              return [
                "0x00000000000000000000000000000000000000c1",
                "0x00000000000000000000000000000000000000c2",
              ];
            case "window":
              return { blockClock: true, lock: 1n, close: 2n, settleDeadline: 3n };
            case "creator":
              return "0x00000000000000000000000000000000000000c9";
            case "ledger":
              return { status: 1, pool: 0n, sets: USDC(690) };
            case "totalSupply":
              return USDC(690);
            case "creatorFees":
              return USDC(2);
            case "creationPaused":
            case "graduationPaused":
            case "graduated":
            case "graduationRuleMet":
              return false;
            case "guardian":
            case "pendingGuardian":
            case "feeRecipient":
              return ZERO;
            default:
              return 1n;
          }
        });
      }),
    };
    const s = await readStatusSnapshot(client as never, deployments["monad-testnet"]);
    expect(s.markets).toHaveLength(1);
    expect(s.markets[0]?.yesSupply).toBe(USDC(690));
    expect(s.creatorFees).toEqual([{ creator: "0x00000000000000000000000000000000000000c9", fees: USDC(2) }]);
    expect(s.secondsPerBlock).toBeCloseTo(0.4);
    expect(s.partial).toBe(false);
    expect(calls).toHaveLength(5);
  });
});

// ---------------------------------------------------------------- the page

const state = vi.hoisted(() => ({ snapshot: undefined as unknown, keeper: undefined as unknown }));

vi.mock("@/lib/status/hooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/status/hooks")>();
  return {
    ...actual,
    useStatusSnapshot: () => ({
      data: state.snapshot,
      isPending: state.snapshot === undefined,
      isError: false,
      refetch: vi.fn(),
    }),
    useServiceHealth: (service: string) => ({
      data: service === "keeper" ? state.keeper : { service, configured: false, reachable: false },
    }),
    useIndexerLifecycle: () => ({ data: undefined }),
  };
});

vi.mock("@/lib/hooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/hooks")>();
  return { ...actual, useNow: () => NOW, useTestUsdcFaucet: () => ({ data: undefined }) };
});

describe("status page", () => {
  beforeEach(() => {
    state.snapshot = snapshot();
    state.keeper = { service: "keeper", configured: false, reachable: false };
  });

  it("shows green checks, the money, the markets, the incident log and every contract", async () => {
    await renderWithProviders(<StatusPage />);
    expect(screen.getByRole("heading", { level: 1, name: "Status" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "All checks pass" })).toBeTruthy();
    expect(screen.getByText(/a surplus of 5.00 USDC/)).toBeTruthy();
    expect(
      screen.getByRole("heading", {
        name: "2026-10-05: keeper and maker stopped for 22 hours, market #1 settled late",
      }),
    ).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Every contract" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Keeper (ours)" })).toBeTruthy();
    expect(screen.getAllByText(/No health URL is set for the keeper/).length).toBeGreaterThan(0);
  });

  it("turns red when the vault is short", async () => {
    state.snapshot = snapshot({ vault: { ...snapshot().vault, balance: USDC(1), surplus: -USDC(694) } });
    await renderWithProviders(<StatusPage />);
    expect(screen.getByRole("heading", { name: "A check is failing" })).toBeTruthy();
  });
});

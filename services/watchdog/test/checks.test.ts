import { type Deployment, deployments } from "@hunch-book/shared";
import type { PublicClient } from "viem";
import { describe, expect, it } from "vitest";
import {
  checkBalance,
  checkGraduation,
  checkService,
  checkSettlement,
  checkSolvency,
  checkSupply,
  evaluate,
  type MarketSnapshot,
  Phase,
  type Snapshot,
  DEFAULT_THRESHOLDS as T,
  toMarkdown,
  type VaultSnapshot,
  worst,
} from "../src/checks.js";
import { readSnapshot } from "../src/read.js";

const MON = 10n ** 18n;
const NOW = 1_791_100_000;

function market(over: Partial<MarketSnapshot> = {}): MarketSnapshot {
  return {
    address: "0x2A44B99014cF73065BFb89197a08DE09D18d3982",
    templateId: 2,
    phase: Phase.Graduated,
    outcome: 0,
    blockClock: false,
    lock: BigInt(NOW - 7200),
    close: BigInt(NOW + 3600),
    settleDeadline: BigInt(NOW + 3600 + 7 * 86400),
    graduated: true,
    ruleMet: true,
    yesSupply: 545_000_000n,
    noSupply: 545_000_000n,
    sets: 545_000_000n,
    ...over,
  };
}

function vault(over: Partial<VaultSnapshot> = {}): VaultSnapshot {
  return {
    stack: "primary",
    address: "0x81b04B3567dcaDaE6a859394248C47ddc403ba37",
    balance: 1_000_000_000n,
    obligations: 1_000_000_000n,
    ...over,
  };
}

function snapshot(over: Partial<Snapshot> = {}): Snapshot {
  return {
    network: "monad-testnet",
    block: 68_000_000n,
    timestamp: NOW,
    secondsPerBlock: 0.3,
    vaults: [vault()],
    markets: [market()],
    balances: { keeper: 5n * MON, maker: 9n * MON },
    services: [],
    ...over,
  };
}

describe("solvency", () => {
  it("passes when the vault holds at least what it owes", () => {
    expect(checkSolvency(vault()).level).toBe("ok");
    expect(checkSolvency(vault({ balance: 1_000_000_001n })).level).toBe("ok");
  });
  it("fails when obligations exceed the balance by a single unit", () => {
    expect(checkSolvency(vault({ obligations: 1_000_000_001n })).level).toBe("fail");
  });
  it("checks every stack's vault on its own: one surplus never covers another's gap", () => {
    const hunch = vault({
      stack: "hunch",
      address: "0x68B530302b012f22e5f00Ce0C6C8cF3A189fee86",
      balance: 10n,
      obligations: 11n,
    });
    const findings = evaluate(snapshot({ vaults: [vault({ balance: 10n ** 12n }), hunch] }));
    const solvency = findings.filter((f) => f.check === "solvency");
    expect(solvency.map((f) => [f.level, f.subject])).toEqual([
      ["ok", "0x81b04B3567dcaDaE6a859394248C47ddc403ba37"],
      ["fail", hunch.address],
    ]);
    expect(solvency[1]?.message).toBe("The hunch stack's vault holds 10 but owes 11 USDC base units.");
    expect(worst(findings)).toBe("fail");
  });
});

describe("supply", () => {
  it("is silent when YES = NO = sets, before graduation and after settlement", () => {
    expect(checkSupply(market())).toBeUndefined();
    expect(checkSupply(market({ graduated: false, yesSupply: 0n, noSupply: 0n, sets: 0n }))).toBeUndefined();
    expect(
      checkSupply(market({ phase: Phase.Settled, yesSupply: 10n, noSupply: 3n, sets: 10n })),
    ).toBeUndefined();
  });
  it("fails when any of the three differ", () => {
    expect(checkSupply(market({ noSupply: 544_999_999n }))?.level).toBe("fail");
    expect(checkSupply(market({ sets: 1n }))?.level).toBe("fail");
  });
});

describe("settlement lag", () => {
  const s = snapshot();
  it("waits until close", () => {
    expect(checkSettlement(market(), s, T)).toBeUndefined();
  });
  it("allows two hours, warns after, fails after a day", () => {
    expect(checkSettlement(market({ close: BigInt(NOW - 3600) }), s, T)).toBeUndefined();
    expect(checkSettlement(market({ close: BigInt(NOW - 3 * 3600) }), s, T)?.level).toBe("warn");
    expect(checkSettlement(market({ close: BigInt(NOW - 25 * 3600) }), s, T)?.level).toBe("fail");
  });
  it("measures block-clock markets with the measured block time", () => {
    // 36,000 blocks at 0.3 s = 3 hours past close.
    const m = market({ blockClock: true, close: s.block - 36_000n });
    expect(checkSettlement(m, s, T)?.level).toBe("warn");
    expect(checkSettlement(market({ blockClock: true, close: s.block + 10n }), s, T)).toBeUndefined();
  });
  it("gives touch templates their 24-hour challenge period first", () => {
    const touch = market({ templateId: 3, close: BigInt(NOW - 20 * 3600) });
    expect(checkSettlement(touch, s, T)).toBeUndefined();
    expect(checkSettlement({ ...touch, close: BigInt(NOW - 27 * 3600) }, s, T)?.level).toBe("warn");
  });
  it("ignores settled and voided markets", () => {
    const late = { close: BigInt(NOW - 30 * 3600) };
    expect(checkSettlement(market({ ...late, phase: Phase.Settled, outcome: 1 }), s, T)).toBeUndefined();
    expect(checkSettlement(market({ ...late, phase: Phase.Voided }), s, T)).toBeUndefined();
  });
  it("fails a market past its deadline that nobody voided", () => {
    const f = checkSettlement(
      market({ close: BigInt(NOW - 9 * 86400), settleDeadline: BigInt(NOW - 3600) }),
      s,
      T,
    );
    expect(f?.level).toBe("fail");
    expect(f?.check).toBe("void");
    expect(f?.message).toContain("voidIfExpired");
  });
});

describe("graduation", () => {
  const s = snapshot();
  const pool = market({ phase: Phase.Pool, graduated: false, lock: BigInt(NOW + 600) });
  it("warns when a pool meets its rule and locks within 30 minutes", () => {
    expect(checkGraduation(pool, s, T)?.level).toBe("warn");
  });
  it("is silent with time to spare, without the rule, or after graduation", () => {
    expect(checkGraduation({ ...pool, lock: BigInt(NOW + 3600) }, s, T)).toBeUndefined();
    expect(checkGraduation({ ...pool, ruleMet: false }, s, T)).toBeUndefined();
    expect(checkGraduation(market(), s, T)).toBeUndefined();
  });
});

describe("gas balances", () => {
  it("passes, warns and fails at the thresholds", () => {
    expect(checkBalance("keeper", 2n * MON, T.keeperWarnWei, T.keeperFailWei).level).toBe("ok");
    expect(checkBalance("keeper", MON / 2n, T.keeperWarnWei, T.keeperFailWei).level).toBe("warn");
    expect(checkBalance("keeper", MON / 10n, T.keeperWarnWei, T.keeperFailWei).level).toBe("fail");
    expect(checkBalance("maker", MON / 10n, T.makerWarnWei, T.makerFailWei).message).toBe(
      "The maker has 0.10 MON, below 0.50 MON.",
    );
  });
});

describe("service health", () => {
  const s = snapshot();
  it("passes a fresh cycle and fails a stale one", () => {
    const fresh = new Date((NOW - 60) * 1000).toISOString();
    const stale = new Date((NOW - 3600) * 1000).toISOString();
    expect(checkService({ name: "keeper", lastCycleAt: fresh }, s, T).level).toBe("ok");
    expect(checkService({ name: "keeper", lastCycleAt: stale }, s, T).level).toBe("fail");
  });
  it("warns, not fails, when the endpoint does not answer", () => {
    const f = checkService({ name: "maker", error: "TimeoutError" }, s, T);
    expect(f.level).toBe("warn");
    expect(f.message).toContain("TimeoutError");
  });
});

describe("evaluate", () => {
  it("is ok for a healthy snapshot and says how many markets it checked", () => {
    const findings = evaluate(snapshot());
    expect(worst(findings)).toBe("ok");
    expect(findings.find((f) => f.check === "markets")?.message).toContain("1 market checked");
  });
  it("counts the stacks it checked markets on", () => {
    const findings = evaluate(snapshot({ markets: [market(), market({ stack: "hunch" })] }));
    expect(findings.find((f) => f.check === "markets")?.message).toBe(
      "2 markets on 2 stacks checked: supply, settlement and graduation on time.",
    );
  });
  it("takes the worst level across every rule", () => {
    const findings = evaluate(
      snapshot({
        balances: { keeper: MON / 2n, maker: 9n * MON },
        markets: [market({ close: BigInt(NOW - 30 * 3600) })],
      }),
    );
    expect(worst(findings)).toBe("fail");
    expect(findings.some((f) => f.check === "markets")).toBe(false);
  });
  it("renders a Markdown table with explorer links for market findings", () => {
    const s = snapshot({ markets: [market({ close: BigInt(NOW - 3 * 3600) })] });
    const md = toMarkdown(s, evaluate(s), "https://testnet.monadscan.com");
    expect(md).toContain("**WARN**");
    expect(md).toContain("https://testnet.monadscan.com/address/0x2A44B99014cF73065BFb89197a08DE09D18d3982");
    expect(md).not.toMatch(/—/);
  });
});

describe("reading the chain", () => {
  // Testnet's layout: the primary stack and `hunch` (Hunch Book's own order book), each with its own
  // factory, vault and markets. The reader walks both at one block.
  const testnet = deployments["monad-testnet"];
  const HUNCH_FACTORY = "0x846Cd400B832203befe5902ef43DAdc969985AF2";
  const HUNCH_VAULT = "0x68B530302b012f22e5f00Ce0C6C8cF3A189fee86";
  const HUNCH_MARKET = "0x00000000000000000000000000000000000000b5";
  const deployment: Deployment = {
    ...testnet,
    stacks: { hunch: { ...(testnet.stacks?.hunch ?? {}), factory: HUNCH_FACTORY, vault: HUNCH_VAULT } },
  };
  const primaryFactory = (testnet.hunchBook.factory as string).toLowerCase();

  it("reads every stack's vault and markets", async () => {
    const blocks: (bigint | undefined)[] = [];
    const client = {
      getBlock: async ({ blockNumber }: { blockNumber?: bigint } = {}) => ({
        number: blockNumber ?? 70_000_000n,
        timestamp: blockNumber ? 1_791_000_000n : 1_791_003_000n,
      }),
      getBalance: async () => 5n * MON,
      multicall: async ({
        contracts,
        blockNumber,
      }: {
        contracts: { address: string; functionName: string; args?: unknown[] }[];
        blockNumber?: bigint;
      }) => {
        blocks.push(blockNumber);
        return contracts.map((c) => {
          const hunch = c.address.toLowerCase() === HUNCH_FACTORY.toLowerCase();
          switch (c.functionName) {
            case "balanceOf":
              return c.args?.[0] === HUNCH_VAULT ? 7n : 9n;
            case "totalObligations":
              return c.address === HUNCH_VAULT ? 8n : 9n;
            case "marketCount":
              return c.address.toLowerCase() === primaryFactory ? 0n : hunch ? 1n : 0n;
            case "marketAt":
              return HUNCH_MARKET;
            case "templateId":
              return 2;
            case "phase":
              return Phase.Pool;
            case "outcome":
              return 0;
            case "window":
              return {
                blockClock: false,
                lock: 1_791_100_000n,
                close: 1_791_200_000n,
                settleDeadline: 1_792_000_000n,
              };
            case "graduated":
              return false;
            case "graduationRuleMet":
              return false;
            case "tokens":
              return [
                "0x00000000000000000000000000000000000000c1",
                "0x00000000000000000000000000000000000000c2",
              ];
            case "totalSupply":
              return 0n;
            case "ledger":
              return { sets: 0n };
            default:
              throw new Error(c.functionName);
          }
        });
      },
    } as unknown as PublicClient;
    const s = await readSnapshot(client, { network: "monad-testnet", deployment, rpcUrl: "" });
    expect(s.vaults).toEqual([
      { stack: "primary", address: testnet.hunchBook.vault, balance: 9n, obligations: 9n },
      { stack: "hunch", address: HUNCH_VAULT, balance: 7n, obligations: 8n },
    ]);
    expect(s.markets.map((m) => [m.stack, m.address])).toEqual([["hunch", HUNCH_MARKET]]);
    expect(new Set(blocks)).toEqual(new Set([70_000_000n]));
    // The hunch vault is short by one unit: the check names it.
    expect(evaluate(s).find((f) => f.level === "fail")?.message).toContain("The hunch stack's vault");
  });
});

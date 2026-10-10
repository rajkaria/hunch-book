import { readFileSync } from "node:fs";
import { type Deployment, deployments, Side } from "@hunch-book/shared";
import { type Abi, type Address, decodeFunctionData, getAddress, type Hex, zeroAddress } from "viem";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { JobContext } from "../src/jobs/context.js";
import { canMintTestUsdc, SEED_RETRY_MS, SeriesJob, TEST_USDC_FAUCET_LIMIT } from "../src/jobs/series.js";
import { setLogSink } from "../src/log.js";
import type { MarketMeta } from "../src/markets.js";
import { parseSeriesFile, type SeriesSpec } from "../src/series/config.js";
import { buildParams, periodAt } from "../src/series/schedule.js";

// Seeded series: right after creating a series market, the keeper stakes for our other wallets
// (market.stakeFor, paid from its own USDC) so the pool can meet its graduation rule on its own. On
// Monad testnet it mints what it lacks from the TestUSDC faucet; on mainnet it never mints. Restarts and
// failures never stake a holder twice.

const USDC = 1_000_000n;
const testnet = deployments["monad-testnet"];
const KEEPER = getAddress("0x1f5AC9bB0DF7d0E0DD133cBd71388e1078475569");
const MAKER = testnet.wallets.maker;
const GUARDIAN = getAddress("0xD183a7daECF3d539683f37e1111558E3dFC210A8");
const FACTORY = getAddress("0x846Cd400B832203befe5902ef43DAdc969985AF2");
const VAULT = getAddress("0x68B530302b012f22e5f00Ce0C6C8cF3A189fee86");
const TEST_USDC = testnet.hunchBook.usdc as Address;
const MARKET = getAddress("0x00000000000000000000000000000000000000a1");
const EXAMPLE = new URL("../series.example.json", import.meta.url);

/** The hunch stack's view on testnet, and the same layout claiming to be mainnet. */
const hunchView: Deployment = {
  ...testnet,
  hunchBook: { factory: FACTORY, vault: VAULT, usdc: TEST_USDC, guardian: GUARDIAN },
};
const mainnetView: Deployment = { ...hunchView, network: "monad-mainnet", chainId: 143 };

// A price series with a fixed strike (no Chainlink reads), seeded for the maker and the guardian.
const base = parseSeriesFile(readFileSync(EXAMPLE, "utf8"))[1] as SeriesSpec;
const spec: SeriesSpec = {
  ...base,
  id: "eth-seeded",
  enabled: true,
  strike: { rule: "fixed", value: 400_000_000_000n },
  firstStake: { side: Side.Yes, amount: 55n * USDC },
  seed: {
    stakes: [
      { for: "maker", side: Side.No, amount: 30n * USDC },
      { for: "guardian", side: Side.No, amount: 25n * USDC },
    ],
  },
};
if (spec.schedule.clock !== "time") throw new Error("expected a time schedule");
const period = periodAt(spec.schedule, 0n);
const now = { block: 1n, timestamp: period.createAt };

/** A small stateful chain: the keeper's USDC, its vault allowance, one market and its stakes. */
class FakeChain {
  balance = 0n;
  allowance = 0n;
  created = false;
  phase = 0;
  stakes = new Map<string, bigint>();
  minStake = USDC;
  /** Actions that answer `skipped` instead of going through. */
  failing = new Set<string>();
  sent: { action: string; to: Address; args: readonly unknown[]; fields?: Record<string, unknown> }[] = [];
  lines: Record<string, unknown>[] = [];

  ctx(deployment: Deployment, opts: { chainId?: number; known?: MarketMeta[] } = {}): JobContext {
    return {
      deployment,
      client: {
        readContract: async ({ functionName }: { functionName: string }) => {
          if (functionName === "marketOf") return this.created ? MARKET : zeroAddress;
          if (functionName === "creator") return KEEPER;
          throw new Error(functionName);
        },
        multicall: async ({
          contracts,
        }: {
          contracts: { address: Address; functionName: string; args?: unknown[] }[];
        }) =>
          contracts.map((c) => {
            switch (c.functionName) {
              case "balanceOf":
                return this.balance;
              case "allowance":
                return this.allowance;
              case "creationPaused":
                return false;
              case "phase":
                return this.phase;
              case "caps":
                return {
                  poolCap: 5_000n * USDC,
                  walletCap: 1_000n * USDC,
                  minStake: this.minStake,
                  creatorMinStake: 5n * USDC,
                };
              case "poolTotals": {
                const total = [...this.stakes.values()].reduce((s, x) => s + x, 0n);
                return [total, 0n, this.stakes.size];
              }
              case "stakeOf":
                return [this.stakes.get(String(c.args?.[0]).toLowerCase()) ?? 0n, 0n];
              default:
                throw new Error(c.functionName);
            }
          }),
      },
      tx: { account: KEEPER, enabled: true, chain: { id: opts.chainId ?? deployment.chainId } },
      health: { jobInfo: () => {} },
      alerter: { send: async () => {} },
      verbose: false,
      knownMarkets: () => opts.known ?? [],
      failed: (_job: string, _label: string, error: unknown) => {
        throw error;
      },
      send: async (
        _job: string,
        _label: string,
        request: { action: string; to: Address; data: Hex; abi: Abi; fields?: Record<string, unknown> },
        options: { dryRun?: boolean } = {},
      ) => {
        const { args = [] } = decodeFunctionData({ abi: request.abi, data: request.data });
        this.sent.push({ action: request.action, to: request.to, args, fields: request.fields });
        if (options.dryRun) return { status: "dry-run", simulation: { ok: true } };
        if (this.failing.has(request.action)) return { status: "skipped", reason: "WalletCapExceeded" };
        this.apply(request.action, args);
        return { status: "success", hash: `0x${"ab".repeat(32)}` };
      },
    } as unknown as JobContext;
  }

  private apply(action: string, args: readonly unknown[]): void {
    const amount = (i: number) => args[i] as bigint;
    if (action === "mintTestUsdc") this.balance += amount(1);
    else if (action.startsWith("approve")) this.allowance = amount(1);
    else if (action === "createMarket") {
      this.created = true;
      this.balance -= amount(3);
      this.allowance -= amount(3);
      this.stakes.set(KEEPER.toLowerCase(), amount(3));
    } else if (action === "seedStake") {
      if (this.allowance < amount(2) || this.balance < amount(2))
        throw new Error("the vault could not pull the stake");
      this.balance -= amount(2);
      this.allowance -= amount(2);
      this.stakes.set(String(args[0]).toLowerCase(), amount(2));
    }
  }

  actions(): string[] {
    return this.sent.map((s) => s.action);
  }

  events(event: string): Record<string, unknown>[] {
    return this.lines.filter((l) => l.event === event);
  }
}

let chain: FakeChain;
beforeEach(() => {
  chain = new FakeChain();
  setLogSink((line) => chain.lines.push(JSON.parse(line)));
});
afterEach(() => setLogSink((line) => console.log(line)));

describe("the seed in the series file", () => {
  const file = (seed: unknown) =>
    JSON.stringify({
      series: [
        {
          id: "s",
          template: 1,
          asset: "BTC",
          schedule: { anchorBlock: 1000, everyBlocks: 100 },
          strike: { rule: "fixed", value: "0" },
          firstStake: { side: "yes", usdc: "55" },
          seed,
        },
      ],
    });

  it("parses holders, sides and amounts", () => {
    const [s] = parseSeriesFile(
      file({
        stakes: [
          { for: "maker", side: "no", usdc: "30" },
          { for: "guardian", side: "no", usdc: "25.5" },
          { for: "0x00000000000000000000000000000000000000c1", side: "yes", usdc: "1" },
        ],
      }),
    );
    expect(s?.seed).toEqual({
      stakes: [
        { for: "maker", side: Side.No, amount: 30n * USDC },
        { for: "guardian", side: Side.No, amount: 25_500_000n },
        { for: getAddress("0x00000000000000000000000000000000000000c1"), side: Side.Yes, amount: USDC },
      ],
    });
    // No seed: as before.
    expect(parseSeriesFile(file(undefined))[0]?.seed).toBeUndefined();
  });

  it("refuses the keeper, a holder named twice, and bad sides or amounts", () => {
    const one = (stake: Record<string, unknown>) => () => parseSeriesFile(file({ stakes: [stake] }));
    expect(one({ for: "keeper", side: "yes", usdc: "5" })).toThrow(/cannot be "keeper".*firstStake/);
    expect(one({ for: "someone", side: "yes", usdc: "5" })).toThrow(/"maker", "guardian" or a 0x address/);
    expect(one({ for: "maker", side: "up", usdc: "5" })).toThrow(/side must be "yes" or "no"/);
    expect(one({ for: "maker", side: "no", usdc: "5.1234567" })).toThrow(/usdc must be an amount/);
    expect(one({ for: "maker", side: "no", usdc: "0" })).toThrow(/above zero/);
    expect(() =>
      parseSeriesFile(
        file({
          stakes: [
            { for: "0x00000000000000000000000000000000000000c1", side: "yes", usdc: "5" },
            { for: "0x00000000000000000000000000000000000000C1", side: "no", usdc: "5" },
          ],
        }),
      ),
    ).toThrow(/twice/);
    expect(() => parseSeriesFile(file({ stakes: [] }))).toThrow(/list of stakes/);
  });

  it("ships seeded examples for templates 1 and 4 that meet the testnet rule", () => {
    const specs = parseSeriesFile(readFileSync(EXAMPLE, "utf8"));
    for (const id of ["btc-funding-weekly", "mon-funding-spike-daily"]) {
      const s = specs.find((x) => x.id === id) as SeriesSpec;
      const stakes = [{ side: s.firstStake.side, amount: s.firstStake.amount }, ...(s.seed?.stakes ?? [])];
      const yes = stakes.filter((x) => x.side === Side.Yes).reduce((t, x) => t + x.amount, 0n);
      const no = stakes.filter((x) => x.side === Side.No).reduce((t, x) => t + x.amount, 0n);
      // The hunch stack's rule: 100 USDC from 3 stakers, both sides, chance near 50%.
      expect(stakes.length).toBeGreaterThanOrEqual(3);
      expect(yes + no).toBeGreaterThanOrEqual(100n * USDC);
      expect(yes > 0n && no > 0n).toBe(true);
      expect(Number((yes * 10_000n) / (yes + no))).toBeGreaterThanOrEqual(4_000);
      expect(Number((yes * 10_000n) / (yes + no))).toBeLessThanOrEqual(6_000);
    }
  });
});

describe("seeding a series market", () => {
  it("on testnet: mints what the keeper lacks, approves once, creates, then stakes for each holder", async () => {
    const job = new SeriesJob([spec], { enabled: true });
    const result = await job.run(chain.ctx(hunchView), [], now);
    expect(chain.actions()).toEqual([
      "mintTestUsdc",
      "approveFirstStake",
      "createMarket",
      "seedStake",
      "seedStake",
    ]);
    // 55 first stake + 30 + 25 seed, from an empty wallet, to the keeper itself.
    expect(chain.sent[0]).toMatchObject({ to: TEST_USDC, args: [KEEPER, 110n * USDC] });
    expect(chain.sent[1]?.args).toEqual([VAULT, 110n * USDC]);
    expect(chain.sent[3]).toMatchObject({
      to: MARKET,
      args: [MAKER, Side.No, 30n * USDC],
      fields: { ours: true },
    });
    expect(chain.sent[4]).toMatchObject({ to: MARKET, args: [GUARDIAN, Side.No, 25n * USDC] });
    expect(
      chain.events("series-seed").map((l) => [l.series, l.for, l.address, l.side, l.usdc, l.ours]),
    ).toEqual([
      ["eth-seeded", "maker", MAKER, "no", "30", true],
      ["eth-seeded", "guardian", GUARDIAN, "no", "25", true],
    ]);
    expect(result).toEqual({ sent: 5, due: 1 });
    expect([chain.balance, chain.allowance]).toEqual([0n, 0n]);
    // Done: the next cycle sends nothing.
    chain.sent = [];
    await job.run(chain.ctx(hunchView), [], now);
    expect(chain.sent).toEqual([]);
  });

  it("mints in faucet-sized calls (at most 10,000 test USDC each)", async () => {
    const big: SeriesSpec = {
      ...spec,
      firstStake: { side: Side.Yes, amount: 6_000n * USDC },
      seed: { stakes: [{ for: "maker", side: Side.No, amount: 6_000n * USDC }] },
    };
    await new SeriesJob([big], { enabled: true }).run(chain.ctx(hunchView), [], now);
    expect(chain.sent.filter((s) => s.action === "mintTestUsdc").map((s) => s.args[1])).toEqual([
      TEST_USDC_FAUCET_LIMIT,
      2_000n * USDC,
    ]);
    // The seed itself is above the market's wallet cap (1,000 USDC): refused, never staked.
    expect(chain.actions()).not.toContain("seedStake");
    expect(chain.events("series-seed-invalid")[0]?.reason).toMatch(/above the market's wallet cap/);
  });

  it("never mints on mainnet: a short balance creates the market and leaves the seed waiting", async () => {
    chain.balance = 55n * USDC; // the first stake only
    let clock = 1_000_000;
    const timed = new SeriesJob([spec], { enabled: true }, () => clock);
    await timed.run(chain.ctx(mainnetView), [], now);
    expect(chain.actions()).toEqual(["approveFirstStake", "createMarket"]);
    expect(chain.events("series-seed-unfunded")[0]).toMatchObject({ series: "eth-seeded", market: MARKET });
    // Not again right away, and still nothing minted after the wait.
    chain.sent = [];
    await timed.run(chain.ctx(mainnetView), [], now);
    expect(chain.sent).toEqual([]);
    clock += SEED_RETRY_MS + 1;
    chain.balance = 55n * USDC; // funded since
    await timed.run(chain.ctx(mainnetView, { known: [ours()] }), [], now);
    // The creation's approval already covered the seed: no second approval, and never a mint.
    expect(chain.actions()).toEqual(["seedStake", "seedStake"]);
  });

  it("checks the chain before minting: only Hunch Book's TestUSDC, on Monad testnet", () => {
    const at = (deployment: Deployment, chainId = deployment.chainId) => ({
      deployment,
      tx: { chain: { id: chainId } },
    });
    expect(canMintTestUsdc(at(hunchView), TEST_USDC)).toBe(true);
    expect(canMintTestUsdc(at(hunchView), testnet.external.circleUsdc as Address)).toBe(false);
    expect(canMintTestUsdc(at(hunchView, 143), TEST_USDC)).toBe(false);
    expect(canMintTestUsdc(at(mainnetView), TEST_USDC)).toBe(false);
  });

  it("after a restart: stakes only the holders the market does not have yet", async () => {
    // The previous process created the market and staked for the maker, then stopped.
    chain.created = true;
    chain.stakes.set(KEEPER.toLowerCase(), 55n * USDC);
    chain.stakes.set(MAKER.toLowerCase(), 30n * USDC);
    chain.balance = 100n * USDC;
    chain.allowance = 25n * USDC;
    const job = new SeriesJob([spec], { enabled: true });
    await job.run(chain.ctx(hunchView, { known: [ours()] }), [], now);
    expect(chain.actions()).toEqual(["seedStake"]);
    expect(chain.sent[0]?.args).toEqual([GUARDIAN, Side.No, 25n * USDC]);
    // A second restart: everything staked, nothing sent.
    chain.sent = [];
    await new SeriesJob([spec], { enabled: true }).run(chain.ctx(hunchView, { known: [ours()] }), [], now);
    expect(chain.sent).toEqual([]);
    expect(chain.events("series-seeded").length).toBeGreaterThan(0);
  });

  it("a failed seed stake leaves the market a pool and is retried only after a wait", async () => {
    chain.failing.add("seedStake");
    let clock = 5_000_000;
    const job = new SeriesJob([spec], { enabled: true }, () => clock);
    await job.run(chain.ctx(hunchView), [], now);
    expect(chain.actions()).toEqual(["mintTestUsdc", "approveFirstStake", "createMarket", "seedStake"]);
    expect(chain.events("series-seed-failed")[0]).toMatchObject({ for: "maker", status: "skipped" });
    chain.sent = [];
    await job.run(chain.ctx(hunchView, { known: [ours()] }), [], now);
    expect(chain.sent).toEqual([]);
    chain.failing.clear();
    clock += SEED_RETRY_MS + 1;
    await job.run(chain.ctx(hunchView, { known: [ours()] }), [], now);
    expect(chain.actions()).toEqual(["seedStake", "seedStake"]);
  });

  it("refuses a seed the market's caps do not allow, and one past the pool", async () => {
    chain.minStake = 50n * USDC;
    await new SeriesJob([spec], { enabled: true }).run(chain.ctx(hunchView), [], now);
    expect(chain.actions()).not.toContain("seedStake");
    expect(chain.events("series-seed-invalid")[0]?.reason).toMatch(/below the market's minimum stake/);

    const late = new FakeChain();
    late.created = true;
    late.phase = 2; // graduated already
    late.stakes.set(KEEPER.toLowerCase(), 55n * USDC);
    await new SeriesJob([spec], { enabled: true }).run(late.ctx(hunchView, { known: [ours()] }), [], now);
    expect(late.sent).toEqual([]);
  });

  it("in a dry run: says what it would create and seed, sends nothing", async () => {
    await new SeriesJob([spec], { enabled: false }).run(chain.ctx(hunchView), [], now);
    expect(chain.created).toBe(false);
    expect(chain.stakes.size).toBe(0);
    expect(chain.balance).toBe(0n);
  });

  it("refuses a holder that resolves to the keeper or to no address", async () => {
    const self: SeriesSpec = { ...spec, seed: { stakes: [{ for: KEEPER, side: Side.No, amount: USDC }] } };
    const run = async (s: SeriesSpec, d: Deployment) => {
      const errors: unknown[] = [];
      const ctx = {
        ...chain.ctx(d),
        failed: (_j: string, _l: string, e: unknown) => errors.push(e),
      } as JobContext;
      await new SeriesJob([s], { enabled: true }).run(ctx, [], now);
      return errors.map(String);
    };
    expect(await run(self, hunchView)).toEqual([expect.stringMatching(/keeper's own address/)]);
    const noGuardian = { ...hunchView, hunchBook: { ...hunchView.hunchBook, guardian: undefined } };
    expect(await run(spec, noGuardian)).toEqual([expect.stringMatching(/no guardian/)]);
    expect(chain.sent).toEqual([]);
  });
});

/** The series market as the keeper's directory knows it: created by the keeper for this period. */
function ours(): MarketMeta {
  return {
    address: MARKET,
    templateId: spec.templateId,
    params: buildParams(spec, period, {
      feed: testnet.external.chainlink["ETH/USD"] as Address,
      strike: { strikeE8: 400_000_000_000n },
    }),
    creator: KEEPER,
  } as MarketMeta;
}

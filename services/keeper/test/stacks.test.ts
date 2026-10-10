import { type Deployment, deployments, impliedProbabilityOracleAbi, Phase } from "@hunch-book/shared";
import { type Address, decodeFunctionData, getAddress } from "viem";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import type { JobContext } from "../src/jobs/context.js";
import { setLogSink } from "../src/log.js";
import type { MarketSnapshot } from "../src/markets.js";
import { buildKeepers } from "../src/stacks.js";

const a = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const testnet = deployments["monad-testnet"];
const config = parseConfig({
  KEEPER_STATE_FILE: "/tmp/k/state.json",
  KEEPER_HEALTH_FILE: "/tmp/k/health.json",
});

const twoStacks: Deployment = {
  ...testnet,
  hunchBook: { factory: a(1), vault: a(2), usdc: a(3), deployBlock: 1 },
  stacks: {
    kuruV2: {
      factory: a(11),
      vault: a(12),
      usdc: a(3),
      deployBlock: 2,
      kuruVersion: 2,
      periphery: { impliedProbabilityOracle: a(13), kuruFeedFactory: a(14) },
    },
  },
};

describe("one keeper per stack", () => {
  it("runs every deployed stack, primary first, each on its own view and files", () => {
    const [primary, v2] = buildKeepers(config, twoStacks, { cycleJobs: undefined });
    expect(primary?.stackName).toBe("primary");
    expect(primary?.kuruVersion).toBe(1);
    expect(primary?.deployment.hunchBook.factory).toBe(a(1));
    expect(v2?.stackName).toBe("kuruV2");
    expect(v2?.kuruVersion).toBe(2);
    expect(v2?.deployment.hunchBook.factory).toBe(a(11));
    expect(v2?.config.stateFile).toBe("/tmp/k/state.kuruV2.json");
    expect(v2?.cycleJobs.map((j) => j.name)).toEqual(["kuruFeeds", "oracle"]);
    expect(v2?.health.current()).toMatchObject({ stack: "kuruV2", kuruVersion: 2 });
  });

  it("pokes a Kuru v2 stack's graduated markets on the book interval and its pools on the pool interval", async () => {
    const [, v2] = buildKeepers(
      parseConfig({ KEEPER_ORACLE_POKE_SECONDS: "7200", KEEPER_KURU_POKE_SECONDS: "900" }),
      twoStacks,
    );
    const now = 10_000n;
    // Seconds since each market's last poke, and its phase.
    const markets: [Address, number, Phase, boolean][] = [
      [a(21), 120, Phase.Pool, false], // pool, poked 2 minutes ago: not due
      [a(22), 120, Phase.Graduated, true], // book live, 2 minutes: due
      [a(23), 30, Phase.Graduated, true], // book live, 30 seconds: not due
      [a(24), 120, Phase.Closed, true], // closed, not settled yet: due
      [a(25), 900, Phase.Pool, false], // pool, 15 minutes: due
      [a(26), 9_000, Phase.Settled, true], // settled: never
    ];
    const poked: Address[][] = [];
    const ctx = {
      config: v2?.config,
      client: {
        multicall: async ({ contracts }: { contracts: { args: [Address] }[] }) =>
          contracts.map(({ args: [m] }) => ({
            timestamp: Number(now) - (markets.find(([x]) => x === m)?.[1] ?? 0),
          })),
      },
      health: { jobInfo: () => {} },
      send: async (_job: string, _key: string, req: { data: `0x${string}` }) => {
        const { args } = decodeFunctionData({ abi: impliedProbabilityOracleAbi, data: req.data });
        poked.push([...(args[0] as readonly Address[])]);
        return { status: "success" };
      },
    } as unknown as JobContext;
    const snapshots = markets.map(
      ([address, , phase, graduated]) => ({ address, phase, graduated }) as MarketSnapshot,
    );
    const oracle = v2?.cycleJobs.find((j) => j.name === "oracle");
    await oracle?.run(ctx, snapshots, { block: 1n, timestamp: now });
    expect(poked.flat()).toEqual([a(22), a(24), a(25)]);
  });

  it("runs only the stacks in KEEPER_STACKS, and refuses names that are not deployed", () => {
    const only = buildKeepers({ ...config, stacks: ["kuruV2"] }, twoStacks);
    expect(only.map((k) => k.stackName)).toEqual(["kuruV2"]);
    expect(() => buildKeepers({ ...config, stacks: ["nope"] }, twoStacks)).toThrow(/nope/);
  });

  it("keeps one idle keeper on a network with no factory yet", () => {
    const empty: Deployment = { ...testnet, hunchBook: {}, stacks: undefined };
    const keepers = buildKeepers(config, empty);
    expect(keepers).toHaveLength(1);
    expect(keepers[0]?.stackName).toBe("primary");
  });
});

// Testnet's layout: the primary stack on Kuru v1, `kuruV2` on Kuru v2, and `hunch` on Hunch Book's own
// order book, which is where new markets go (`defaultStack`).
const SERIES_FILE = new URL("../series.example.json", import.meta.url).pathname;
const venue = { kind: "hunch" as const, bookFactory: a(31), marginAccount: a(32), bookImplementation: a(33) };
const threeStacks: Deployment = {
  ...twoStacks,
  stacks: {
    ...twoStacks.stacks,
    hunch: {
      factory: a(21),
      vault: a(22),
      usdc: a(3),
      graduator: a(23),
      deployBlock: 3,
      kuruVersion: 1,
      venue,
      // A periphery with a Kuru v2 feed factory: the Kuru v2 jobs must still stay off on a Hunch venue.
      periphery: { impliedProbabilityOracle: a(24), kuruFeedFactory: a(25) },
    },
  },
  defaultStack: "hunch",
};
const seriesConfig = parseConfig({
  KEEPER_STATE_FILE: "/tmp/k/state.json",
  KEEPER_HEALTH_FILE: "/tmp/k/health.json",
  KEEPER_SERIES_FILE: SERIES_FILE,
});
const jobNames = (k: { cycleJobs: { name: string }[] } | undefined) => k?.cycleJobs.map((j) => j.name);
const seriesOtherFactories = (k: { cycleJobs: { name: string }[] } | undefined) => {
  const series = k?.cycleJobs.find((j) => j.name === "series") as unknown as
    | { opts: { otherFactories: Address[] } }
    | undefined;
  return series?.opts.otherFactories;
};

describe("the hunch stack", () => {
  it("points the keeper's Kuru v1 addresses at Hunch Book's own book factory and margin account", () => {
    const [primary, v2, hunch] = buildKeepers(config, threeStacks);
    expect(hunch?.stackName).toBe("hunch");
    expect(hunch?.kuruVersion).toBe(1);
    expect(hunch?.venue).toBe("hunch");
    expect(hunch?.deployment.hunchBook.factory).toBe(a(21));
    expect(hunch?.deployment.external.kuru).toEqual({ router: a(31), marginAccount: a(32) });
    // Its transactions are built from the same view.
    expect(hunch?.tx.deployment.external.kuru.router).toBe(a(31));
    expect(hunch?.config.stateFile).toBe("/tmp/k/state.hunch.json");
    expect(hunch?.health.current()).toMatchObject({ stack: "hunch", kuruVersion: 1, venue: "hunch" });

    // The Kuru stacks keep Kuru's addresses.
    expect(primary?.venue).toBe("kuru");
    expect(primary?.deployment.external.kuru).toEqual(testnet.external.kuru);
    expect(primary?.health.current()).toMatchObject({ stack: "primary", venue: "kuru" });
    expect(v2?.venue).toBe("kuru");
    expect(v2?.deployment.external.kuru).toEqual(testnet.external.kuru);
  });

  it("never runs a Kuru v2 job on a Hunch venue: oracle pokes for live books only", async () => {
    const [, v2, hunch] = buildKeepers(config, threeStacks);
    expect(jobNames(v2)).toEqual(["kuruFeeds", "oracle"]);
    expect(jobNames(hunch)).toEqual(["oracle"]);
    // v1 oracle rules: a pool is never poked, a live book is (on the oracle interval, not Kuru v2's).
    const poked: Address[] = [];
    const ctx = {
      config: hunch?.config,
      client: {
        multicall: async ({ contracts }: { contracts: unknown[] }) => contracts.map(() => ({ timestamp: 0 })),
      },
      health: { jobInfo: () => {} },
      send: async (_job: string, _key: string, req: { data: `0x${string}` }) => {
        const { args } = decodeFunctionData({ abi: impliedProbabilityOracleAbi, data: req.data });
        poked.push(...(args[0] as readonly Address[]));
        return { status: "success" };
      },
    } as unknown as JobContext;
    const snapshots = [
      { address: a(41), phase: Phase.Pool, graduated: false },
      { address: a(42), phase: Phase.Graduated, graduated: true },
    ] as MarketSnapshot[];
    await hunch?.cycleJobs[0]?.run(ctx, snapshots, { block: 1n, timestamp: 10_000n });
    expect(poked.map(getAddress)).toEqual([getAddress(a(42))]);
  });

  it("runs series on the default stack, checking the other stacks' factories for each period", () => {
    const keepers = buildKeepers(seriesConfig, threeStacks);
    expect(keepers.map((k) => [k.stackName, jobNames(k)?.includes("series")])).toEqual([
      ["primary", false],
      ["kuruV2", false],
      ["hunch", true],
    ]);
    expect(seriesOtherFactories(keepers[2])).toEqual([a(1), a(11)]);
  });

  it("keeps series on the primary stack when defaultStack is absent", () => {
    const keepers = buildKeepers(seriesConfig, { ...threeStacks, defaultStack: undefined });
    expect(keepers.map((k) => [k.stackName, jobNames(k)?.includes("series")])).toEqual([
      ["primary", true],
      ["kuruV2", false],
      ["hunch", false],
    ]);
    expect(seriesOtherFactories(keepers[0])).toEqual([a(11), a(21)]);
    // A defaultStack that names no deployed stack falls back to the primary one too.
    const typo = buildKeepers(seriesConfig, { ...threeStacks, defaultStack: "nope" });
    expect(jobNames(typo[0])).toContain("series");
  });

  it("warns, and runs no series, when KEEPER_STACKS leaves the default stack out", () => {
    const lines: Record<string, unknown>[] = [];
    setLogSink((line) => lines.push(JSON.parse(line)));
    try {
      const keepers = buildKeepers({ ...seriesConfig, stacks: ["primary", "kuruV2"] }, threeStacks);
      expect(keepers.some((k) => jobNames(k)?.includes("series"))).toBe(false);
      expect(lines.find((l) => l.event === "series-off")).toMatchObject({
        level: "warn",
        defaultStack: "hunch",
        stacks: ["primary", "kuruV2"],
      });
    } finally {
      setLogSink((line) => console.log(line));
    }
  });
});

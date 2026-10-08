import { type Deployment, deployments, impliedProbabilityOracleAbi, Phase } from "@hunch-book/shared";
import { type Address, decodeFunctionData } from "viem";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import type { JobContext } from "../src/jobs/context.js";
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

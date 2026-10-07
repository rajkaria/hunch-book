import { type Deployment, deployments } from "@hunch-book/shared";
import type { Address } from "viem";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
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

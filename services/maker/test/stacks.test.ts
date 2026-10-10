import { type Deployment, deployments } from "@hunch-book/shared";
import type { Address } from "viem";
import { describe, expect, it } from "vitest";
import { configForStack, parseConfig } from "../src/config.js";
import { bookStateStatus } from "../src/kuru.js";
import { buildMakers } from "../src/stacks.js";
import { v2Orders } from "../src/v2.js";

const a = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const testnet = deployments["monad-testnet"];
const config = parseConfig({ MAKER_HEALTH_FILE: "/tmp/m/health.json" });

const twoStacks: Deployment = {
  ...testnet,
  hunchBook: { factory: a(1), vault: a(2), usdc: a(3) },
  stacks: { kuruV2: { factory: a(11), vault: a(12), usdc: a(3), kuruVersion: 2 } },
};

describe("one bot per stack", () => {
  it("quotes every deployed stack on its own Kuru version and health file", () => {
    const [primary, v2] = buildMakers(config, twoStacks);
    expect(primary?.stackName).toBe("primary");
    expect(primary?.kuruVersion).toBe(1);
    expect(primary?.depsV2).toBeUndefined();
    expect(v2?.stackName).toBe("kuruV2");
    expect(v2?.kuruVersion).toBe(2);
    expect(v2?.depsV2?.accountCore).toBe(testnet.external.kuruV2?.accountCore);
    expect(v2?.config.healthFile).toBe("/tmp/m/health.kuruV2.json");
    expect(v2?.health.current()).toMatchObject({ stack: "kuruV2", kuruVersion: 2 });
  });

  it("picks stacks with MAKER_STACKS and refuses unknown names", () => {
    const only = buildMakers({ ...parseConfig({ MAKER_STACKS: "kuruV2" }) }, twoStacks);
    expect(only.map((m) => m.stackName)).toEqual(["kuruV2"]);
    expect(() => buildMakers({ ...config, stacks: ["nope"] }, twoStacks)).toThrow(/nope/);
    expect(configForStack(config, { name: "primary", primary: true })).toBe(config);
  });

  it("needs Kuru's v2 AccountCore address for a v2 stack", () => {
    const noKuru: Deployment = { ...twoStacks, external: { ...twoStacks.external, kuruV2: undefined } };
    expect(() => buildMakers({ ...config, stacks: ["kuruV2"] }, noKuru)).toThrow(
      /external.kuruV2.accountCore/,
    );
  });
});

describe("the hunch stack", () => {
  // Testnet's layout: primary on Kuru v1, kuruV2 on Kuru v2, hunch on Hunch Book's own order book.
  const venue = {
    kind: "hunch" as const,
    bookFactory: a(31),
    marginAccount: a(32),
    bookImplementation: a(33),
  };
  const threeStacks: Deployment = {
    ...twoStacks,
    stacks: {
      ...twoStacks.stacks,
      hunch: { factory: a(21), vault: a(22), usdc: a(3), kuruVersion: 1, venue },
    },
    defaultStack: "hunch",
  };

  it("quotes on every deployed stack by default, the hunch one as a v1 bot on Hunch's margin account", () => {
    const makers = buildMakers(config, threeStacks);
    expect(makers.map((m) => [m.stackName, m.kuruVersion, m.venue])).toEqual([
      ["primary", 1, "kuru"],
      ["kuruV2", 2, "kuru"],
      ["hunch", 1, "hunch"],
    ]);
    const [primary, , hunch] = makers;
    expect(hunch?.depsV2).toBeUndefined();
    expect(hunch?.deps.marginAccount).toBe(a(32));
    expect(hunch?.deployment.external.kuru).toEqual({ router: a(31), marginAccount: a(32) });
    expect(hunch?.tx.deployment.hunchBook.factory).toBe(a(21));
    expect(hunch?.config.healthFile).toBe("/tmp/m/health.hunch.json");
    expect(hunch?.health.current()).toMatchObject({ stack: "hunch", kuruVersion: 1, venue: "hunch" });
    // The Kuru v1 stack keeps Kuru's margin account.
    expect(primary?.deps.marginAccount).toBe(testnet.external.kuru.marginAccount);
    expect(primary?.health.current()).toMatchObject({ stack: "primary", venue: "kuru" });
  });

  it("MAKER_STACKS can pick the hunch stack alone", () => {
    const only = buildMakers(parseConfig({ MAKER_STACKS: "hunch" }), threeStacks);
    expect(only.map((m) => [m.stackName, m.venue, m.deps.marginAccount])).toEqual([
      ["hunch", "hunch", a(32)],
    ]);
  });

  it("reads book state 1 as cancels only (Kuru's soft pause, or a Hunch book whose market is not trading)", () => {
    expect(bookStateStatus(1)).toEqual({
      status: "book-cancels-only",
      reason: "the book takes cancels only",
    });
    expect(bookStateStatus(2)).toEqual({ status: "book-paused", reason: "book paused" });
  });
});

describe("v2 orders", () => {
  it("encodes bids and asks as GTC post-only batch orders", () => {
    expect(
      v2Orders({ bids: [{ price: 405_000, size: 10_000_000n }], asks: [{ price: 435_000, size: 2n }] }),
    ).toEqual([
      {
        side: 0,
        quantity: 10_000_000n,
        price: 405_000,
        tif: 0,
        executionInstruction: 1,
        minSizeAfterBlock: 0,
      },
      { side: 1, quantity: 2n, price: 435_000, tif: 0, executionInstruction: 1, minSizeAfterBlock: 0 },
    ]);
  });
});

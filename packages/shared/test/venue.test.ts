import type { Address } from "viem";
import { describe, expect, it } from "vitest";
import {
  type Deployment,
  defaultStackOf,
  deploymentForStack,
  deployments,
  rpcUrlsOf,
  stackNamed,
  stacksOf,
  venueLabel,
  venueOf,
} from "../src/index.js";

// Hunch Book's own order book (docs/PROTOCOL.md §8.1, "Hunch order book"): a stack whose `venue` is
// "hunch" trades on Hunch's books, which speak Kuru v1's interface.

const a = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;

const d: Deployment = {
  ...deployments["monad-testnet"],
  hunchBook: { factory: a(1), router: a(2) },
  stacks: {
    kuruV2: { factory: a(3), router: a(4), kuruVersion: 2 },
    hunch: {
      factory: a(5),
      router: a(6),
      kuruVersion: 1,
      venue: { kind: "hunch", bookFactory: a(7), marginAccount: a(8), bookImplementation: a(9) },
    },
  },
  defaultStack: "hunch",
};

describe("venues", () => {
  it("marks each stack's venue", () => {
    expect(stacksOf(d).map((s) => [s.name, s.venue])).toEqual([
      ["primary", "kuru"],
      ["kuruV2", "kuru"],
      ["hunch", "hunch"],
    ]);
    expect(venueOf({})).toBe("kuru");
  });

  it("names the venue in copy", () => {
    expect(venueLabel({ venue: "hunch", kuruVersion: 1 })).toBe("Hunch order book");
    expect(venueLabel({ venue: "kuru", kuruVersion: 2 })).toBe("Kuru v2");
    expect(venueLabel({ venue: "kuru", kuruVersion: 1 })).toBe("Kuru");
  });

  it("points a Hunch stack's view of external.kuru at its own book factory and margin account", () => {
    const hunch = stackNamed(d, "hunch");
    const primary = stackNamed(d, "primary");
    if (!hunch || !primary) throw new Error("missing stack");
    const view = deploymentForStack(d, hunch);
    expect(view.hunchBook.factory).toBe(a(5));
    expect(view.external.kuru).toEqual({ router: a(7), marginAccount: a(8) });
    expect(view.external.perpl).toBe(d.external.perpl);
    // Kuru stacks keep Kuru's addresses.
    expect(deploymentForStack(d, primary).external.kuru).toBe(d.external.kuru);
  });

  it("finds the default stack, or falls back to the primary", () => {
    expect(defaultStackOf(d)?.name).toBe("hunch");
    expect(defaultStackOf({ ...d, defaultStack: undefined })?.name).toBe("primary");
    expect(defaultStackOf({ ...d, defaultStack: "gone" })?.name).toBe("primary");
    expect(defaultStackOf({ ...d, hunchBook: {}, stacks: {} })).toBeUndefined();
  });

  it("the testnet file has a Hunch stack and makes it the default", () => {
    const t = deployments["monad-testnet"];
    const hunch = defaultStackOf(t);
    expect(hunch?.name).toBe("hunch");
    expect(hunch?.venue).toBe("hunch");
    expect(hunch?.kuruVersion).toBe(1);
    expect(hunch?.contracts.venue?.marginAccount).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(hunch?.contracts.usdc).toBe(t.hunchBook.usdc);
  });
});

describe("rpc endpoints", () => {
  it("puts a private RPC first, then the file's RPC and its fallbacks, without repeats", () => {
    const t = deployments["monad-testnet"];
    const urls = rpcUrlsOf(t);
    expect(urls[0]).toBe(t.rpc);
    expect(urls.length).toBeGreaterThan(1);
    expect(new Set(urls).size).toBe(urls.length);
    expect(rpcUrlsOf(t, " https://private.example ")[0]).toBe("https://private.example");
    expect(rpcUrlsOf({ rpc: "https://a", rpcFallbacks: ["https://a", "https://b"] }, "https://b")).toEqual([
      "https://b",
      "https://a",
    ]);
    expect(rpcUrlsOf({ rpc: "https://a" })).toEqual(["https://a"]);
  });
});

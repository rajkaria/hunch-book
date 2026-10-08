import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deployments, Phase } from "@hunch-book/shared";
import { type Address, getAddress } from "viem";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { applyOptIns } from "../src/jobs/autoRedeem.js";
import { Backoff } from "../src/jobs/context.js";
import { buildCycleJobs } from "../src/jobs/index.js";
import { hasLiveBook, marketsDue } from "../src/jobs/oracle.js";
import { parseState, StateStore } from "../src/state.js";

const h = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`);
const FACTORY = "0x2c30da53F8C384D6eD6603E3138a98fd15E4928A" as Address;

describe("auto-redeem opt-ins", () => {
  it("keeps holders whose latest OptInSet is true, in first-seen order", () => {
    expect(
      applyOptIns(
        [h(1)],
        [
          { holder: h(2), optedIn: true },
          { holder: h(3), optedIn: true },
          { holder: h(1), optedIn: false },
          { holder: h(2), optedIn: true },
          { holder: h(1), optedIn: true },
        ],
      ),
    ).toEqual([h(2), h(3), h(1)]);
    expect(applyOptIns([h(1)], [{ holder: h(4), optedIn: false }])).toEqual([h(1)]);
  });

  it("saves holders and the scan cursor per AutoRedeemer, and starts over for a new one", () => {
    const file = join(mkdtempSync(join(tmpdir(), "keeper-state-")), "state.json");
    const store = new StateStore(file, "monad-testnet", FACTORY);
    store.updateAutoRedeem(h(9), (s) => {
      s.optedIn = [h(1), h(2)];
      s.cursor = 68_050_000;
    });
    store.save();
    const again = new StateStore(file, "monad-testnet", FACTORY);
    expect(again.autoRedeem(h(9))).toEqual({ redeemer: h(9), cursor: 68_050_000, optedIn: [h(1), h(2)] });
    expect(again.autoRedeem(h(8))).toEqual({ redeemer: h(8), optedIn: [] });
    expect(
      parseState(
        '{"version":1,"network":"monad-testnet","factory":"x","markets":{}}',
        "monad-testnet",
        FACTORY,
      ).autoRedeem,
    ).toBeUndefined();
  });
});

describe("oracle pokes", () => {
  it("pokes markets never poked or last poked at least the interval ago", () => {
    expect(
      marketsDue(
        [
          { address: h(1), lastPoke: 0n },
          { address: h(2), lastPoke: 1_000n },
          { address: h(3), lastPoke: 1_299n },
          { address: h(4), lastPoke: 1_301n },
        ],
        1_600n,
        300,
      ),
    ).toEqual([h(1), h(2), h(3)]);
  });

  it("a market's own interval wins over the shared one", () => {
    expect(
      marketsDue(
        [
          { address: h(1), lastPoke: 1_500n, pokeSeconds: 60 },
          { address: h(2), lastPoke: 1_560n, pokeSeconds: 60 },
          { address: h(3), lastPoke: 1_500n },
          { address: h(4), lastPoke: 1_000n, pokeSeconds: undefined },
        ],
        1_600n,
        300,
      ),
    ).toEqual([h(1), h(4)]);
  });

  it("only markets with a live book", () => {
    expect(hasLiveBook({ graduated: true, phase: Phase.Graduated })).toBe(true);
    expect(hasLiveBook({ graduated: true, phase: Phase.Closed })).toBe(true);
    expect(hasLiveBook({ graduated: true, phase: Phase.Settled })).toBe(false);
    expect(hasLiveBook({ graduated: false, phase: Phase.PoolLocked })).toBe(false);
  });
});

describe("Backoff", () => {
  it("waits the first delay, doubling to the longest, and can pause without counting a failure", () => {
    let now = 0;
    const b = new Backoff(60, 300, () => now);
    expect(b.waiting("x")).toBe(false);
    expect(b.fail("x")).toBe(60);
    expect(b.waiting("x")).toBe(true);
    now = 60_000;
    expect(b.waiting("x")).toBe(false);
    expect(b.fail("x")).toBe(120);
    expect(b.fail("x")).toBe(240);
    expect(b.fail("x")).toBe(300);
    b.clear("x");
    expect(b.fail("x")).toBe(60);
    b.pause("y", 10);
    expect(b.waiting("y")).toBe(true);
  });
});

describe("which cycle jobs run", () => {
  const testnet = deployments["monad-testnet"];

  it("every periphery job whose contract is deployed, the series job only with a file", () => {
    const names = buildCycleJobs(parseConfig({}), testnet).map((j) => j.name);
    expect(names).toEqual(["autoRedeem", "orders", "oracle"]);
  });

  it("switches jobs off by name, and the oracle with a zero interval", () => {
    expect(
      buildCycleJobs(parseConfig({ KEEPER_JOBS_OFF: "orders, autoRedeem" }), testnet).map((j) => j.name),
    ).toEqual(["oracle"]);
    expect(
      buildCycleJobs(parseConfig({ KEEPER_ORACLE_POKE_SECONDS: "0" }), testnet).map((j) => j.name),
    ).toEqual(["autoRedeem", "orders"]);
    expect(() => parseConfig({ KEEPER_JOBS_OFF: "graduate" })).toThrow(/unknown job "graduate"/);
  });

  it("runs none on a network without the periphery", () => {
    expect(buildCycleJobs(parseConfig({}), deployments["monad-mainnet"])).toEqual([]);
  });

  it("adds the series job from KEEPER_SERIES_FILE", () => {
    const file = new URL("../series.example.json", import.meta.url).pathname;
    const names = buildCycleJobs(parseConfig({ KEEPER_SERIES_FILE: file }), testnet).map((j) => j.name);
    expect(names).toContain("series");
  });
});

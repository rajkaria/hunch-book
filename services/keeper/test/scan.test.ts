import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Address, PublicClient } from "viem";
import { describe, expect, it } from "vitest";
import {
  logWindows,
  ScanBudget,
  type ScanContext,
  scanMarketCreated,
  scanStakers,
  stakersComplete,
} from "../src/scan.js";
import { RpcStakerSource } from "../src/stakers.js";
import { emptyState, parseState, StateStore } from "../src/state.js";

const FACTORY = "0x2c30da53F8C384D6eD6603E3138a98fd15E4928A" as Address;
const MARKET = "0x2A44B99014cF73065BFb89197a08DE09D18d3982" as Address;
const OTHER = "0x00000000000000000000000000000000000000Aa" as Address;
const user = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;

interface FakeLog {
  address: Address;
  blockNumber: bigint;
  args: Record<string, unknown>;
}

/** A client whose getLogs serves `logs` by address and block range, recording every request. */
function fakeClient(logs: FakeLog[]) {
  const calls: { address: Address; fromBlock: bigint; toBlock: bigint }[] = [];
  const client = {
    async getLogs(req: { address: Address; fromBlock: bigint; toBlock: bigint }) {
      calls.push({ address: req.address, fromBlock: req.fromBlock, toBlock: req.toBlock });
      if (req.toBlock - req.fromBlock + 1n > 100n) throw new Error("block range exceeds 100");
      return logs.filter(
        (l) => l.address === req.address && l.blockNumber >= req.fromBlock && l.blockNumber <= req.toBlock,
      );
    },
  };
  return { client: client as unknown as PublicClient, calls };
}

const tempFile = () => join(mkdtempSync(join(tmpdir(), "keeper-state-")), "state.json");

function ctx(client: PublicClient, store: StateStore, head: bigint, budget = 1_000): ScanContext {
  return { client, store, head, range: 100, budget: new ScanBudget(budget) };
}

const HISTORY: FakeLog[] = [
  { address: FACTORY, blockNumber: 1_150n, args: { market: OTHER } },
  { address: FACTORY, blockNumber: 1_420n, args: { market: MARKET } },
  { address: MARKET, blockNumber: 1_420n, args: { user: user(1) } },
  { address: MARKET, blockNumber: 1_500n, args: { user: user(2) } },
  { address: MARKET, blockNumber: 1_501n, args: { user: user(1) } },
  { address: MARKET, blockNumber: 1_777n, args: { user: user(3) } },
];

describe("logWindows", () => {
  it("cuts a range into windows of at most `range` blocks", () => {
    expect(logWindows(1_000n, 1_250n, 100)).toEqual([
      { from: 1_000n, to: 1_099n },
      { from: 1_100n, to: 1_199n },
      { from: 1_200n, to: 1_250n },
    ]);
    expect(logWindows(5n, 5n, 100)).toEqual([{ from: 5n, to: 5n }]);
    expect(logWindows(6n, 5n, 100)).toEqual([]);
    expect(logWindows(0n, 999n, 100, 2)).toHaveLength(2);
  });
});

describe("factory scan", () => {
  it("finds a market's creation block from MarketCreated, in 100-block windows from the deploy block", async () => {
    const { client, calls } = fakeClient(HISTORY);
    const store = new StateStore(tempFile(), "monad-testnet", FACTORY);
    const result = await scanMarketCreated(ctx(client, store, 5_000n), FACTORY, 1_000, MARKET);
    expect(result.done).toBe(true);
    expect(store.market(MARKET).createdBlock).toBe(1_420);
    expect(store.market(OTHER).createdBlock).toBe(1_150); // found on the way
    // It stops at the window holding the market, not at the head.
    expect(calls.map((c) => [c.fromBlock, c.toBlock])).toEqual([
      [1_000n, 1_099n],
      [1_100n, 1_199n],
      [1_200n, 1_299n],
      [1_300n, 1_399n],
      [1_400n, 1_499n],
    ]);
    expect(store.factoryCursor).toBe(1_500);
  });

  it("spends at most its budget per cycle and resumes from the saved cursor", async () => {
    const file = tempFile();
    const first = fakeClient(HISTORY);
    const store = new StateStore(file, "monad-testnet", FACTORY);
    const partial = await scanMarketCreated(ctx(first.client, store, 5_000n, 2), FACTORY, 1_000, MARKET);
    expect(partial).toEqual({ cursor: 1_200, done: false });
    expect(first.calls).toHaveLength(2);
    store.save();

    // A restart: a new store from the same file carries on at block 1,200.
    const second = fakeClient(HISTORY);
    const reopened = new StateStore(file, "monad-testnet", FACTORY);
    expect(reopened.factoryCursor).toBe(1_200);
    await scanMarketCreated(ctx(second.client, reopened, 5_000n), FACTORY, 1_000, MARKET);
    expect(second.calls[0]?.fromBlock).toBe(1_200n);
    expect(reopened.market(MARKET).createdBlock).toBe(1_420);
  });
});

describe("staker scan", () => {
  it("collects stakers once each, and is complete only after passing the block where staking closed", async () => {
    const { client, calls } = fakeClient(HISTORY);
    const store = new StateStore(tempFile(), "monad-testnet", FACTORY);
    store.update(MARKET, (m) => {
      m.createdBlock = 1_420;
    });

    const open = await scanStakers(ctx(client, store, 1_600n), MARKET);
    expect(open).toEqual({ cursor: 1_601, complete: false });
    expect(store.market(MARKET).stakers).toEqual([user(1), user(2)]);

    store.update(MARKET, (m) => {
      m.stakingClosedAt = 1_800;
    });
    const done = await scanStakers(ctx(client, store, 5_000n), MARKET);
    expect(done).toEqual({ cursor: 1_801, complete: true });
    expect(store.market(MARKET).stakers).toEqual([user(1), user(2), user(3)]);
    // It reads only up to where staking closed, never on to the head.
    expect(calls.at(-1)?.toBlock).toBe(1_800n);
    const before = calls.length;
    await scanStakers(ctx(client, store, 9_000n), MARKET);
    expect(calls.length).toBe(before);
    expect(stakersComplete(store.market(MARKET))).toBe(true);
  });

  it("RpcStakerSource finds the creation block first, then the stakers", async () => {
    const { client } = fakeClient(HISTORY);
    const store = new StateStore(tempFile(), "monad-testnet", FACTORY);
    store.update(MARKET, (m) => {
      m.stakingClosedAt = 1_800;
    });
    const source = new RpcStakerSource(FACTORY, 1_000);
    const list = await source.stakers(MARKET, ctx(client, store, 2_000n));
    expect(list.users).toEqual([user(1), user(2), user(3)]);
    expect(list.complete).toBe(true);
    expect(list.detail).toBe("3 stakers from Staked logs (complete)");

    const tight = new StateStore(tempFile(), "monad-testnet", FACTORY);
    const partial = await source.stakers(MARKET, ctx(fakeClient(HISTORY).client, tight, 2_000n, 1));
    expect(partial).toMatchObject({ users: [], complete: false });
    expect(partial.detail).toMatch(
      /looking for the market's creation block: factory scan at block 1100 of 2000/,
    );

    const noDeployBlock = new RpcStakerSource(FACTORY, undefined);
    const missing = await noDeployBlock.stakers(
      MARKET,
      ctx(client, new StateStore(tempFile(), "x", FACTORY), 2_000n),
    );
    expect(missing.detail).toMatch(/deployBlock is missing/);
  });
});

describe("state file", () => {
  it("round-trips through the file, and writes only when something changed", () => {
    const file = tempFile();
    const store = new StateStore(file, "monad-testnet", FACTORY);
    store.save();
    expect(existsSync(file)).toBe(false);
    store.factoryCursor = 123;
    store.addStakers(MARKET, [user(5), user(5).toUpperCase().replace("0X", "0x") as Address, user(6)]);
    store.update(MARKET, (m) => {
      m.bookRequestedAt = 1_700_000_000;
    });
    store.save();
    const saved = JSON.parse(readFileSync(file, "utf8"));
    expect(saved).toMatchObject({
      version: 1,
      network: "monad-testnet",
      factory: FACTORY,
      factoryCursor: 123,
    });
    const reopened = new StateStore(file, "monad-testnet", FACTORY);
    expect(reopened.market(MARKET)).toEqual({ stakers: [user(5), user(6)], bookRequestedAt: 1_700_000_000 });
  });

  it("starts fresh for another network, another factory, or a damaged file", () => {
    const file = tempFile();
    const store = new StateStore(file, "monad-testnet", FACTORY);
    store.factoryCursor = 9;
    store.save();
    expect(new StateStore(file, "monad-mainnet", FACTORY).factoryCursor).toBeUndefined();
    expect(new StateStore(file, "monad-testnet", OTHER).factoryCursor).toBeUndefined();
    writeFileSync(file, "{ not json");
    expect(new StateStore(file, "monad-testnet", FACTORY).factoryCursor).toBeUndefined();
    expect(parseState("[]", "monad-testnet", FACTORY)).toEqual(emptyState("monad-testnet", FACTORY));
  });
});

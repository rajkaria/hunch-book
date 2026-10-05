import { deployments, marketAbi, Phase } from "@hunch-book/shared";
import {
  type Address,
  ContractFunctionZeroDataError,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  type Hex,
} from "viem";
import { describe, expect, it, vi } from "vitest";
import type { HunchContext } from "../src/context.js";
import { findSettlementTx } from "../src/index.js";

// findSettlementTx against a stub client: the market is created at CREATED, settles at SETTLED, and the
// RPC can be told to fail reads, the way public RPCs drop bursts of historical calls.

const MARKET = "0x00000000000000000000000000000000000000a1" as Address;
const KEEPER = "0x1f5AC9bB0DF7d0E0DD133cBd71388e1078475569" as Address;
const HASH = `0x${"2d".repeat(32)}` as Hex;
const CREATED = 1_000n;
const SETTLED = 51_234n;
const HEAD = 60_000n;

function stubContext(failRead: (block: bigint, attempt: number) => boolean, prunedBelow = 0n) {
  const attempts = new Map<bigint, number>();
  const readContract = vi.fn(async ({ blockNumber }: { blockNumber: bigint }) => {
    const n = (attempts.get(blockNumber) ?? 0) + 1;
    attempts.set(blockNumber, n);
    if (blockNumber < prunedBelow) throw new Error("missing trie node: state is not available");
    if (failRead(blockNumber, n)) throw new Error("RPC Request failed.");
    if (blockNumber < CREATED) {
      throw new ContractFunctionZeroDataError({ functionName: "phase" });
    }
    return blockNumber >= SETTLED ? Phase.Settled : Phase.Closed;
  });
  const topics = encodeEventTopics({ abi: marketAbi, eventName: "Settled" } as never);
  const settledEvent = marketAbi.find((i) => i.type === "event" && i.name === "Settled") as unknown as {
    inputs: { name: string; type: string; indexed?: boolean }[];
  };
  const indexed = settledEvent.inputs.filter((i) => i.indexed);
  const plain = settledEvent.inputs.filter((i) => !i.indexed);
  const valueFor = (t: string, name: string): unknown =>
    t === "address"
      ? KEEPER
      : t.startsWith("uint")
        ? name.toLowerCase().includes("outcome")
          ? 2
          : 0n
        : `0x${"00".repeat(32)}`;
  const getLogs = vi.fn(async ({ fromBlock }: { fromBlock: bigint }) =>
    fromBlock === SETTLED
      ? [
          {
            address: MARKET,
            topics: [
              ...(topics as Hex[]).slice(0, 1),
              ...indexed.map((i) => encodeAbiParameters([{ type: i.type }], [valueFor(i.type, i.name)])),
            ],
            data: encodeAbiParameters(
              plain.map((i) => ({ type: i.type })),
              plain.map((i) => valueFor(i.type, i.name)),
            ),
            transactionHash: HASH,
          },
        ]
      : [],
  );
  const ctx = {
    deployment: {
      ...deployments["monad-testnet"],
      hunchBook: { ...deployments["monad-testnet"].hunchBook, deployBlock: 500 },
    },
    publicClient: {
      getBlockNumber: vi.fn(async () => HEAD),
      readContract,
      getLogs,
      getTransaction: vi.fn(async () => ({
        to: MARKET,
        from: KEEPER,
        input: encodeFunctionData({ abi: marketAbi, functionName: "settle", args: ["0x"] }),
      })),
      getBlock: vi.fn(async () => ({ timestamp: 1_791_229_555n })),
    },
  } as unknown as HunchContext;
  return { ctx, readContract };
}

describe("findSettlementTx", () => {
  it("finds the block where the market became final and reads its transaction", async () => {
    const { ctx } = stubContext(() => false);
    const tx = await findSettlementTx(ctx, { address: MARKET }, { retryBaseMs: 0 });
    expect(tx).toMatchObject({ block: SETTLED, hash: HASH, kind: "settled", method: "settle", by: KEEPER });
  });

  it("retries reads the RPC dropped, and still lands on the right block", async () => {
    // Every historical read fails twice before it answers.
    const { ctx, readContract } = stubContext((_b, attempt) => attempt <= 2);
    const tx = await findSettlementTx(ctx, { address: MARKET }, { retryBaseMs: 0 });
    expect(tx?.block).toBe(SETTLED);
    expect(readContract.mock.calls.length).toBeGreaterThan(20);
  });

  it("throws instead of guessing when a read keeps failing", async () => {
    const { ctx } = stubContext((b) => b > 30_000n && b < 40_000n);
    await expect(findSettlementTx(ctx, { address: MARKET }, { retryBaseMs: 0 })).rejects.toThrow(
      /RPC Request failed/,
    );
  });

  it("reads blocks whose state the node pruned as not final, without retrying them", async () => {
    const { ctx, readContract } = stubContext(() => false, 20_000n);
    expect((await findSettlementTx(ctx, { address: MARKET }, { retryBaseMs: 0 }))?.block).toBe(SETTLED);
    const pruned = readContract.mock.calls
      .filter(([a]) => a.blockNumber < 20_000n)
      .map(([a]) => a.blockNumber);
    expect(new Set(pruned).size).toBe(pruned.length);
  });

  it("returns null for a market that is not final, without searching", async () => {
    const { ctx, readContract } = stubContext(() => false);
    const notFinal = {
      ...ctx,
      publicClient: { ...ctx.publicClient, getBlockNumber: async () => SETTLED - 1n },
    };
    expect(
      await findSettlementTx(notFinal as HunchContext, { address: MARKET }, { retryBaseMs: 0 }),
    ).toBeNull();
    expect(readContract).toHaveBeenCalledTimes(1);
  });
});

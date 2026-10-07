import { type Deployment, deployments, Phase } from "@hunch-book/shared";
import { type Address, maxUint256, zeroAddress } from "viem";
import { vi } from "vitest";
import type { ReadClient } from "../src/lib/chain/client";
import { FACTORY, priceParams, RESOLVER, USDC } from "./fixtures";

// A fake chain for read-layer tests: answers contract reads by function name.

// Single-stack deployments: tests of extra stacks build their own (kuru-v2.test.ts).
export const notDeployed: Deployment = { ...deployments["monad-testnet"], hunchBook: {}, stacks: undefined };
export const deployed: Deployment = {
  ...deployments["monad-testnet"],
  stacks: undefined,
  hunchBook: {
    factory: FACTORY,
    vault: "0x00000000000000000000000000000000000000aa",
    usdc: "0x00000000000000000000000000000000000000ab",
  },
};

export const marketAddr = (i: number): Address => `0x${(0xa0 + i).toString(16).padStart(40, "0")}` as Address;
export const BOOK = "0x00000000000000000000000000000000000000bb" as Address;

export type Handler = (address: Address, args: readonly unknown[] | undefined) => unknown;

/** A fake chain: answers reads by function name, fails anything it does not know. */
export function stubClient(
  handlers: Record<string, Handler>,
  blocks: Record<string, bigint> = {},
): ReadClient {
  const answer = (c: { address: Address; functionName: string; args?: readonly unknown[] }) => {
    const h = handlers[c.functionName];
    if (!h) throw new Error(`no handler for ${c.functionName}`);
    return h(c.address, c.args);
  };
  return {
    readContract: vi.fn(async (c) => answer(c as never)),
    multicall: vi.fn(async ({ contracts }: { contracts: readonly unknown[] }) =>
      contracts.map((c) => {
        try {
          return { status: "success", result: answer(c as never) };
        } catch (error) {
          return { status: "failure", error };
        }
      }),
    ),
    getBlock: vi.fn(async (p: { blockNumber?: bigint; blockTag?: string }) => {
      const number = p.blockNumber ?? 2_000_000n;
      return { number, timestamp: blocks[number.toString()] ?? 0n };
    }),
  } as unknown as ReadClient;
}

export function marketHandlers(
  count: number,
  overrides: Record<string, Handler> = {},
): Record<string, Handler> {
  return {
    marketCount: () => BigInt(count),
    marketAt: (_a, args) => marketAddr(Number(args?.[0])),
    isMarket: (_a, args) =>
      String(args?.[0]).toLowerCase().startsWith("0x00000000000000000000000000000000000000a"),
    phase: (a) => (a === marketAddr(1) ? Phase.Graduated : Phase.Pool),
    poolTotals: () => [USDC(300), USDC(100), 4],
    window: () => ({
      blockClock: false,
      lock: 1_800_000_000n,
      close: 1_800_086_400n,
      settleDeadline: 1_800_691_200n,
    }),
    tokens: () => [
      "0x00000000000000000000000000000000000000c1",
      "0x00000000000000000000000000000000000000c2",
    ],
    book: (a) => (a === marketAddr(1) ? BOOK : zeroAddress),
    outcome: () => 0,
    templateId: () => 2,
    params: () => priceParams,
    resolver: () => RESOLVER,
    caps: () => ({
      poolCap: USDC(5_000),
      walletCap: USDC(1_000),
      minStake: USDC(1),
      creatorMinStake: USDC(5),
    }),
    rule: () => ({ minPool: USDC(500), minStakers: 10, minChanceBps: 300, maxChanceBps: 9_700 }),
    creator: () => "0x00000000000000000000000000000000000000d1",
    graduated: (a) => a === marketAddr(1),
    evidenceHash: () => `0x${"00".repeat(32)}`,
    marketId: (a) => BigInt(Number.parseInt(a.slice(-2), 16) - 0xa0),
    graduationRuleMet: () => false,
    describe: () => "Will BTC/USD be at or above $120,000 at the close?",
    bestBidAsk: () => [maxUint256, 620_000_000_000_000_000n],
    ...overrides,
  };
}

import { type Deployment, deployments, Phase } from "@hunch-book/shared";
import { type Address, maxUint256, zeroAddress } from "viem";
import { describe, expect, it, vi } from "vitest";
import type { ReadClient } from "../src/lib/chain/client";
import {
  listMarkets,
  measureMsPerBlock,
  readMarket,
  readMarketHeadline,
  readPortfolio,
  readProtocolAddresses,
  readUsdcState,
  readUserPosition,
} from "../src/lib/chain/reads";
import { FACTORY, priceParams, RESOLVER, USDC, USER } from "./fixtures";

const notDeployed: Deployment = { ...deployments["monad-testnet"], hunchBook: {} };
const deployed: Deployment = {
  ...deployments["monad-testnet"],
  hunchBook: {
    factory: FACTORY,
    vault: "0x00000000000000000000000000000000000000aa",
    usdc: "0x00000000000000000000000000000000000000ab",
  },
};

const marketAddr = (i: number): Address => `0x${(0xa0 + i).toString(16).padStart(40, "0")}` as Address;
const BOOK = "0x00000000000000000000000000000000000000bb" as Address;

type Handler = (address: Address, args: readonly unknown[] | undefined) => unknown;

/** A fake chain: answers reads by function name, fails anything it does not know. */
function stubClient(handlers: Record<string, Handler>, blocks: Record<string, bigint> = {}): ReadClient {
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

function marketHandlers(count: number, overrides: Record<string, Handler> = {}): Record<string, Handler> {
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

describe("listMarkets", () => {
  it("returns not-deployed without touching the chain", async () => {
    const client = stubClient({});
    expect(await listMarkets(client, notDeployed)).toEqual({ status: "not-deployed" });
    expect(client.readContract).not.toHaveBeenCalled();
  });

  it("lists markets newest first with their rule, pool and book quote", async () => {
    const client = stubClient(marketHandlers(3));
    const result = await listMarkets(client, deployed);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.data.total).toBe(3);
    expect(result.data.markets.map((m) => m.address)).toEqual([marketAddr(2), marketAddr(1), marketAddr(0)]);
    const graduated = result.data.markets[1];
    expect(graduated?.phase).toBe(Phase.Graduated);
    expect(graduated?.book).toBe(BOOK);
    expect(graduated?.quote).toEqual({ bid: null, ask: 620_000_000_000_000_000n });
    const pool = result.data.markets[0];
    expect(pool?.book).toBeNull();
    expect(pool?.quote).toBeNull();
    expect(pool?.pool).toEqual({ yes: USDC(300), no: USDC(100), total: USDC(400), stakers: 4 });
    expect(pool?.description).toBe("Will BTC/USD be at or above $120,000 at the close?");
    expect(pool?.decoded.kind).toBe("price-at-time");
  });

  it("reads only the newest markets past the limit", async () => {
    const client = stubClient(marketHandlers(5));
    const result = await listMarkets(client, deployed, { limit: 2 });
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.data.total).toBe(5);
    expect(result.data.markets.map((m) => m.address)).toEqual([marketAddr(4), marketAddr(3)]);
  });

  it("returns an empty list when the factory has no markets", async () => {
    const result = await listMarkets(stubClient(marketHandlers(0)), deployed);
    expect(result).toEqual({ status: "ok", data: { markets: [], total: 0 } });
  });

  it("skips a market whose core reads fail, and survives a failing describe", async () => {
    const client = stubClient(
      marketHandlers(2, {
        window: (a) => {
          if (a === marketAddr(0)) throw new Error("revert");
          return { blockClock: false, lock: 1n, close: 2n, settleDeadline: 3n };
        },
        describe: () => {
          throw new Error("revert");
        },
      }),
    );
    const result = await listMarkets(client, deployed);
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.data.markets.map((m) => m.address)).toEqual([marketAddr(1)]);
    expect(result.data.markets[0]?.description).toBeNull();
  });
});

describe("readMarket", () => {
  it("refuses an address the factory does not list", async () => {
    const stranger = "0x1111111111111111111111111111111111111111" as Address;
    expect(await readMarket(stubClient(marketHandlers(1)), deployed, stranger)).toEqual({
      status: "not-market",
    });
  });

  it("reads a listed market", async () => {
    const result = await readMarket(stubClient(marketHandlers(2)), deployed, marketAddr(0));
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.data.marketId).toBe(0n);
  });

  it("throws when the factory cannot be asked, so the page can offer a retry", async () => {
    const client = stubClient(
      marketHandlers(1, {
        isMarket: () => {
          throw new Error("rpc down");
        },
      }),
    );
    await expect(readMarket(client, deployed, marketAddr(0))).rejects.toThrow("rpc down");
  });

  it("is not-deployed without a factory", async () => {
    expect(await readMarket(stubClient({}), notDeployed, marketAddr(0))).toEqual({ status: "not-deployed" });
  });

  it("builds a headline for page metadata, or null", async () => {
    expect(await readMarketHeadline(stubClient(marketHandlers(1)), deployed, marketAddr(0))).toBe(
      "Will BTC/USD be at or above $120,000 at the close?",
    );
    const noDescribe = stubClient(
      marketHandlers(1, {
        describe: () => {
          throw new Error("x");
        },
      }),
    );
    expect(await readMarketHeadline(noDescribe, deployed, marketAddr(0))).toMatch(
      /^Will the asset be at or above/,
    );
    const broken = stubClient(
      marketHandlers(1, {
        isMarket: () => {
          throw new Error("down");
        },
      }),
    );
    expect(await readMarketHeadline(broken, deployed, marketAddr(0))).toBeNull();
  });
});

describe("wallet reads", () => {
  const handlers = marketHandlers(2, {
    stakeOf: (a) => (a === marketAddr(0) ? [USDC(25), 0n] : [0n, 0n]),
    claimableTokens: () => [0n, 0n],
    claimablePool: () => [0n, 0n],
    balanceOf: () => 0n,
    allowance: () => USDC(10),
  });

  it("keeps only markets where the wallet has something", async () => {
    const result = await readPortfolio(stubClient(handlers), deployed, USER);
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.data).toHaveLength(1);
    expect(result.data[0]?.market.address).toBe(marketAddr(0));
    expect(result.data[0]?.stake).toEqual({ yes: USDC(25), no: 0n });
  });

  it("reads one position", async () => {
    const p = await readUserPosition(stubClient(handlers), marketAddr(0), USER);
    expect(p.stake.yes).toBe(USDC(25));
  });

  it("reads USDC balance and allowance to the vault", async () => {
    const state = await readUsdcState(
      stubClient({ balanceOf: () => USDC(50), allowance: () => USDC(10) }),
      deployed.hunchBook.usdc as Address,
      deployed.hunchBook.vault as Address,
      USER,
    );
    expect(state).toEqual({ balance: USDC(50), allowance: USDC(10) });
  });

  it("takes the vault and USDC from deployments, and from the factory only when missing", async () => {
    const client = stubClient({
      vault: () => "0x00000000000000000000000000000000000000ee",
      usdc: () => zeroAddress,
    });
    expect(await readProtocolAddresses(client, deployed)).toEqual({
      vault: deployed.hunchBook.vault,
      usdc: deployed.hunchBook.usdc,
    });
    expect(client.readContract).not.toHaveBeenCalled();
    const partial = { ...deployed, hunchBook: { factory: FACTORY, usdc: deployed.hunchBook.usdc } };
    expect((await readProtocolAddresses(client, partial))?.vault).toBe(
      "0x00000000000000000000000000000000000000ee",
    );
    expect(await readProtocolAddresses(client, notDeployed)).toBeNull();
  });
});

describe("measureMsPerBlock", () => {
  it("measures the chain's pace over recent blocks", async () => {
    const client = stubClient({}, { "2000000": 1_000_004_000n, "1990000": 1_000_000_000n });
    expect(await measureMsPerBlock(client, 2_000_000n)).toBe(400);
  });

  it("gives up on a young chain", async () => {
    expect(await measureMsPerBlock(stubClient({}), 5_000n)).toBeNull();
  });
});

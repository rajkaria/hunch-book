import {
  collateralVaultAbi,
  type Deployment,
  encodePerplFundingParams,
  hunchBookFactoryAbi,
  kuruV2OrderBookAbi,
  marketAbi,
  Phase,
} from "@hunch-book/shared";
import type { Address } from "viem";
import { beforeEach, describe, expect, it } from "vitest";
import { getMarket, getOrderBook, listMarkets, mintSets, quote, stake } from "../src/index.js";
import { FakeChain } from "./fake-chain.js";
import {
  addr,
  blockWindow,
  type FakeMarket,
  Ledger,
  registerFactory,
  registerMarket,
  registerResolver,
  registerToken,
  testnet,
  USDC,
  VAULT,
} from "./fixtures.js";

// A deployment with two stacks (docs/PROTOCOL.md §8.1): the primary one on Kuru v1 and `kuruV2`, with its
// own factory, vault and router. The SDK lists both, tags each market with its stack, reads v2 prices and
// books, and sends stakes and set mints to the market's own stack.

const FACTORY2 = addr(0xf2);
const VAULT2 = addr(0xf3);
const ROUTER2 = addr(0xf4);
const BOOK2 = addr(0xb2);
const YES2 = addr(0x5001);
const NO2 = addr(0x5002);
const KEY = `0x${"ab".repeat(32)}` as const;

const deployment: Deployment = {
  ...testnet,
  stacks: { kuruV2: { factory: FACTORY2, vault: VAULT2, router: ROUTER2, usdc: USDC, kuruVersion: 2 } },
};

const params = (n: bigint) =>
  encodePerplFundingParams({
    perpId: 16n,
    startBlock: 2_000n + n,
    endBlock: 20_000n,
    threshold: 0n,
    expectedScalingExp: 2,
  });

function market(id: number, address: number, extra: Partial<FakeMarket> = {}): FakeMarket {
  return {
    address: addr(address),
    id,
    templateId: 1,
    params: params(BigInt(address)),
    phase: Phase.Pool,
    window: blockWindow(2_000n, 20_000n, 1_900_000_000n),
    pool: { yes: 300_000_000n, no: 100_000_000n, stakers: 4 },
    resolver: addr(0xaa),
    ...extra,
  };
}

let chain: FakeChain;
const ledger = new Ledger();
let v1: FakeMarket[];
let v2: FakeMarket[];

beforeEach(() => {
  chain = new FakeChain();
  v1 = [market(1, 0x1001), market(2, 0x1002)];
  v2 = [
    market(1, 0x2001),
    market(2, 0x2002, {
      phase: Phase.Graduated,
      graduated: true,
      book: BOOK2,
      tokens: { yes: YES2, no: NO2 },
    }),
  ];
  registerFactory(chain, v1);
  for (const m of v1) registerMarket(chain, m);
  chain.register(FACTORY2, hunchBookFactoryAbi, {
    marketCount: () => BigInt(v2.length),
    marketAt: ([i]) => v2[Number(i as bigint)]?.address as Address,
    isMarket: ([a]) => v2.some((m) => m.address.toLowerCase() === (a as string).toLowerCase()),
    vault: () => VAULT2,
    usdc: () => USDC,
  });
  for (const m of v2) {
    registerMarket(chain, m);
    // registerMarket answers the primary factory; v2 markets belong to FACTORY2.
    chain.register(m.address, marketAbi, { factory: () => FACTORY2 });
  }
  registerResolver(chain, addr(0xaa), () => [0, `0x${"00".repeat(32)}`], { describe: "YES if longs pay." });
  chain.register(BOOK2, kuruV2OrderBookAbi, {
    bestBidAsk: () => [410_000, 430_000],
    getL2Book: () => [
      [410_000, 400_000],
      [50_000_000n, 100_000_000n],
      [430_000, 450_000],
      [40_000_000n, 200_000_000n],
    ],
    getMarketParams: () => [1_000_000, 1_000_000n, 1_000, 1_000_000n, 5_000_000_000n, 7_000n, 4_000n],
  });
  registerToken(chain, USDC, ledger, "USD Coin");
  registerToken(chain, YES2, ledger);
  registerToken(chain, NO2, ledger);
});

describe("several stacks", () => {
  it("lists every stack's markets, primary first, each tagged with its stack", async () => {
    const page = await listMarkets(chain.context({ deployment }), { limit: 10 });
    expect(page.total).toBe(4);
    expect(page.markets.map((m) => [m.address, m.stack ?? "primary"])).toEqual([
      [addr(0x1002), "primary"],
      [addr(0x1001), "primary"],
      [addr(0x2002), "kuruV2"],
      [addr(0x2001), "kuruV2"],
    ]);
    const second = await listMarkets(chain.context({ deployment }), { limit: 2, offset: 2 });
    expect(second.markets.map((m) => m.address)).toEqual([addr(0x2002), addr(0x2001)]);
  });

  it("reads a v2 market with its stack, Kuru version and v2 prices (already E6)", async () => {
    const m = await getMarket(chain.context({ deployment }), addr(0x2002));
    expect(m).toMatchObject({
      stack: "kuruV2",
      kuruVersion: 2,
      prices: { bidE6: 410_000n, askE6: 430_000n },
    });
    expect(m?.chance.bps).toBe(4_200);
    expect(await getMarket(chain.context({ deployment }), addr(0x9999))).toBeNull();
  });

  it("reads a v2 book and quotes it with v2 matching (fee in pps)", async () => {
    const ctx = chain.context({ deployment });
    const book = await getOrderBook(ctx, addr(0x2002));
    expect(book.params.takerFeePps).toBe(7_000n);
    expect(book.asks[0]).toEqual({ price: 430_000n, size: 40_000_000n });
    expect(book.midE6).toBe(420_000n);
    const q = await quote(ctx, addr(0x2002), "buyYes", 4_300_000n);
    // 10 YES at 0.43, minus ceil(10e6 * 7000 / 1e7) = 7000.
    expect(q.tokens).toBe(10_000_000n - 7_000n);
  });

  it("stakes and mints sets through the market's own stack's vault", async () => {
    const ctx = chain.context({ deployment, key: KEY });
    const me = ctx.walletClient?.account?.address as Address;
    ledger.set(USDC, me, 1_000_000_000n);
    await stake(ctx, addr(0x2001), "yes", 5_000_000n);
    expect(chain.sent[0]).toMatchObject({ to: USDC, functionName: "approve", args: [VAULT2, 5_000_000n] });
    expect(chain.sent[1]).toMatchObject({ to: addr(0x2001), functionName: "stake" });
    expect(ledger.allowance(USDC, me, VAULT)).toBe(0n);
    chain.register(VAULT2, collateralVaultAbi, { mintSets: () => undefined });
    await mintSets(ctx, addr(0x2002), 1_000_000n);
    expect(chain.sent.at(-1)).toMatchObject({ to: VAULT2, functionName: "mintSets" });
  });
});

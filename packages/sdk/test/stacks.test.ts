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
import {
  createMarket,
  getMarket,
  getOrderBook,
  listMarkets,
  marketVenue,
  mintSets,
  quote,
  stake,
} from "../src/index.js";
import { FakeChain } from "./fake-chain.js";
import {
  addr,
  blockWindow,
  FACTORY,
  type FakeMarket,
  Ledger,
  registerBook,
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

// Testnet's third stack: `hunch`, on Hunch Book's own order book. Its books speak Kuru v1's interface, so
// the SDK reads and quotes them as v1 books; each market carries the venue so copy can name it.
const FACTORY3 = addr(0xf5);
const VAULT3 = addr(0xf6);
const BOOK3 = addr(0xb3);
const YES3 = addr(0x6001);
const NO3 = addr(0x6002);
const VENUE = {
  kind: "hunch" as const,
  bookFactory: addr(0xf7),
  marginAccount: addr(0xf8),
  bookImplementation: addr(0xf9),
};

describe("a stack on Hunch Book's own order book", () => {
  const withHunch: Deployment = {
    ...deployment,
    stacks: {
      ...deployment.stacks,
      hunch: {
        factory: FACTORY3,
        vault: VAULT3,
        router: addr(0xfa),
        usdc: USDC,
        kuruVersion: 1,
        venue: VENUE,
      },
    },
    defaultStack: "hunch",
  };
  let v3: FakeMarket[];

  beforeEach(() => {
    v3 = [
      market(1, 0x3001, {
        phase: Phase.Graduated,
        graduated: true,
        book: BOOK3,
        tokens: { yes: YES3, no: NO3 },
      }),
    ];
    chain.register(FACTORY3, hunchBookFactoryAbi, {
      marketCount: () => BigInt(v3.length),
      marketAt: ([i]) => v3[Number(i as bigint)]?.address as Address,
      isMarket: ([a]) => v3.some((m) => m.address.toLowerCase() === (a as string).toLowerCase()),
      marketOf: () => "0x0000000000000000000000000000000000000000",
      createMarket: () => addr(0x3999),
      vault: () => VAULT3,
      usdc: () => USDC,
    });
    for (const m of v3) {
      registerMarket(chain, m);
      chain.register(m.address, marketAbi, { factory: () => FACTORY3 });
    }
    registerBook(chain, BOOK3, YES3, {
      bids: [{ price: 440_000n, size: 50_000_000n }],
      asks: [{ price: 460_000n, size: 30_000_000n }],
    });
    registerToken(chain, YES3, ledger);
    registerToken(chain, NO3, ledger);
  });

  it("lists its markets tagged with the stack and the venue; Kuru markets keep theirs", async () => {
    const page = await listMarkets(chain.context({ deployment: withHunch }), { limit: 10 });
    expect(page.total).toBe(5);
    expect(page.markets.map((m) => [m.address, m.stack, m.kuruVersion, m.venue])).toEqual([
      [addr(0x1002), undefined, undefined, undefined],
      [addr(0x1001), undefined, undefined, undefined],
      [addr(0x2002), "kuruV2", 2, "kuru"],
      [addr(0x2001), "kuruV2", 2, "kuru"],
      [addr(0x3001), "hunch", 1, "hunch"],
    ]);
    expect(page.markets.map((m) => marketVenue(m).label)).toEqual([
      "Kuru",
      "Kuru",
      "Kuru v2",
      "Kuru v2",
      "Hunch order book",
    ]);
  });

  it("reads a Hunch order book market's prices and book as Kuru v1's", async () => {
    const ctx = chain.context({ deployment: withHunch });
    const m = await getMarket(ctx, addr(0x3001));
    expect(m).toMatchObject({
      stack: "hunch",
      kuruVersion: 1,
      venue: "hunch",
      prices: { bidE6: 440_000n, askE6: 460_000n },
    });
    expect(marketVenue(m as NonNullable<typeof m>)).toEqual({ venue: "hunch", label: "Hunch order book" });
    const book = await getOrderBook(ctx, addr(0x3001));
    expect(book.book).toBe(BOOK3);
    expect(book.midE6).toBe(450_000n);
    expect(book.params.takerFeeBps).toBe(0n);
    const q = await quote(ctx, addr(0x3001), "buyYes", 4_600_000n);
    expect(q.tokens).toBe(10_000_000n); // 10 YES at 0.46, no fee
  });

  it("stakes through the hunch stack's own vault", async () => {
    const ctx = chain.context({ deployment: withHunch, key: KEY });
    const me = ctx.walletClient?.account?.address as Address;
    ledger.set(USDC, me, 1_000_000_000n);
    v3.push(market(2, 0x3002));
    registerMarket(chain, v3[1] as FakeMarket);
    chain.register(addr(0x3002), marketAbi, { factory: () => FACTORY3 });
    await stake(ctx, addr(0x3002), "no", 5_000_000n);
    expect(chain.sent[0]).toMatchObject({ to: USDC, functionName: "approve", args: [VAULT3, 5_000_000n] });
  });

  it("creates new markets on the default stack, and on another stack only when asked", async () => {
    const ctx = chain.context({ deployment: withHunch, key: KEY });
    const me = ctx.walletClient?.account?.address as Address;
    ledger.set(USDC, me, 1_000_000_000n);
    const input = { templateId: 1, params: params(0x3100n), side: "yes" as const, firstStake: 5_000_000n };
    const created = await createMarket(ctx, input);
    expect(created.market).toBe(addr(0x3999));
    expect(chain.sent.at(-1)).toMatchObject({ to: FACTORY3, functionName: "createMarket" });
    // The first stake is approved to the hunch stack's vault, never the primary one's.
    expect(ledger.allowance(USDC, me, VAULT3)).toBeGreaterThanOrEqual(5_000_000n);
    const approvals = chain.sent.filter((c) => c.functionName === "approve").map((c) => c.args[0]);
    expect(approvals).not.toContain(VAULT);
    // Without defaultStack, the primary stack, as before.
    await createMarket(chain.context({ deployment, key: KEY }), input);
    expect(chain.sent.at(-1)).toMatchObject({ to: FACTORY, functionName: "createMarket" });
  });

  it("tags a primary stack that is itself on a Hunch venue (a network deployed with VENUE=hunch)", async () => {
    const primaryHunch: Deployment = {
      ...testnet,
      hunchBook: { ...testnet.hunchBook, venue: VENUE },
    };
    const m = await getMarket(chain.context({ deployment: primaryHunch }), addr(0x1001));
    expect(m).toMatchObject({ stack: "primary", kuruVersion: 1, venue: "hunch" });
  });
});

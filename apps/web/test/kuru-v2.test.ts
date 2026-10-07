import { type Deployment, deployments, Phase } from "@hunch-book/shared";
import { type Address, zeroAddress } from "viem";
import { describe, expect, it, vi } from "vitest";
import type { ApiDeps } from "../src/app/api/v1/_lib/deps";
import { getKuruRequests } from "../src/app/api/v1/_lib/kuru";
import { contractGroups } from "../src/components/status/ContractLinks";
import { readBookSnapshotV2 } from "../src/lib/chain/kuru";
import { listMarkets, readMarket } from "../src/lib/chain/reads";
import { lifecycleActions } from "../src/lib/market/actions";
import type { MarketView } from "../src/lib/market/types";
import { routerOf, stackOf, vaultOf } from "../src/lib/stacks";
import { type Fill, fillFromSwapLog, isBetweenOthers, routersOf, tapeStats } from "../src/lib/tape/fills";
import { deployed, marketAddr, marketHandlers, stubClient } from "./chain";

// The app on a deployment with a Kuru v2 stack next to the primary one (docs/PROTOCOL.md §8.1).

const testnet = deployments["monad-testnet"];
const FACTORY2 = "0x00000000000000000000000000000000000000f2" as Address;
const VAULT2 = "0x00000000000000000000000000000000000000f3" as Address;
const ROUTER2 = "0x00000000000000000000000000000000000000f4" as Address;
const GRAD2 = "0x00000000000000000000000000000000000000f5" as Address;
const BOOK2 = "0x00000000000000000000000000000000000000b2" as Address;

const twoStacks: Deployment = {
  ...deployed,
  hunchBook: { ...deployed.hunchBook, router: "0x00000000000000000000000000000000000000a9" },
  stacks: {
    kuruV2: {
      factory: FACTORY2,
      vault: VAULT2,
      router: ROUTER2,
      graduator: GRAD2,
      usdc: deployed.hunchBook.usdc,
      kuruVersion: 2,
    },
  },
};

// Primary stack: market 0 (pool). Kuru v2 stack: market 5 (pool, no book yet) and 6 (trading on BOOK2).
const v2Markets = [marketAddr(5), marketAddr(6)];
const client = () =>
  stubClient(
    marketHandlers(1, {
      marketCount: (a) => (a === FACTORY2 ? 2n : 1n),
      marketAt: (a, args) => (a === FACTORY2 ? v2Markets[Number(args?.[0])] : marketAddr(0)),
      isMarket: (a, args) =>
        a === FACTORY2 ? v2Markets.includes(args?.[0] as Address) : args?.[0] === marketAddr(0),
      phase: (a) => (a === marketAddr(6) ? Phase.Graduated : Phase.Pool),
      graduated: (a) => a === marketAddr(6),
      book: (a) => (a === marketAddr(6) ? BOOK2 : zeroAddress),
      // A v2 book answers two uint32 prices in pricePrecision units.
      bestBidAsk: () => [420_000, 440_000],
      bookOf: () => zeroAddress,
      graduationRuleMet: () => true,
    }),
  );

describe("markets on several stacks", () => {
  it("lists every stack, tags v2 markets, reads v2 prices at the v1 scale, and v2 book readiness", async () => {
    const result = await listMarkets(client(), twoStacks);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.data.total).toBe(3);
    const [primary, trading, pool] = [
      result.data.markets.find((m) => m.address === marketAddr(0)),
      result.data.markets.find((m) => m.address === marketAddr(6)),
      result.data.markets.find((m) => m.address === marketAddr(5)),
    ];
    expect(primary?.stack).toBeUndefined();
    expect(trading).toMatchObject({ stack: "kuruV2", kuruVersion: 2 });
    expect(trading?.quote).toEqual({ bid: 420_000n * 10n ** 12n, ask: 440_000n * 10n ** 12n });
    expect(pool?.bookReady).toBe(false);
    expect(primary?.bookReady).toBeUndefined();
  });

  it("finds a market on whichever stack's factory knows it", async () => {
    const r = await readMarket(client(), twoStacks, marketAddr(6));
    expect(r.status).toBe("ok");
    if (r.status === "ok") expect(r.data).toMatchObject({ stack: "kuruV2", kuruVersion: 2 });
    expect((await readMarket(client(), twoStacks, marketAddr(9))).status).toBe("not-market");
  });

  it("routes a market's trades and stakes to its own stack", () => {
    const v2 = { stack: "kuruV2" } as Pick<MarketView, "stack">;
    expect(routerOf(v2, twoStacks)).toBe(ROUTER2);
    expect(vaultOf(v2, twoStacks)).toBe(VAULT2);
    expect(stackOf({}, twoStacks)?.name).toBe("primary");
    expect(routerOf({}, twoStacks)).toBe(twoStacks.hunchBook.router);
  });
});

describe("graduation waits for Kuru's book on v2", () => {
  const base = {
    phase: Phase.Pool,
    ruleMet: true,
    graduated: false,
    kuruVersion: 2 as const,
    window: {
      blockClock: false,
      lock: 1_900_000_000n,
      close: 1_900_086_400n,
      settleDeadline: 1_900_691_200n,
    },
    pool: { yes: 1n, no: 1n, total: 2n, stakers: 2 },
  } as MarketView;
  const graduate = (m: MarketView) => lifecycleActions(m, null, null).find((a) => a.id === "graduate");

  it("keeps Graduate off, with the reason, until the book is registered", () => {
    expect(graduate({ ...base, bookReady: false })).toMatchObject({ enabled: false });
    expect(graduate({ ...base, bookReady: false })?.reason).toMatch(/Kuru creates this market's book first/);
    expect(graduate({ ...base, bookReady: true })).toMatchObject({ enabled: true });
    expect(graduate({ ...base, kuruVersion: undefined, bookReady: undefined })).toMatchObject({
      enabled: true,
    });
  });
});

describe("v2 fills for the tape", () => {
  const books = new Map([
    [
      BOOK2.toLowerCase(),
      { book: BOOK2, market: marketAddr(6), marketNumber: 2, question: "Q?", kuruVersion: 2 as const },
    ],
  ]);
  const log = (args: Record<string, unknown>) => ({
    address: BOOK2,
    blockNumber: 100n,
    logIndex: 3,
    transactionHash: `0x${"ab".repeat(32)}` as const,
    args,
  });

  it("turns a router buy into one fill at its average price, naming the trader from the router's event", () => {
    const trader = "0x0000000000000000000000000000000000000777" as Address;
    const fill = fillFromSwapLog(
      log({ executor: ROUTER2, isBuy: true, amountInUsed: 4_300_000n, amountOut: 10_000_000n }),
      twoStacks,
      books,
      new Map([[`0x${"ab".repeat(32)}`, trader]]),
    );
    expect(fill).toMatchObject({
      market: marketAddr(6),
      priceE6: 430_000n,
      size: 10_000_000n,
      notional: 4_300_000n,
      takerBuysYes: true,
      viaRouter: true,
      trader,
      maker: zeroAddress,
      makerKnown: false,
      makerIsOurMaker: false,
    });
    // An unknown maker is never counted as between others, even when the trader is not ours.
    expect(isBetweenOthers(fill as Fill)).toBe(false);
    expect(tapeStats([fill as Fill])).toMatchObject({
      fills: 1,
      makerUnknown: 1,
      betweenOthers: 0,
      ourMakerShareBps: null,
    });
  });

  it("reads a direct sell as the swapper's, and skips malformed or empty swaps", () => {
    const direct = "0x0000000000000000000000000000000000000888" as Address;
    const sell = fillFromSwapLog(
      log({ executor: direct, isBuy: false, amountInUsed: 10_000_000n, amountOut: 4_100_000n }),
      twoStacks,
      books,
      new Map(),
    );
    expect(sell).toMatchObject({ priceE6: 410_000n, size: 10_000_000n, viaRouter: false, trader: direct });
    expect(fillFromSwapLog(log({ executor: direct }), twoStacks, books, new Map())).toBeNull();
    expect(
      fillFromSwapLog(
        log({ executor: direct, isBuy: true, amountInUsed: 1n, amountOut: 0n }),
        twoStacks,
        books,
        new Map(),
      ),
    ).toBeNull();
    expect(routersOf(twoStacks)).toEqual([twoStacks.hunchBook.router, ROUTER2]);
  });
});

describe("v2 book snapshot", () => {
  it("reads levels, the pps fee (v2 matching) and the state, with no owner attribution", async () => {
    const c = {
      getBlock: vi.fn(async () => ({ number: 77n, timestamp: 0n })),
      multicall: vi.fn(async () => [
        {
          status: "success",
          result: [[420_000], [5_000_000n], [440_000, 450_000], [3_000_000n, 9_000_000n]],
        },
        {
          status: "success",
          result: [1_000_000, 1_000_000n, 1_000, 1_000_000n, 5_000_000_000n, 7_000n, 4_000n],
        },
        { status: "success", result: 1 },
        { status: "success", result: "0x00000000000000000000000000000000000000c1" },
        { status: "success", result: "0x00000000000000000000000000000000000000ab" },
      ]),
    };
    const snap = await readBookSnapshotV2(c as never, BOOK2);
    expect(snap.block).toBe(77n);
    expect(snap.bids).toEqual([{ price: 420_000n, size: 5_000_000n }]);
    expect(snap.asks).toHaveLength(2);
    expect(snap.params).toMatchObject({
      takerFeePps: 7_000n,
      takerFeeBps: 7n,
      tickSize: 1_000n,
      minSize: 1n,
    });
    expect(snap.state).toBe(1);
    expect(snap.owned).toBeNull();
  });
});

describe("status page", () => {
  it("lists each extra stack and Kuru's v2 contracts", () => {
    const groups = contractGroups({
      ...twoStacks,
      external: { ...testnet.external, kuruV2: testnet.external.kuruV2 },
    });
    const v2 = groups.find((g) => g.title === "Stack kuruV2 (Kuru v2)");
    expect(v2?.items.map((i) => i.label)).toEqual(["Factory", "Collateral vault", "Graduator", "Router"]);
    const outside = groups.find((g) => g.title.startsWith("Outside"));
    expect(outside?.items.map((i) => i.label)).toContain("Kuru v2 AccountCore");
  });
});

describe("GET /api/v1/kuru/requests", () => {
  it("is a 404 where the deployments file has no Kuru v2", async () => {
    const noV2 = { ...testnet, external: { ...testnet.external, kuruV2: undefined } };
    const res = await getKuruRequests(new Request("https://x/api/v1/kuru/requests"), {
      deployment: noV2,
      network: "monad-testnet",
    } as unknown as ApiDeps);
    expect(res.status).toBe(404);
  });

  it("lists a v2 pool's token setup, the exact deploySpotMarket call and where the book lands", async () => {
    const YES = "0x00000000000000000000000000000000000000c1" as Address;
    const USDC = deployed.hunchBook.usdc as Address;
    const EXPECTED = "0x00000000000000000000000000000000000000e1" as Address;
    const FEED = "0x00000000000000000000000000000000000000e2" as Address;
    const answers: Record<string, unknown> = {
      bookRequest: {
        baseToken: YES,
        quoteToken: USDC,
        sizePrecision: 1_000_000n,
        pricePrecision: 1_000_000,
        tickSize: 1_000,
        passiveSpreadTicks: 10,
        minQuoteNotional: 1_000_000n,
        maxQuoteNotional: 5_000_000_000n,
        takerFeePps: 7_000n,
        makerFeePps: 4_000n,
      },
      predictedBook: EXPECTED,
      bookOf: zeroAddress,
      predictAdapter: FEED,
      adapterOf: FEED,
      whitelistedSpotTokens: true,
    };
    const publicClient = {
      readContract: vi.fn(async (c: { functionName: string; args?: readonly unknown[] }) => {
        if (c.functionName === "spotTokenConfigs") return [6, c.args?.[0] === USDC];
        if (c.functionName === "priceSource") return c.args?.[0] === USDC ? FEED : zeroAddress;
        return answers[c.functionName];
      }),
      getCode: vi.fn(async () => undefined),
    };
    const stackDeployment: Deployment = {
      ...twoStacks,
      stacks: {
        kuruV2: { ...(twoStacks.stacks?.kuruV2 ?? {}), periphery: { kuruFeedFactory: FEED } },
      },
      external: { ...testnet.external },
    };
    const market = {
      address: marketAddr(5),
      id: 1,
      stack: "kuruV2",
      kuruVersion: 2,
      phase: Phase.Pool,
      phaseName: "pool",
      rule: "Q?",
      graduationRuleMet: false,
      pool: { yes: 10_000_000n, no: 5_000_000n, total: 15_000_000n, stakers: 2 },
    };
    const deps = {
      network: "monad-testnet",
      deployment: stackDeployment,
      now: () => 1_000,
      sdk: { context: { publicClient }, markets: { all: vi.fn(async () => [market]) } },
    } as unknown as ApiDeps;
    const res = await getKuruRequests(new Request("https://x/api/v1/kuru/requests"), deps);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { requests: Record<string, unknown>[] };
    expect(body.requests).toHaveLength(1);
    expect(body.requests[0]).toMatchObject({
      market: marketAddr(5),
      stack: "kuruV2",
      status: "needs-token-setup",
      expectedBook: EXPECTED,
      bookDeployed: false,
      deploySpotMarket: { baseToken: YES, maxQuoteNotional: "5000000000", takerFeePps: "7000" },
      tokens: {
        yes: {
          token: YES,
          priceFeed: FEED,
          priceFeedCreated: true,
          enabledInAccountCore: false,
          priceSource: null,
        },
        usdc: { token: USDC, enabledInAccountCore: true, priceSource: FEED },
      },
    });
  });
});

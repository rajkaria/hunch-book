import { deployments, PriceSource } from "@hunch-book/shared";
import { type Address, ContractFunctionRevertedError, encodeErrorResult, type Hex, zeroAddress } from "viem";
import { describe, expect, it } from "vitest";
import { resolverErrorsAbi } from "../src/lib/create/abis";
import { MIN_DRIFT, PACE_SPAN } from "../src/lib/create/clock";
import { chainlinkOption, pythOption } from "../src/lib/create/price";
import {
  previewMarket,
  readChallengeBlocks,
  readClock,
  readCreateConfig,
  readFastBlockTime,
  readMarketOf,
  readPerpContext,
  readPriceFeeds,
  readSpotPrice,
} from "../src/lib/create/reads";
import { deployed, notDeployed, stubClient } from "./chain";
import { FACTORY, RESOLVER, USDC } from "./fixtures";

// The create flow's read layer against a fake chain that answers by function name.

const RULE = { minPool: USDC(500), minStakers: 10, minChanceBps: 300, maxChanceBps: 9_700 };
const CAPS = { poolCap: USDC(5_000), walletCap: USDC(1_000), minStake: USDC(1), creatorMinStake: USDC(5) };

describe("readCreateConfig", () => {
  it("lists only the template ids with a resolver, plus pause state, caps, vault and USDC", async () => {
    const client = stubClient({
      creationPaused: () => false,
      caps: () => CAPS,
      templateOf: (_a, args) =>
        [1, 2, 4].includes(Number(args?.[0]))
          ? { resolver: `0x${"e".repeat(39)}${args?.[0]}` as Address, rule: RULE }
          : { resolver: zeroAddress, rule: { minPool: 0n, minStakers: 0, minChanceBps: 0, maxChanceBps: 0 } },
    });
    const config = await readCreateConfig(client, deployed);
    expect(config).toMatchObject({
      factory: FACTORY,
      vault: deployed.hunchBook.vault,
      usdc: deployed.hunchBook.usdc,
      paused: false,
      caps: CAPS,
    });
    expect(Object.keys(config?.templates ?? {}).map(Number)).toEqual([1, 2, 4]);
    expect(config?.templates[4]?.rule).toEqual(RULE);
  });

  it("returns null before deployment and throws when the factory does not answer", async () => {
    expect(await readCreateConfig(stubClient({}), notDeployed)).toBeNull();
    await expect(readCreateConfig(stubClient({ caps: () => CAPS }), deployed)).rejects.toThrow(
      "Could not read the factory's settings.",
    );
  });
});

describe("readMarketOf", () => {
  it("returns the market at a key, or null for none", async () => {
    const market = "0x2A44B99014cF73065BFb89197a08DE09D18d3982" as Address;
    expect(await readMarketOf(stubClient({ marketOf: () => market }), FACTORY, `0x${"1".repeat(64)}`)).toBe(
      market,
    );
    expect(
      await readMarketOf(stubClient({ marketOf: () => zeroAddress }), FACTORY, `0x${"1".repeat(64)}`),
    ).toBeNull();
  });
});

describe("readClock", () => {
  it("measures the pace over two 10,000-block spans", async () => {
    const head = 2_000_000n;
    const client = stubClient(
      {},
      {
        [head.toString()]: 1_000_000_000n + 6_020n,
        [(head - PACE_SPAN).toString()]: 1_000_000_000n + 3_000n,
        [(head - 2n * PACE_SPAN).toString()]: 1_000_000_000n,
      },
    );
    const { head: h, pace } = await readClock(client, 400);
    expect(h).toEqual({ number: head, timestamp: 1_000_006_020 });
    expect(pace.msPerBlock).toBeCloseTo(302);
    expect(pace.measured).toBe(true);
    expect(pace.drift).toBe(MIN_DRIFT);
  });
});

describe("readPerpContext", () => {
  const INTERVAL = 8_571n;
  const last = 68_036_598n;
  const info = {
    name: "MON Perp",
    symbol: "MON",
    priceDecimals: 5n,
    status: 4,
    fundingStartBlock: 12_179_391n,
    markPNS: 3_468n,
    fundingSumScalingExp: 3n,
  };

  it("reads the perp, the interval and recent events on the funding grid", async () => {
    const client = stubClient({
      getPerpetualInfoV2: () => info,
      getFundingInterval: () => INTERVAL,
      // The sum rises by 100 per event; the event block is the last grid block at or before the ask.
      getFundingSumAtBlock: (_a, args) => {
        const asked = BigInt(args?.[1] as bigint);
        const event = asked - (asked % INTERVAL);
        return [Number(event / INTERVAL) * 100, event];
      },
    });
    const ctx = await readPerpContext(client, deployments["monad-testnet"], 64n, last + 50n, 10);
    expect(ctx.info).toEqual({
      perpId: 64n,
      name: "MON Perp",
      symbol: "MON",
      priceDecimals: 5,
      scalingExp: 3,
      status: 4,
      fundingStartBlock: 12_179_391n,
      markPrice: 3_468n,
    });
    expect(ctx.interval).toBe(INTERVAL);
    expect(ctx.anchor).toBe(0n);
    expect(ctx.history.lastEvent).toBe(last);
    expect(ctx.history.samples).toHaveLength(11);
    expect(ctx.history.samples.at(-1)).toEqual({ block: last, sum: BigInt(Number(last / INTERVAL) * 100) });
    expect(ctx.history.samples[0]?.block).toBe(last - 10n * INTERVAL);
  });

  it("skips events before funding started and says plainly when the perp is unknown", async () => {
    const client = stubClient({
      getPerpetualInfoV2: () => info,
      getFundingInterval: () => INTERVAL,
      getFundingSumAtBlock: (_a, args) => {
        const asked = BigInt(args?.[1] as bigint);
        return asked < last - 2n * INTERVAL ? [0, 0n] : [5, last];
      },
    });
    const ctx = await readPerpContext(client, deployments["monad-testnet"], 64n, last, 10);
    expect(ctx.history.samples).toHaveLength(3);
    await expect(
      readPerpContext(
        stubClient({ getFundingInterval: () => INTERVAL }),
        deployments["monad-testnet"],
        99n,
        last,
      ),
    ).rejects.toThrow("Perpl does not describe perp 99 on this network.");
  });
});

describe("readPriceFeeds", () => {
  const btc = deployments["monad-testnet"].external.chainlink["BTC/USD"] as Address;
  const other = "0x00000000000000000000000000000000000000f9" as Address;
  const sol = deployments["monad-testnet"].external.pyth.ids["SOL/USD"] as Hex;

  it("labels Chainlink feeds from deployments (or their description) and Pyth ids from the resolver", async () => {
    const client = stubClient({
      feeds: () => [btc, other],
      pythIds: () => [sol],
      pythLabel: () => "SOL/USD",
      description: () => "LINK / USD",
    });
    const options = await readPriceFeeds(client, deployments["monad-testnet"], RESOLVER);
    expect(options.map((o) => [o.label, o.source])).toEqual([
      ["BTC/USD", PriceSource.Chainlink],
      ["LINK/USD", PriceSource.Chainlink],
      ["SOL/USD", PriceSource.Pyth],
    ]);
  });

  it("lists Chainlink only for the touch resolver, which has no Pyth ids", async () => {
    const options = await readPriceFeeds(
      stubClient({ feeds: () => [btc] }),
      deployments["monad-testnet"],
      RESOLVER,
    );
    expect(options.map((o) => o.label)).toEqual(["BTC/USD"]);
  });

  it("throws when the resolver does not list its feeds", async () => {
    await expect(readPriceFeeds(stubClient({}), deployments["monad-testnet"], RESOLVER)).rejects.toThrow(
      "Could not read which price feeds the resolver accepts.",
    );
  });
});

describe("readSpotPrice", () => {
  const btc = chainlinkOption("BTC/USD", "0x12C0F44368a02081ce58a936d1C1F606BB301715");
  const sol = pythOption("SOL/USD", "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d");

  it("reads Chainlink's latest round in 8 decimals", async () => {
    const client = stubClient({
      latestRoundData: () => [1n, 8_472_106_882_025n, 0n, 1_791_076_720n, 1n],
      decimals: () => 8,
    });
    expect(await readSpotPrice(client, deployments["monad-testnet"], btc)).toEqual({
      priceE8: 8_472_106_882_025n,
      updatedAt: 1_791_076_720,
    });
  });

  it("reads Pyth's last onchain price and scales it", async () => {
    const client = stubClient({
      getPriceUnsafe: () => ({ price: 120_795_753_010n, conf: 1n, expo: -9, publishTime: 1_791_094_474n }),
    });
    expect(await readSpotPrice(client, deployments["monad-testnet"], sol)).toEqual({
      priceE8: 12_079_575_301n,
      updatedAt: 1_791_094_474,
    });
  });

  it("returns null for a missing or non-positive price", async () => {
    expect(
      await readSpotPrice(stubClient({ decimals: () => 8 }), deployments["monad-testnet"], btc),
    ).toBeNull();
    const zero = stubClient({ getPriceUnsafe: () => ({ price: 0n, conf: 0n, expo: -8, publishTime: 0n }) });
    expect(await readSpotPrice(zero, deployments["monad-testnet"], sol)).toBeNull();
  });
});

describe("resolver views", () => {
  it("reads template 4's challenge period and template 6's fast block time", async () => {
    expect(await readChallengeBlocks(stubClient({ challengeBlocks: () => 288_000n }), RESOLVER)).toBe(
      288_000n,
    );
    expect(await readFastBlockTime(stubClient({ fastBlockTimeMs: () => 200n }), RESOLVER)).toBe(200);
  });
});

describe("previewMarket", () => {
  const window = { blockClock: true, lock: 10, close: 20, settleDeadline: 30 };

  it("returns the resolver's window and sentence", async () => {
    const client = stubClient({ validate: () => window, describe: () => "  Will it?  " });
    expect(await previewMarket(client, RESOLVER, "0x01")).toEqual({
      window: { blockClock: true, lock: 10n, close: 20n, settleDeadline: 30n },
      sentence: "Will it?",
      error: null,
    });
  });

  it("turns a validate revert into plain words", async () => {
    const data = encodeErrorResult({ abi: resolverErrorsAbi, errorName: "PerpPaused", args: [64n] });
    const client = stubClient({
      validate: () => {
        throw new ContractFunctionRevertedError({ abi: resolverErrorsAbi, data, functionName: "validate" });
      },
      describe: () => "Will it?",
    });
    expect(await previewMarket(client, RESOLVER, "0x01")).toEqual({
      window: null,
      sentence: "Will it?",
      error: "Perpl has paused this perp, so it cannot be used for a new market.",
    });
  });
});

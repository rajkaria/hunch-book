import {
  deployments,
  encodePerplFundingParams,
  encodePriceAtTimeParams,
  PriceSource,
  TemplateId,
  type Window,
} from "@hunch-book/shared";
import { type Address, decodeAbiParameters, type Hex, type PublicClient } from "viem";
import { describe, expect, it } from "vitest";
import {
  defaultSettlers,
  type SettleDeps,
  type SettleMarket,
  SettlerRegistry,
} from "../src/settlers/index.js";
import { perplFundingSettler } from "../src/settlers/perplFunding.js";
import {
  encodeChainlinkEvidence,
  encodePythEvidence,
  priceAtTimeSettler,
} from "../src/settlers/priceAtTime.js";
import { checkHermesUpdate, fetchHermesUpdate, hermesUrl } from "../src/settlers/pyth.js";
import { chainlinkFixture, fixtureRounds } from "./fixtures.js";

const MARKET = "0x2A44B99014cF73065BFb89197a08DE09D18d3982" as Address;
const RESOLVER = "0x5582e5Aeb12e15EAda88402E2903Bc628Cc28B3C" as Address;
const PYTH = "0x2880aB155794e7179c9eE2e38200202908C17B43" as Address;
const SOL = "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d" as Hex;
const ZERO32 = `0x${"00".repeat(32)}` as Hex;
const window: Window = { blockClock: false, lock: 0n, close: 0n, settleDeadline: 0n };

describe("registry", () => {
  it("knows templates 1 to 7 and takes new ones", () => {
    const registry = defaultSettlers();
    expect(registry.templates()).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(registry.get(TemplateId.PerplFunding)?.name).toBe("perpl-funding");
    expect(registry.get(TemplateId.PriceAtTime)?.name).toBe("price-at-time");
    expect(registry.get(TemplateId.ChainlinkTouch)?.name).toBe("chainlink-touch");
    expect(registry.get(TemplateId.PerplFundingSpike)?.name).toBe("perpl-funding-spike");
    expect(registry.get(TemplateId.PriceRange)?.name).toBe("price-range");
    expect(registry.get(TemplateId.Parlay)?.name).toBe("parlay");
    expect(registry.get(TemplateId.Snapshot)?.name).toBe("snapshot");
    // Only the early-YES templates hunt for proofs.
    expect(registry.templates().filter((id) => registry.get(id)?.prover)).toEqual([3, 4]);
    expect(registry.get(9)).toBeUndefined();
    const custom = {
      name: "custom",
      waitReason: () => null,
      evidence: async () => ({ status: "wait" as const, reason: "x" }),
    };
    expect(new SettlerRegistry().register(9, custom).get(9)).toBe(custom);
  });

  it("gives every registry its own hunt memory", () => {
    expect(defaultSettlers().get(3)).not.toBe(defaultSettlers().get(3));
  });
});

describe("template 1, Perpl funding", () => {
  const params = encodePerplFundingParams({
    perpId: 64n,
    startBlock: 68_058_301n,
    endBlock: 68_264_005n,
    threshold: 1_500n,
    expectedScalingExp: 6,
  });
  const market: SettleMarket = { address: MARKET, templateId: 1, params, window, resolver: RESOLVER };

  it("waits until block.number > endBlock", () => {
    expect(perplFundingSettler.waitReason(market, { block: 68_264_005n, timestamp: 0n })).toBe(
      "waiting for block > 68264005",
    );
    expect(perplFundingSettler.waitReason(market, { block: 68_264_006n, timestamp: 0n })).toBeNull();
  });

  it("settles with empty evidence and no value", async () => {
    const result = await perplFundingSettler.evidence(
      market,
      { block: 68_264_006n, timestamp: 0n },
      {} as SettleDeps,
    );
    expect(result).toMatchObject({ status: "ready", evidence: "0x", value: 0n });
  });
});

/** A client that answers the Chainlink reads from a fixture, and Pyth's pyth()/getUpdateFee. */
function fakeClient(pair: "btc-usd" | "eth-usd", fee = 1n) {
  const rounds = fixtureRounds(pair);
  const byId = new Map(rounds.map((r) => [r.roundId, r]));
  const calls: string[] = [];
  const client = {
    async readContract(req: { functionName: string; args?: unknown[] }) {
      calls.push(req.functionName);
      const asTuple = (r: { roundId: bigint; answer: bigint; updatedAt: bigint }) =>
        [r.roundId, r.answer, r.updatedAt, r.updatedAt, r.roundId] as const;
      if (req.functionName === "latestRoundData") return asTuple(rounds.at(-1) as (typeof rounds)[number]);
      if (req.functionName === "getRoundData") {
        const r = byId.get(req.args?.[0] as bigint);
        if (!r) throw new Error("execution reverted");
        return asTuple(r);
      }
      if (req.functionName === "pyth") return PYTH;
      if (req.functionName === "getUpdateFee") return fee;
      throw new Error(`unexpected ${req.functionName}`);
    },
  };
  return { client: client as unknown as PublicClient, calls };
}

function priceMarket(source: number, closeTime: bigint): SettleMarket {
  const params = encodePriceAtTimeParams({
    source: source as 0 | 1,
    feed:
      source === PriceSource.Chainlink
        ? (deployments["monad-mainnet"].external.chainlink["BTC/USD"] as Address)
        : "0x0000000000000000000000000000000000000000",
    pythId: source === PriceSource.Pyth ? SOL : ZERO32,
    strikeE8: 100_000n * 10n ** 8n,
    lockTime: closeTime - 3_600n,
    closeTime,
  });
  return { address: MARKET, templateId: 2, params, window, resolver: RESOLVER };
}

describe("template 2, price at a time: Chainlink", () => {
  const rounds = fixtureRounds("btc-usd");
  const target = ((rounds[200]?.updatedAt ?? 0n) + (rounds[201]?.updatedAt ?? 0n)) / 2n;

  it("waits until block.timestamp > T", () => {
    const m = priceMarket(PriceSource.Chainlink, target);
    expect(priceAtTimeSettler.waitReason(m, { block: 0n, timestamp: target })).toMatch(
      /^waiting for time > /,
    );
    expect(priceAtTimeSettler.waitReason(m, { block: 0n, timestamp: target + 1n })).toBeNull();
  });

  it("passes the round that brackets T, abi-encoded as uint80", async () => {
    const { client } = fakeClient("btc-usd");
    const deps = { client, deployment: deployments["monad-mainnet"], pythApiKey: undefined, hermesUrl: "" };
    const result = await priceAtTimeSettler.evidence(
      priceMarket(PriceSource.Chainlink, target),
      { block: 0n, timestamp: 0n },
      deps,
    );
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    const [roundId] = decodeAbiParameters([{ type: "uint80" }], result.evidence);
    expect(roundId).toBe(rounds[200]?.roundId);
    expect(result.evidence).toBe(encodeChainlinkEvidence(rounds[200]?.roundId as bigint));
    expect(result.evidence.length).toBe(2 + 64);
    expect(result.value).toBe(0n);
    expect(result.detail).toMatchObject({ source: "chainlink", roundId: rounds[200]?.roundId, target });
  });

  it("waits while the feed has no round after T", async () => {
    const { client } = fakeClient("btc-usd");
    const deps = { client, deployment: deployments["monad-mainnet"], pythApiKey: undefined, hermesUrl: "" };
    const last = chainlinkFixture("btc-usd").rounds.at(-1)?.updatedAt ?? 0;
    const result = await priceAtTimeSettler.evidence(
      priceMarket(PriceSource.Chainlink, BigInt(last) + 5n),
      { block: 0n, timestamp: 0n },
      deps,
    );
    expect(result.status).toBe("wait");
  });
});

describe("template 2, price at a time: Pyth", () => {
  const T = 1_791_000_000n;
  const body = (publishTime: number, prev: number | undefined, data = ["504e4155aa", "504e4155bb"]) => ({
    binary: { encoding: "hex", data },
    parsed: [
      {
        id: SOL.slice(2),
        price: { price: "15012345678", expo: -8, publish_time: publishTime },
        metadata: prev === undefined ? {} : { prev_publish_time: prev },
      },
    ],
  });

  it("builds the Hermes URL for T", () => {
    expect(hermesUrl("https://hermes.pyth.network", SOL, T)).toBe(
      `https://hermes.pyth.network/v2/updates/price/1791000000?ids[]=${SOL.slice(2)}&encoding=hex&parsed=true`,
    );
  });

  it("accepts only the first update in [T, T + 60 s], as the resolver does", () => {
    expect(checkHermesUpdate(body(1_791_000_000, 1_790_999_999), SOL, T).status).toBe("found");
    expect(checkHermesUpdate(body(1_791_000_060, 1_790_999_000), SOL, T).status).toBe("found");
    expect(checkHermesUpdate(body(1_791_000_061, 1_790_999_000), SOL, T).status).toBe("unsettleable");
    expect(checkHermesUpdate(body(1_790_999_999, 1_790_999_998), SOL, T).status).toBe("wait");
    expect(checkHermesUpdate(body(1_791_000_005, 1_791_000_001), SOL, T).status).toBe("unsettleable");
    expect(checkHermesUpdate(body(1_791_000_005, undefined, []), SOL, T).status).toBe("wait");
    const found = checkHermesUpdate(body(1_791_000_001, 1_790_999_990), SOL, T);
    expect(found.status === "found" && found.update.updateData).toEqual(["0x504e4155aa", "0x504e4155bb"]);
  });

  it("asks Hermes with the API key as a bearer token, and waits without a key", async () => {
    const seen: { url: string; auth: string | null }[] = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      seen.push({ url, auth: new Headers(init?.headers).get("authorization") });
      return new Response(JSON.stringify(body(1_791_000_002, 1_790_999_999)), { status: 200 });
    }) as typeof fetch;
    const noKey = await fetchHermesUpdate({
      baseUrl: "https://h",
      apiKey: undefined,
      id: SOL,
      target: T,
      fetchFn,
    });
    expect(noKey).toEqual({
      status: "wait",
      reason: "PYTH_API_KEY is not set: Hermes needs it for historical updates",
    });
    expect(seen).toHaveLength(0);
    const ok = await fetchHermesUpdate({ baseUrl: "https://h", apiKey: "k123", id: SOL, target: T, fetchFn });
    expect(ok.status).toBe("found");
    expect(seen[0]).toEqual({ url: hermesUrl("https://h", SOL, T), auth: "Bearer k123" });

    const denied = (async () => new Response("unauthorized", { status: 401 })) as unknown as typeof fetch;
    expect(
      await fetchHermesUpdate({ baseUrl: "https://h", apiKey: "bad", id: SOL, target: T, fetchFn: denied }),
    ).toEqual({
      status: "wait",
      reason: "Hermes answered HTTP 401",
    });
  });

  it("passes the update as bytes[] and pays Pyth's fee from the resolver's Pyth contract", async () => {
    const { client, calls } = fakeClient("btc-usd", 7n);
    const fetchFn = (async () =>
      new Response(JSON.stringify(body(1_791_000_003, 1_790_999_990)), {
        status: 200,
      })) as unknown as typeof fetch;
    const deps: SettleDeps = {
      client,
      deployment: deployments["monad-mainnet"],
      pythApiKey: "k",
      hermesUrl: "https://h",
      fetchFn,
    };
    const result = await priceAtTimeSettler.evidence(
      priceMarket(PriceSource.Pyth, T),
      { block: 0n, timestamp: 0n },
      deps,
    );
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.value).toBe(7n);
    expect(result.evidence).toBe(encodePythEvidence(["0x504e4155aa", "0x504e4155bb"]));
    const [updates] = decodeAbiParameters([{ type: "bytes[]" }], result.evidence);
    expect(updates).toEqual(["0x504e4155aa", "0x504e4155bb"]);
    expect(calls).toEqual(["pyth", "getUpdateFee"]);
    expect(result.detail).toMatchObject({ source: "pyth", publishTime: 1_791_000_003, fee: 7n });
  });
});

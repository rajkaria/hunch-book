import {
  type ChainlinkRound,
  chainlinkEvidence,
  chainlinkEvidenceHash,
  chainlinkRoundId,
  deployments,
  encodePerplFundingParams,
  encodePriceAtTimeParams,
  marketAbi,
  Outcome,
  Phase,
  PriceSource,
  perplEvidenceHash,
  TemplateId,
} from "@hunch-book/shared";
import {
  type Address,
  BaseError,
  ContractFunctionRevertedError,
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  encodeFunctionData,
  encodePacked,
  type Hex,
  parseAbi,
} from "viem";
import { describe, expect, it } from "vitest";
import { readBookSnapshot } from "../src/lib/chain/kuru";
import { decodeMarketParams } from "../src/lib/market/params";
import { planSettlement } from "../src/lib/market/settle";
import { findSettlementTx, runVerification, type VerifyClient } from "../src/lib/verify/read";
import { MARKET, makeMarket, USDC } from "./fixtures";

// The verifier, the settle plan and the book read against a fake chain that answers by function name.

type Handler = (address: Address, args: readonly unknown[], block?: bigint) => unknown;

function fakeChain(
  handlers: Record<string, Handler>,
  extra: Partial<Record<"getLogs" | "getTransaction" | "getBlock", (p: never) => unknown>> = {},
): VerifyClient {
  const answer = (c: {
    address: Address;
    functionName: string;
    args?: readonly unknown[];
    blockNumber?: bigint;
  }) => {
    const h = handlers[c.functionName];
    if (!h) throw new Error(`no handler for ${c.functionName}`);
    return h(c.address, c.args ?? [], c.blockNumber);
  };
  return {
    readContract: async (c: never) => answer(c),
    multicall: async ({ contracts }: { contracts: readonly never[] }) =>
      contracts.map((c) => {
        try {
          return { status: "success", result: answer(c) };
        } catch (error) {
          return { status: "failure", error };
        }
      }),
    simulateContract: async (c: never) => ({ result: answer(c) }),
    getLogs: async (p: never) => (extra.getLogs ? extra.getLogs(p) : []),
    getTransaction: async (p: never) => extra.getTransaction?.(p),
    getBlock: async (p: never) => extra.getBlock?.(p) ?? { timestamp: 0n },
  } as unknown as VerifyClient;
}

const deployment = deployments["monad-testnet"];
const EXCHANGE = deployment.external.perpl.exchange;

// ---------------------------------------------------------------- Perpl

const perplParams = encodePerplFundingParams({
  perpId: 16n,
  startBlock: 1_000_000n,
  endBlock: 1_002_000n,
  threshold: 50n,
  expectedScalingExp: 2,
});
const perplMarket = (overrides = {}) =>
  makeMarket({
    templateId: TemplateId.PerplFunding,
    params: perplParams,
    decoded: decodeMarketParams(TemplateId.PerplFunding, perplParams),
    ...overrides,
  });

const sums: Record<string, [number, bigint]> = {
  "1000000": [-120, 999_000n],
  "1002000": [-60, 1_001_500n],
  "1001000": [-100, 1_000_900n],
};
const perplHash = perplEvidenceHash({
  exchange: EXCHANGE,
  perpId: 16n,
  startBlock: 1_000_000n,
  endBlock: 1_002_000n,
  sumStart: -120n,
  sumEnd: -60n,
  eventStart: 999_000n,
  eventEnd: 1_001_500n,
});

function perplChain(resolveResult: readonly [number, Hex] = [Outcome.Yes, perplHash]) {
  return fakeChain({
    exchange: () => EXCHANGE,
    versionUnchanged: () => true,
    getPerpetualInfoV2: () => ({ symbol: "BTC", priceDecimals: 1n, fundingSumScalingExp: 2n }),
    getFundingInterval: () => 8_571n,
    getFundingSumAtBlock: (_a, args) => {
      const hit = sums[String(args[1])];
      if (!hit) throw new Error("no sum");
      return hit;
    },
    resolve: () => resolveResult,
  });
}

describe("verifier: Perpl funding", () => {
  it("rebuilds the read, the hash and the resolver run, and matches the stored settlement", async () => {
    const m = perplMarket({ phase: Phase.Settled, outcome: Outcome.Yes, evidenceHash: perplHash });
    const v = await runVerification(perplChain(), deployment, m, 1_100_000n);
    expect(v.mode).toBe("settled");
    if (v.read.template !== "perpl") throw new Error("expected a Perpl read");
    expect(v.read.start).toEqual({ sum: -120n, eventBlock: 999_000n });
    expect(v.read.end).toEqual({ sum: -60n, eventBlock: 1_001_500n });
    // ΔF = 60 > 50: YES.
    expect(v.read.delta).toBe(60n);
    expect(v.read.outcome).toBe(Outcome.Yes);
    expect(v.read.priceDecimals).toBe(1);
    expect(v.read.scalingExp).toBe(2);
    expect(v.read.expectedHash).toBe(perplHash);
    expect(v.rerun).toEqual({ outcome: Outcome.Yes, evidenceHash: perplHash });
    expect(v.matches).toEqual({ outcome: true, hash: true, resolver: true });
  });

  it("flags a stored hash or outcome that the chain does not reproduce", async () => {
    const m = perplMarket({
      phase: Phase.Settled,
      outcome: Outcome.No,
      evidenceHash: `0x${"12".repeat(32)}`,
    });
    const v = await runVerification(perplChain(), deployment, m, 1_100_000n);
    expect(v.matches).toEqual({ outcome: false, hash: false, resolver: false });
  });

  it("previews an unsettled market at the chain head, without a hash", async () => {
    const m = perplMarket({ phase: Phase.Graduated });
    const v = await runVerification(
      perplChain([Outcome.Unresolved, `0x${"00".repeat(32)}`]),
      deployment,
      m,
      1_001_000n,
    );
    expect(v.mode).toBe("preview");
    expect(v.matches).toBeNull();
    if (v.read.template !== "perpl") throw new Error("expected a Perpl read");
    expect(v.read.final).toBe(false);
    expect(v.read.endRead).toBe(1_001_000n);
    expect(v.read.delta).toBe(20n);
    expect(v.read.expectedHash).toBeNull();
    expect(v.rerun).toBeNull();
  });

  it("says nothing is read before the window starts", async () => {
    const v = await runVerification(perplChain(), deployment, perplMarket(), 900_000n);
    if (v.read.template !== "perpl") throw new Error("expected a Perpl read");
    expect(v.read.started).toBe(false);
    expect(v.read.start).toBeNull();
  });
});

// ---------------------------------------------------------------- Chainlink

const FEED = "0x12C0F44368a02081ce58a936d1C1F606BB301715" as Address;
const AGGREGATOR = "0x00000000000000000000000000000000000000a7" as Address;
const CLOSE = 1_800_086_400n;
const round = (i: bigint): ChainlinkRound => ({
  roundId: chainlinkRoundId(1n, i),
  answer: 12_000_000_000_000n + i,
  updatedAt: CLOSE - 3_000n + i * 600n,
});
// Rounds 1..20, ten minutes apart: round 5 is the last at or before the close.

const priceParams = encodePriceAtTimeParams({
  source: PriceSource.Chainlink,
  feed: FEED,
  pythId: `0x${"00".repeat(32)}`,
  strikeE8: 12_000_000_000_000n,
  lockTime: CLOSE - 86_400n,
  closeTime: CLOSE,
});
const priceMarket = (overrides = {}) =>
  makeMarket({
    params: priceParams,
    decoded: decodeMarketParams(TemplateId.PriceAtTime, priceParams),
    phase: Phase.Closed,
    graduated: true,
    ...overrides,
  });
const chainlinkHash = chainlinkEvidenceHash({
  feed: FEED,
  roundId: round(5n).roundId,
  answer: round(5n).answer,
  updatedAt: round(5n).updatedAt,
  nextUpdatedAt: round(6n).updatedAt,
  target: CLOSE,
});

function chainlinkChain(top = 20n, resolve: Handler = () => [Outcome.Yes, chainlinkHash]) {
  return fakeChain({
    latestRoundData: () => {
      const r = round(top);
      return [r.roundId, r.answer, 0n, r.updatedAt, r.roundId];
    },
    getRoundData: (_a, args) => {
      const id = args[0] as bigint;
      const i = id & ((1n << 64n) - 1n);
      if (i < 1n || i > top) return [0n, 0n, 0n, 0n, 0n];
      const r = round(i);
      return [r.roundId, r.answer, 0n, r.updatedAt, r.roundId];
    },
    phaseAggregators: () => AGGREGATOR,
    decimals: () => 8,
    resolve,
  });
}

describe("verifier: Chainlink price", () => {
  it("finds the bracketing round, rebuilds the hash and matches", async () => {
    const m = priceMarket({ phase: Phase.Settled, outcome: Outcome.Yes, evidenceHash: chainlinkHash });
    const v = await runVerification(chainlinkChain(), deployment, m, 5_000_000n);
    if (v.read.template !== "chainlink") throw new Error("expected a Chainlink read");
    expect(v.read.bracket?.status).toBe("found");
    if (v.read.bracket?.status === "found") {
      expect(v.read.bracket.round).toEqual(round(5n));
      expect(v.read.bracket.next).toEqual(round(6n));
    }
    expect(v.read.decimals).toBe(8);
    expect(v.read.priceE8).toBe(12_000_000_000_005n);
    expect(v.read.outcome).toBe(Outcome.Yes);
    expect(v.read.expectedHash).toBe(chainlinkHash);
    expect(v.matches).toEqual({ outcome: true, hash: true, resolver: true });
  });

  it("shows the resolver refusing a bracket more than an hour old", async () => {
    // Round 5 is now two hours before the close.
    const client = fakeChain({
      latestRoundData: () => [
        round(20n).roundId,
        round(20n).answer,
        0n,
        round(20n).updatedAt,
        round(20n).roundId,
      ],
      getRoundData: (_a, args) => {
        const i = (args[0] as bigint) & ((1n << 64n) - 1n);
        const r = i <= 5n ? { ...round(i), updatedAt: CLOSE - 7_200n - (5n - i) * 600n } : round(i);
        return [r.roundId, r.answer, 0n, r.updatedAt, r.roundId];
      },
      phaseAggregators: () => AGGREGATOR,
      decimals: () => 8,
      resolve: () => {
        const stale = parseAbi(["error RoundTooStale(uint80 roundId, uint256 updatedAt, uint256 target)"]);
        throw new BaseError("reverted", {
          cause: new ContractFunctionRevertedError({
            abi: stale,
            data: encodeErrorResult({ abi: stale, errorName: "RoundTooStale", args: [1n, 2n, 3n] }),
            functionName: "resolve",
          }),
        });
      },
    });
    const v = await runVerification(client, deployment, priceMarket(), 5_000_000n);
    if (v.read.template !== "chainlink") throw new Error("expected a Chainlink read");
    expect(v.read.bracket?.status).toBe("stale");
    expect(v.read.expectedHash).toBeNull();
    expect(v.rerun).toBeNull();
    expect(v.rerunError).toMatch(/more than an hour old/);
  });

  it("previews 'waiting' while no round after the close exists", async () => {
    const v = await runVerification(chainlinkChain(5n), deployment, priceMarket(), 5_000_000n);
    if (v.read.template !== "chainlink") throw new Error("expected a Chainlink read");
    expect(v.read.bracket?.status).toBe("waiting");
    expect(v.rerun).toBeNull();
  });
});

// ---------------------------------------------------------------- the settle plan

describe("planSettlement", () => {
  it("Perpl: empty evidence, and the resolver's answer", async () => {
    const plan = await planSettlement(perplChain() as never, perplMarket({ phase: Phase.Closed }));
    expect(plan).toEqual({
      status: "ready",
      evidence: "0x",
      outcome: Outcome.Yes,
      evidenceHash: perplHash,
      bracket: null,
    });
  });

  it("Perpl: 'not resolvable yet' when the resolver returns Unresolved", async () => {
    const plan = await planSettlement(
      perplChain([Outcome.Unresolved, `0x${"00".repeat(32)}`]) as never,
      perplMarket({ phase: Phase.Closed }),
    );
    expect(plan.status).toBe("unresolved");
    if (plan.status === "unresolved") expect(plan.reason).toMatch(/^Not resolvable yet/);
  });

  it("Chainlink: settles with abi.encode(round 5)", async () => {
    const plan = await planSettlement(chainlinkChain() as never, priceMarket());
    expect(plan.status).toBe("ready");
    if (plan.status === "ready") {
      expect(plan.evidence).toBe(chainlinkEvidence(round(5n).roundId));
      expect(plan.outcome).toBe(Outcome.Yes);
    }
  });

  it("Chainlink: waits for a round after the close", async () => {
    const plan = await planSettlement(chainlinkChain(5n) as never, priceMarket());
    expect(plan.status).toBe("blocked");
    if (plan.status === "blocked")
      expect(plan.reason).toMatch(/Waiting for Chainlink's first round after the close/);
  });

  it("reports a resolver revert in plain words", async () => {
    const stale = parseAbi(["error RoundTooStale(uint80 roundId, uint256 updatedAt, uint256 target)"]);
    const data = encodeErrorResult({ abi: stale, errorName: "RoundTooStale", args: [1n, 2n, 3n] });
    const plan = await planSettlement(
      chainlinkChain(20n, () => {
        throw new BaseError("reverted", {
          cause: new ContractFunctionRevertedError({ abi: stale, data, functionName: "resolve" }),
        });
      }) as never,
      priceMarket(),
    );
    expect(plan).toEqual({ status: "blocked", reason: expect.stringMatching(/more than an hour old/) });
  });

  it("Pyth: the keeper settles these", async () => {
    const pyth = encodePriceAtTimeParams({
      source: PriceSource.Pyth,
      feed: "0x0000000000000000000000000000000000000000",
      pythId: `0x${"11".repeat(32)}`,
      strikeE8: 1n,
      lockTime: 1n,
      closeTime: CLOSE,
    });
    const plan = await planSettlement(
      fakeChain({}) as never,
      priceMarket({ params: pyth, decoded: decodeMarketParams(TemplateId.PriceAtTime, pyth) }),
    );
    expect(plan).toEqual({ status: "blocked", reason: expect.stringMatching(/The keeper settles these/) });
  });
});

// ---------------------------------------------------------------- the settlement transaction

describe("findSettlementTx", () => {
  const SETTLED_AT = 1_234_567n;
  const settler = "0x00000000000000000000000000000000000000D9" as Address;
  const evidence = chainlinkEvidence(round(5n).roundId);
  const hash = `0x${"77".repeat(32)}` as Hex;
  const topics = encodeEventTopics({ abi: marketAbi, eventName: "Settled" });
  const data = encodeAbiParameters(
    [{ type: "uint8" }, { type: "bytes32" }, { type: "address" }],
    [Outcome.Yes, chainlinkHash, settler],
  );

  it("searches past state for the block, then reads its event and call", async () => {
    let calls = 0;
    const client = fakeChain(
      {
        phase: (_a, _args, block) => {
          calls += 1;
          return block !== undefined && block >= SETTLED_AT ? Phase.Settled : Phase.Closed;
        },
      },
      {
        getLogs: ((p: { fromBlock: bigint }) =>
          p.fromBlock === SETTLED_AT
            ? [{ address: MARKET, topics, data, transactionHash: hash, blockNumber: SETTLED_AT }]
            : []) as never,
        getTransaction: (() => ({
          from: settler,
          to: MARKET,
          input: encodeFunctionData({ abi: marketAbi, functionName: "settle", args: [evidence] }),
        })) as never,
        getBlock: (() => ({ timestamp: 1_800_100_000n })) as never,
      },
    );
    const tx = await findSettlementTx(
      client,
      { address: MARKET, window: priceMarket().window },
      1_000_000n,
      2_000_000n,
    );
    expect(tx).toEqual({
      block: SETTLED_AT,
      time: 1_800_100_000,
      hash,
      by: settler,
      kind: "settled",
      evidence,
    });
    // A batched search: far fewer reads than a block-by-block walk.
    expect(calls).toBeLessThan(80);
  });

  it("returns null when the market is not final at the head", async () => {
    const client = fakeChain({ phase: () => Phase.Closed });
    expect(
      await findSettlementTx(client, { address: MARKET, window: priceMarket().window }, 1n, 100n),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------- the book read

describe("readBookSnapshot", () => {
  const MAKER = deployment.wallets.maker;
  const OTHER = "0x00000000000000000000000000000000000000f9" as Address;
  const BOOK = "0x00000000000000000000000000000000000000bb" as Address;
  const l2 = encodePacked(Array(8).fill("uint256"), [
    68_000_000n,
    385_000n,
    USDC(5),
    0n,
    416_000n,
    USDC(3),
    420_000n,
    USDC(2),
  ]);
  // Bid 0.385: orders 1 (maker, 2) -> 2 (other, 3). Ask 0.416: order 3 (maker, 3). Ask 0.420: order 4 (other).
  const orders: Record<number, readonly [Address, bigint, number, number, number, number, number, boolean]> =
    {
      1: [MAKER, USDC(2), 0, 2, 0, 385_000, 0, true],
      2: [OTHER, USDC(3), 1, 0, 0, 385_000, 0, true],
      3: [MAKER, USDC(3), 0, 0, 0, 416_000, 0, false],
      4: [OTHER, USDC(2), 0, 0, 0, 420_000, 0, false],
    };
  const client = fakeChain({
    getL2Book: () => l2,
    getMarketParams: () => [1_000_000, 1_000_000n, OTHER, 6n, OTHER, 6n, 1_000, USDC(1), USDC(5_000), 0n, 0n],
    marketState: () => 0,
    s_buyPricePoints: (_a, args) => (args[0] === 385_000n ? [1, 2] : [0, 0]),
    s_sellPricePoints: (_a, args) => (args[0] === 416_000n ? [3, 3] : args[0] === 420_000n ? [4, 4] : [0, 0]),
    s_orders: (_a, args) => {
      const o = orders[Number(args[0])];
      if (!o) throw new Error("no order");
      return o;
    },
  });

  it("decodes levels and params, and attributes our maker's size per level", async () => {
    const snap = await readBookSnapshot(client as never, BOOK, MAKER);
    expect(snap.block).toBe(68_000_000n);
    expect(snap.bids).toEqual([{ price: 385_000n, size: USDC(5) }]);
    expect(snap.asks).toEqual([
      { price: 416_000n, size: USDC(3) },
      { price: 420_000n, size: USDC(2) },
    ]);
    expect(snap.params.pricePrecision).toBe(1_000_000n);
    expect(snap.params.minSize).toBe(USDC(1));
    expect(snap.owned).toEqual({ bids: [USDC(2)], asks: [USDC(3), 0n] });
  });

  it("skips attribution without an owner", async () => {
    expect((await readBookSnapshot(client as never, BOOK)).owned).toBeNull();
  });
});

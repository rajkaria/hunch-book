import { marketAbi, Outcome, Phase } from "@hunch-book/shared";
import { type Address, encodeAbiParameters, encodeEventTopics, type Hex, zeroAddress } from "viem";
import { describe, expect, it, vi } from "vitest";
import type { ProofResult } from "../src/lib/indexer/queries";
import {
  firstBlockWhere,
  latestFinal,
  measureSettlement,
  readProofFromChain,
  type TimingClient,
} from "../src/lib/proof/chain";
import {
  countMarkets,
  marketBacking,
  proofFromIndexer,
  shareBps,
  vaultBalance,
} from "../src/lib/proof/metrics";
import { deployed, marketAddr, marketHandlers, stubClient } from "./chain";
import { MARKET, makeMarket, USDC } from "./fixtures";

const stats: NonNullable<ProofResult["ProtocolStats_by_pk"]> = {
  marketsCreated: 12,
  marketsPool: 4,
  marketsGraduated: 3,
  marketsSettled: 4,
  marketsVoided: 1,
  marketsGraduatedTotal: 7,
  wallets: 40,
  ourWallets: 13,
  externalWallets: 27,
  stakerWallets: 35,
  traderWallets: 9,
  stakeCount: 80,
  stakedUsdc: "9000000000",
  stakeCountOurs: 20,
  stakedUsdcOurs: "3000000000",
  fillCount: 200,
  fillCountOurMaker: 150,
  fillCountOurTrader: 10,
  fillCountBetweenOthers: 45,
  volume: "50000000000",
  volumeOurMaker: "40000000000",
  volumeBetweenOthers: "9000000000",
  ourMakerShareBps: 7_500,
  ourMakerVolumeShareBps: 8_000,
  routerTradeCount: 60,
  routerVolume: "20000000000",
  settlementsTimed: 3,
  avgSettlementLatencySeconds: "42",
  settlementsBlockClock: 1,
  avgSettlementLatencyBlocks: "150",
  earlySettlements: 1,
  redemptionCount: 30,
  redeemedUsdc: "7000000000",
  marketsRedeemed: 4,
  avgSecondsToFirstRedemption: "600",
  vaultObligations: "100000000",
  vaultUsdcBalance: "100500000",
  solvencyMargin: "500000",
  updatedAt: "1791096632",
  updatedAtBlock: "68000000",
};

const indexerAnswer: ProofResult = {
  ProtocolStats_by_pk: stats,
  DailyStats: [
    {
      date: "2026-10-04",
      marketsCreated: 2,
      stakeCount: 10,
      fillCount: 50,
      fillCountOurMaker: 40,
      fillCountBetweenOthers: 9,
      volume: "1000000",
      volumeOurMaker: "800000",
      activeWallets: 12,
      activeOurWallets: 3,
      newWallets: 5,
    },
  ],
  Market: [
    {
      id: "0x00000000000000000000000000000000000000a1",
      number: 1,
      question: "Will BTC close above?",
      stage: "Graduated",
      outcome: "Unresolved",
      graduated: true,
      creatorIsOurs: true,
      collateralIn: "600000000",
      collateralOut: "100000000",
      vaultPool: "0",
      vaultSets: "500000000",
      feesAccrued: "0",
      solvencyMargin: "0",
      fillCount: 10,
      fillCountOurMaker: 8,
      volume: "5000000",
      createdTx: `0x${"11".repeat(32)}`,
    },
    {
      id: "0x00000000000000000000000000000000000000a2",
      number: 2,
      question: null,
      stage: "Pool",
      outcome: "Unresolved",
      graduated: false,
      creatorIsOurs: false,
      collateralIn: "10",
      collateralOut: "0",
      vaultPool: "11",
      vaultSets: "0",
      feesAccrued: "0",
      solvencyMargin: "-1",
      fillCount: 0,
      fillCountOurMaker: 0,
      volume: "0",
      createdTx: `0x${"22".repeat(32)}`,
    },
  ],
  Settlement: [
    {
      id: "0x00000000000000000000000000000000000000a3",
      voided: false,
      outcome: "Yes",
      early: false,
      graduated: true,
      latencySeconds: "30",
      latencyBlocks: null,
      settlerIsOurs: true,
      block: "68000100",
      timestamp: "1791000000",
      tx: `0x${"33".repeat(32)}`,
      market: {
        id: "0x00000000000000000000000000000000000000a3",
        number: 3,
        question: null,
        blockClock: false,
        closeAt: "1790999970",
        firstRedemptionAt: "1791000600",
        redemptionCount: 2,
      },
    },
    {
      id: "0x00000000000000000000000000000000000000a4",
      voided: true,
      outcome: "Unresolved",
      early: false,
      graduated: false,
      latencySeconds: null,
      latencyBlocks: "120",
      settlerIsOurs: false,
      block: "68000200",
      timestamp: "1791000100",
      tx: `0x${"44".repeat(32)}`,
      market: {
        id: "0x00000000000000000000000000000000000000a4",
        number: 4,
        question: null,
        blockClock: true,
        closeAt: "68000080",
        firstRedemptionAt: null,
        redemptionCount: 0,
      },
    },
  ],
};

describe("proof metrics", () => {
  it("computes shares in basis points, rounded down", () => {
    expect(shareBps(1, 3)).toBe(3_333);
    expect(shareBps(150n, 200n)).toBe(7_500);
    expect(shareBps(5, 0)).toBe(0);
  });

  it("the vault margin is what it holds minus what it owes", () => {
    expect(vaultBalance(USDC(100.5), USDC(100))).toEqual({
      balance: USDC(100.5),
      obligations: USDC(100),
      margin: USDC(0.5),
    });
    expect(vaultBalance(1n, 2n).margin).toBe(-1n);
  });

  it("reads every figure from the indexer, with our share and fills between others apart", () => {
    const p = proofFromIndexer(indexerAnswer);
    expect(p.markets).toEqual({
      created: 12,
      graduated: 7,
      settled: 4,
      voided: 1,
      pools: 4,
      trading: 3,
      covered: 12,
    });
    expect(p.wallets).toEqual({ total: 40, ours: 13, external: 27, stakers: 35, traders: 9 });
    expect(p.trades).toMatchObject({
      fills: 200,
      fillsOurMaker: 150,
      fillsBetweenOthers: 45,
      volume: USDC(50_000),
      volumeOurMaker: USDC(40_000),
      ourMakerShareBps: 7_500,
      ourMakerVolumeShareBps: 8_000,
    });
    expect(p.timing).toMatchObject({
      avgSettleSeconds: 42n,
      avgSettleBlocks: 150n,
      avgFirstRedemptionSeconds: 600n,
    });
    expect(p.vault).toEqual({ balance: USDC(100.5), obligations: USDC(100), margin: USDC(0.5) });
    expect(p.daily[0]).toMatchObject({ date: "2026-10-04", fills: 50, fillsOurMaker: 40, volume: USDC(1) });
  });

  it("times each settlement in the market's own clock, and from settlement to first redemption", () => {
    const [price, perpl] = proofFromIndexer(indexerAnswer).settlements;
    expect(price).toMatchObject({
      number: 3,
      outcome: "Yes",
      latency: 30n,
      latencyUnit: "seconds",
      toFirstRedemption: 600n,
    });
    expect(perpl).toMatchObject({
      voided: true,
      outcome: null,
      latency: 120n,
      latencyUnit: "blocks",
      toFirstRedemption: null,
    });
  });

  it("lists each market's ledger and flags any negative margin", () => {
    const p = proofFromIndexer(indexerAnswer);
    expect(p.perMarket[0]).toMatchObject({
      number: 1,
      stage: "Trading",
      owed: USDC(500),
      collateralIn: USDC(600),
      collateralOut: USDC(100),
      margin: 0n,
    });
    expect(p.negative.map((m) => m.number)).toEqual([2]);
  });

  it("still renders when the indexer has no totals yet", () => {
    const p = proofFromIndexer({ ...indexerAnswer, ProtocolStats_by_pk: null });
    expect(p.wallets).toBeNull();
    expect(p.trades).toBeNull();
    expect(p.markets.created).toBe(0);
  });

  it("counts markets by phase from chain reads", () => {
    const markets = [
      makeMarket({ phase: Phase.Pool }),
      makeMarket({ phase: Phase.PoolLocked }),
      makeMarket({ phase: Phase.Graduated, graduated: true }),
      makeMarket({ phase: Phase.Closed, graduated: true }),
      makeMarket({ phase: Phase.Settled, graduated: true, outcome: Outcome.Yes }),
      makeMarket({ phase: Phase.Voided }),
    ];
    expect(countMarkets(140, markets)).toEqual({
      created: 140,
      graduated: 3,
      settled: 1,
      voided: 1,
      pools: 2,
      trading: 2,
      covered: 6,
    });
  });

  it("checks a graduated market's sets against both token supplies", () => {
    const trading = makeMarket({ phase: Phase.Graduated, graduated: true });
    const ledger = { pool: 0n, sets: USDC(400) };
    expect(marketBacking(trading, ledger, { yes: USDC(400), no: USDC(400) }).backed).toBe(true);
    expect(marketBacking(trading, ledger, { yes: USDC(400), no: USDC(399) }).backed).toBe(false);
    const pool = marketBacking(makeMarket(), { pool: USDC(400), sets: 0n }, { yes: 0n, no: 0n });
    expect(pool).toMatchObject({ stage: "Pool", owed: USDC(400), backed: null });
    const settled = marketBacking(
      makeMarket({ phase: Phase.Settled, graduated: true, outcome: Outcome.No }),
      ledger,
      { yes: USDC(400), no: USDC(100) },
    );
    expect(settled).toMatchObject({ stage: "Settled NO", backed: null });
    expect(marketBacking(trading, null, null).backed).toBeNull();
  });
});

describe("readProofFromChain", () => {
  it("counts from the factory and reads the vault, each ledger and each supply", async () => {
    const client = stubClient(
      marketHandlers(3, {
        ledger: (_a, args) =>
          args?.[0] === marketAddr(1) ? { pool: 0n, sets: USDC(400) } : { pool: USDC(400), sets: 0n },
        totalSupply: () => USDC(400),
        balanceOf: () => USDC(800.25),
        totalObligations: () => USDC(800),
      }),
    );
    const p = await readProofFromChain(client, deployed);
    expect(p.markets).toMatchObject({ created: 3, graduated: 1, pools: 2, trading: 1, covered: 3 });
    expect(p.wallets).toBeNull();
    expect(p.trades).toBeNull();
    expect(p.timing).toBeNull();
    expect(p.vault).toEqual({ balance: USDC(800.25), obligations: USDC(800), margin: USDC(0.25) });
    const graduated = p.perMarket.find((m) => m.market === marketAddr(1));
    expect(graduated).toMatchObject({ sets: USDC(400), yesSupply: USDC(400), backed: true });
    expect(p.perMarket.find((m) => m.market === marketAddr(0))).toMatchObject({
      pool: USDC(400),
      backed: null,
    });
    expect(p.listed).toHaveLength(3);
  });
});

describe("firstBlockWhere", () => {
  it("finds the first block where a condition starts to hold", async () => {
    const hit = vi.fn(async (b: bigint) => b >= 123_456n);
    expect(await firstBlockWhere(100_000n, 200_000n, hit)).toBe(123_456n);
    // Eight probes a round: far fewer reads than blocks.
    expect(hit.mock.calls.length).toBeLessThan(60);
    expect(await firstBlockWhere(5n, 6n, async () => true)).toBe(6n);
  });
});

describe("measureSettlement", () => {
  const SETTLED_AT = 5_000n;
  const REDEEMED_AT = 7_321n;
  const HEAD = 10_000n;
  const settleHash = `0x${"5e".repeat(32)}` as Hex;
  const topics = encodeEventTopics({ abi: marketAbi, eventName: "Settled" });
  const data = encodeAbiParameters(
    [{ type: "uint8" }, { type: "bytes32" }, { type: "address" }],
    [1, `0x${"ab".repeat(32)}`, "0x0f1156Eb25DBebee5386EC80F1EB0B85C7dD232A"],
  );

  function client(): TimingClient {
    return {
      getBlockNumber: async () => HEAD,
      readContract: vi.fn(async (c: { functionName: string; blockNumber?: bigint }) => {
        const at = c.blockNumber ?? HEAD;
        if (c.functionName === "phase") return at >= SETTLED_AT ? Phase.Settled : Phase.Closed;
        if (c.functionName === "ledger") return { pool: 0n, sets: at >= REDEEMED_AT ? USDC(300) : USDC(400) };
        throw new Error(`unexpected ${c.functionName}`);
      }),
      getLogs: async ({ fromBlock }: { fromBlock: bigint }) =>
        fromBlock === SETTLED_AT
          ? [
              {
                address: MARKET,
                data,
                topics,
                transactionHash: settleHash,
                blockNumber: SETTLED_AT,
                logIndex: 0,
              },
            ]
          : [],
      getTransaction: async () => ({ to: zeroAddress, from: zeroAddress as Address, input: "0x" }),
      getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({
        number: blockNumber,
        timestamp: 1_800_000_000n + blockNumber,
      }),
    } as unknown as TimingClient;
  }

  it("finds the settlement, its delay after close, and the first redemption after it", async () => {
    const m = makeMarket({
      phase: Phase.Settled,
      outcome: Outcome.Yes,
      graduated: true,
      window: { blockClock: false, lock: 1n, close: 1_800_004_000n, settleDeadline: 1_900_000_000n },
    });
    const t = await measureSettlement(
      client(),
      { ...deployed, hunchBook: { ...deployed.hunchBook, deployBlock: 1 } },
      m,
      HEAD,
    );
    expect(t).toMatchObject({
      block: SETTLED_AT,
      tx: settleHash,
      outcome: "Yes",
      voided: false,
      latency: 1_000n,
      latencyUnit: "seconds",
      toFirstRedemption: REDEEMED_AT - SETTLED_AT,
    });
  });

  it("picks the newest final markets to time", () => {
    const markets = [
      makeMarket({ phase: Phase.Pool }),
      makeMarket({ phase: Phase.Settled }),
      makeMarket({ phase: Phase.Voided }),
    ];
    expect(latestFinal(markets, 1).map((m) => m.phase)).toEqual([Phase.Settled]);
  });
});

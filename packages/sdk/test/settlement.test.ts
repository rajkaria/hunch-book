import {
  chainlinkRoundId,
  encodeChainlinkTouchParams,
  encodeFundingEventEvidence,
  encodeParlayParams,
  encodePerplFundingParams,
  encodePerplFundingSpikeParams,
  encodePriceAtTimeParams,
  encodePriceRangeParams,
  encodeRoundEvidence,
  marketAbi,
  Outcome,
  Phase,
  PriceSource,
  resolverAbi,
  TouchDirection,
} from "@hunch-book/shared";
import { type Abi, type Address, encodeAbiParameters, type Hex, parseAbi } from "viem";
import { beforeEach, describe, expect, it } from "vitest";
import { createContext, planSettlement, priceToE8Ceil, touches } from "../src/index.js";
import { FakeChain, Revert } from "./fake-chain.js";
import {
  addr,
  blockWindow,
  type FakeMarket,
  type FundingEvent,
  makeRounds,
  registerFactory,
  registerFeed,
  registerMarket,
  registerPerpl,
  registerResolver,
  testnet,
  timeWindow,
} from "./fixtures.js";

const HASH: Hex = `0x${"ab".repeat(32)}`;
const FEED = testnet.external.chainlink["BTC/USD"] as Address;
const EXCHANGE = testnet.external.perpl.exchange;
const RESOLVER = addr(0xaa);
const T0 = 1_800_000_000n;
const ZERO32: Hex = `0x${"00".repeat(32)}`;

let chain: FakeChain;
let markets: FakeMarket[];

function setup(
  m: FakeMarket,
  resolve: (evidence: Hex, value: bigint) => readonly [number, Hex],
  extra = {},
): void {
  markets = [m];
  registerFactory(chain, markets);
  registerMarket(chain, m);
  registerResolver(chain, RESOLVER, (_p, e, v) => resolve(e, v), extra);
}

/** A resolver stand-in that answers only for the evidence the test expects, like the real ones. */
const expects =
  (wanted: Hex, outcome: Outcome) =>
  (evidence: Hex): readonly [number, Hex] => {
    if (evidence.toLowerCase() !== wanted.toLowerCase())
      throw new Revert(parseAbi(["error MalformedEvidence()"]), "MalformedEvidence");
    return [outcome, HASH];
  };

beforeEach(() => {
  chain = new FakeChain();
  chain.block = { number: 50_000n, timestamp: T0 + 100_000n };
});

describe("planSettlement: lifecycle", () => {
  const perpl = (endBlock: bigint): FakeMarket => ({
    address: addr(0x101),
    id: 1,
    templateId: 1,
    params: encodePerplFundingParams({
      perpId: 16n,
      startBlock: 1_000n,
      endBlock,
      threshold: 0n,
      expectedScalingExp: 2,
    }),
    phase: Phase.Closed,
    window: blockWindow(1_000n, endBlock, T0 + 1_000_000n),
    resolver: RESOLVER,
  });

  it("template 1: waits for the block after the window, then settles with empty evidence", async () => {
    setup(perpl(60_000n), expects("0x", Outcome.Yes));
    const wait = await planSettlement(chain.context(), addr(0x101));
    expect(wait).toMatchObject({ status: "wait" });
    expect((wait as { reason: string }).reason).toMatch(/block 60001/);

    chain = new FakeChain();
    chain.block = { number: 50_000n, timestamp: T0 + 100_000n };
    setup(perpl(40_000n), expects("0x", Outcome.Yes));
    const ready = await planSettlement(chain.context(), addr(0x101));
    expect(ready).toMatchObject({
      status: "ready",
      method: "settle",
      evidence: "0x",
      value: 0n,
      outcome: Outcome.Yes,
      outcomeLabel: "yes",
      evidenceHash: HASH,
    });
  });

  it("reports Unresolved from the dry run as a wait, and a revert as blocked, in plain words", async () => {
    setup(perpl(40_000n), () => [Outcome.Unresolved, ZERO32]);
    const unresolved = await planSettlement(chain.context(), addr(0x101));
    expect(unresolved.status).toBe("wait");
    expect((unresolved as { reason: string }).reason).toMatch(/Perpl/);

    registerResolver(chain, RESOLVER, () => {
      throw new Revert(
        parseAbi(["error ExchangeVersionChanged(uint256,uint256,uint256)"]),
        "ExchangeVersionChanged",
        [1n, 8n, 0n],
      );
    });
    const blocked = await planSettlement(chain.context(), addr(0x101));
    expect(blocked).toEqual({
      status: "blocked",
      reason: "Perpl's contract version changed since the resolver was deployed.",
      detail: { endBlock: 40_000n },
    });
  });

  it("is final once settled or voided, and expired past the deadline", async () => {
    setup({ ...perpl(40_000n), phase: Phase.Settled, outcome: Outcome.No }, expects("0x", Outcome.No));
    expect(await planSettlement(chain.context(), addr(0x101))).toMatchObject({
      status: "final",
      outcome: Outcome.No,
    });

    chain = new FakeChain();
    chain.block = { number: 50_000n, timestamp: T0 + 2_000_000n };
    setup(perpl(40_000n), expects("0x", Outcome.Yes));
    const expired = await planSettlement(chain.context(), addr(0x101));
    expect(expired.status).toBe("expired");
    expect((expired as { reason: string }).reason).toMatch(/voidIfExpired/);
  });
});

describe("planSettlement: Chainlink price at a time (templates 2 and 5)", () => {
  // Rounds every 10 minutes from T0; the close sits 5 minutes after round 10.
  const rounds = makeRounds(1n, 30, T0, 600n, (i) => 8_000_000_000_000n + BigInt(i) * 10_000_000_000n);
  const close = T0 + 9n * 600n + 300n;
  const r10 = chainlinkRoundId(1n, 10n);

  const priceMarket = (closeTime: bigint, templateId: 2 | 5): FakeMarket => ({
    address: addr(0x202),
    id: 2,
    templateId,
    params:
      templateId === 2
        ? encodePriceAtTimeParams({
            source: PriceSource.Chainlink,
            feed: FEED,
            pythId: ZERO32,
            strikeE8: 8_050_000_000_000n,
            lockTime: T0,
            closeTime,
          })
        : encodePriceRangeParams({
            source: PriceSource.Chainlink,
            feed: FEED,
            pythId: ZERO32,
            lowerE8: 8_000_000_000_000n,
            upperE8: 8_200_000_000_000n,
            lockTime: T0,
            closeTime,
          }),
    phase: Phase.PoolLocked,
    window: timeWindow(T0, closeTime, closeTime + 604_800n),
    resolver: RESOLVER,
  });

  it("finds the one round that brackets the close", async () => {
    for (const templateId of [2, 5] as const) {
      chain = new FakeChain();
      chain.block = { number: 50_000n, timestamp: T0 + 100_000n };
      registerFeed(chain, FEED, rounds);
      setup(priceMarket(close, templateId), expects(encodeRoundEvidence(r10), Outcome.Yes));
      const plan = await planSettlement(chain.context(), addr(0x202));
      expect(plan).toMatchObject({ status: "ready", method: "settle", evidence: encodeRoundEvidence(r10) });
      expect((plan as { detail: Record<string, unknown> }).detail).toMatchObject({
        roundId: r10,
        updatedAt: T0 + 9n * 600n,
        nextUpdatedAt: T0 + 10n * 600n,
      });
    }
  });

  it("waits before the close and for the first round after it", async () => {
    registerFeed(chain, FEED, rounds);
    chain.block = { number: 50_000n, timestamp: close - 1n };
    setup(priceMarket(close, 2), expects(encodeRoundEvidence(r10), Outcome.Yes));
    expect((await planSettlement(chain.context(), addr(0x202))).status).toBe("wait");
    chain.block = { number: 50_000n, timestamp: close + 100n };
    const plan = await planSettlement(chain.context(), addr(0x202));
    expect(plan.status).toBe("wait");
    expect((plan as { reason: string }).reason).toMatch(/first round after the close/);
  });

  it("is blocked when the bracketing round is more than an hour old", async () => {
    const sparse = [
      { roundId: chainlinkRoundId(1n, 1n), answer: 1n, updatedAt: T0 },
      { roundId: chainlinkRoundId(1n, 2n), answer: 1n, updatedAt: T0 + 10_000n },
    ];
    registerFeed(chain, FEED, sparse);
    setup(priceMarket(T0 + 5_000n, 2), expects("0x", Outcome.Yes));
    const plan = await planSettlement(chain.context(), addr(0x202));
    expect(plan.status).toBe("blocked");
    expect((plan as { reason: string }).reason).toMatch(/voids at its deadline/);
  });
});

describe("planSettlement: Pyth price at a time", () => {
  const pythId = testnet.external.pyth.ids["SOL/USD"] as Hex;
  const close = T0 + 1_000n;
  const market: FakeMarket = {
    address: addr(0x203),
    id: 3,
    templateId: 2,
    params: encodePriceAtTimeParams({
      source: PriceSource.Pyth,
      feed: addr(0),
      pythId,
      strikeE8: 1n,
      lockTime: T0,
      closeTime: close,
    }),
    phase: Phase.PoolLocked,
    window: timeWindow(T0, close, close + 604_800n),
    resolver: RESOLVER,
  };
  const update: Hex = "0x504e4155deadbeef";

  it("waits without an API key, and with one settles with the update and Pyth's fee", async () => {
    const evidence = encodeAbiParameters([{ type: "bytes[]" }], [[update]]);
    setup(market, (e, value) => {
      if (value !== 7n)
        throw new Revert(parseAbi(["error InsufficientFee(uint256,uint256)"]), "InsufficientFee", [
          7n,
          value,
        ]);
      return expects(evidence, Outcome.No)(e);
    });
    chain.register(
      testnet.external.pyth.contract,
      parseAbi(["function getUpdateFee(bytes[]) view returns (uint256)"]),
      {
        getUpdateFee: () => 7n,
      },
    );
    const noKey = await planSettlement(chain.context(), addr(0x203));
    expect(noKey.status).toBe("wait");
    expect((noKey as { reason: string }).reason).toMatch(/apiKey/);

    let asked = "";
    const ctx = createContext({
      ...chain.context(),
      publicClient: chain.publicClient(),
      deployment: testnet,
      pyth: {
        apiKey: "test",
        fetch: (async (url: string) => {
          asked = url;
          return new Response(
            JSON.stringify({
              binary: { data: [update.slice(2)] },
              parsed: [
                {
                  id: pythId.slice(2),
                  price: { price: "15000000000", expo: -8, publish_time: Number(close) + 2 },
                  metadata: { prev_publish_time: Number(close) - 1 },
                },
              ],
            }),
            { status: 200 },
          );
        }) as typeof fetch,
      },
    });
    const plan = await planSettlement(ctx, addr(0x203));
    expect(asked).toContain(`/v2/updates/price/${close}?ids[]=${pythId.slice(2)}`);
    expect(plan).toMatchObject({ status: "ready", evidence, value: 7n, outcome: Outcome.No });
  });
});

describe("planSettlement: touch (template 3)", () => {
  const start = T0 + 1_000n;
  const end = start + 6_000n;
  const strike = 8_100_000_000_000n;
  // Rounds every 10 minutes from T0, from 80,000 USD up 100 USD a round: round 11 (T0 + 6,000 s) is the
  // first at or above the 81,000 USD strike, inside the window [T0 + 1,000 s, T0 + 7,000 s].
  const rounds = makeRounds(1n, 40, T0, 600n, (i) => 8_000_000_000_000n + BigInt(i - 1) * 10_000_000_000n);
  const touchMarket = (direction: TouchDirection, strikeE8 = strike): FakeMarket => ({
    address: addr(0x303),
    id: 4,
    templateId: 3,
    params: encodeChainlinkTouchParams({
      feed: FEED,
      strikeE8,
      direction,
      lockTime: T0,
      startTime: start,
      endTime: end,
    }),
    phase: Phase.PoolLocked,
    window: timeWindow(T0, end, end + 86_400n + 604_800n),
    resolver: RESOLVER,
  });

  it("finds the first touching round and proves YES before close", async () => {
    registerFeed(chain, FEED, rounds);
    chain.block = { number: 50_000n, timestamp: end - 100n };
    const r11 = chainlinkRoundId(1n, 11n);
    setup(touchMarket(TouchDirection.AtOrAbove), expects(encodeRoundEvidence(r11), Outcome.Yes));
    const plan = await planSettlement(chain.context(), addr(0x303));
    expect(plan).toMatchObject({
      status: "ready",
      method: "proveYes",
      evidence: encodeRoundEvidence(r11),
      outcome: Outcome.Yes,
    });
  });

  it("skips rounds that carried an answer forward", async () => {
    const carried = rounds.map((r) =>
      r.roundId === chainlinkRoundId(1n, 11n) ? { ...r, answeredInRound: r.roundId - 1n } : r,
    );
    registerFeed(chain, FEED, carried);
    chain.block = { number: 50_000n, timestamp: end - 100n };
    const r12 = chainlinkRoundId(1n, 12n);
    setup(touchMarket(TouchDirection.AtOrAbove), expects(encodeRoundEvidence(r12), Outcome.Yes));
    expect(await planSettlement(chain.context(), addr(0x303))).toMatchObject({
      status: "ready",
      evidence: encodeRoundEvidence(r12),
    });
  });

  it("waits with no touch, then settles NO with empty evidence after the challenge period", async () => {
    registerFeed(chain, FEED, rounds);
    chain.block = { number: 50_000n, timestamp: end + 3_600n };
    setup(touchMarket(TouchDirection.AtOrBelow, 7_000_000_000_000n), expects("0x", Outcome.No));
    const wait = await planSettlement(chain.context(), addr(0x303));
    expect(wait.status).toBe("wait");
    expect((wait as { reason: string }).reason).toMatch(/challenge period/);
    chain.block = { number: 50_000n, timestamp: end + 86_400n };
    expect(await planSettlement(chain.context(), addr(0x303))).toMatchObject({
      status: "ready",
      method: "settle",
      evidence: "0x",
      outcome: Outcome.No,
    });
  });

  it("rounds each direction the resolver's way", () => {
    // 8 decimals feeds need no rounding; 18 decimals do.
    expect(
      touches(8_100_000_000_000n, 8, { strikeE8: 8_100_000_000_000n, direction: TouchDirection.AtOrAbove })
        .touched,
    ).toBe(true);
    const justBelow = 81_000n * 10n ** 18n - 1n; // 80,999.999... at 18 decimals
    expect(
      touches(justBelow, 18, { strikeE8: 8_100_000_000_000n, direction: TouchDirection.AtOrAbove }).touched,
    ).toBe(false);
    const justAbove = 81_000n * 10n ** 18n + 1n;
    expect(
      touches(justAbove, 18, { strikeE8: 8_100_000_000_000n, direction: TouchDirection.AtOrBelow }).touched,
    ).toBe(false);
    expect(priceToE8Ceil(justAbove, -18)).toBe(8_100_000_000_001n);
  });
});

describe("planSettlement: funding spike (template 4)", () => {
  const A = 10_000n;
  const B = 12_000n;
  const spikeMarket = (threshold: bigint): FakeMarket => ({
    address: addr(0x404),
    id: 5,
    templateId: 4,
    params: encodePerplFundingSpikeParams({
      perpId: 16n,
      startBlock: A,
      endBlock: B,
      threshold,
      expectedScalingExp: 2,
    }),
    phase: Phase.Graduated,
    graduated: true,
    window: blockWindow(A, B, T0 + 1_000_000n),
    resolver: RESOLVER,
  });
  // Events every 100 blocks; the one at 11,000 charges 50 units, every other one 10.
  const grid = (): FundingEvent[] => {
    const events: FundingEvent[] = [];
    let sum = 0n;
    for (let b = 9_000n; b <= 13_000n; b += 100n) {
      sum += b === 11_000n ? 50n : 10n;
      events.push({ block: b, sum });
    }
    return events;
  };

  it("finds a spike on Perpl's grid and proves it before close", async () => {
    registerPerpl(chain, EXCHANGE, grid());
    chain.block = { number: 11_500n, timestamp: T0 + 100_000n };
    setup(spikeMarket(40n), expects(encodeFundingEventEvidence(11_000n), Outcome.Yes), {
      exchange: EXCHANGE,
    });
    const plan = await planSettlement(chain.context(), addr(0x404));
    expect(plan).toMatchObject({
      status: "ready",
      method: "proveYes",
      evidence: encodeFundingEventEvidence(11_000n),
    });
    expect((plan as { detail: Record<string, unknown> }).detail).toMatchObject({
      increment: 50n,
      eventBlock: 11_000n,
    });
  });

  it("walks event by event when an event is off the grid", async () => {
    const events = grid().filter((e) => e.block !== 11_500n);
    events.push({ block: 11_550n, sum: (events.find((e) => e.block === 11_400n)?.sum ?? 0n) + 10n });
    events.sort((a, b) => Number(a.block - b.block));
    // Re-accumulate so sums stay cumulative after the move.
    let sum = 0n;
    for (const e of events) {
      sum += e.block === 11_000n ? 50n : 10n;
      e.sum = sum;
    }
    registerPerpl(chain, EXCHANGE, events);
    chain.block = { number: 13_000n, timestamp: T0 + 100_000n };
    setup(spikeMarket(40n), expects(encodeFundingEventEvidence(11_000n), Outcome.Yes), {
      exchange: EXCHANGE,
    });
    expect(await planSettlement(chain.context(), addr(0x404))).toMatchObject({
      status: "ready",
      method: "settle",
    });
  });

  it("settles NO with empty evidence once the challenge blocks have passed", async () => {
    registerPerpl(chain, EXCHANGE, grid());
    chain.block = { number: B + 50n, timestamp: T0 + 100_000n };
    setup(spikeMarket(60n), expects("0x", Outcome.No), { exchange: EXCHANGE, challengeBlocks: 100n });
    const wait = await planSettlement(chain.context(), addr(0x404));
    expect((wait as { reason: string }).reason).toMatch(/after block 12100/);
    chain.block = { number: B + 101n, timestamp: T0 + 100_000n };
    expect(await planSettlement(chain.context(), addr(0x404))).toMatchObject({
      status: "ready",
      evidence: "0x",
      outcome: Outcome.No,
    });
  });
});

describe("planSettlement: parlay (template 6)", () => {
  const legs = [addr(0x601), addr(0x602)];
  const parlay: FakeMarket = {
    address: addr(0x606),
    id: 6,
    templateId: 6,
    params: encodeParlayParams({ legs, lockTime: T0, closeTime: T0 + 1_000n }),
    phase: Phase.PoolLocked,
    window: timeWindow(T0, T0 + 1_000n, T0 + 1_000_000n),
    resolver: RESOLVER,
  };
  const legOutcome = (address: Address, outcome: Outcome) =>
    chain.register(address, marketAbi as Abi, { outcome: () => outcome, evidenceHash: () => HASH });

  it("waits for open legs, and settles NO as soon as one leg is NO", async () => {
    setup(parlay, expects("0x", Outcome.No));
    legOutcome(legs[0] as Address, Outcome.Yes);
    legOutcome(legs[1] as Address, Outcome.Unresolved);
    const wait = await planSettlement(chain.context(), parlay.address);
    expect(wait).toMatchObject({ status: "wait", reason: "Waiting for 1 of 2 legs to settle." });
    legOutcome(legs[1] as Address, Outcome.No);
    expect(await planSettlement(chain.context(), parlay.address)).toMatchObject({
      status: "ready",
      evidence: "0x",
      outcome: Outcome.No,
    });
  });

  it("refuses an unknown template in plain words", async () => {
    setup({ ...parlay, templateId: 9 }, expects("0x", Outcome.No));
    expect(await planSettlement(chain.context(), parlay.address)).toMatchObject({
      status: "blocked",
      reason: "The SDK does not know template 9's evidence format.",
    });
    expect(resolverAbi.length).toBeGreaterThan(0);
  });
});

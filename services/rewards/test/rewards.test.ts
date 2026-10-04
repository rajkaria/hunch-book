import { verifyRewardProof } from "@hunch-book/sdk";
import { deployments, merkleDistributorAbi } from "@hunch-book/shared";
import {
  type Address,
  concat,
  decodeFunctionData,
  encodeAbiParameters,
  getAddress,
  type Hex,
  keccak256,
} from "viem";
import { describe, expect, it } from "vitest";
import { buildEpoch } from "../src/epoch.js";
import { type BookEvent, OrderBookState, sameLevels } from "../src/orders.js";
import {
  bindingActiveAt,
  creditReferrers,
  type FeeEvent,
  protocolShare,
  referralCredit,
} from "../src/referrals.js";
import { sampleFromLine, sampleToLine } from "../src/sample.js";
import { makerRewards, scoreMarket, scoreSample } from "../src/score.js";
import { windows } from "../src/sources.js";

const a = (n: number): Address => getAddress(`0x${n.toString(16).padStart(40, "0")}`);
const MARKET = a(0x1000);
const OURS = deployments["monad-testnet"].wallets.maker;
const order = (owner: Address, isBuy: boolean, price: bigint, size: bigint, orderId = 0n) => ({
  orderId,
  owner,
  isBuy,
  price,
  size,
});

describe("order book rebuilt from Kuru's events", () => {
  it("tracks creations, partial fills, full fills and single and batch cancels", () => {
    const s = new OrderBookState();
    const events: BookEvent[] = [
      {
        kind: "created",
        block: 10n,
        logIndex: 0,
        orderId: 1n,
        owner: a(1),
        price: 400_000n,
        size: 50_000_000n,
        isBuy: true,
      },
      {
        kind: "created",
        block: 10n,
        logIndex: 1,
        orderId: 2n,
        owner: a(1),
        price: 450_000n,
        size: 50_000_000n,
        isBuy: false,
      },
      {
        kind: "created",
        block: 11n,
        logIndex: 0,
        orderId: 3n,
        owner: a(2),
        price: 400_000n,
        size: 10_000_000n,
        isBuy: true,
      },
      { kind: "filled", block: 12n, logIndex: 0, orderId: 2n, remaining: 20_000_000n },
      {
        kind: "created",
        block: 12n,
        logIndex: 1,
        orderId: 4n,
        owner: a(2),
        price: 460_000n,
        size: 5_000_000n,
        isBuy: false,
      },
      { kind: "filled", block: 13n, logIndex: 0, orderId: 4n, remaining: 0n },
      { kind: "cancelled", block: 14n, logIndex: 0, orderIds: [3n] },
      {
        kind: "created",
        block: 14n,
        logIndex: 1,
        orderId: 5n,
        owner: a(1),
        price: 390_000n,
        size: 1_000_000n,
        isBuy: true,
      },
      { kind: "cancelled", block: 15n, logIndex: 0, orderIds: [5n, 99n] },
    ];
    // Out of order on purpose: applyAll sorts by block and log index.
    s.applyAll([...events].reverse());
    expect(s.resting().map((o) => [o.orderId, o.size])).toEqual([
      [1n, 50_000_000n],
      [2n, 20_000_000n],
    ]);
    expect(s.block).toBe(15n);
    expect(s.levels()).toEqual({
      bids: [{ price: 400_000n, size: 50_000_000n }],
      asks: [{ price: 450_000n, size: 20_000_000n }],
    });
  });

  it("aggregates levels the way getL2Book reports them, and compares them", () => {
    const s = new OrderBookState();
    s.applyAll([
      {
        kind: "created",
        block: 1n,
        logIndex: 0,
        orderId: 1n,
        owner: a(1),
        price: 400_000n,
        size: 5n,
        isBuy: true,
      },
      {
        kind: "created",
        block: 1n,
        logIndex: 1,
        orderId: 2n,
        owner: a(2),
        price: 400_000n,
        size: 7n,
        isBuy: true,
      },
      {
        kind: "created",
        block: 1n,
        logIndex: 2,
        orderId: 3n,
        owner: a(2),
        price: 410_000n,
        size: 1n,
        isBuy: true,
      },
      {
        kind: "created",
        block: 1n,
        logIndex: 3,
        orderId: 4n,
        owner: a(1),
        price: 430_000n,
        size: 2n,
        isBuy: false,
      },
      {
        kind: "created",
        block: 1n,
        logIndex: 4,
        orderId: 5n,
        owner: a(1),
        price: 420_000n,
        size: 3n,
        isBuy: false,
      },
    ]);
    const levels = s.levels();
    expect(levels.bids).toEqual([
      { price: 410_000n, size: 1n },
      { price: 400_000n, size: 12n },
    ]);
    expect(levels.asks).toEqual([
      { price: 420_000n, size: 3n },
      { price: 430_000n, size: 2n },
    ]);
    expect(sameLevels(levels, { bids: levels.bids, asks: levels.asks })).toBe(true);
    expect(sameLevels(levels, { bids: levels.bids, asks: [{ price: 420_000n, size: 3n }] })).toBe(false);
  });

  it("round-trips samples through the JSON lines file", () => {
    const sample = {
      market: MARKET,
      block: 5n,
      time: 1_800_000_000,
      l2Match: true,
      orders: [order(a(1), true, 400_000n, 3n, 9n)],
    };
    expect(sampleFromLine(sampleToLine(sample))).toEqual(sample);
  });

  it("walks a range in 100-block windows", () => {
    expect(windows(1_000n, 1_250n)).toEqual([
      { fromBlock: 1_000n, toBlock: 1_099n },
      { fromBlock: 1_100n, toBlock: 1_199n },
      { fromBlock: 1_200n, toBlock: 1_250n },
    ]);
  });
});

describe("maker score (docs/PERIPHERY.md, V-5)", () => {
  // A touch at 0.42 on both sides pins the mid at 0.42 (a pure-math fixture: Kuru never leaves a book
  // locked), so the test orders below, bids at or under it and asks at or over it, never move it.
  // Band 0.03.
  const book = (extra: ReturnType<typeof order>[] = []) => [
    order(a(9), true, 420_000n, 1n),
    order(a(9), false, 420_000n, 1n),
    ...extra,
  ];

  it("weights an order by ((B - d) / B)^2: full at the mid, zero at the band's edge", () => {
    const at = (price: bigint) => {
      const s = scoreSample(book([order(a(1), true, price, 1_000_000n)]));
      return s?.get(a(1))?.qBid ?? 0n;
    };
    // Scaled units: size · (2B − 2d)^2, so the mid scores size · (2B)^2.
    expect(at(420_000n)).toBe(1_000_000n * 60_000n ** 2n);
    expect(at(405_000n)).toBe(1_000_000n * 30_000n ** 2n); // d = B / 2: a quarter of the mid's
    expect(at(390_000n)).toBe(0n); // d = B: the edge scores nothing
    expect(at(380_000n)).toBe(0n);
  });

  it("pays up to three times as much for quoting both sides", () => {
    const one = scoreSample(book([order(a(1), true, 420_000n, 1_000n)]))?.get(a(1));
    const both = scoreSample(
      book([order(a(2), true, 420_000n, 1_000n), order(a(2), false, 420_000n, 1_000n)]),
    )?.get(a(2));
    expect(one?.s3).toBe(1_000n * 60_000n ** 2n);
    expect(both?.s3).toBe(3n * 1_000n * 60_000n ** 2n);
    // Lopsided: S = max(min, max / 3).
    const lop = scoreSample(
      book([order(a(3), true, 420_000n, 9_000n), order(a(3), false, 420_000n, 1_000n)]),
    )?.get(a(3));
    expect(lop?.s3).toBe(9_000n * 60_000n ** 2n);
  });

  it("skips samples with one side of the book empty, and marks time at the touch", () => {
    expect(scoreSample([order(a(1), true, 400_000n, 1n)])).toBeNull();
    const s = scoreSample(book([order(a(1), true, 420_000n, 5n), order(a(2), true, 395_000n, 5n)]));
    expect(s?.get(a(1))?.atTouch).toBe(true);
    expect(s?.get(a(2))?.atTouch).toBe(false);
  });

  it("splits a market's pool by score, never pays our maker and never redistributes its share", () => {
    const samples = [
      {
        market: MARKET,
        block: 1n,
        orders: [
          order(OURS, true, 410_000n, 3_000_000n),
          order(OURS, false, 430_000n, 3_000_000n),
          order(a(1), true, 410_000n, 1_000_000n),
          order(a(1), false, 430_000n, 1_000_000n),
        ],
      },
      {
        market: MARKET,
        block: 2n,
        orders: [
          order(OURS, true, 410_000n, 3_000_000n),
          order(OURS, false, 430_000n, 3_000_000n),
          order(a(1), true, 410_000n, 1_000_000n),
          order(a(1), false, 430_000n, 1_000_000n),
        ],
      },
      { market: MARKET, block: 3n, orders: [order(a(1), true, 410_000n, 1_000_000n)] },
    ];
    const score = scoreMarket(MARKET, samples);
    expect(score).toMatchObject({ samples: 2, skipped: 1 });
    const rewards = makerRewards(score, 100_000_000n, { ourMakers: [OURS] });
    const ours = rewards.find((r) => r.maker === getAddress(OURS));
    const theirs = rewards.find((r) => r.maker === a(1));
    expect(ours).toMatchObject({
      ours: true,
      reward: 0n,
      earned: 75_000_000n,
      shareBps: 7_500,
      timeAtTouchBps: 10_000,
    });
    expect(theirs).toMatchObject({ ours: false, reward: 25_000_000n, earned: 25_000_000n, shareBps: 2_500 });
    // The 75 USDC our maker would have earned is not given to anyone else.
    expect(rewards.reduce((s, r) => s + r.reward, 0n)).toBe(25_000_000n);
  });

  it("rounds every reward down, so a pool is never overpaid", () => {
    const samples = [
      {
        market: MARKET,
        block: 1n,
        orders: [
          order(a(1), true, 410_000n, 1n),
          order(a(1), false, 430_000n, 1n),
          order(a(2), true, 410_000n, 1n),
          order(a(2), false, 430_000n, 1n),
          order(a(3), true, 410_000n, 1n),
          order(a(3), false, 430_000n, 1n),
        ],
      },
    ];
    const rewards = makerRewards(scoreMarket(MARKET, samples), 100n, { ourMakers: [] });
    expect(rewards.map((r) => r.reward)).toEqual([33n, 33n, 33n]);
  });
});

describe("referral credits (docs/PERIPHERY.md, C-8)", () => {
  const event = (user: Address, fee: bigint, time: bigint): FeeEvent => ({
    kind: "redeem",
    market: MARKET,
    user,
    fee,
    block: time,
    time,
    tx: `0x${"ab".repeat(32)}`,
  });

  it("shares only the protocol's 75%, at the policy's basis points, rounded down", () => {
    expect(protocolShare(1_000_000n)).toBe(750_000n);
    expect(protocolShare(3n)).toBe(3n); // the creator's floor(3 · 25%) = 0
    expect(referralCredit(1_000_000n)).toBe(150_000n); // 20% of 75%
    expect(referralCredit(1_000_000n, 1_000n)).toBe(75_000n);
    expect(referralCredit(4n)).toBe(0n);
  });

  it("credits only fees paid while the binding was active", async () => {
    const referrer = a(0xee);
    const bindings = new Map([[a(1), { referrer, boundAt: 100n, expiresAt: 200n }]]);
    const result = await creditReferrers(
      [
        event(a(1), 1_000_000n, 99n),
        event(a(1), 1_000_000n, 100n),
        event(a(1), 2_000_000n, 199n),
        event(a(1), 1_000_000n, 200n),
        event(a(2), 1_000_000n, 150n),
      ],
      async (user) => bindings.get(user) ?? null,
    );
    expect(result.credits.get(referrer)).toBe(150_000n + 300_000n);
    expect(result.rows).toHaveLength(2);
    expect(result.unbound).toBe(3);
    expect(
      bindingActiveAt(
        { referrer: "0x0000000000000000000000000000000000000000", boundAt: 0n, expiresAt: 9n },
        1n,
      ),
    ).toBe(false);
  });
});

describe("epoch file", () => {
  const makers = [
    {
      market: MARKET,
      maker: a(1),
      earned: 25_000_000n,
      reward: 25_000_000n,
      shareBps: 2_500,
      timeAtTouchBps: 10_000,
      ours: false,
    },
    {
      market: a(0x2000),
      maker: a(1),
      earned: 1_000_000n,
      reward: 1_000_000n,
      shareBps: 100,
      timeAtTouchBps: 0,
      ours: false,
    },
    {
      market: MARKET,
      maker: OURS,
      earned: 75_000_000n,
      reward: 0n,
      shareBps: 7_500,
      timeAtTouchBps: 10_000,
      ours: true,
    },
  ];

  it("merges maker rewards and referral credits per account into one tree the distributor verifies", () => {
    const file = buildEpoch({
      network: "monad-testnet",
      epoch: 3n,
      token: a(0x5d),
      distributor: a(0xd1),
      claimDeadline: 1_800_000_000n,
      makers,
      referrals: new Map([
        [a(1), 150_000n],
        [a(0xee), 450_000n],
      ]),
      programs: {},
    });
    expect(file).toMatchObject({ epoch: "3", total: "26600000", totalUsdc: "26.6", dryRun: true });
    expect(file.claims.map((c) => [c.account, c.amount, c.makerReward, c.referralReward])).toEqual([
      [a(1), "26150000", "26000000", "150000"],
      [a(0xee), "450000", "0", "450000"],
    ]);
    expect(file.excluded).toEqual([
      { account: getAddress(OURS), label: expect.stringContaining("ours"), wouldHaveEarned: "75000000" },
    ]);
    for (const c of file.claims) {
      const leaf = keccak256(
        keccak256(
          encodeAbiParameters(
            [{ type: "uint256" }, { type: "address" }, { type: "uint256" }],
            [3n, c.account, BigInt(c.amount)],
          ),
        ),
      );
      expect(verifyRewardProof(file.root as Hex, leaf, c.proof)).toBe(true);
    }
    const call = decodeFunctionData({ abi: merkleDistributorAbi, data: file.fund?.createEpoch.data as Hex });
    expect(call).toEqual({
      functionName: "createEpoch",
      args: [a(0x5d), file.root, 26_600_000n, 1_800_000_000n],
    });
    expect(concat([file.fund?.approve.data as Hex]).startsWith("0x095ea7b3")).toBe(true);
  });

  it("writes an empty epoch with no root when nobody earned anything", () => {
    const file = buildEpoch({
      network: "monad-testnet",
      epoch: 0n,
      token: a(1),
      distributor: a(2),
      claimDeadline: 1n,
      makers: [],
      referrals: new Map(),
      programs: {},
    });
    expect(file).toMatchObject({ total: "0", root: null, claims: [], fund: null });
  });
});

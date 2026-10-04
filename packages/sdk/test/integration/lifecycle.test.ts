import {
  type Deployment,
  deployments,
  merkleDistributorAbi,
  Outcome,
  Phase,
  PriceSource,
  Side,
  TouchDirection,
} from "@hunch-book/shared";
import {
  type Abi,
  type Address,
  erc20Abi,
  type Hex,
  maxUint256,
  type PrivateKeyAccount,
  parseAbi,
} from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bindReferrerFor,
  buildReferralBinding,
  buildRewardTree,
  buildStakeAuthorization,
  claimRewards,
  claimTokens,
  collect,
  createContext,
  createMarket,
  getMarket,
  getPosition,
  graduate,
  type HunchContext,
  isRewardClaimed,
  mergeSets,
  mintSets,
  mintTestUsdc,
  nextRewardEpoch,
  optInAutoRedeemWithPermit,
  planSettlement,
  proveYes,
  referralOf,
  settle,
  signReferralBinding,
  signStakeAuthorization,
  stake,
  stakeWithAuthorization,
  verifySettlement,
} from "../../src/index.js";
import { Anvil, type Artifact, artifact } from "./anvil.js";

// The SDK against Hunch Book's real contracts on a local anvil chain: the real factory, vault, markets
// and outcome tokens, the six real resolvers reading mock Chainlink and Perpl sources, and the real
// distributor, referral registry and auto-redeemer. Every market is created, staked, settled with
// evidence the SDK finds by itself, and verified by the SDK against the hash the real resolver stored.
// Skips (does not fail) when anvil or contracts/out is missing.

const ART = {
  usdc: artifact("TestUSDC.sol", "TestUSDC"),
  market: artifact("Market.sol", "Market"),
  factory: artifact("HunchBookFactory.sol", "HunchBookFactory"),
  graduator: artifact("MockGraduator.sol", "MockGraduator"),
  perpl: artifact("MockPerplExchange.sol", "MockPerplExchange"),
  feed: artifact("MockChainlinkAggregator.sol", "MockChainlinkAggregator"),
  perplResolver: artifact("PerplFundingResolver.sol", "PerplFundingResolver"),
  priceResolver: artifact("PriceAtTimeResolver.sol", "PriceAtTimeResolver"),
  touchResolver: artifact("ChainlinkTouchResolver.sol", "ChainlinkTouchResolver"),
  spikeResolver: artifact("PerplFundingSpikeResolver.sol", "PerplFundingSpikeResolver"),
  rangeResolver: artifact("PriceRangeResolver.sol", "PriceRangeResolver"),
  parlayResolver: artifact("MarketOutcomeResolver.sol", "MarketOutcomeResolver"),
  distributor: artifact("MerkleDistributor.sol", "MerkleDistributor"),
  referrals: artifact("ReferralRegistry.sol", "ReferralRegistry"),
  autoRedeemer: artifact("AutoRedeemer.sol", "AutoRedeemer"),
};
const built = Object.values(ART).every((a) => a !== null);
const abi = (name: keyof typeof ART): Abi => (ART[name] as Artifact).abi;

const USDC = 1_000_000n;
const PERP = 16n;
const INTERVAL = 100n;
const CHALLENGE_BLOCKS = 86_400n;
const ZERO32: Hex = `0x${"00".repeat(32)}`;
const rid = (n: bigint): bigint => (1n << 64n) | n;
const RULE = { minPool: 20n * USDC, minStakers: 2, minChanceBps: 300, maxChanceBps: 9_700 };

let anvil: Anvil | null = null;
let deployer: PrivateKeyAccount;
let alice: PrivateKeyAccount;
let bob: PrivateKeyAccount;
let relayer: PrivateKeyAccount;
let deployment: Deployment;
let perpl: Address;
let feed: Address;
let b0: bigint;
let t0: bigint;
const m: Record<string, Address> = {};

function ctxFor(account?: PrivateKeyAccount): HunchContext {
  const a = anvil as Anvil;
  return createContext({
    deployment,
    publicClient: a.client,
    walletClient: account ? (a.wallet(account) as never) : undefined,
  });
}

async function setRound(n: bigint, answer: bigint, updatedAt: bigint, latest = true): Promise<void> {
  const a = anvil as Anvil;
  await a.send(deployer, feed, abi("feed"), "setRound", [rid(n), answer, updatedAt]);
  if (latest) await a.send(deployer, feed, abi("feed"), "setLatest", [rid(n)]);
}

const e8 = (usd: bigint): bigint => usd * 100_000_000n;

beforeAll(async () => {
  if (!built) {
    console.warn(
      "contracts/out is missing: run `forge build` in contracts/ to run the SDK integration tests",
    );
    return;
  }
  anvil = await Anvil.start();
  if (!anvil) return;
  const a = anvil;
  [deployer, alice, bob, relayer] = await Promise.all([a.account(), a.account(), a.account(), a.account()]);

  const usdc = await a.deploy(deployer, ART.usdc as Artifact);
  const implementation = await a.deploy(deployer, ART.market as Artifact);
  const caps = {
    poolCap: 5_000n * USDC,
    walletCap: 1_000n * USDC,
    minStake: USDC,
    creatorMinStake: 5n * USDC,
  };
  const factory = await a.deploy(deployer, ART.factory as Artifact, [
    usdc,
    implementation,
    deployer.address,
    deployer.address,
    caps,
    50_000n * USDC,
  ]);
  const vault = await a.read<Address>(factory, abi("factory"), "vault");
  const graduator = await a.deploy(deployer, ART.graduator as Artifact);
  await a.send(deployer, factory, abi("factory"), "setGraduator", [graduator]);

  perpl = await a.deploy(deployer, ART.perpl as Artifact);
  await a.send(deployer, perpl, abi("perpl"), "setInterval", [INTERVAL]);
  await a.send(deployer, perpl, abi("perpl"), "listPerp", [PERP, "BTC Perp", "BTC", 1n, 2n, 1n]);
  feed = await a.deploy(deployer, ART.feed as Artifact, [8, "BTC / USD"]);

  const resolvers = {
    perplFunding: await a.deploy(deployer, ART.perplResolver as Artifact, [perpl, 1_000n]),
    priceAtTime: await a.deploy(deployer, ART.priceResolver as Artifact, [
      [feed],
      "0x0000000000000000000000000000000000000000",
      [],
      [],
    ]),
    chainlinkTouch: await a.deploy(deployer, ART.touchResolver as Artifact, [[feed]]),
    perplFundingSpike: await a.deploy(deployer, ART.spikeResolver as Artifact, [
      perpl,
      1_000n,
      CHALLENGE_BLOCKS,
    ]),
    priceRange: await a.deploy(deployer, ART.rangeResolver as Artifact, [
      [feed],
      "0x0000000000000000000000000000000000000000",
      [],
      [],
    ]),
    marketOutcome: await a.deploy(deployer, ART.parlayResolver as Artifact, [factory, 200n]),
  };
  const order = [
    "perplFunding",
    "priceAtTime",
    "chainlinkTouch",
    "perplFundingSpike",
    "priceRange",
    "marketOutcome",
  ] as const;
  for (const [i, key] of order.entries()) {
    await a.send(deployer, factory, abi("factory"), "addTemplate", [i + 1, resolvers[key], RULE]);
  }
  const periphery = {
    merkleDistributor: await a.deploy(deployer, ART.distributor as Artifact, [deployer.address]),
    referralRegistry: await a.deploy(deployer, ART.referrals as Artifact, [15_552_000n]),
    autoRedeemer: await a.deploy(deployer, ART.autoRedeemer as Artifact, [factory]),
  };
  const testnet = deployments["monad-testnet"];
  deployment = {
    ...testnet,
    rpc: a.url,
    hunchBook: {
      factory,
      vault,
      usdc,
      graduator,
      resolvers,
      periphery,
      deployBlock: Number((await a.head()).number) - 40,
    },
    external: {
      ...testnet.external,
      perpl: { exchange: perpl, perps: { BTC: Number(PERP) } },
      chainlink: { "BTC/USD": feed },
    },
  };

  // Test USDC from the faucet, through the SDK.
  for (const who of [deployer, alice, bob, relayer]) await mintTestUsdc(ctxFor(who), 5_000n * USDC);

  const head = await a.head();
  b0 = head.number;
  t0 = head.timestamp;
  // Perpl funding events every 100 blocks from b0 to b0 + 3,000; every one charges 10 units except
  // the one at b0 + 900, which charges 50.
  let sum = 0n;
  for (let block = b0; block <= b0 + 3_000n; block += INTERVAL) {
    sum += block === b0 + 900n ? 50n : 10n;
    await a.send(deployer, perpl, abi("perpl"), "pushEvent", [PERP, block, Number(sum)]);
  }
}, 240_000);

afterAll(() => anvil?.stop());

describe.skipIf(!built)("SDK on anvil with the real contracts", () => {
  it("creates one market per template with typed params", async () => {
    if (!anvil) return;
    const head = await anvil.head();
    const A = head.number + 400n;
    const lock = t0 + 2_000n;
    const close = t0 + 3_000n;
    const ctx = ctxFor(deployer);
    const create = async (key: string, input: Parameters<typeof createMarket>[1]) => {
      const tx = await createMarket(ctx, input);
      expect(tx.url).toMatch(/^https:\/\/testnet\.monadscan\.com\/tx\/0x/);
      m[key] = tx.market;
    };
    await create("funding", {
      templateId: 1,
      params: { perpId: PERP, startBlock: A, endBlock: A + 300n, threshold: 0n, expectedScalingExp: 2 },
      side: "yes",
      firstStake: 10n * USDC,
    });
    await create("spikeYes", {
      templateId: 4,
      params: { perpId: PERP, startBlock: A, endBlock: A + 800n, threshold: 40n, expectedScalingExp: 2 },
      side: "no",
      firstStake: 5n * USDC,
    });
    await create("spikeNo", {
      templateId: 4,
      params: { perpId: PERP, startBlock: A, endBlock: A + 800n, threshold: 60n, expectedScalingExp: 2 },
      side: "no",
      firstStake: 5n * USDC,
    });
    await create("price", {
      templateId: 2,
      params: {
        source: PriceSource.Chainlink,
        feed,
        pythId: ZERO32,
        strikeE8: e8(80_000n),
        lockTime: lock,
        closeTime: close,
      },
      side: "yes",
      firstStake: 5n * USDC,
    });
    await create("range", {
      templateId: 5,
      params: {
        source: PriceSource.Chainlink,
        feed,
        pythId: ZERO32,
        lowerE8: e8(79_000n),
        upperE8: e8(81_000n),
        lockTime: lock,
        closeTime: close,
      },
      side: "yes",
      firstStake: 5n * USDC,
    });
    await create("touchYes", {
      templateId: 3,
      params: {
        feed,
        strikeE8: e8(82_000n),
        direction: TouchDirection.AtOrAbove,
        lockTime: lock,
        startTime: lock,
        endTime: t0 + 5_000n,
      },
      side: "no",
      firstStake: 5n * USDC,
    });
    await create("touchNo", {
      templateId: 3,
      params: {
        feed,
        strikeE8: e8(70_000n),
        direction: TouchDirection.AtOrBelow,
        lockTime: lock,
        startTime: lock,
        endTime: t0 + 5_000n,
      },
      side: "no",
      firstStake: 5n * USDC,
    });
    await create("parlay", {
      templateId: 6,
      params: {
        legs: [m.price as Address, m.range as Address],
        lockTime: lock - 100n,
        closeTime: close + 100n,
      },
      side: "yes",
      firstStake: 5n * USDC,
    });
    const funding = await getMarket(ctx, m.funding as Address);
    expect(funding).toMatchObject({
      templateId: 1,
      phaseName: "pool",
      asset: "BTC",
      rule: expect.stringContaining("Perpl"),
    });
    const parlay = await getMarket(ctx, m.parlay as Address);
    expect(parlay?.decoded.kind).toBe("parlay");
    await expect(
      createMarket(ctx, {
        templateId: 2,
        params: {
          source: PriceSource.Chainlink,
          feed,
          pythId: ZERO32,
          strikeE8: e8(80_000n),
          lockTime: lock,
          closeTime: close,
        },
        side: "yes",
        firstStake: 5n * USDC,
      }),
    ).rejects.toThrow(/already exists/);
  }, 120_000);

  it("stakes directly and from a signed USDC authorisation a relayer submits", async () => {
    if (!anvil) return;
    await stake(ctxFor(alice), m.funding as Address, "no", 20n * USDC);
    await stake(ctxFor(bob), m.price as Address, "no", 3n * USDC);
    const auth = await buildStakeAuthorization(ctxFor(alice), {
      market: m.price as Address,
      user: alice.address,
      side: "yes",
      amount: 7n * USDC,
    });
    const signed = await signStakeAuthorization(ctxFor(alice), auth);
    const tx = await stakeWithAuthorization(ctxFor(relayer), signed);
    expect(tx.status).toBe("success");
    const position = await getPosition(ctxFor(), m.price as Address, alice.address);
    expect(position.stake).toEqual({ yes: 7n * USDC, no: 0n });
    // The relayer paid the gas, the user paid the USDC.
    expect(
      await anvil.read<bigint>(deployment.hunchBook.usdc as Address, erc20Abi as Abi, "balanceOf", [
        relayer.address,
      ]),
    ).toBe(5_000n * USDC);
  }, 60_000);

  it("graduates, claims tokens, mints and merges sets, and opts in to auto-redeem with a permit", async () => {
    if (!anvil) return;
    await graduate(ctxFor(bob), m.funding as Address);
    const info = await getMarket(ctxFor(), m.funding as Address);
    expect(info?.phase).toBe(Phase.Graduated);
    expect(info?.prices).toBeNull(); // the test graduator's book is a placeholder address
    await claimTokens(ctxFor(alice), m.funding as Address);
    await claimTokens(ctxFor(deployer), m.funding as Address);
    const yes = info?.tokens.yes as Address;
    // Pool 10 YES + 20 NO = 30: alice's 20 NO claim 30 NO.
    expect((await getPosition(ctxFor(), m.funding as Address, alice.address)).balances).toEqual({
      yes: 0n,
      no: 30n * USDC,
    });
    await mintSets(ctxFor(bob), m.funding as Address, 4n * USDC);
    await mergeSets(ctxFor(bob), m.funding as Address, USDC);
    expect((await getPosition(ctxFor(), m.funding as Address, bob.address)).balances).toEqual({
      yes: 3n * USDC,
      no: 3n * USDC,
    });
    await optInAutoRedeemWithPermit(ctxFor(deployer), { token: yes, value: maxUint256 });
    const ar = deployment.hunchBook.periphery?.autoRedeemer as Address;
    expect(await anvil.read<bigint>(yes, erc20Abi as Abi, "allowance", [deployer.address, ar])).toBe(
      maxUint256,
    );
    expect(
      await anvil.read<boolean>(ar, parseAbi(["function optedIn(address) view returns (bool)"]), "optedIn", [
        deployer.address,
      ]),
    ).toBe(true);
  }, 60_000);

  it("template 1: settles from Perpl's history and verifies against the stored hash", async () => {
    if (!anvil) return;
    const ctx = ctxFor(bob);
    const early = await planSettlement(ctx, m.funding as Address);
    expect(early.status).toBe("wait");
    const info = await getMarket(ctx, m.funding as Address);
    const head = await anvil.head();
    if (info && head.number <= info.window.close)
      await anvil.mine(Number(info.window.close - head.number) + 2);
    const tx = await settle(ctx, m.funding as Address);
    expect(tx.outcome).toBe(Outcome.Yes);
    const v = await verifySettlement(ctxFor(), m.funding as Address);
    expect(v).toMatchObject({
      status: "settled",
      verified: true,
      matches: { evidenceHash: true, outcome: true, rerun: true },
    });
    expect(v.recomputed.evidenceHash).toBe(
      info ? (await getMarket(ctx, m.funding as Address))?.evidenceHash : undefined,
    );
    // The YES holder collects: deployer staked 10 YES and holds 30 YES; 2% of NO's 20 is the fee.
    const before = await anvil.read<bigint>(
      deployment.hunchBook.usdc as Address,
      erc20Abi as Abi,
      "balanceOf",
      [deployer.address],
    );
    const txs = await collect(ctxFor(deployer), m.funding as Address);
    expect(txs).toHaveLength(1);
    const after = await anvil.read<bigint>(
      deployment.hunchBook.usdc as Address,
      erc20Abi as Abi,
      "balanceOf",
      [deployer.address],
    );
    expect(after - before).toBe(30n * USDC - (30n * USDC * 200n * 20n) / (10_000n * 30n));
  }, 60_000);

  it("template 4: proves a spike YES before close", async () => {
    if (!anvil) return;
    const head = await anvil.head();
    const spikeBlock = b0 + 900n;
    if (head.number <= spikeBlock) await anvil.mine(Number(spikeBlock - head.number) + 2);
    const plan = await planSettlement(ctxFor(), m.spikeYes as Address);
    expect(plan).toMatchObject({ status: "ready", method: "proveYes", outcome: Outcome.Yes });
    await proveYes(ctxFor(bob), m.spikeYes as Address);
    const yes = await verifySettlement(ctxFor(), m.spikeYes as Address);
    expect(yes).toMatchObject({
      verified: true,
      stored: { outcome: "yes" },
      recomputed: { outcome: "yes", reads: { eventBlock: spikeBlock, increment: 40n + 10n } },
    });
  }, 120_000);

  it("templates 2, 3, 5 and 6: Chainlink rounds settle price, range and touch markets, then the parlay", async () => {
    if (!anvil) return;
    const now = await anvil.head();
    const base = now.timestamp > t0 + 3_100n ? now.timestamp : t0 + 3_100n;
    // Round 1 brackets the close (t0 + 3,000) with round 2; round 2 also touches 82,000.
    await setRound(1n, e8(80_500n), t0 + 2_500n);
    await anvil.warp(base + 10n);
    await setRound(2n, e8(82_500n), base + 5n);

    await proveYes(ctxFor(bob), m.touchYes as Address);
    expect((await getMarket(ctxFor(), m.touchYes as Address))?.outcomeLabel).toBe("yes");
    expect(await verifySettlement(ctxFor(), m.touchYes as Address)).toMatchObject({ verified: true });

    for (const key of ["price", "range"]) {
      const tx = await settle(ctxFor(bob), m[key] as Address);
      expect(tx.outcome).toBe(Outcome.Yes);
      const v = await verifySettlement(ctxFor(), m[key] as Address);
      expect(v).toMatchObject({
        verified: true,
        recomputed: { reads: { roundId: rid(1n), priceE8: e8(80_500n) } },
      });
    }
    const parlay = await settle(ctxFor(bob), m.parlay as Address);
    expect(parlay.outcome).toBe(Outcome.Yes);
    expect(await verifySettlement(ctxFor(), m.parlay as Address)).toMatchObject({
      verified: true,
      recomputed: { reads: { outcomes: ["yes", "yes"] } },
    });

    // Pool-only winners collect their payout: alice staked 7 YES through the relayer.
    const before = await anvil.read<bigint>(
      deployment.hunchBook.usdc as Address,
      erc20Abi as Abi,
      "balanceOf",
      [alice.address],
    );
    await collect(ctxFor(alice), m.price as Address);
    const after = await anvil.read<bigint>(
      deployment.hunchBook.usdc as Address,
      erc20Abi as Abi,
      "balanceOf",
      [alice.address],
    );
    expect(after).toBeGreaterThan(before + 7n * USDC);
  }, 120_000);

  it("template 3: settles a touch market NO after the challenge period and verifies at the settlement block", async () => {
    if (!anvil) return;
    const end = t0 + 5_000n;
    await setRound(3n, e8(81_000n), end + 100n);
    await anvil.warp(end + 86_400n + 10n);
    const plan = await planSettlement(ctxFor(), m.touchNo as Address);
    expect(plan).toMatchObject({ status: "ready", method: "settle", evidence: "0x", outcome: Outcome.No });
    await settle(ctxFor(bob), m.touchNo as Address);
    // A new round after settlement changes nothing: the NO hash names the round that was latest then.
    await setRound(4n, e8(81_500n), end + 86_400n + 20n);
    const v = await verifySettlement(ctxFor(), m.touchNo as Address);
    expect(v).toMatchObject({
      verified: true,
      matches: { evidenceHash: true, outcome: true },
      recomputed: { reads: { latestRoundId: rid(3n) } },
    });
    expect(v.settlement?.method).toBe("settle");
  }, 60_000);

  it("template 4: settles a spike market NO once the challenge blocks have passed", async () => {
    if (!anvil) return;
    const waiting = await planSettlement(ctxFor(), m.spikeNo as Address);
    expect(waiting.status).toBe("wait");
    const info = await getMarket(ctxFor(), m.spikeNo as Address);
    const now = await anvil.head();
    await anvil.mine(Number((info?.window.close ?? 0n) + CHALLENGE_BLOCKS - now.number) + 2);
    const no = await settle(ctxFor(bob), m.spikeNo as Address);
    expect(no.outcome).toBe(Outcome.No);
    expect(await verifySettlement(ctxFor(), m.spikeNo as Address)).toMatchObject({
      verified: true,
      matches: { evidenceHash: true, outcome: true },
    });
  }, 180_000);

  it("pays a reward epoch built with the SDK's tree, and binds a referral from a signature", async () => {
    if (!anvil) return;
    const dist = deployment.hunchBook.periphery?.merkleDistributor as Address;
    const usdc = deployment.hunchBook.usdc as Address;
    const epoch = await nextRewardEpoch(ctxFor());
    const tree = buildRewardTree(epoch, [
      { account: alice.address, amount: 3n * USDC },
      { account: bob.address, amount: 2n * USDC },
      { account: relayer.address, amount: 1n },
    ]);
    const now = await anvil.head();
    await anvil.send(deployer, usdc, erc20Abi as Abi, "approve", [dist, tree.total]);
    await anvil.send(deployer, dist, merkleDistributorAbi as Abi, "createEpoch", [
      usdc,
      tree.root,
      tree.total,
      now.timestamp + 8n * 86_400n,
    ]);
    const before = await anvil.read<bigint>(usdc, erc20Abi as Abi, "balanceOf", [alice.address]);
    await claimRewards(
      ctxFor(relayer),
      tree.claims.map((c) => ({ epoch, account: c.account, amount: c.amount, proof: c.proof })),
    );
    expect(await anvil.read<bigint>(usdc, erc20Abi as Abi, "balanceOf", [alice.address])).toBe(
      before + 3n * USDC,
    );
    expect(await isRewardClaimed(ctxFor(), epoch, bob.address)).toBe(true);

    const binding = await buildReferralBinding(ctxFor(alice), { user: alice.address, referrer: bob.address });
    const signed = await signReferralBinding(ctxFor(alice), binding);
    await bindReferrerFor(ctxFor(relayer), signed);
    expect(await referralOf(ctxFor(), alice.address)).toMatchObject({ referrer: bob.address, active: true });
    expect(Side.Yes).toBe(0);
  }, 60_000);
});

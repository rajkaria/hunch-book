import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Deployment,
  encodeChainlinkTouchParams,
  encodeParlayParams,
  encodePerplFundingSpikeParams,
  marketAbi,
  Outcome,
  Phase,
  Side,
  TemplateId,
  TouchDirection,
} from "@hunch-book/shared";
import {
  type Abi,
  type Address,
  erc20Abi,
  getAddress,
  type Hex,
  maxUint256,
  type PrivateKeyAccount,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseConfig } from "../../src/config.js";
import type { HealthSnapshot } from "../../src/health.js";
import { Keeper } from "../../src/keeper.js";
import { setLogSink } from "../../src/log.js";
import { abiOf, type Core, deployCore, LocalChain, testnet, USDC, windowParams } from "./chain.js";

// The keeper's new jobs against Hunch Book's real core contracts and the real resolvers and periphery
// contracts on a local anvil chain. Chainlink and Perpl are the resolvers' own test stand-ins, and the
// Kuru book is the periphery tests' stand-in, so every answer comes from the real resolver code:
// - template 3: a touch is proved with proveYes the cycle its round exists; a market with no touch
//   settles NO only after every round of the window is read and the 24-hour challenge period is over;
// - template 4: a funding spike is proved once its event is final; NO after endBlock + challengeBlocks;
// - template 6: a parlay over the two touch markets settles NO once one leg settles NO;
// - conditional orders: a stop-loss executes once the YES bid falls to its trigger;
// - oracle pokes for markets with a live book, at most once per interval;
// - auto-redeem: after settlement, the keeper redeems the winning tokens of a holder who opted in.
//
// Skips (does not fail) when anvil is missing or contracts/out has not been built.

const lines: Record<string, unknown>[] = [];
let chain: LocalChain | null = null;
let deployer: PrivateKeyAccount;
let stakers: PrivateKeyAccount[] = [];
let core: Core;
let deployment: Deployment;
let keeperKey: Hex;
let dir: string;
let keeper: Keeper;
let T: bigint;
let H: bigint;
const c = () => chain as LocalChain;
const a = {} as Record<
  | "feed"
  | "perpl"
  | "touch"
  | "spike"
  | "parlay"
  | "graduator"
  | "router"
  | "redeemer"
  | "orders"
  | "oracle"
  | "book",
  Address
>;
const m = {} as Record<"touchYes" | "touchNo" | "parlay" | "spikeYes" | "spikeNo" | "graduated", Address>;
const PERP = 16n;
const INTERVAL = 20n;
const CHALLENGE_BLOCKS = 86_400n;
let A1: bigint;
let A2: bigint;

const events = (event: string) => lines.filter((l) => l.event === event);
const txs = (action: string) => events("tx").filter((l) => l.action === action);
const health = (): HealthSnapshot => JSON.parse(readFileSync(join(dir, "health.json"), "utf8"));
const phase = (market: Address) => c().readMarket<number>(market, "phase");
const outcome = (market: Address) => c().readMarket<number>(market, "outcome");
const roundId = (n: bigint) => (1n << 64n) | n;

async function cycle(): Promise<void> {
  lines.length = 0;
  await keeper.cycle();
}

async function createMarket(templateId: number, params: Hex, side: number, stake: bigint): Promise<Address> {
  await c().send(deployer, core.factory, abiOf("factory"), "createMarket", [templateId, params, side, stake]);
  const count = await c().read<bigint>(core.factory, abiOf("factory"), "marketCount");
  return getAddress(await c().read<Address>(core.factory, abiOf("factory"), "marketAt", [count - 1n]));
}

const stake = (who: PrivateKeyAccount, market: Address, side: number, amount: bigint) =>
  c().send(who, market, marketAbi as Abi, "stake", [side, amount]);

beforeAll(async () => {
  chain = await LocalChain.start();
  if (!chain) return;
  setLogSink((line) => lines.push(JSON.parse(line)));
  dir = mkdtempSync(join(tmpdir(), "keeper-v2-"));
  deployer = await chain.account();
  stakers = [];
  for (let i = 0; i < 5; i++) stakers.push(await chain.account());
  keeperKey = generatePrivateKey();
  await chain.fundedAccount(keeperKey);
  core = await deployCore(chain, deployer, stakers);
  const send = (to: Address, name: Parameters<typeof abiOf>[0], fn: string, args: unknown[] = []) =>
    c().send(deployer, to, abiOf(name), fn, args);

  // Templates 3, 4 and 6 with their real resolvers.
  a.feed = await chain.deploy(deployer, "mockFeed", [8, "BTC / USD"]);
  a.perpl = await chain.deploy(deployer, "mockPerpl");
  await send(a.perpl, "mockPerpl", "listPerp", [PERP, "BTC Perp", "BTC", 1n, 0n, 1n]);
  await send(a.perpl, "mockPerpl", "setInterval", [INTERVAL]);
  a.touch = await chain.deploy(deployer, "touchResolver", [[a.feed]]);
  a.spike = await chain.deploy(deployer, "spikeResolver", [a.perpl, 1_000n, CHALLENGE_BLOCKS]);
  a.parlay = await chain.deploy(deployer, "parlayResolver", [core.factory, 200n]);
  const rule = { minPool: 50n * USDC, minStakers: 4, minChanceBps: 300, maxChanceBps: 9_700 };
  await send(core.factory, "factory", "addTemplate", [TemplateId.ChainlinkTouch, a.touch, rule]);
  await send(core.factory, "factory", "addTemplate", [TemplateId.PerplFundingSpike, a.spike, rule]);
  await send(core.factory, "factory", "addTemplate", [TemplateId.Parlay, a.parlay, rule]);

  // Graduation into a book that quotes, and the periphery.
  a.graduator = await chain.deploy(deployer, "mockGraduator");
  await send(core.factory, "factory", "setGraduator", [a.graduator]);
  a.router = await chain.deploy(deployer, "router", [core.factory]);
  a.redeemer = await chain.deploy(deployer, "autoRedeemer", [core.factory]);
  a.orders = await chain.deploy(deployer, "conditionalOrders", [core.factory, a.router]);
  a.oracle = await chain.deploy(deployer, "oracle", [core.factory]);
  const peripheryBlock = Number(await chain.client.getBlockNumber());

  T = (await chain.client.getBlock()).timestamp;
  H = await chain.client.getBlockNumber();

  // Touch markets: one that a round will touch, one that no round touches.
  const touch = (strikeE8: bigint) =>
    encodeChainlinkTouchParams({
      feed: a.feed,
      strikeE8,
      direction: TouchDirection.AtOrAbove,
      lockTime: T + 1_000n,
      startTime: T + 1_000n,
      endTime: T + 20_000n,
    });
  m.touchYes = await createMarket(TemplateId.ChainlinkTouch, touch(70_000n * 10n ** 8n), Side.Yes, 5n * USDC);
  await stake(stakers[0] as PrivateKeyAccount, m.touchYes, Side.No, 3n * USDC);
  m.touchNo = await createMarket(TemplateId.ChainlinkTouch, touch(80_000n * 10n ** 8n), Side.Yes, 5n * USDC);
  await stake(stakers[1] as PrivateKeyAccount, m.touchNo, Side.No, 4n * USDC);
  // A parlay on both: it locks before either leg.
  m.parlay = await createMarket(
    TemplateId.Parlay,
    encodeParlayParams({ legs: [m.touchYes, m.touchNo], lockTime: T + 900n, closeTime: T + 1_500n }),
    Side.No,
    5n * USDC,
  );
  await stake(stakers[2] as PrivateKeyAccount, m.parlay, Side.Yes, 2n * USDC);

  // Funding spike markets. Perpl events every 20 blocks, +3 each, except one +10 just after A1.
  A1 = H + 400n;
  A2 = H + 401n;
  const first = A1 - 40n;
  let sum = 1_000n;
  for (let k = 0n; k <= 40n; k++) {
    const block = first + k * INTERVAL;
    sum += block === A1 + 60n ? 10n : 3n;
    await send(a.perpl, "mockPerpl", "pushEvent", [PERP, block, sum]);
  }
  const spike = (start: bigint, threshold: bigint) =>
    encodePerplFundingSpikeParams({
      perpId: PERP,
      startBlock: start,
      endBlock: start + 200n,
      threshold,
      expectedScalingExp: 0,
    });
  m.spikeYes = await createMarket(TemplateId.PerplFundingSpike, spike(A1, 5n), Side.Yes, 5n * USDC);
  await stake(stakers[3] as PrivateKeyAccount, m.spikeYes, Side.No, 3n * USDC);
  m.spikeNo = await createMarket(TemplateId.PerplFundingSpike, spike(A2, 50n), Side.No, 5n * USDC);
  await stake(stakers[3] as PrivateKeyAccount, m.spikeNo, Side.Yes, 2n * USDC);

  // A template-1 market that graduates into a quoting book (MockResolver answers what the test sets).
  m.graduated = await createMarket(
    TemplateId.PerplFunding,
    windowParams(H + 300n, H + 1_500n, T + 30n * 86_400n),
    Side.Yes,
    5n * USDC,
  );
  for (const [i, s] of stakers.slice(0, 4).entries()) {
    await stake(s, m.graduated, i < 2 ? Side.Yes : Side.No, i < 2 ? 20n * USDC : 15n * USDC);
  }
  const [yes] = await chain.readMarket<[Address, Address]>(m.graduated, "tokens");
  a.book = await chain.deploy(deployer, "peripheryBook", [
    {
      pricePrecision: 1_000_000,
      sizePrecision: 1_000_000n,
      baseAsset: yes,
      baseAssetDecimals: 6,
      quoteAsset: core.usdc,
      quoteAssetDecimals: 6,
      tickSize: 1_000,
      minSize: 1_000_000n,
      maxSize: 5_000n * USDC,
      takerFeeBps: 0n,
      makerFeeBps: 0n,
    },
    30n,
  ]);
  await send(a.graduator, "mockGraduator", "registerBook", [m.graduated, a.book]);

  const wallets = { maker: testnet.wallets.maker, keeper: privateKeyToAccount(keeperKey).address };
  const { factory, vault, usdc, deployBlock } = core;
  deployment = {
    ...testnet,
    wallets,
    hunchBook: {
      factory,
      vault,
      usdc,
      graduator: a.graduator,
      router: a.router,
      deployBlock,
      periphery: {
        autoRedeemer: a.redeemer,
        conditionalOrders: a.orders,
        impliedProbabilityOracle: a.oracle,
        deployBlock: peripheryBlock,
      },
    },
  };
  const config = parseConfig({
    KEEPER_ENABLED: "1",
    KEEPER_PRIVATE_KEY: keeperKey,
    KEEPER_RPC_URL: chain.url,
    KEEPER_RPC_RPS: "200",
    KEEPER_STATE_FILE: join(dir, "state.json"),
    KEEPER_HEALTH_FILE: join(dir, "health.json"),
    KEEPER_MAX_GAS_PRICE_GWEI: "10000",
    KEEPER_SETTLE_RETRY_SECONDS: "1",
    KEEPER_SETTLE_RETRY_MAX_SECONDS: "1",
    KEEPER_LOG_RANGE: "10000",
  });
  keeper = new Keeper(config, deployment);
}, 300_000);

afterAll(() => {
  setLogSink((line) => console.log(line));
  chain?.stop();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("the keeper's v2 jobs against the real resolvers and periphery on anvil", () => {
  it("runs every cycle-level job the deployments file enables", (ctx) => {
    if (!chain) return ctx.skip();
    expect(keeper.cycleJobs.map((j) => j.name)).toEqual(["autoRedeem", "orders", "oracle"]);
  });

  it("graduates into the quoting book and pushes the claims", async (ctx) => {
    if (!chain) return ctx.skip();
    await cycle();
    expect(txs("graduate")).toMatchObject([{ market: m.graduated, status: "success" }]);
    await chain.test.mine({ blocks: 20 });
    await cycle();
    expect(txs("claimTokensFor").every((l) => l.status === "success")).toBe(true);
    expect(await chain.readMarket<Address>(m.graduated, "book")).toBe(a.book);
    expect(await phase(m.graduated)).toBe(Phase.Graduated);
  });

  it("pokes the oracle for a market with a live book, then not again within the interval", async (ctx) => {
    if (!chain) return ctx.skip();
    const latest = await chain.read<{ timestamp: number }>(a.oracle, abiOf("oracle"), "latest", [
      m.graduated,
    ]);
    expect(Number(latest.timestamp)).toBeGreaterThan(0);
    await cycle();
    expect(txs("pokeMany")).toHaveLength(0);
    expect(health().jobs.oracle.info).toMatchObject({ liveBooks: 1, due: 0 });
  });

  it("executes a stop-loss once the YES bid falls to its trigger", async (ctx) => {
    if (!chain) return ctx.skip();
    const owner = stakers[0] as PrivateKeyAccount;
    const [yes] = await chain.readMarket<[Address, Address]>(m.graduated, "tokens");
    await chain.send(owner, yes, erc20Abi as Abi, "approve", [a.orders, 2n * USDC]);
    await chain.send(owner, a.orders, abiOf("conditionalOrders"), "place", [
      {
        market: m.graduated,
        kind: 1, // SellYes
        condition: 1, // AtOrBelow
        triggerPriceE6: 400_000,
        expiry: T + 10_000_000n,
        executorTipBps: 10,
        amountIn: 2n * USDC,
        limit: 0n,
      },
    ]);
    await cycle();
    expect(txs("executeOrder")).toHaveLength(0);
    expect(events("order-waiting")[0]).toMatchObject({ reason: "that side of the book is empty" });

    await chain.send(deployer, a.book, abiOf("peripheryBook"), "addBid", [380_000, 10n * USDC]);
    const before = await chain.balance(core.usdc, owner.address);
    await cycle();
    expect(txs("executeOrder")).toMatchObject([{ orderId: "1", status: "success", price: "380000" }]);
    // 2 YES sold at 0.38, less the 0.1% tip paid to the keeper.
    const received = (await chain.balance(core.usdc, owner.address)) - before;
    expect(received).toBe(760_000n - (760_000n * 10n) / 10_000n);
    expect(await chain.balance(core.usdc, keeper.keeper)).toBe((760_000n * 10n) / 10_000n);
  });

  it("proves a touch with proveYes the cycle its round exists, and keeps NO waiting", async (ctx) => {
    if (!chain) return ctx.skip();
    const send = (fn: string, args: unknown[]) => c().send(deployer, a.feed, abiOf("mockFeed"), fn, args);
    await send("setRound", [roundId(1n), 69_000n * 10n ** 8n, T + 1_500n]);
    await send("setRound", [roundId(2n), 70_500n * 10n ** 8n, T + 3_000n]);
    await send("setLatest", [roundId(2n)]);
    await chain.test.setNextBlockTimestamp({ timestamp: T + 3_500n });
    await chain.test.mine({ blocks: 1 });
    await cycle();
    expect(txs("proveYes")).toMatchObject([
      { market: m.touchYes, status: "success", settler: "chainlink-touch", roundId: roundId(2n).toString() },
    ]);
    expect(await outcome(m.touchYes)).toBe(Outcome.Yes);
    expect(await outcome(m.touchNo)).toBe(Outcome.Unresolved);
    const plan = events("plan").find((l) => l.market === m.touchNo && l.job === "settle");
    expect(plan?.reason).toMatch(/^waiting for the challenge period to end/);
  });

  it("proves a funding spike once its event is final", async (ctx) => {
    if (!chain) return ctx.skip();
    const head = await chain.client.getBlockNumber();
    if (head < A1 + 70n) await chain.test.mine({ blocks: Number(A1 + 70n - head) });
    await cycle();
    expect(txs("proveYes")).toMatchObject([
      { market: m.spikeYes, status: "success", eventBlock: (A1 + 60n).toString(), increment: "10" },
    ]);
    expect(await outcome(m.spikeYes)).toBe(Outcome.Yes);
    expect(await outcome(m.spikeNo)).toBe(Outcome.Unresolved);
  });

  it("settles the graduated market and redeems the tokens of a holder who opted in", async (ctx) => {
    if (!chain) return ctx.skip();
    const holder = stakers[1] as PrivateKeyAccount;
    const [yes] = await chain.readMarket<[Address, Address]>(m.graduated, "tokens");
    await chain.send(holder, a.redeemer, abiOf("autoRedeemer"), "setOptIn", [true]);
    await chain.send(holder, yes, erc20Abi as Abi, "approve", [a.redeemer, maxUint256]);
    await chain.send(deployer, core.resolver, abiOf("mockResolver"), "setAnswer", [Outcome.Yes]);
    const head = await chain.client.getBlockNumber();
    await chain.test.mine({ blocks: Number(H + 1_520n - head) });
    await sleep(1_100);
    await cycle();
    expect(txs("settle").find((l) => l.market === m.graduated)).toMatchObject({ status: "success" });
    const held = await chain.balance(yes, holder.address);
    expect(held).toBeGreaterThan(0n);
    // What the holder could redeem alone, at 1 USDC less the redemption fee fixed at graduation.
    const [yesAmount, , expected] = await chain.read<[bigint, bigint, bigint]>(
      a.redeemer,
      abiOf("autoRedeemer"),
      "redeemable",
      [m.graduated, holder.address],
    );
    expect(yesAmount).toBe(held);
    const before = await chain.balance(core.usdc, holder.address);
    await cycle();
    expect(txs("redeemManyFor")).toMatchObject([{ market: m.graduated, holders: 1, status: "success" }]);
    // The estimate alone would starve the holder's redemption inside the batch's try/catch; the limit
    // sent is the one at which the holder is really redeemed.
    const sent = txs("redeemManyFor")[0] as { gasLimit: string; gasNeeded: string };
    expect(BigInt(sent.gasLimit)).toBeGreaterThanOrEqual(BigInt(sent.gasNeeded));
    expect(await chain.balance(yes, holder.address)).toBe(0n);
    expect((await chain.balance(core.usdc, holder.address)) - before).toBe(expected);
    expect(expected).toBeLessThan(held);
    expect(health().jobs.autoRedeem.info).toMatchObject({ optedIn: 1, holdersRedeemed: 1 });
  });

  it("settles the touch NO, the parlay NO and the spike NO after their challenge periods", async (ctx) => {
    if (!chain) return ctx.skip();
    // The feed reports after the window; no round in it reached 80,000.
    await chain.send(deployer, a.feed, abiOf("mockFeed"), "setRound", [
      roundId(3n),
      71_000n * 10n ** 8n,
      T + 20_500n,
    ]);
    await chain.send(deployer, a.feed, abiOf("mockFeed"), "setLatest", [roundId(3n)]);
    const head = await chain.client.getBlockNumber();
    await chain.test.mine({ blocks: Number(A2 + 200n + CHALLENGE_BLOCKS + 5n - head) });
    const now = (await chain.client.getBlock()).timestamp;
    const target = T + 20_000n + 86_400n + 10n;
    if (now < target) await chain.test.setNextBlockTimestamp({ timestamp: target });
    await chain.test.mine({ blocks: 1 });
    await sleep(1_100);
    await cycle();
    const settles = txs("settle").filter((l) => l.status === "success");
    expect(settles.map((l) => l.market).sort()).toEqual([m.touchNo, m.parlay, m.spikeNo].sort());
    // Rounds 1 and 2 are in the window; round 3, after it, shows every round of the window was read.
    expect(settles.find((l) => l.market === m.touchNo)).toMatchObject({ answer: "no", roundsRead: 2 });
    expect(await outcome(m.touchNo)).toBe(Outcome.No);
    expect(await outcome(m.parlay)).toBe(Outcome.No);
    expect(await outcome(m.spikeNo)).toBe(Outcome.No);
    expect(health().jobs.prove.lastAction).toMatchObject({ action: "proveYes", status: "success" });
  });
});

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Deployment,
  graduatorV2Abi,
  impliedProbabilityOracleAbi,
  marketAbi,
  outcomeTokenPriceAdapterFactoryAbi,
  Phase,
  Side,
} from "@hunch-book/shared";
import { type Abi, type Address, getAddress, type PrivateKeyAccount, zeroAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseConfig } from "../../src/config.js";
import type { HealthSnapshot } from "../../src/health.js";
import { Keeper } from "../../src/keeper.js";
import { setLogSink } from "../../src/log.js";
import {
  abiOf,
  type Core,
  createMarket,
  deployCore,
  LocalChain,
  testnet,
  USDC,
  windowParams,
} from "./chain.js";

// A Kuru v2 stack (docs/PROTOCOL.md §8.1, Kuru v2) with the real GraduatorV2, oracle and feeds factory,
// and the contracts' mock of Kuru's v2 exchange, where only Kuru creates books:
//   1. as soon as a market exists, the keeper creates its YES and NO feeds, pokes the oracle (pools
//      too, so the feeds have history before Kuru reads them) and asks Kuru for the book, once;
//   2. Kuru sets the tokens up and deploys the book: the keeper registers it, before the pool fills;
//   3. the pool meets its rule: the keeper graduates the market into that book.
// Skips (does not fail) when anvil or contracts/out is missing.

const WEBHOOK = "https://hooks.example.com/keeper";
const REQUESTED = {
  sizePrecision: 1_000_000n,
  pricePrecision: 1_000_000,
  tickSize: 1_000,
  passiveSpreadTicks: 10,
  minQuoteNotional: 1_000_000n,
  takerFeePps: 7_000n,
  makerFeePps: 4_000n,
};
const LIMITS = { maxTickSize: 10_000, maxMinQuoteNotional: 10_000_000n, maxTakerFeePps: 30_000n };
const FEED_PARAMS = {
  twapWindow: 1_800,
  baseHaircutBps: 0,
  closeHaircutBps: 0,
  rampSeconds: 1,
  spreadMultiplierBps: 0,
  maxSpreadHaircutBps: 0,
  blockTimeMs: 400,
};

const lines: Record<string, unknown>[] = [];
const posts: Record<string, unknown>[] = [];
let chain: LocalChain | null = null;
let deployer: PrivateKeyAccount;
let kuru: PrivateKeyAccount;
let stakers: PrivateKeyAccount[];
let core: Core;
let accountCore: Address;
let spotRouter: Address;
let limiter: Address;
let graduator: Address;
let oracle: Address;
let feeds: Address;
let deployment: Deployment;
let dir: string;
let keeperKey: `0x${string}`;
let market: Address;

const fakeFetch = (async (url: string, init?: RequestInit) => {
  if (url === WEBHOOK) posts.push(JSON.parse(String(init?.body)));
  return new Response("ok", { status: 200 });
}) as typeof fetch;

function makeKeeper(): Keeper {
  const config = parseConfig({
    KEEPER_ENABLED: "1",
    KEEPER_PRIVATE_KEY: keeperKey,
    KEEPER_RPC_URL: chain?.url,
    KEEPER_RPC_RPS: "200",
    KEEPER_STATE_FILE: join(dir, "state.json"),
    KEEPER_HEALTH_FILE: join(dir, "health.json"),
    KEEPER_MAX_GAS_PRICE_GWEI: "10000",
    KEEPER_ALERT_WEBHOOK: WEBHOOK,
  });
  return new Keeper(config, deployment, { fetchFn: fakeFetch, stack: { name: "kuruV2", primary: false } });
}

const events = (event: string) => lines.filter((l) => l.event === event);
const health = (): HealthSnapshot => JSON.parse(readFileSync(join(dir, "health.json"), "utf8"));

beforeAll(async () => {
  chain = await LocalChain.start();
  if (!chain) return;
  setLogSink((line) => lines.push(JSON.parse(line)));
  dir = mkdtempSync(join(tmpdir(), "keeper-kuru-v2-"));
  deployer = await chain.account();
  kuru = await chain.account();
  stakers = [];
  for (let i = 0; i < 4; i++) stakers.push(await chain.account());
  keeperKey = generatePrivateKey();
  await chain.fundedAccount(keeperKey);
  core = await deployCore(chain, deployer, stakers);

  accountCore = await chain.deploy(kuru, "mockKuruAccountCoreV2");
  spotRouter = await chain.deploy(kuru, "mockKuruSpotRouterV2", [accountCore]);
  limiter = await chain.deploy(kuru, "mockKuruLimiterV2");
  await chain.send(kuru, accountCore, abiOf("mockKuruAccountCoreV2"), "setSpotRouter", [spotRouter]);
  await chain.send(kuru, accountCore, abiOf("mockKuruAccountCoreV2"), "setWithdrawalLimiter", [limiter]);

  graduator = await chain.deploy(deployer, "graduatorV2", [
    core.factory,
    spotRouter,
    accountCore,
    core.usdc,
    REQUESTED,
    LIMITS,
  ]);
  await chain.send(deployer, core.factory, abiOf("factory"), "setGraduator", [graduator]);
  oracle = await chain.deploy(deployer, "oracle", [core.factory, 2]);
  feeds = await chain.deploy(deployer, "adapterFactory", [oracle, FEED_PARAMS]);

  const head = await chain.client.getBlockNumber();
  const now = (await chain.client.getBlock()).timestamp;
  market = await createMarket(
    chain,
    core,
    deployer,
    windowParams(head + 400n, head + 450n, now + 86_400n),
    Side.Yes,
    5n * USDC,
  );

  const wallets = { maker: testnet.wallets.maker, keeper: privateKeyToAccount(keeperKey).address };
  const { factory, vault, usdc, deployBlock } = core;
  deployment = {
    ...testnet,
    wallets,
    hunchBook: {
      factory,
      vault,
      usdc,
      graduator,
      deployBlock,
      kuruVersion: 2,
      periphery: { impliedProbabilityOracle: oracle, kuruFeedFactory: feeds },
    },
    external: { ...testnet.external, kuruV2: { accountCore, spotRouter, withdrawalLimiter: limiter } },
  };
}, 120_000);

afterAll(() => {
  setLogSink((line) => console.log(line));
  chain?.stop();
});

describe("a Kuru v2 stack, where only Kuru creates books", () => {
  let keeper: Keeper;
  let request: Record<string, unknown>;

  it("creates the feeds, pokes the pool and asks Kuru for the book from creation, once", async (ctx) => {
    if (!chain) return ctx.skip();
    keeper = makeKeeper();
    expect(keeper.kuruVersion).toBe(2);
    expect(keeper.cycleJobs.map((j) => j.name)).toEqual(["kuruFeeds", "oracle"]);
    await keeper.cycle();

    for (const side of [Side.Yes, Side.No]) {
      const feed = await chain.read<Address>(feeds, outcomeTokenPriceAdapterFactoryAbi as Abi, "adapterOf", [
        market,
        side,
      ]);
      expect(feed).not.toBe(zeroAddress);
    }
    const latest = await chain.read<{ timestamp: number }>(
      oracle,
      impliedProbabilityOracleAbi as Abi,
      "latest",
      [market],
    );
    expect(Number(latest.timestamp)).toBeGreaterThan(0);

    expect(events("plan").find((l) => l.market === market && l.job === "graduate")).toMatchObject({
      action: "book-request",
    });
    const [yes] = await chain.readMarket<[Address, Address]>(market, "tokens");
    const predicted = await chain.read<Address>(graduator, graduatorV2Abi as Abi, "predictedBook", [market]);
    request = events("book-request")[0] as Record<string, unknown>;
    expect(request).toMatchObject({
      market,
      kuru: 2,
      call: "deploySpotMarket",
      spotRouter,
      accountCore,
      expectedBook: predicted,
      bookState: "not deployed",
      args: {
        baseToken: yes,
        quoteToken: core.usdc,
        sizePrecision: "1000000",
        pricePrecision: 1_000_000,
        tickSize: 1_000,
        passiveSpreadTicks: 10,
        minQuoteNotional: "1000000",
        maxQuoteNotional: "5000000000",
        takerFeePps: "7000",
        makerFeePps: "4000",
      },
    });
    // The request goes out before the feeds job runs: it names the feed's predicted address.
    const yesFeed = await chain.read<Address>(feeds, outcomeTokenPriceAdapterFactoryAbi as Abi, "adapterOf", [
      market,
      Side.Yes,
    ]);
    expect((request.tokenSetup as Record<string, unknown>).priceFeed).toBe(yesFeed);
    expect(posts).toHaveLength(1);
    expect(health()).toMatchObject({ stack: "kuruV2", kuruVersion: 2 });

    lines.length = 0;
    await keeper.cycle();
    expect(events("book-request")).toHaveLength(0);
    expect(events("tx").filter((l) => l.action === "createAdapter")).toHaveLength(0);
  });

  it("registers the book as soon as Kuru creates it, before the pool fills", async (ctx) => {
    if (!chain) return ctx.skip();
    const a = request.args as Record<string, string | number>;
    const [yes] = await chain.readMarket<[Address, Address]>(market, "tokens");
    // Kuru's setup: enable both tokens, give them price sources, then deploy the requested book.
    for (const token of [yes, core.usdc]) {
      await chain.send(kuru, accountCore, abiOf("mockKuruAccountCoreV2"), "configureSpotToken", [
        token,
        true,
      ]);
      await chain.send(kuru, limiter, abiOf("mockKuruLimiterV2"), "setPriceSource", [token, kuru.address]);
    }
    await chain.send(kuru, spotRouter, abiOf("mockKuruSpotRouterV2"), "deploySpotMarket", [
      a.baseToken,
      a.quoteToken,
      BigInt(a.sizePrecision as string),
      a.pricePrecision,
      a.tickSize,
      a.passiveSpreadTicks,
      BigInt(a.minQuoteNotional as string),
      BigInt(a.maxQuoteNotional as string),
      BigInt(a.takerFeePps as string),
      BigInt(a.makerFeePps as string),
    ]);
    lines.length = 0;
    await keeper.cycle();
    const book = getAddress(await chain.read<Address>(graduator, graduatorV2Abi as Abi, "bookOf", [market]));
    expect(book).toBe(getAddress(request.expectedBook as Address));
    expect(events("tx").find((l) => l.action === "registerBook")).toMatchObject({ status: "success" });
    expect(await chain.readMarket<number>(market, "phase")).toBe(Phase.Pool);
  });

  it("graduates into the registered book once the pool meets its rule", async (ctx) => {
    if (!chain) return ctx.skip();
    for (const [i, s] of stakers.entries()) {
      await chain.send(s, market, marketAbi as Abi, "stake", [i < 2 ? Side.Yes : Side.No, 20n * USDC]);
    }
    lines.length = 0;
    await keeper.cycle();
    expect(await chain.readMarket<number>(market, "phase")).toBe(Phase.Graduated);
    const book = await chain.read<Address>(graduator, graduatorV2Abi as Abi, "bookOf", [market]);
    expect(getAddress(await chain.readMarket<Address>(market, "book"))).toBe(getAddress(book));
  });
});

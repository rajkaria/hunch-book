import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collateralVaultAbi,
  type Deployment,
  deployments,
  encodePerplFundingParams,
  kuruMarginAccountAbi,
  kuruOrderBookAbi,
  marketAbi,
  monadTestnet,
  Phase,
  Side,
  TemplateId,
} from "@hunch-book/shared";
import {
  type Abi,
  type Address,
  createPublicClient,
  createTestClient,
  createWalletClient,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  http,
  type PrivateKeyAccount,
  type PublicClient,
  parseEther,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Maker } from "../../src/bot.js";
import { parseConfig } from "../../src/config.js";
import type { HealthSnapshot } from "../../src/health.js";
import { readBalances, vaultSetOps } from "../../src/inventory.js";
import { type BookInfo, findOwnOrders, readBookInfo, readL2Book, readMarketState } from "../../src/kuru.js";
import { setLogSink } from "../../src/log.js";
import { createRuntime, type MarketRuntime, quoteMarket, unwindMarket } from "../../src/maker.js";
import { buildMakers } from "../../src/stacks.js";
import { revertReason } from "../../src/tx.js";
import { type Anvil, type Artifact, artifact, startAnvil } from "./anvil.js";
import { MULTICALL3_ADDRESS, MULTICALL3_RUNTIME } from "./multicall3.js";

// The v1 maker on Hunch Book's own order book (docs/PROTOCOL.md §8.1, "Hunch order book"), on a fresh
// local chain with the real contracts from contracts/out: the core (test USDC, factory, vault, market),
// HunchOrderBookFactory with its HunchMarginAccount, and the v1 Graduator wired to it, as
// DeployHunchStack.s.sol does. The deployment is testnet's layout: the stack is `stacks.hunch`, the
// default stack, with `external.kuru` still naming Kuru's real contracts (no code on this chain). So the
// bot must take its margin account from the stack's view, quote post-only, handle a crossing quote and
// the book's cancels-only state after close, and never need fees or an AMM vault.
// Skips (does not fail) when anvil is missing or contracts/out has not been built.

const testnet = deployments["monad-testnet"];
const USDC = 1_000_000n;
const ARTIFACTS = {
  usdc: artifact("TestUSDC.sol", "TestUSDC"),
  market: artifact("Market.sol", "Market"),
  factory: artifact("HunchBookFactory.sol", "HunchBookFactory"),
  mockResolver: artifact("MockResolver.sol", "MockResolver"),
  graduator: artifact("Graduator.sol", "Graduator"),
  bookFactory: artifact("HunchOrderBookFactory.sol", "HunchOrderBookFactory"),
};
const built = Object.values(ARTIFACTS).every((a) => a !== null);
const abiOf = (name: keyof typeof ARTIFACTS): Abi => (ARTIFACTS[name] as Artifact).abi;

const lines: Record<string, unknown>[] = [];
let anvil: Anvil | null = null;
let client: PublicClient;
let deployer: PrivateKeyAccount;
let taker: PrivateKeyAccount;
let dir: string;
let usdc: Address;
let vault: Address;
let marginAccount: Address;
let market: Address;
let book: Address;
let tokens: { yes: Address; no: Address; usdc: Address };
let deployment: Deployment;
let bot: Maker;
let info: BookInfo;
let rt: MarketRuntime;

const events = (event: string) => lines.filter((l) => l.event === event);

const wallet = (from: PrivateKeyAccount) =>
  createWalletClient({ account: from, chain: monadTestnet, transport: http(anvil?.url) });

async function deploy(from: PrivateKeyAccount, name: keyof typeof ARTIFACTS, args: unknown[] = []) {
  const a = ARTIFACTS[name] as Artifact;
  const hash = await wallet(from).deployContract({ abi: a.abi, bytecode: a.bytecode, args });
  const receipt = await client.waitForTransactionReceipt({ hash });
  return getAddress(receipt.contractAddress as Address);
}

async function send(
  from: PrivateKeyAccount,
  address: Address,
  abi: Abi | readonly unknown[],
  functionName: string,
  args: unknown[] = [],
): Promise<void> {
  const hash = await wallet(from).writeContract({ address, abi: abi as Abi, functionName, args });
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${functionName} reverted`);
}

const read = <T>(
  address: Address,
  abi: Abi | readonly unknown[],
  functionName: string,
  args: unknown[] = [],
) => client.readContract({ address, abi: abi as Abi, functionName, args }) as Promise<T>;

async function funded(): Promise<PrivateKeyAccount> {
  const account = privateKeyToAccount(generatePrivateKey());
  await createTestClient({ mode: "anvil", chain: monadTestnet, transport: http(anvil?.url) }).setBalance({
    address: account.address,
    value: parseEther("100"),
  });
  return account;
}

beforeAll(async () => {
  if (!built) {
    console.warn("contracts/out is missing: run `forge build` in contracts/ to run the Hunch venue test");
    return;
  }
  anvil = await startAnvil(testnet.chainId, (monadTestnet.contracts?.multicall3?.blockCreated ?? 0) + 1);
  if (!anvil) return;
  setLogSink((line) => lines.push(JSON.parse(line)));
  dir = mkdtempSync(join(tmpdir(), "maker-hunch-"));
  client = createPublicClient({ chain: monadTestnet, transport: http(anvil.url) }) as PublicClient;
  await createTestClient({ mode: "anvil", chain: monadTestnet, transport: http(anvil.url) }).setCode({
    address: MULTICALL3_ADDRESS,
    bytecode: MULTICALL3_RUNTIME,
  });
  deployer = await funded();
  taker = await funded();
  const stakers: PrivateKeyAccount[] = [];
  for (let i = 0; i < 4; i++) stakers.push(await funded());
  const makerKey = generatePrivateKey();
  const maker = privateKeyToAccount(makerKey);
  await createTestClient({ mode: "anvil", chain: monadTestnet, transport: http(anvil.url) }).setBalance({
    address: maker.address,
    value: parseEther("100"),
  });

  // The core, as contracts/test does it: a template-1 MockResolver with a small graduation rule.
  const deployBlock = Number(await client.getBlockNumber());
  usdc = await deploy(deployer, "usdc");
  const implementation = await deploy(deployer, "market");
  const caps = {
    poolCap: 5_000n * USDC,
    walletCap: 1_000n * USDC,
    minStake: USDC,
    creatorMinStake: 5n * USDC,
  };
  const factory = await deploy(deployer, "factory", [
    usdc,
    implementation,
    deployer.address,
    deployer.address,
    caps,
    50_000n * USDC,
  ]);
  vault = getAddress(await read<Address>(factory, abiOf("factory"), "vault"));
  const resolver = await deploy(deployer, "mockResolver");
  await send(deployer, factory, abiOf("factory"), "addTemplate", [
    TemplateId.PerplFunding,
    resolver,
    { minPool: 50n * USDC, minStakers: 4, minChanceBps: 300, maxChanceBps: 9_700 },
  ]);

  // Hunch Book's own order book, and the graduator that creates a book in graduate().
  const bookFactory = await deploy(deployer, "bookFactory", [factory]);
  marginAccount = getAddress(await read<Address>(bookFactory, abiOf("bookFactory"), "marginAccount"));
  const bookImplementation = getAddress(
    await read<Address>(bookFactory, abiOf("bookFactory"), "implementation"),
  );
  const graduator = await deploy(deployer, "graduator", [
    factory,
    bookFactory,
    marginAccount,
    usdc,
    true,
    {
      sizePrecision: USDC,
      pricePrecision: 1_000_000,
      tickSize: 1_000,
      minSize: USDC,
      takerFeeBps: 0n,
      makerFeeBps: 0n,
      kuruAmmSpread: 30n,
    },
  ]);
  await send(deployer, factory, abiOf("factory"), "setGraduator", [graduator]);

  for (const a of [deployer, taker, maker, ...stakers]) {
    await send(a, usdc, abiOf("usdc"), "mint", [a.address, 1_000n * USDC]);
    await send(a, usdc, erc20Abi, "approve", [vault, 2n ** 255n]);
  }
  const head = await client.getBlockNumber();
  const now = (await client.getBlock()).timestamp;
  // MockResolver reads template 1 params as a block-clock window: lock, close, settlement deadline.
  const params = encodePerplFundingParams({
    perpId: 1n,
    startBlock: head + 300n,
    endBlock: head + 350n,
    threshold: now + 86_400n,
    expectedScalingExp: 0,
  });
  await send(deployer, factory, abiOf("factory"), "createMarket", [
    TemplateId.PerplFunding,
    params,
    Side.Yes,
    5n * USDC,
  ]);
  market = getAddress(await read<Address>(factory, abiOf("factory"), "marketAt", [0n]));
  for (const [i, s] of stakers.entries()) {
    await send(s, market, marketAbi, "stake", [i < 2 ? Side.Yes : Side.No, 20n * USDC]);
  }
  await send(deployer, market, marketAbi, "graduate");
  book = getAddress(await read<Address>(market, marketAbi, "book"));
  const [yes, no] = await read<[Address, Address]>(market, marketAbi, "tokens");
  tokens = { yes: getAddress(yes), no: getAddress(no), usdc };

  deployment = {
    ...testnet,
    wallets: { maker: maker.address, keeper: testnet.wallets.keeper },
    hunchBook: {},
    stacks: {
      hunch: {
        factory,
        vault,
        usdc,
        graduator,
        deployBlock,
        kuruVersion: 1,
        venue: { kind: "hunch", bookFactory, marginAccount, bookImplementation },
      },
    },
    defaultStack: "hunch",
  };
  const config = parseConfig({
    MAKER_ENABLED: "1",
    MAKER_PRIVATE_KEY: makerKey,
    MAKER_RPC_URL: anvil.url,
    MAKER_RPC_RPS: "200",
    MAKER_MAX_GAS_PRICE_GWEI: "10000",
    MAKER_HEALTH_FILE: join(dir, "health.json"),
    MAKER_LEVELS: "2",
    MAKER_ORDER_SIZE: "10",
    MAKER_INVENTORY_CAP: "50",
  });
  const makers = buildMakers(config, deployment);
  if (makers.length !== 1) throw new Error(`expected one bot, got ${makers.length}`);
  bot = makers[0] as Maker;
  info = await readBookInfo(client, book);
  rt = createRuntime({
    market,
    book,
    info,
    no: tokens.no,
    sets: vaultSetOps(bot.tx, vault, market, usdc, 100n * USDC),
  });
}, 120_000);

afterAll(() => {
  setLogSink((line) => console.log(line));
  anvil?.stop();
});

describe("the v1 maker on Hunch Book's own order book", () => {
  it("buildMakers gives the hunch stack a v1 bot on Hunch Book's margin account", (ctx) => {
    if (!anvil) return ctx.skip();
    expect(bot.stackName).toBe("hunch");
    expect(bot.kuruVersion).toBe(1);
    expect(bot.venue).toBe("hunch");
    expect(bot.depsV2).toBeUndefined();
    expect(bot.deps.marginAccount).toBe(marginAccount);
    expect(bot.deps.marginAccount).not.toBe(testnet.external.kuru.marginAccount);
    expect(bot.health.current()).toMatchObject({ stack: "hunch", kuruVersion: 1, venue: "hunch" });
  });

  it("reads the book as a Kuru v1 book with no fees", async (ctx) => {
    if (!anvil) return ctx.skip();
    expect(info).toMatchObject({
      base: tokens.yes,
      quote: usdc,
      pricePrecision: 1_000_000,
      sizePrecision: USDC,
      tickSize: 1_000,
      minSize: USDC,
      baseDecimals: 6,
      quoteDecimals: 6,
      takerFeeBps: 0n,
      makerFeeBps: 0n,
    });
    expect(await readMarketState(client, book)).toBe(0);
  });

  it("quotes both sides post-only, funded through Hunch Book's margin account", async (ctx) => {
    if (!anvil) return ctx.skip();
    await quoteMarket(bot.deps, rt, { fair: 0.42, widen: 1, now: 1_000 });
    const l2 = await readL2Book(client, book);
    expect(l2.bids).toEqual([
      { price: 405_000n, size: 10_000_000n },
      { price: 395_000n, size: 10_000_000n },
    ]);
    expect(l2.asks).toEqual([
      { price: 435_000n, size: 10_000_000n },
      { price: 445_000n, size: 10_000_000n },
    ]);
    const found = await findOwnOrders(client, book, bot.maker, l2);
    expect(found.map((o) => o.id).sort()).toEqual(rt.tracker.cancelIds());
    const balances = await readBalances(client, bot.maker, tokens, marginAccount);
    expect(balances.walletNo).toBe(20n * USDC); // 20 sets minted on the vault: their YES rests on the asks
    expect(balances.marginUsdc).toBe(1n * USDC); // the float
    expect(
      events("tx")
        .filter((l) => l.action === "marginDeposit")
        .map((l) => l.to),
    ).toEqual([marginAccount, marginAccount]);
  });

  it("requotes in one batch, then sees a taker's fills and withdraws the proceeds", async (ctx) => {
    if (!anvil) return ctx.skip();
    await quoteMarket(bot.deps, rt, { fair: 0.5, widen: 1, now: 1_010 });
    expect((await readL2Book(client, book)).asks.map((l) => l.price)).toEqual([515_000n, 525_000n]);

    // A taker buys 6 USDC of YES from the wallet (approve the book; no fee).
    await send(taker, usdc, erc20Abi, "approve", [book, 6n * USDC]);
    await send(taker, book, kuruOrderBookAbi, "placeAndExecuteMarketBuy", [6n * USDC, 0n, false, false]);

    const before = lines.length;
    await quoteMarket(bot.deps, rt, { fair: 0.5, widen: 1, now: 1_020 });
    const fresh = lines.slice(before);
    expect(fresh.filter((l) => l.event === "fill").map((f) => [f.price, f.complete])).toEqual([
      [515_000, true],
      [525_000, false],
    ]);
    expect(fresh.find((l) => l.event === "quote")?.reason).toBe("fill");
    expect(fresh.some((l) => l.event === "tx" && l.action === "marginWithdraw")).toBe(true);
    expect(rt.health.position).toBeLessThan(-11);
    expect(rt.health.position).toBeGreaterThan(-12);
  });

  it("a quote that would cross the book (a race): nothing sent, re-sync, then requote around it", async (ctx) => {
    if (!anvil) return ctx.skip();
    const stale = await client.readContract({
      address: book,
      abi: kuruOrderBookAbi,
      functionName: "getL2Book",
    });
    // Someone rests an ask at 0.49 after the bot read the book.
    await send(taker, vault, collateralVaultAbi, "mintSets", [market, 5n * USDC, taker.address]);
    await send(taker, tokens.yes, erc20Abi, "approve", [marginAccount, 5n * USDC]);
    await send(taker, marginAccount, kuruMarginAccountAbi, "deposit", [taker.address, tokens.yes, 5n * USDC]);
    await send(taker, book, kuruOrderBookAbi, "addSellOrder", [490_000, 2n * USDC, false]);
    const resting = rt.tracker.cancelIds();

    // The bot quotes from the book as it read it: its bid at 0.505 would cross the new ask.
    const staleClient = new Proxy(client, {
      get(target, prop, receiver) {
        if (prop !== "readContract") return Reflect.get(target, prop, receiver);
        return (args: { functionName: string }) =>
          args.functionName === "getL2Book" ? Promise.resolve(stale) : target.readContract(args as never);
      },
    }) as PublicClient;
    const before = lines.length;
    await quoteMarket({ ...bot.deps, tx: { ...bot.deps.tx, publicClient: staleClient } }, rt, {
      fair: 0.52,
      widen: 1,
      now: 1_030,
    });
    const fresh = lines.slice(before);
    expect(fresh.find((l) => l.event === "tx-skipped" && l.action === "batchUpdate")?.reason).toBe(
      "simulation failed: PostOnlyError",
    );
    expect(fresh.find((l) => l.event === "quote-crossed")).toMatchObject({ level: "warn", book });
    expect(rt.synced).toBe(false);
    // The batch's cancels did not go out either: the old quotes still rest, and are still tracked.
    expect(rt.tracker.cancelIds()).toEqual(resting);

    // Next cycle, from a fresh read: the bid stays below the outside ask.
    await quoteMarket(bot.deps, rt, { fair: 0.52, widen: 1, now: 1_040 });
    const l2 = await readL2Book(client, book);
    expect(l2.bids[0]?.price).toBeLessThan(490_000n);
    expect(l2.asks[0]?.price).toBe(490_000n);
    expect(rt.synced).toBe(true);
    const mine = await findOwnOrders(client, book, bot.maker, l2);
    expect(mine.map((o) => o.id).sort()).toEqual(rt.tracker.cancelIds());
  });

  it("after close the book takes cancels only: the bot cancels, then unwinds", async (ctx) => {
    if (!anvil) return ctx.skip();
    await createTestClient({ mode: "anvil", chain: monadTestnet, transport: http(anvil.url) }).mine({
      blocks: 400,
    });
    expect(await read<number>(market, marketAbi, "phase")).toBe(Phase.Closed);
    expect(await readMarketState(client, book)).toBe(1);

    const before = lines.length;
    await quoteMarket(bot.deps, rt, { fair: 0.5, widen: 1, now: 2_000 });
    const fresh = lines.slice(before);
    expect(rt.health.status).toBe("book-cancels-only");
    expect(fresh.find((l) => l.event === "cancel")).toMatchObject({ reason: "the book takes cancels only" });
    expect(fresh.some((l) => l.event === "quote")).toBe(false);
    let l2 = await readL2Book(client, book);
    expect(await findOwnOrders(client, book, bot.maker, l2)).toEqual([]);

    // Placing is refused while the market is not trading.
    const data = encodeFunctionData({
      abi: kuruOrderBookAbi,
      functionName: "addBuyOrder",
      args: [400_000, USDC, true],
    });
    const error = await client.estimateGas({ account: bot.maker, to: book, data }).catch((e) => e);
    expect(revertReason(error, kuruOrderBookAbi)).toBe("MarketStateError");

    await unwindMarket(bot.deps, rt, { reason: "close", merge: true });
    const b = await readBalances(client, bot.maker, tokens, marginAccount);
    expect([b.marginYes, b.marginUsdc]).toEqual([0n, 0n]);
    expect(b.walletYes === 0n || b.walletNo === 0n).toBe(true);
    l2 = await readL2Book(client, book);
    expect(await findOwnOrders(client, book, bot.maker, l2)).toEqual([]);
  });

  it("cancel-all --book handles only books its own margin account lists", async (ctx) => {
    if (!anvil) return ctx.skip();
    const elsewhere = getAddress(`0x${"42".repeat(20)}`);
    lines.length = 0;
    await bot.cancelEverything("cancel-all", [book, elsewhere]);
    expect(events("cancel-skip")).toMatchObject([{ books: [elsewhere], marginAccount }]);
    expect(events("cancel-error")).toEqual([]);
    const health = JSON.parse(readFileSync(join(dir, "health.hunch.json"), "utf8")) as HealthSnapshot;
    expect(health).toMatchObject({ stack: "hunch", kuruVersion: 1, venue: "hunch" });
  });
});

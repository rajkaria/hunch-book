import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Deployment,
  deployments,
  encodePerplFundingParams,
  monadTestnet,
  Outcome,
  Phase,
  TemplateId,
} from "@hunch-book/shared";
import {
  type Abi,
  type Address,
  createPublicClient,
  createTestClient,
  createWalletClient,
  getAddress,
  type Hex,
  http,
  type PublicClient,
  parseEther,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createKuruBook, deployMockToken, mintMock, type Signer } from "../../scripts/lib/throwaway-book.js";
import { perplExchangeAbi } from "../../src/abis.js";
import { Maker } from "../../src/bot.js";
import { parseConfig } from "../../src/config.js";
import type { HealthSnapshot } from "../../src/health.js";
import { readBalances } from "../../src/inventory.js";
import { findOwnOrders, readL2Book } from "../../src/kuru.js";
import { setLogSink } from "../../src/log.js";
import { type Anvil, startAnvilFork } from "./anvil.js";
import {
  mockFactoryAbi,
  mockFactoryBytecode,
  mockMarketAbi,
  mockMarketBytecode,
  mockVaultAbi,
  mockVaultBytecode,
} from "./mock-hunch.js";

// The whole bot loop on a fork of Monad testnet: market discovery from a factory, Perpl funding fair
// value from Perpl's real testnet history, minting sets through a vault, quoting on a real Kuru book,
// unwinding at close, and the shutdown cancel. Hunch Book's contracts are not deployed yet, so the
// factory, vault and market are test-only stand-ins with the frozen interfaces' ABI (MockHunch.sol).
// Skips (does not fail) when anvil is not installed or the fork cannot start.

const testnet = deployments["monad-testnet"];
const FORK_RPC = process.env.MAKER_FORK_RPC ?? process.env.MONAD_TESTNET_RPC ?? testnet.rpc;
const USDC = 1_000_000n;
const PERP_BTC = BigInt(testnet.external.perpl.perps.BTC as number);

const lines: Record<string, unknown>[] = [];
let anvil: Anvil | null = null;
let client: PublicClient;
let deployer: Signer;
let bot: Maker;
let market: Address;
let vault: Address;
let book: Address;
let tokens: { yes: Address; no: Address; usdc: Address };
let healthFile: string;

async function deploy(abi: Abi, bytecode: Hex, args: unknown[]): Promise<Address> {
  const hash = await deployer.walletClient.deployContract({
    abi,
    bytecode,
    args,
    account: deployer.account,
    chain: monadTestnet,
  });
  const receipt = await client.waitForTransactionReceipt({ hash });
  return getAddress(receipt.contractAddress as Address);
}

async function call(address: Address, abi: Abi, functionName: string, args: unknown[]): Promise<void> {
  const hash = await deployer.walletClient.writeContract({
    address,
    abi,
    functionName,
    args,
    account: deployer.account,
    chain: monadTestnet,
  });
  await client.waitForTransactionReceipt({ hash });
}

const health = (): HealthSnapshot => JSON.parse(readFileSync(healthFile, "utf8"));

beforeAll(async () => {
  anvil = await startAnvilFork(FORK_RPC);
  if (!anvil) return;
  setLogSink((line) => lines.push(JSON.parse(line)));
  const transport = http(anvil.url);
  client = createPublicClient({ chain: monadTestnet, transport }) as PublicClient;
  const test = createTestClient({ mode: "anvil", chain: monadTestnet, transport });
  const deployerAccount = privateKeyToAccount(generatePrivateKey());
  await test.setBalance({ address: deployerAccount.address, value: parseEther("100") });
  deployer = {
    publicClient: client,
    walletClient: createWalletClient({ account: deployerAccount, chain: monadTestnet, transport }),
    account: deployerAccount,
    chain: monadTestnet,
  };

  tokens = {
    yes: await deployMockToken(deployer, "Mock YES", "mYES"),
    no: await deployMockToken(deployer, "Mock NO", "mNO"),
    usdc: await deployMockToken(deployer, "Mock USDC", "mUSDC"),
  };
  vault = await deploy(mockVaultAbi, mockVaultBytecode, [tokens.usdc]);
  const factory = await deploy(mockFactoryAbi, mockFactoryBytecode, []);

  // A real Perpl question on testnet: will BTC longs pay shorts on net over the next ~50 intervals?
  const exchange = testnet.external.perpl.exchange;
  const info = await client.readContract({
    address: exchange,
    abi: perplExchangeAbi,
    functionName: "getPerpetualInfoV2",
    args: [PERP_BTC],
  });
  const now = await client.getBlockNumber();
  const startBlock = now + 1_000n;
  const endBlock = startBlock + 50n * 8_571n;
  const params = encodePerplFundingParams({
    perpId: PERP_BTC,
    startBlock,
    endBlock,
    threshold: 0n,
    expectedScalingExp: Number(info.fundingSumScalingExp),
  });
  const window = { blockClock: true, lock: startBlock, close: endBlock, settleDeadline: 2n ** 40n };
  market = await deploy(mockMarketAbi, mockMarketBytecode, [
    tokens.yes,
    tokens.no,
    vault,
    TemplateId.PerplFunding,
    params,
    window,
  ]);
  ({ book } = await createKuruBook(
    deployer,
    testnet.external.kuru.router,
    tokens.yes,
    tokens.usdc,
    5_000n * USDC,
  ));
  await call(market, mockMarketAbi, "setBook", [book]);
  await call(market, mockMarketAbi, "setPhase", [Phase.Graduated]);
  await call(factory, mockFactoryAbi, "add", [market]);

  const key = generatePrivateKey();
  const makerAddress = privateKeyToAccount(key).address;
  await test.setBalance({ address: makerAddress, value: parseEther("100") });
  await mintMock(deployer, tokens.usdc, makerAddress, 1_000n * USDC);

  healthFile = join(mkdtempSync(join(tmpdir(), "maker-health-")), "health.json");
  const config = parseConfig({
    MAKER_ENABLED: "1",
    MAKER_PRIVATE_KEY: key,
    MAKER_RPC_URL: anvil.url,
    MAKER_HEALTH_FILE: healthFile,
    MAKER_ORDER_SIZE: "10",
    MAKER_INVENTORY_CAP: "50",
    MAKER_MAX_GAS_PRICE_GWEI: "10000",
  });
  const deployment: Deployment = { ...testnet, hunchBook: { factory, vault, usdc: tokens.usdc } };
  bot = new Maker(config, deployment);
}, 360_000);

afterAll(() => {
  setLogSink((line) => console.log(line));
  const quote = lines.find((l) => l.event === "quote");
  if (quote) console.info(JSON.stringify(quote));
  anvil?.stop();
});

describe("the maker loop on a fork of Monad testnet", () => {
  it("finds the graduated market, prices it from Perpl's history, mints sets, and quotes", async (ctx) => {
    if (!anvil) return ctx.skip();
    await bot.cycle();

    const quote = lines.find((l) => l.event === "quote");
    expect(quote).toMatchObject({ market, book, reason: "no-orders", template: TemplateId.PerplFunding });
    const fair = quote?.fair as number;
    expect(fair).toBeGreaterThan(0);
    expect(fair).toBeLessThan(1);
    expect(quote?.samples).toBeGreaterThanOrEqual(300);
    expect(lines.some((l) => l.event === "tx" && l.action === "mintSets" && l.status === "success")).toBe(
      true,
    );

    const l2 = await readL2Book(client, book);
    expect(l2.bids).toHaveLength(1);
    expect(l2.asks).toHaveLength(1);
    const bid = Number(l2.bids[0]?.price) / 1e6;
    const ask = Number(l2.asks[0]?.price) / 1e6;
    expect(ask - bid).toBeGreaterThanOrEqual(0.02 - 1e-9);
    expect(bid).toBeLessThanOrEqual(Math.max(fair, 0.01));
    expect(ask).toBeGreaterThanOrEqual(Math.min(fair, 0.99));

    const h = health();
    expect(h.enabled).toBe(true);
    expect(h.openOrders).toBe(2);
    expect(h.lastQuoteAt).toBeTruthy();
    expect(Number(h.monBalance)).toBeGreaterThan(0);
    expect(h.markets[0]).toMatchObject({ market, book, status: "quoting" });
  });

  it("leaves nothing resting once the market closes, and merges its sets back to USDC", async (ctx) => {
    if (!anvil) return ctx.skip();
    await call(market, mockMarketAbi, "setPhase", [Phase.Closed]);
    await bot.cycle();
    const l2 = await readL2Book(client, book);
    expect(await findOwnOrders(client, book, bot.maker, l2)).toEqual([]);
    const b = await readBalances(client, bot.maker, tokens, testnet.external.kuru.marginAccount);
    expect([b.marginYes, b.marginUsdc]).toEqual([0n, 0n]);
    expect(b.walletYes).toBe(0n);
    expect(b.walletNo).toBe(0n);
    expect(b.walletUsdc).toBe(1_000n * USDC);
    expect(health().markets[0]).toMatchObject({ status: "closed", openOrders: 0 });
  });

  it("cancels everything on shutdown", async (ctx) => {
    if (!anvil) return ctx.skip();
    await call(market, mockMarketAbi, "setPhase", [Phase.Graduated]);
    await bot.cycle();
    expect((await readL2Book(client, book)).asks.length).toBe(1);
    await bot.cancelEverything("shutdown");
    const l2 = await readL2Book(client, book);
    expect(await findOwnOrders(client, book, bot.maker, l2)).toEqual([]);
    expect(health().openOrders).toBe(0);
  });

  it("redeems the winning side once the market settles", async (ctx) => {
    if (!anvil) return ctx.skip();
    await mintMock(deployer, tokens.usdc, vault, 100n * USDC);
    await call(market, mockMarketAbi, "setOutcome", [Outcome.Yes]);
    await call(market, mockMarketAbi, "setPhase", [Phase.Settled]);
    const margin = testnet.external.kuru.marginAccount;
    const before = await readBalances(client, bot.maker, tokens, margin);
    expect(before.walletYes).toBeGreaterThan(0n);
    await bot.cycle();
    const after = await readBalances(client, bot.maker, tokens, margin);
    expect(after.walletYes).toBe(0n);
    expect(after.walletNo).toBe(before.walletNo);
    expect(after.walletUsdc - before.walletUsdc).toBe(before.walletYes);
    expect(lines.some((l) => l.event === "tx" && l.action === "redeem" && l.side === "yes")).toBe(true);
  });
});

import {
  deployments,
  kuruV2AccountCoreAbi,
  kuruV2OrderBookAbi,
  kuruV2SpotRouterAbi,
  monadTestnet,
} from "@hunch-book/shared";
import {
  type Address,
  createPublicClient,
  createTestClient,
  createWalletClient,
  erc20Abi,
  http,
  type PublicClient,
  parseEther,
  parseGwei,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deployMockToken, mintMock, mockSetOps, type Signer } from "../../scripts/lib/throwaway-book.js";
import type { BookInfo } from "../../src/kuru.js";
import { setLogSink } from "../../src/log.js";
import type { TxContext } from "../../src/tx.js";
import {
  createRuntimeV2,
  occupiedSlots,
  quoteMarketV2,
  readBalancesV2,
  readBookInfoV2,
  readL2BookV2,
  unwindMarketV2,
  type V2Deps,
  type V2Runtime,
} from "../../src/v2.js";
import { type Anvil, startAnvilFork } from "./anvil.js";

// The v2 maker's own execution code against Kuru's real v2 contracts (AccountCore, SpotRouter,
// OrderBook, WithdrawalLimiter) on a local fork of Monad testnet. Kuru's owner is impersonated for the
// steps only Kuru can take: price sources, enabling and whitelisting a throwaway 6-decimal token pair,
// and deploySpotMarket with Hunch Book's parameters. Then: a quoting cycle rests orders in slots, a
// requote replaces them in one batch, a taker's swap fills one, the next cycle sees the fill, and the
// unwind cancels everything and empties the account. Skips (does not fail) when anvil is missing or the
// fork cannot start.

const testnet = deployments["monad-testnet"];
const FORK_RPC = process.env.MAKER_FORK_RPC ?? process.env.MONAD_TESTNET_RPC ?? testnet.rpc;
const USDC = 1_000_000n;
const kuru = testnet.external.kuruV2;

const lines: Record<string, unknown>[] = [];
let anvil: Anvil | null = null;
let client: PublicClient;
let maker: Signer;
let taker: Signer;
let tokens: { yes: Address; no: Address; usdc: Address };
let book: Address;
let info: BookInfo;
let deps: V2Deps;
let rt: V2Runtime;

const gasOf = (action: string) =>
  lines
    .filter((l) => l.event === "tx" && l.action === action)
    .map((l) => ({ used: l.gasUsed, limit: l.gasLimit }));

async function signer(rpc: string): Promise<Signer> {
  const account = privateKeyToAccount(generatePrivateKey());
  const transport = http(rpc);
  await createTestClient({ mode: "anvil", chain: monadTestnet, transport }).setBalance({
    address: account.address,
    value: parseEther("100"),
  });
  return {
    publicClient: client,
    walletClient: createWalletClient({ account, chain: monadTestnet, transport }),
    account,
    chain: monadTestnet,
  };
}

/** Sends as Kuru's owner (impersonated on the fork). */
async function asKuru(
  owner: Address,
  address: Address,
  abi: readonly unknown[],
  functionName: string,
  args: unknown[],
) {
  const transport = http(anvil?.url);
  const wallet = createWalletClient({ account: owner, chain: monadTestnet, transport });
  const hash = await wallet.writeContract({
    address,
    abi: abi as never,
    functionName: functionName as never,
    args: args as never,
  });
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${functionName} reverted`);
}

const limiterAbi = [
  {
    type: "function",
    name: "setPriceSource",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "source", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "priceSource",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [{ name: "", type: "address" }],
  },
] as const;
const governanceAbi = [
  {
    type: "function",
    name: "configureSpotToken",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "enabled", type: "bool" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "whitelistSpotToken",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "status", type: "bool" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "deploySpotMarket",
    stateMutability: "nonpayable",
    inputs: [
      { name: "baseToken", type: "address" },
      { name: "quoteToken", type: "address" },
      { name: "sizePrecision", type: "uint96" },
      { name: "pricePrecision", type: "uint32" },
      { name: "tickSize", type: "uint32" },
      { name: "passiveSpreadTicks", type: "uint32" },
      { name: "minQuoteNotional", type: "uint96" },
      { name: "maxQuoteNotional", type: "uint96" },
      { name: "takerFeePps", type: "uint256" },
      { name: "makerFeePps", type: "uint256" },
    ],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "owner",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

beforeAll(async () => {
  if (!kuru) return;
  anvil = await startAnvilFork(FORK_RPC);
  if (!anvil) return;
  setLogSink((line) => lines.push(JSON.parse(line)));
  client = createPublicClient({ chain: monadTestnet, transport: http(anvil.url) }) as PublicClient;
  maker = await signer(anvil.url);
  taker = await signer(anvil.url);

  tokens = {
    yes: await deployMockToken(taker, "Mock YES", "mYES"),
    no: await deployMockToken(taker, "Mock NO", "mNO"),
    usdc: await deployMockToken(taker, "Mock USDC", "mUSDC"),
  };
  await mintMock(taker, tokens.usdc, maker.account.address, 1_000n * USDC);
  await mintMock(taker, tokens.usdc, taker.account.address, 1_000n * USDC);

  // Kuru's per-token setup and the book, as Kuru's owner. Kuru's own USDC price source prices both
  // throwaway tokens at about 1 USD, which is all its WithdrawalLimiter needs here.
  const owner = await client.readContract({
    address: kuru.spotRouter,
    abi: governanceAbi,
    functionName: "owner",
  });
  const test = createTestClient({ mode: "anvil", chain: monadTestnet, transport: http(anvil.url) });
  await test.impersonateAccount({ address: owner });
  await test.setBalance({ address: owner, value: parseEther("10") });
  const limiter = kuru.withdrawalLimiter as Address;
  const usdcSource = await client.readContract({
    address: limiter,
    abi: limiterAbi,
    functionName: "priceSource",
    args: [kuru.usdc as Address],
  });
  for (const token of [tokens.yes, tokens.usdc]) {
    await asKuru(owner, limiter, limiterAbi, "setPriceSource", [token, usdcSource]);
    await asKuru(owner, kuru.accountCore, governanceAbi, "configureSpotToken", [token, true]);
    await asKuru(owner, kuru.spotRouter, governanceAbi, "whitelistSpotToken", [token, true]);
  }
  const params = [
    tokens.yes,
    tokens.usdc,
    USDC,
    1_000_000,
    1_000,
    10,
    USDC,
    5_000n * USDC,
    7_000n,
    4_000n,
  ] as const;
  await asKuru(owner, kuru.spotRouter, governanceAbi, "deploySpotMarket", [...params]);
  book = await client.readContract({
    address: kuru.spotRouter,
    abi: kuruV2SpotRouterAbi,
    functionName: "computeAddress",
    args: params,
  });
  info = await readBookInfoV2(client, book);

  const tx: TxContext = {
    publicClient: client,
    walletClient: maker.walletClient,
    account: maker.account,
    chain: monadTestnet,
    deployment: testnet,
    enabled: true,
    maxGasPriceWei: parseGwei("10000"),
    maxGasPerTx: 5_000_000n,
  };
  deps = {
    tx,
    accountCore: kuru.accountCore,
    quote: {
      halfSpread: 0.015,
      minSpread: 0.02,
      skew: 0.02,
      levels: 2,
      levelStep: 0.01,
      orderSize: 10,
      inventoryCap: 50,
      minPrice: 0.01,
      maxPrice: 0.99,
    },
    requoteThreshold: 0.005,
    heartbeatSeconds: 300,
    dustTokens: 1,
  };
  rt = createRuntimeV2({ market: book, book, info, no: tokens.no, sets: mockSetOps(maker, tokens) });
}, 360_000);

afterAll(() => {
  setLogSink((line) => console.log(line));
  if (anvil) {
    console.info(
      JSON.stringify({ book, batch: gasOf("batch"), deposit: gasOf("deposit") }, (_k, v) =>
        typeof v === "bigint" ? v.toString() : v,
      ),
    );
  }
  anvil?.stop();
});

describe("maker on a fork of Monad testnet's Kuru v2", () => {
  it("reads a Hunch-style v2 book: precisions 1e6, tick 0.001, minimum order 1 USDC, fees in pps", async (ctx) => {
    if (!anvil) return ctx.skip();
    expect(info).toMatchObject({
      base: tokens.yes,
      quote: tokens.usdc,
      pricePrecision: 1_000_000,
      sizePrecision: 1_000_000n,
      tickSize: 1_000,
      minQuoteNotional: USDC,
      maxQuoteNotional: 5_000n * USDC,
      takerFeePps: 7_000n,
      baseDecimals: 6,
      quoteDecimals: 6,
    });
  });

  it("rests one quoting cycle in slots on both sides, opening the account with its first deposit", async (ctx) => {
    if (!anvil) return ctx.skip();
    await quoteMarketV2(deps, rt, { fair: 0.42, widen: 1, now: 1_000 });
    const l2 = await readL2BookV2(client, book);
    expect(l2.bids).toEqual([
      { price: 405_000n, size: 10_000_000n },
      { price: 395_000n, size: 10_000_000n },
    ]);
    expect(l2.asks).toEqual([
      { price: 435_000n, size: 10_000_000n },
      { price: 445_000n, size: 10_000_000n },
    ]);
    const b = await readBalancesV2(client, maker.account.address, tokens, kuru?.accountCore as Address);
    expect(b.accountId).not.toBe(0);
    expect(await occupiedSlots(client, book, b.accountId)).toHaveLength(4);
    expect(b.walletNo).toBe(20n * USDC); // 20 sets minted: their YES rests on the asks
    expect(b.reservedYes).toBe(20n * USDC);
    expect(gasOf("batch")).toHaveLength(1);
  });

  it("requotes in one batch when fair value moves: the old slots are cancelled in the same call", async (ctx) => {
    if (!anvil) return ctx.skip();
    await quoteMarketV2(deps, rt, { fair: 0.5, widen: 1, now: 1_010 });
    const l2 = await readL2BookV2(client, book);
    expect(l2.bids.map((l) => l.price)).toEqual([485_000n, 475_000n]);
    expect(l2.asks.map((l) => l.price)).toEqual([515_000n, 525_000n]);
    const b = await readBalancesV2(client, maker.account.address, tokens, kuru?.accountCore as Address);
    expect(await occupiedSlots(client, book, b.accountId)).toHaveLength(4);
    expect(gasOf("batch")).toHaveLength(2);
  });

  it("sees a taker's fill on the next cycle and requotes", async (ctx) => {
    if (!anvil || !kuru) return ctx.skip();
    const spend = 3n * USDC;
    const core = kuru.accountCore;
    const write = async (address: Address, abi: readonly unknown[], functionName: string, args: unknown[]) =>
      taker.publicClient.waitForTransactionReceipt({
        hash: await taker.walletClient.writeContract({
          address,
          abi: abi as never,
          functionName: functionName as never,
          args: args as never,
          account: taker.account,
          chain: monadTestnet,
        }),
      });
    await write(tokens.usdc, erc20Abi, "approve", [core, spend]);
    await write(core, kuruV2AccountCoreAbi, "deposit", [taker.account.address, tokens.usdc, spend]);
    const id = await client.readContract({
      address: core,
      abi: kuruV2AccountCoreAbi,
      functionName: "rootAccountIdOf",
      args: [taker.account.address],
    });
    const deadline = (await client.getBlock()).timestamp + 600n;
    await write(book, kuruV2OrderBookAbi, "swap", [id, true, spend, 0n, deadline]);

    const before = gasOf("batch").length;
    await quoteMarketV2(deps, rt, { fair: 0.5, widen: 1, now: 1_020 });
    expect(lines.some((l) => l.event === "quote" && l.reason === "fill")).toBe(true);
    expect(gasOf("batch").length).toBe(before + 1);
  });

  it("unwinds: cancels every order and empties the Kuru account", async (ctx) => {
    if (!anvil) return ctx.skip();
    await unwindMarketV2(deps, rt, { reason: "close", merge: true });
    const b = await readBalancesV2(client, maker.account.address, tokens, kuru?.accountCore as Address);
    expect(await occupiedSlots(client, book, b.accountId)).toHaveLength(0);
    expect(b.reservedYes + b.reservedUsdc).toBe(0n);
    expect(b.marginYes + b.marginUsdc).toBe(0n);
    expect(rt.unwound).toBe(true);
  });
});

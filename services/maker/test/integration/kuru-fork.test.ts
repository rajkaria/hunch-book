import { deployments, kuruOrderBookAbi, monadTestnet } from "@hunch-book/shared";
import {
  type Address,
  createPublicClient,
  createTestClient,
  createWalletClient,
  encodeFunctionData,
  erc20Abi,
  http,
  type PublicClient,
  parseEther,
  parseGwei,
  zeroAddress,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createKuruBook,
  deployMockToken,
  mintMock,
  mockSetOps,
  type Signer,
} from "../../scripts/lib/throwaway-book.js";
import { readBalances } from "../../src/inventory.js";
import { type BookInfo, findOwnOrders, readBookInfo, readL2Book } from "../../src/kuru.js";
import { setLogSink } from "../../src/log.js";
import {
  cancelBook,
  createRuntime,
  type MakerDeps,
  type MarketRuntime,
  marginFloat,
  quoteMarket,
  unwindMarket,
} from "../../src/maker.js";
import { revertReason, type TxContext } from "../../src/tx.js";
import { type Anvil, startAnvilFork } from "./anvil.js";

// Runs the bot's own execution code against Kuru's real contracts on a local fork of Monad testnet:
// a throwaway 6-decimal token pair, a book made by Kuru's Router.deployProxy, quoting cycles, a taker
// fill, and cancel-all. The vault is not deployed yet, so minting sets is stubbed with mock tokens.
// Skips (does not fail) when anvil is not installed or the fork cannot start.

const testnet = deployments["monad-testnet"];
const FORK_RPC = process.env.MAKER_FORK_RPC ?? process.env.MONAD_TESTNET_RPC ?? testnet.rpc;
const USDC = 1_000_000n;

const lines: Record<string, unknown>[] = [];
let anvil: Anvil | null = null;
let client: PublicClient;
let maker: Signer;
let taker: Signer;
let tokens: { yes: Address; no: Address; usdc: Address };
let book: Address;
let info: BookInfo;
let deps: MakerDeps;
let rt: MarketRuntime;

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

const ownerOf = async (id: bigint) =>
  (
    await client.readContract({
      address: book,
      abi: kuruOrderBookAbi,
      functionName: "s_orders",
      args: [Number(id)],
    })
  )[0];

beforeAll(async () => {
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
  ({ book } = await createKuruBook(
    taker,
    testnet.external.kuru.router,
    tokens.yes,
    tokens.usdc,
    5_000n * USDC,
  ));
  info = await readBookInfo(client, book);

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
    marginAccount: testnet.external.kuru.marginAccount,
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
  rt = createRuntime({ market: book, book, info, no: tokens.no, sets: mockSetOps(maker, tokens) });
}, 360_000);

afterAll(() => {
  setLogSink((line) => console.log(line));
  if (anvil) {
    console.info(
      JSON.stringify(
        { book, batchUpdate: gasOf("batchUpdate"), marginDeposit: gasOf("marginDeposit") },
        (_k, v) => (typeof v === "bigint" ? v.toString() : v),
      ),
    );
  }
  anvil?.stop();
});

describe("maker on a fork of Monad testnet's Kuru", () => {
  it("created a Hunch-style book: YES/USDC, precisions 1e6, tick 0.001, min 1 YES", async (ctx) => {
    if (!anvil) return ctx.skip();
    expect(info).toMatchObject({
      base: tokens.yes,
      quote: tokens.usdc,
      pricePrecision: 1_000_000,
      sizePrecision: 1_000_000n,
      tickSize: 1_000,
      minSize: 1_000_000n,
      baseDecimals: 6,
      quoteDecimals: 6,
    });
  });

  it("places one quoting cycle as resting orders on both sides", async (ctx) => {
    if (!anvil) return ctx.skip();
    await quoteMarket(deps, rt, { fair: 0.42, widen: 1, now: 1_000 });

    const l2 = await readL2Book(client, book);
    expect(l2.bids).toEqual([
      { price: 405_000n, size: 10_000_000n },
      { price: 395_000n, size: 10_000_000n },
    ]);
    expect(l2.asks).toEqual([
      { price: 435_000n, size: 10_000_000n },
      { price: 445_000n, size: 10_000_000n },
    ]);
    const tracked = rt.tracker.cancelIds();
    expect(tracked).toHaveLength(4);
    const found = await findOwnOrders(client, book, maker.account.address, l2);
    expect(found.map((o) => o.id).sort()).toEqual(tracked);

    const balances = await readBalances(client, maker.account.address, tokens, deps.marginAccount);
    expect(balances.walletNo).toBe(20n * USDC); // 20 sets minted: their YES rests on the asks
    expect(balances.marginYes).toBe(0n);
    // The float: one bid ladder's worth (0.405 × 10 + 0.395 × 10), so a requote needs no deposit.
    expect(balances.marginUsdc).toBe(8n * USDC);
    expect(marginFloat(rt.tracker.quotes().bids, rt.info, 1n * USDC)).toBe(8n * USDC);
    expect(gasOf("batchUpdate")).toHaveLength(1);
  });

  it("requotes in one batchUpdate when fair value moves, and never cancels an id twice", async (ctx) => {
    if (!anvil) return ctx.skip();
    const old = rt.tracker.cancelIds();
    await quoteMarket(deps, rt, { fair: 0.5, widen: 1, now: 1_010 });

    for (const id of old) {
      expect(await ownerOf(id)).toBe(zeroAddress);
      expect(rt.tracker.isRetired(id)).toBe(true);
    }
    expect(rt.tracker.cancelIds().some((id) => old.includes(id))).toBe(false);
    const l2 = await readL2Book(client, book);
    expect(l2.bids.map((l) => l.price)).toEqual([485_000n, 475_000n]);
    expect(l2.asks.map((l) => l.price)).toEqual([515_000n, 525_000n]);
    expect(gasOf("batchUpdate")).toHaveLength(2);

    // What the tracker protects against: Kuru reverts a second cancel of the same id.
    const data = encodeFunctionData({
      abi: kuruOrderBookAbi,
      functionName: "batchUpdate",
      args: [[], [], [], [], [Number(old[0])], false],
    });
    const error = await client
      .estimateGas({ account: maker.account.address, to: book, data })
      .catch((e) => e);
    expect(revertReason(error, kuruOrderBookAbi)).toBe("OnlyOwnerAllowedError");
  });

  it("detects a taker's fills, requotes, and keeps proceeds inside the float in margin", async (ctx) => {
    if (!anvil) return ctx.skip();
    const spend = 6n * USDC;
    await taker.publicClient.waitForTransactionReceipt({
      hash: await taker.walletClient.writeContract({
        address: tokens.usdc,
        abi: erc20Abi,
        functionName: "approve",
        args: [book, spend],
        account: taker.account,
        chain: monadTestnet,
      }),
    });
    await taker.publicClient.waitForTransactionReceipt({
      hash: await taker.walletClient.writeContract({
        address: book,
        abi: kuruOrderBookAbi,
        functionName: "placeAndExecuteMarketBuy",
        args: [spend, 0n, false, false],
        account: taker.account,
        chain: monadTestnet,
      }),
    });

    const before = lines.length;
    await quoteMarket(deps, rt, { fair: 0.5, widen: 1, now: 1_020 });
    const fresh = lines.slice(before);
    const fills = fresh.filter((l) => l.event === "fill");
    expect(fills.map((f) => [f.price, f.complete])).toEqual([
      [515_000, true],
      [525_000, false],
    ]);
    expect(fresh.find((l) => l.event === "quote")?.reason).toBe("fill");
    // About 6 USDC of proceeds on top of an 8 USDC float is not worth a withdraw transaction; the
    // margin is withdrawn down to the float only past twice the float.
    // (The asks it sold need YES again: that deposit is of YES, never of USDC.)
    const usdcMoves = fresh.filter(
      (l) =>
        l.event === "tx" &&
        (l.action === "marginDeposit" || l.action === "marginWithdraw") &&
        String(l.token).toLowerCase() === tokens.usdc.toLowerCase(),
    );
    expect(usdcMoves).toEqual([]);

    const balances = await readBalances(client, maker.account.address, tokens, deps.marginAccount);
    expect(balances.marginUsdc).toBeLessThanOrEqual(
      2n * marginFloat(rt.tracker.quotes().bids, rt.info, 1n * USDC),
    );
    // Sold about 11.65 YES: the bot is now short YES (long NO) and skews its quotes up.
    expect(rt.health.position).toBeLessThan(-11);
    expect(rt.health.position).toBeGreaterThan(-12);
    const l2 = await readL2Book(client, book);
    expect(l2.bids[0]?.price).toBeGreaterThan(485_000n);
  });

  it("unwinds at close: cancels everything, empties the margin account, merges pairs", async (ctx) => {
    if (!anvil) return ctx.skip();
    await unwindMarket(deps, rt, { reason: "close", merge: true });
    const l2 = await readL2Book(client, book);
    expect(await findOwnOrders(client, book, maker.account.address, l2)).toEqual([]);
    expect(l2).toMatchObject({ bids: [], asks: [] });
    const b = await readBalances(client, maker.account.address, tokens, deps.marginAccount);
    expect([b.marginYes, b.marginUsdc]).toEqual([0n, 0n]);
    expect(b.walletYes === 0n || b.walletNo === 0n).toBe(true);
    expect(rt.tracker.cancelIds()).toEqual([]);
  });

  it("cancel-all clears the book of the bot's orders without local state", async (ctx) => {
    if (!anvil) return ctx.skip();
    await quoteMarket(deps, rt, { fair: 0.3, widen: 1, now: 2_000 });
    expect((await readL2Book(client, book)).bids.length).toBeGreaterThan(0);
    await cancelBook(deps, book, info, "cancel-all");
    const l2 = await readL2Book(client, book);
    expect(await findOwnOrders(client, book, maker.account.address, l2)).toEqual([]);
    const b = await readBalances(client, maker.account.address, tokens, deps.marginAccount);
    expect([b.marginYes, b.marginUsdc]).toEqual([0n, 0n]);
  });

  it("with the kill switch off, prints the intended quotes and sends nothing", async (ctx) => {
    if (!anvil) return ctx.skip();
    const dry = createRuntime({
      market: book,
      book,
      info,
      no: tokens.no,
      sets: { mint: async () => true, merge: async () => true },
    });
    const nonce = await client.getTransactionCount({ address: maker.account.address });
    const before = lines.length;
    await quoteMarket({ ...deps, tx: { ...deps.tx, enabled: false } }, dry, {
      fair: 0.6,
      widen: 1,
      now: 3_000,
    });
    const fresh = lines.slice(before);
    expect(fresh.find((l) => l.event === "quote")).toMatchObject({ dryRun: true, reason: "no-orders" });
    expect(fresh.some((l) => l.event === "dry-run" && l.action === "batchUpdate")).toBe(true);
    expect(fresh.some((l) => l.event === "tx")).toBe(false);
    expect(await client.getTransactionCount({ address: maker.account.address })).toBe(nonce);
    expect(await readL2Book(client, book)).toMatchObject({ bids: [], asks: [] });
  });
});

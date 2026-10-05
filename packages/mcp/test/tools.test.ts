import {
  decodeMarketParams,
  deployments,
  encodeMarketParams,
  HunchError,
  type MarketInfo,
  Outcome,
  Phase,
  type Quote,
} from "@hunch-book/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Address, Hex } from "viem";
import { describe, expect, it, vi } from "vitest";
import { type McpConfig, parseConfig, writesEnabled } from "../src/config.js";
import { createServer, offeredTools, runTool } from "../src/server.js";
import { type HunchPort, parseTemplateParams, TOOLS, type ToolDef } from "../src/tools.js";

const testnet = deployments["monad-testnet"];
const KEY = `0x${"1".repeat(64)}`;
const ME = "0x00000000000000000000000000000000000000aa" as Address;
const MARKET = "0x0000000000000000000000000000000000001001" as Address;
const TX = `0x${"ab".repeat(32)}` as Hex;

function market(overrides: Partial<MarketInfo> = {}): MarketInfo {
  const params = encodeMarketParams({
    templateId: 1,
    params: { perpId: 16n, startBlock: 100n, endBlock: 200n, threshold: 0n, expectedScalingExp: 2 },
  });
  return {
    address: MARKET,
    id: 1,
    templateId: 1,
    template: "Perpl net funding",
    phase: Phase.Graduated,
    phaseName: "trading",
    phaseLabel: "Trading",
    outcome: Outcome.Unresolved,
    outcomeLabel: "unresolved",
    graduated: true,
    pool: { yes: 410_000_000n, no: 280_000_000n, total: 690_000_000n, stakers: 11 },
    window: { blockClock: true, lock: 100n, close: 200n, settleDeadline: 1_800_000_000n },
    tokens: {
      yes: "0x0000000000000000000000000000000000002001",
      no: "0x0000000000000000000000000000000000002002",
    },
    book: "0x0000000000000000000000000000000000003000",
    resolver: "0x0000000000000000000000000000000000000aaa",
    creator: ME,
    params,
    decoded: decodeMarketParams(1, params),
    asset: "BTC",
    rule: "Will BTC longs pay shorts on net on Perpl between block 100 and block 200?",
    graduationRule: { minPool: 500_000_000n, minStakers: 10, minChanceBps: 300, maxChanceBps: 9_700 },
    graduationRuleMet: true,
    caps: {
      poolCap: 5_000_000_000n,
      walletCap: 1_000_000_000n,
      minStake: 1_000_000n,
      creatorMinStake: 5_000_000n,
    },
    evidenceHash: `0x${"00".repeat(32)}`,
    prices: { bidE6: 830_000n, askE6: 861_000n },
    chance: { bps: 8_455, source: "book" },
    ...overrides,
  };
}

const quoteFor = (kind: Quote["kind"], amount: bigint): Quote => ({
  kind,
  amount,
  usdc: kind === "buyYes" ? amount : 8_300_000n,
  tokens: kind === "buyYes" ? 11_614_401n : amount,
  returned: { usdc: 0n, yes: 0n },
  avgPriceE6: 861_000n,
  levels: 1,
  shortfall: null,
  market: MARKET,
  book: "0x0000000000000000000000000000000000003000",
  block: 68_058_338n,
  slippageBps: 100n,
  limit: kind === "buyNo" ? 2_000_000_000n : 11_498_256n,
  approval: { token: "usdc", amount },
  impactBps: 183n,
  touchPriceE6: 861_000n,
  midE6: 845_500n,
});

function fakeSdk(wallet: Address | null = ME) {
  const account = wallet ?? undefined;
  const tx = {
    hash: TX,
    url: `https://testnet.monadscan.com/tx/${TX}`,
    status: "success" as const,
    blockNumber: 1n,
    result: undefined,
    receipt: null,
  };
  const markets = [
    market(),
    market({
      id: 2,
      address: "0x0000000000000000000000000000000000001002",
      templateId: 2,
      template: "Price at a time",
      asset: "ETH/USD",
      phase: Phase.Pool,
      phaseName: "pool",
    }),
  ];
  const sdk = {
    network: "monad-testnet",
    account,
    deployment: testnet,
    markets: {
      list: vi.fn(),
      all: vi.fn(async () => markets),
      get: vi.fn(
        async (a: Address) => markets.find((m) => m.address.toLowerCase() === a.toLowerCase()) ?? null,
      ),
      position: vi.fn(async () => ({
        market: MARKET,
        stake: { yes: 5_000_000n, no: 0n },
        claimableTokens: { yes: 0n, no: 0n },
        claimablePool: { paid: 0n, fee: 0n },
        balances: { yes: 7_000_000n, no: 0n },
      })),
      portfolio: vi.fn(async () => []),
    },
    quotes: {
      quote: vi.fn(async (_m: unknown, kind: Quote["kind"], amount: bigint) => quoteFor(kind, amount)),
    },
    actions: {
      createMarket: vi.fn(async () => ({
        ...tx,
        market: "0x000000000000000000000000000000000000beef" as Address,
      })),
      stake: vi.fn(async () => tx),
      trade: vi.fn(async (_m: unknown, kind: Quote["kind"], amount: bigint) => ({
        ...tx,
        quote: quoteFor(kind, amount),
      })),
      settle: vi.fn(async () => ({ ...tx, outcome: Outcome.Yes, method: "settle" as const })),
      collect: vi.fn(async () => [tx, tx]),
      collectAll: vi.fn(async (list: readonly unknown[]) => ({
        mode: "sequential" as const,
        calls: list.map((_m, i) => ({ label: `Redeem leg ${i + 1}` })),
        transactions: list.map(() => ({ hash: tx.hash, url: tx.url, status: "success" as const })),
      })),
      mintTestUsdc: vi.fn(async () => tx),
    },
    settlement: {
      plan: vi.fn(async () => ({
        status: "wait" as const,
        reason: "Waiting for block 201: Perpl's funding is final only after the window's last block.",
      })),
      verify: vi.fn(),
    },
  };
  return sdk;
}

const config = (env: Record<string, string> = {}): McpConfig =>
  parseConfig({ HUNCH_MCP_PRIVATE_KEY: KEY, ...env });
const byName = (name: string): ToolDef =>
  (TOOLS as readonly ToolDef[]).find((t) => t.name === name) as ToolDef;
const run = async (name: string, input: unknown, sdk = fakeSdk(), cfg = config()) => {
  const result = await runTool(byName(name), input, { sdk: sdk as unknown as HunchPort, config: cfg });
  return { result, sdk, json: result.isError ? null : JSON.parse(result.content[0]?.text ?? "{}") };
};

describe("config", () => {
  it("defaults to testnet, read-only without a key, with per-call limits", () => {
    const c = parseConfig({});
    expect(c).toMatchObject({
      network: "monad-testnet",
      privateKey: undefined,
      maxUsdcPerCall: 100_000_000n,
      maxSlippageBps: 300n,
      defaultSlippageBps: 100n,
    });
    expect(writesEnabled(c)).toBe(false);
    expect(writesEnabled(config())).toBe(true);
    expect(parseConfig({ HUNCH_MCP_MAX_USDC_PER_CALL: "12.5" }).maxUsdcPerCall).toBe(12_500_000n);
  });

  it("keeps mainnet read-only unless writes are allowed explicitly", () => {
    expect(writesEnabled(config({ HUNCH_MCP_NETWORK: "monad-mainnet" }))).toBe(false);
    expect(
      writesEnabled(config({ HUNCH_MCP_NETWORK: "monad-mainnet", HUNCH_MCP_ALLOW_MAINNET_WRITES: "1" })),
    ).toBe(true);
  });

  it("rejects bad values without ever echoing the key", () => {
    const secret = "0xdeadbeef";
    let message = "";
    try {
      parseConfig({ HUNCH_MCP_PRIVATE_KEY: secret });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/not a 32-byte hex key/);
    expect(message).not.toContain("deadbeef");
    expect(() => parseConfig({ HUNCH_MCP_NETWORK: "ethereum" })).toThrow(/monad-testnet/);
    expect(() => parseConfig({ HUNCH_MCP_MAX_SLIPPAGE_BPS: "9000" })).toThrow(/at most 5000/);
  });
});

describe("tool schemas", () => {
  it("names every tool once, in plain words", () => {
    const names = TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of [
      "list_markets",
      "get_market",
      "quote",
      "get_portfolio",
      "create_market",
      "stake",
      "trade",
      "settle",
      "redeem",
      "redeem_all",
      "verify_settlement",
    ]) {
      expect(names).toContain(name);
    }
    const dash = String.fromCharCode(0x2014);
    for (const t of TOOLS) expect(`${t.title} ${t.description}`.includes(dash)).toBe(false);
  });

  it("offers write tools only with a wallet", () => {
    const readOnly = offeredTools(parseConfig({})).map((t) => t.name);
    expect(readOnly).toContain("list_markets");
    expect(readOnly).not.toContain("trade");
    expect(offeredTools(config()).map((t) => t.name)).toContain("trade");
  });

  it("serves tools and docs over the MCP protocol", async () => {
    const server = createServer(fakeSdk() as unknown as HunchPort, config());
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1.0.0" });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    const { tools } = await client.listTools();
    const trade = tools.find((t) => t.name === "trade");
    expect(trade?.inputSchema.required).toEqual(["market", "kind", "amount"]);
    expect(trade?.annotations?.readOnlyHint).toBe(false);
    expect(tools.find((t) => t.name === "list_markets")?.annotations?.readOnlyHint).toBe(true);

    const listed = await client.callTool({ name: "list_markets", arguments: { phase: "trading" } });
    const body = JSON.parse((listed.content as { text: string }[])[0]?.text ?? "{}");
    expect(body).toMatchObject({
      total: 2,
      matching: 1,
      markets: [{ id: 1, chanceOfYes: "84.55%", book: { bid: "0.8300", ask: "0.8610" } }],
    });

    const bad = await client.callTool({
      name: "quote",
      arguments: { market: "not-an-address", kind: "buyYes", amount: "1" },
    });
    expect(bad.isError).toBe(true);

    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toEqual([
      "docs://hunch-book/protocol",
      "docs://hunch-book/templates",
      "docs://hunch-book/periphery",
      "docs://hunch-book/sdk",
    ]);
    const doc = await client.readResource({ uri: "docs://hunch-book/templates" });
    expect((doc.contents[0] as { text: string }).text).toMatch(/^# Hunch Book templates/);
    await client.close();
  });
});

describe("tool handlers", () => {
  it("lists markets filtered by asset and template", async () => {
    const { json } = await run("list_markets", { asset: "eth" });
    expect(json.markets.map((m: { id: number }) => m.id)).toEqual([2]);
    const byTemplate = await run("list_markets", { template: 1, limit: 1 });
    expect(byTemplate.json.matching).toBe(1);
  });

  it("reads one market with its settlement plan and the wallet's position", async () => {
    const { json } = await run("get_market", { market: MARKET });
    expect(json).toMatchObject({
      id: 1,
      rule: expect.stringContaining("BTC longs"),
      pool: { totalUsdc: "690", stakers: 11 },
      window: { clock: "block", lockBlock: "100", closeBlock: "200" },
      settlement: { status: "wait" },
      yourPosition: { tokens: { yes: "7" } },
    });
    const missing = await run("get_market", { market: "0x0000000000000000000000000000000000009999" });
    expect(missing.result.isError).toBe(true);
    expect(missing.result.content[0]?.text).toMatch(/not a Hunch Book market/);
  });

  it("quotes in plain units", async () => {
    const { json, sdk } = await run("quote", { market: MARKET, kind: "buyYes", amount: "10" });
    expect(sdk.quotes.quote).toHaveBeenCalledWith(MARKET, "buyYes", 10_000_000n, { slippageBps: 100n });
    expect(json).toMatchObject({
      canFill: true,
      youPayUsdc: "10",
      tokens: "11.614401 YES",
      averagePrice: "0.8610",
      impactBps: 183,
      limit: "receive at least 11.498256 YES",
    });
  });

  it("enforces the per-call USDC, token and slippage limits before sending anything", async () => {
    const tooMuch = await run("trade", { market: MARKET, kind: "buyYes", amount: "100.000001" });
    expect(tooMuch.result.isError).toBe(true);
    expect(tooMuch.result.content[0]?.text).toMatch(/limit of 100 USDC per call/);
    expect(tooMuch.sdk.actions.trade).not.toHaveBeenCalled();

    const slip = await run("trade", { market: MARKET, kind: "buyYes", amount: "1", slippageBps: 301 });
    expect(slip.result.content[0]?.text).toMatch(/above this server's limit of 300 bps/);

    // buyNo is capped by the most it can cost (the quote's limit), here 2,000 USDC.
    const buyNo = await run("trade", { market: MARKET, kind: "buyNo", amount: "5" });
    expect(buyNo.result.content[0]?.text).toMatch(/at its most/);

    const sell = await run("trade", { market: MARKET, kind: "sellYes", amount: "201" });
    expect(sell.result.content[0]?.text).toMatch(/limit of 200 per call/);

    const stake = await run("stake", { market: MARKET, side: "yes", amount: "250" });
    expect(stake.result.isError).toBe(true);
    expect(stake.sdk.actions.stake).not.toHaveBeenCalled();
  });

  it("trades within the limits and returns the explorer link", async () => {
    const { json, sdk } = await run("trade", {
      market: MARKET,
      kind: "buyYes",
      amount: "10",
      slippageBps: 50,
    });
    expect(sdk.actions.trade).toHaveBeenCalledWith(
      MARKET,
      "buyYes",
      10_000_000n,
      expect.objectContaining({ slippageBps: 50n }),
    );
    expect(json).toMatchObject({ tx: TX, explorer: `https://testnet.monadscan.com/tx/${TX}` });
  });

  it("does not send a settle that cannot succeed, and says why", async () => {
    const waiting = await run("settle", { market: MARKET });
    expect(waiting.json).toMatchObject({
      settled: false,
      status: "wait",
      reason: expect.stringContaining("block 201"),
    });
    expect(waiting.sdk.actions.settle).not.toHaveBeenCalled();

    const sdk = fakeSdk();
    sdk.settlement.plan.mockResolvedValueOnce({
      status: "ready",
      method: "settle",
      evidence: "0x",
      value: 0n,
      outcome: Outcome.Yes,
      outcomeLabel: "yes",
      evidenceHash: TX,
      detail: {},
    } as never);
    const settled = await run("settle", { market: MARKET }, sdk);
    expect(settled.json).toMatchObject({
      settled: true,
      outcome: "yes",
      explorer: expect.stringContaining("/tx/"),
    });
  });

  it("collects every transaction of a finished market", async () => {
    const { json } = await run("redeem", { market: MARKET });
    expect(json.transactions).toHaveLength(2);
  });

  it("collects every finished market in the portfolio, and nothing still open", async () => {
    const empty = await run("redeem_all", {});
    expect(empty.json.note).toBe("Nothing to collect.");
    expect(empty.sdk.actions.collectAll).not.toHaveBeenCalled();

    const sdk = fakeSdk();
    const entry = (phase: Phase, id: number) => ({
      info: market({ id, phase }),
      stake: { yes: 0n, no: 0n },
      claimableTokens: { yes: 0n, no: 0n },
      claimablePool: { paid: 0n, fee: 0n },
      balances: { yes: 1_000_000n, no: 0n },
      market: MARKET,
    });
    sdk.markets.portfolio.mockResolvedValueOnce([
      entry(Phase.Settled, 1),
      entry(Phase.Graduated, 2),
      entry(Phase.Voided, 3),
    ] as never);
    const { json } = await run("redeem_all", {}, sdk);
    const sent = sdk.actions.collectAll.mock.calls[0]?.[0] as { id: number }[];
    expect(sent.map((m) => m.id)).toEqual([1, 3]);
    expect(json.mode).toBe("sequential");
    expect(json.calls).toEqual(["Redeem leg 1", "Redeem leg 2"]);
    expect(json.transactions).toHaveLength(2);
  });

  it("creates markets from JSON params for every template", async () => {
    const { json, sdk } = await run("create_market", {
      templateId: 1,
      params: { perpId: "16", startBlock: "1000", endBlock: "9571", threshold: "0", expectedScalingExp: 2 },
      side: "yes",
      firstStake: "5",
    });
    expect(json.market).toBe("0x000000000000000000000000000000000000beef");
    expect(sdk.actions.createMarket).toHaveBeenCalledWith({
      templateId: 1,
      params: { perpId: 16n, startBlock: 1_000n, endBlock: 9_571n, threshold: 0n, expectedScalingExp: 2 },
      side: "yes",
      firstStake: 5_000_000n,
    });
    const feed = testnet.external.chainlink["BTC/USD"] as Address;
    expect(
      parseTemplateParams(2, {
        source: "chainlink",
        feed,
        strikeE8: "8500000000000",
        lockTime: 1,
        closeTime: 2,
      }),
    ).toEqual({
      templateId: 2,
      params: {
        source: 0,
        feed,
        pythId: `0x${"00".repeat(32)}`,
        strikeE8: 8_500_000_000_000n,
        lockTime: 1n,
        closeTime: 2n,
      },
    });
    expect(
      parseTemplateParams(3, {
        feed,
        strikeE8: 1,
        direction: "atOrBelow",
        lockTime: 1,
        startTime: 1,
        endTime: 2,
      }).params,
    ).toMatchObject({ direction: 1 });
    expect(
      parseTemplateParams(5, {
        source: "pyth",
        pythId: `0x${"12".repeat(32)}`,
        lowerE8: 1,
        upperE8: 2,
        lockTime: 1,
        closeTime: 2,
      }).params,
    ).toMatchObject({ source: 1 });
    expect(parseTemplateParams(6, { legs: [MARKET, ME], lockTime: 1, closeTime: 2 }).templateId).toBe(6);
    expect(
      parseTemplateParams(7, {
        sourceId: 2,
        threshold: "1000000",
        comparator: "atOrBelow",
        lockTime: 1,
        closeTime: 2,
      }),
    ).toEqual({
      templateId: 7,
      params: {
        sourceId: 2,
        threshold: 1_000_000n,
        comparator: 3,
        lockTime: 1n,
        closeTime: 2n,
        snapshotWindow: 600,
      },
    });
    expect(() =>
      parseTemplateParams(7, {
        sourceId: 0,
        threshold: 1,
        comparator: "above",
        lockTime: 1,
        closeTime: 2,
        snapshotWindow: 10,
      }),
    ).toThrow(/snapshotWindow/);
    expect(() =>
      parseTemplateParams(2, { source: "chainlink", strikeE8: 1, lockTime: 1, closeTime: 2 }),
    ).toThrow(/needs `feed`/);
    expect(() => parseTemplateParams(9, {})).toThrow(/not one of 1 to 7/);
    expect(() => parseTemplateParams(1, { perpId: "x" })).toThrow(/perpId/);
  });

  it("turns SDK errors into plain-word tool errors", async () => {
    const sdk = fakeSdk();
    sdk.actions.stake.mockRejectedValueOnce(
      new HunchError("That stake would take the pool over its cap.", { code: "PoolCapExceeded" }),
    );
    const { result } = await run("stake", { market: MARKET, side: "no", amount: "1" }, sdk);
    expect(result).toEqual({
      content: [{ type: "text", text: "That stake would take the pool over its cap." }],
      isError: true,
    });
  });

  it("needs a wallet to read its own portfolio, and mints test USDC only on testnet", async () => {
    const readOnly = await run("get_portfolio", {}, fakeSdk(null));
    expect(readOnly.result.content[0]?.text).toMatch(/Name a wallet/);
    const sdk = fakeSdk();
    (sdk as { network: string }).network = "monad-mainnet";
    const mint = await run("get_test_usdc", { amount: "10" }, sdk);
    expect(mint.result.content[0]?.text).toMatch(/only on Monad testnet/);
  });
});

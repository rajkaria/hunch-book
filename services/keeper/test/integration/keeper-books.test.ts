import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Deployment, graduatorAbi, marketAbi, Outcome, Phase, Side } from "@hunch-book/shared";
import { type Abi, type Address, getAddress, type PrivateKeyAccount } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseConfig } from "../../src/config.js";
import type { HealthSnapshot } from "../../src/health.js";
import { Keeper } from "../../src/keeper.js";
import { setLogSink } from "../../src/log.js";
import { defaultSettlers, type Settler } from "../../src/settlers/index.js";
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

// Graduation where only Kuru can create books (Monad mainnet), with the real Graduator in
// "cannot create books" mode and the contracts' mock of Kuru's Router (owner-only deployProxy, the same
// CREATE2 address prediction) and MarginAccount:
//   1. the pool meets its rule: the keeper asks Kuru for the book (log line + webhook), once;
//   2. Kuru deploys the book: the keeper finds it at the predicted address and registers it;
//   3. the keeper graduates the market into that book.
// Also: a market on a template the keeper has no settler for is skipped, and a settler registered for
// it at startup settles it. Skips (does not fail) when anvil or contracts/out is missing.

const TEMPLATE_X = 9;
const WEBHOOK = "https://hooks.example.com/keeper";
const BOOK_PARAMS = {
  sizePrecision: 1_000_000n,
  pricePrecision: 1_000_000,
  tickSize: 1_000,
  minSize: 1_000_000n,
  takerFeeBps: 0n,
  makerFeeBps: 0n,
  kuruAmmSpread: 30n,
};

const lines: Record<string, unknown>[] = [];
const posts: Record<string, unknown>[] = [];
let chain: LocalChain | null = null;
let deployer: PrivateKeyAccount;
let kuru: PrivateKeyAccount;
let core: Core;
let router: Address;
let graduator: Address;
let deployment: Deployment;
let dir: string;
let keeperKey: `0x${string}`;
let market: Address;
let other: Address;

const fakeFetch = (async (url: string, init?: RequestInit) => {
  if (url === WEBHOOK) posts.push(JSON.parse(String(init?.body)));
  return new Response("ok", { status: 200 });
}) as typeof fetch;

function makeKeeper(settlers = defaultSettlers()): Keeper {
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
  return new Keeper(config, deployment, { settlers, fetchFn: fakeFetch });
}

const events = (event: string) => lines.filter((l) => l.event === event);
const health = (): HealthSnapshot => JSON.parse(readFileSync(join(dir, "health.json"), "utf8"));

beforeAll(async () => {
  chain = await LocalChain.start();
  if (!chain) return;
  setLogSink((line) => lines.push(JSON.parse(line)));
  dir = mkdtempSync(join(tmpdir(), "keeper-books-"));
  deployer = await chain.account();
  kuru = await chain.account();
  const stakers: PrivateKeyAccount[] = [];
  for (let i = 0; i < 4; i++) stakers.push(await chain.account());
  keeperKey = generatePrivateKey();
  await chain.fundedAccount(keeperKey);
  core = await deployCore(chain, deployer, stakers);

  // Kuru as on mainnet: only its owner can create books.
  const margin = await chain.deploy(kuru, "mockKuruMarginAccount");
  router = await chain.deploy(kuru, "mockKuruRouter", [margin]);
  await chain.send(kuru, margin, abiOf("mockKuruMarginAccount"), "setRouter", [router]);
  await chain.send(kuru, router, abiOf("mockKuruRouter"), "setOwnerOnly", [true]);
  graduator = await chain.deploy(deployer, "graduator", [
    core.factory,
    router,
    margin,
    core.usdc,
    false,
    BOOK_PARAMS,
  ]);
  await chain.send(deployer, core.factory, abiOf("factory"), "setGraduator", [graduator]);
  await chain.send(deployer, core.factory, abiOf("factory"), "addTemplate", [
    TEMPLATE_X,
    core.resolver,
    { minPool: 50n * USDC, minStakers: 4, minChanceBps: 300, maxChanceBps: 9_700 },
  ]);

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
  for (const [i, s] of stakers.entries()) {
    await chain.send(s, market, marketAbi as Abi, "stake", [i < 2 ? Side.Yes : Side.No, 20n * USDC]);
  }
  // A small pool on the template with no settler: closes 20 blocks from now.
  await chain.send(deployer, core.factory, abiOf("factory"), "createMarket", [
    TEMPLATE_X,
    windowParams(head + 30n, head + 40n, now + 86_400n),
    Side.No,
    5n * USDC,
  ]);
  const count = await chain.read<bigint>(core.factory, abiOf("factory"), "marketCount");
  other = getAddress(await chain.read<Address>(core.factory, abiOf("factory"), "marketAt", [count - 1n]));

  const wallets = { maker: testnet.wallets.maker, keeper: privateKeyToAccount(keeperKey).address };
  const { factory, vault, usdc, deployBlock } = core;
  deployment = {
    ...testnet,
    wallets,
    hunchBook: { factory, vault, usdc, graduator, deployBlock },
    external: { ...testnet.external, kuru: { router, marginAccount: margin } },
  };
}, 120_000);

afterAll(() => {
  setLogSink((line) => console.log(line));
  chain?.stop();
});

describe("graduation where only Kuru can create books", () => {
  let keeper: Keeper;
  let request: Record<string, unknown>;

  it("asks Kuru for the book with the exact deployProxy parameters, once", async (ctx) => {
    if (!chain) return ctx.skip();
    keeper = makeKeeper();
    await keeper.cycle();
    expect(events("plan").find((l) => l.market === market && l.job === "graduate")).toMatchObject({
      action: "book-request",
    });
    const [yes] = await chain.readMarket<[Address, Address]>(market, "tokens");
    request = events("book-request")[0] as Record<string, unknown>;
    expect(request).toMatchObject({
      market,
      kuruRouter: router,
      call: "deployProxy",
      args: {
        _type: 0,
        _baseAssetAddress: yes,
        _quoteAssetAddress: core.usdc,
        _sizePrecision: "1000000",
        _pricePrecision: 1_000_000,
        _tickSize: 1_000,
        _minSize: "1000000",
        _maxSize: "5000000000",
        _takerFeeBps: "0",
        _makerFeeBps: "0",
        _kuruAmmSpread: "30",
      },
    });
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ event: "book-request", market, network: "monad-testnet" });
    expect(health().jobs.graduate.lastAction).toMatchObject({
      market,
      action: "book-request",
      status: "requested",
    });
    expect(await chain.readMarket<number>(market, "phase")).toBe(Phase.Pool);

    lines.length = 0;
    await keeper.cycle();
    expect(events("book-request")).toHaveLength(0);
    expect(posts).toHaveLength(1);
  });

  it("registers the book once Kuru has deployed it, then graduates into it", async (ctx) => {
    if (!chain) return ctx.skip();
    const a = request.args as Record<string, string | number>;
    await chain.send(kuru, router, abiOf("mockKuruRouter"), "deployProxy", [
      a._type,
      a._baseAssetAddress,
      a._quoteAssetAddress,
      BigInt(a._sizePrecision as string),
      a._pricePrecision,
      a._tickSize,
      BigInt(a._minSize as string),
      BigInt(a._maxSize as string),
      BigInt(a._takerFeeBps as string),
      BigInt(a._makerFeeBps as string),
      BigInt(a._kuruAmmSpread as string),
    ]);
    const book = getAddress(await chain.read<Address>(router, abiOf("mockKuruRouter"), "lastDeployed"));
    expect(request.expectedBook).toBe(book);

    lines.length = 0;
    await keeper.cycle();
    expect(events("tx").find((l) => l.action === "registerBook")).toMatchObject({
      market,
      book,
      status: "success",
    });
    expect(await chain.read<Address>(graduator, graduatorAbi as Abi, "bookOf", [market])).toBe(book);

    lines.length = 0;
    await keeper.cycle();
    expect(events("tx").find((l) => l.action === "graduate")).toMatchObject({ market, status: "success" });
    expect(await chain.readMarket<number>(market, "phase")).toBe(Phase.Graduated);
    expect(await chain.readMarket<Address>(market, "book")).toBe(book);
  });
});

describe("templates the keeper does not know", () => {
  it("skips them with one warning, and settles them once a settler is registered", async (ctx) => {
    if (!chain) return ctx.skip();
    await chain.test.mine({ blocks: 60 });
    await chain.send(deployer, core.resolver, abiOf("mockResolver"), "setAnswer", [Outcome.No]);

    lines.length = 0;
    const plain = makeKeeper();
    await plain.cycle();
    await plain.cycle();
    expect(events("unknown-template")).toEqual([
      expect.objectContaining({ templateId: TEMPLATE_X, market: other }),
    ]);
    expect(events("plan").find((l) => l.market === other && l.job === "settle")?.reason).toBe(
      `no settler for template ${TEMPLATE_X}: skipped`,
    );
    expect(await chain.readMarket<number>(other, "phase")).toBe(Phase.PoolLocked);

    const closeOnly: Settler = {
      name: "test-window",
      waitReason: () => null,
      evidence: async () => ({ status: "ready", evidence: "0x", value: 0n, detail: {} }),
    };
    lines.length = 0;
    await makeKeeper(defaultSettlers().register(TEMPLATE_X, closeOnly)).cycle();
    expect(events("tx").find((l) => l.action === "settle")).toMatchObject({
      market: other,
      settler: "test-window",
      status: "success",
    });
    expect(await chain.readMarket<number>(other, "outcome")).toBe(Outcome.No);
  });
});

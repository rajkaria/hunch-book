import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Deployment, kuruOrderBookAbi, marketAbi, Phase, Side } from "@hunch-book/shared";
import {
  type Abi,
  type Address,
  erc20Abi,
  getAddress,
  isAddressEqual,
  type PrivateKeyAccount,
  zeroAddress,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseConfig } from "../../src/config.js";
import type { HealthSnapshot } from "../../src/health.js";
import { setLogSink } from "../../src/log.js";
import { buildKeepers } from "../../src/stacks.js";
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

// Graduation on a stack whose books are Hunch Book's own order book (docs/PROTOCOL.md §8.1), with the
// real contracts: HunchOrderBookFactory (which deploys HunchMarginAccount and the book implementation)
// and the v1 Graduator wired to it with canCreateBooks = true, as DeployHunchStack.s.sol does. The
// deployment is testnet's layout: the stack sits under `stacks.hunch`, is the default stack, and
// `external.kuru` still names Kuru's real testnet contracts, which have no code on this chain. So the
// test shows the keeper runs on the stack's own view (deploymentForStack) and never reaches for Kuru:
// one `graduate()` creates the book, with no book request and no registerBook.
// Skips (does not fail) when anvil or contracts/out is missing.

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
let chain: LocalChain | null = null;
let deployer: PrivateKeyAccount;
let core: Core;
let bookFactory: Address;
let marginAccount: Address;
let graduator: Address;
let deployment: Deployment;
let dir: string;
let keeperKey: `0x${string}`;
let market: Address;

const events = (event: string) => lines.filter((l) => l.event === event);
const c = () => chain as LocalChain;

beforeAll(async () => {
  chain = await LocalChain.start();
  if (!chain) return;
  setLogSink((line) => lines.push(JSON.parse(line)));
  dir = mkdtempSync(join(tmpdir(), "keeper-hunch-"));
  deployer = await chain.account();
  const stakers: PrivateKeyAccount[] = [];
  for (let i = 0; i < 4; i++) stakers.push(await chain.account());
  keeperKey = generatePrivateKey();
  await chain.fundedAccount(keeperKey);
  core = await deployCore(chain, deployer, stakers);

  bookFactory = await chain.deploy(deployer, "hunchBookFactory", [core.factory]);
  marginAccount = getAddress(
    await chain.read<Address>(bookFactory, abiOf("hunchBookFactory"), "marginAccount"),
  );
  const bookImplementation = getAddress(
    await chain.read<Address>(bookFactory, abiOf("hunchBookFactory"), "implementation"),
  );
  graduator = await chain.deploy(deployer, "graduator", [
    core.factory,
    bookFactory,
    marginAccount,
    core.usdc,
    true,
    BOOK_PARAMS,
  ]);
  await chain.send(deployer, core.factory, abiOf("factory"), "setGraduator", [graduator]);

  const head = await chain.client.getBlockNumber();
  const now = (await chain.client.getBlock()).timestamp;
  // Meets the rule: 5 stakers, 85 USDC, 25 / 85 on YES.
  market = await createMarket(
    chain,
    core,
    deployer,
    windowParams(head + 400n, head + 450n, now + 86_400n),
    Side.Yes,
    5n * USDC,
  );
  for (const [i, s] of stakers.entries()) {
    await chain.send(s, market, marketAbi as Abi, "stake", [i < 1 ? Side.Yes : Side.No, 20n * USDC]);
  }

  const wallets = { maker: testnet.wallets.maker, keeper: privateKeyToAccount(keeperKey).address };
  const { factory, vault, usdc, deployBlock } = core;
  deployment = {
    ...testnet,
    wallets,
    // No primary stack on this chain: the hunch stack is the only one, and the default.
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
}, 120_000);

afterAll(() => {
  setLogSink((line) => console.log(line));
  chain?.stop();
});

describe("graduation on Hunch Book's own order book", () => {
  it("builds the hunch keeper on the stack's own view: Kuru's addresses are the venue's", (ctx) => {
    if (!chain) return ctx.skip();
    const [keeper, ...rest] = buildKeepers(parseConfig({ KEEPER_RPC_URL: chain.url }), deployment);
    expect(rest).toHaveLength(0);
    expect(keeper?.stackName).toBe("hunch");
    expect(keeper?.venue).toBe("hunch");
    expect(keeper?.deployment.external.kuru).toEqual({ router: bookFactory, marginAccount });
  });

  it("graduates in one transaction: graduate() creates the book, nothing asks Kuru", async (ctx) => {
    if (!chain) return ctx.skip();
    // Kuru's real testnet router has no code here: any read of it would fail the cycle.
    expect(await c().client.getCode({ address: testnet.external.kuru.router })).toBeUndefined();
    const config = parseConfig({
      KEEPER_ENABLED: "1",
      KEEPER_PRIVATE_KEY: keeperKey,
      KEEPER_RPC_URL: chain.url,
      KEEPER_RPC_RPS: "200",
      KEEPER_STATE_FILE: join(dir, "state.json"),
      KEEPER_HEALTH_FILE: join(dir, "health.json"),
      KEEPER_MAX_GAS_PRICE_GWEI: "10000",
    });
    const [keeper] = buildKeepers(config, deployment);
    if (!keeper) throw new Error("no keeper");
    lines.length = 0;
    await keeper.cycle();

    expect(events("plan").find((l) => l.market === market && l.job === "graduate")).toMatchObject({
      action: "graduate",
      reason: "rule met; the graduator creates the Hunch order book in the same transaction",
    });
    expect(events("tx").find((l) => l.action === "graduate")).toMatchObject({ market, status: "success" });
    expect(events("book-request")).toEqual([]);
    expect(events("tx").filter((l) => l.action === "registerBook")).toEqual([]);
    expect(events("job-error")).toEqual([]);

    expect(await c().readMarket<number>(market, "phase")).toBe(Phase.Graduated);
    const book = getAddress(await c().readMarket<Address>(market, "book"));
    expect(isAddressEqual(book, zeroAddress)).toBe(false);
    // The book is one of the venue's: its own market and margin account, verified there, and live.
    expect(getAddress(await c().read<Address>(book, abiOf("hunchOrderBook"), "market"))).toBe(market);
    expect(getAddress(await c().read<Address>(book, abiOf("hunchOrderBook"), "marginAccount"))).toBe(
      marginAccount,
    );
    expect(
      await c().read<boolean>(marginAccount, abiOf("hunchMarginAccount"), "verifiedMarket", [book]),
    ).toBe(true);
    expect(await c().read<number>(book, kuruOrderBookAbi as Abi, "marketState")).toBe(0);
    expect(getAddress(await c().read<Address>(graduator, abiOf("graduator"), "bookOf", [market]))).toBe(book);

    const health = JSON.parse(readFileSync(join(dir, "health.hunch.json"), "utf8")) as HealthSnapshot;
    expect(health).toMatchObject({ stack: "hunch", kuruVersion: 1, venue: "hunch" });
    expect(health.jobs.graduate.lastAction).toMatchObject({ market, action: "graduate", status: "success" });
  });
});

// A seeded series on the hunch stack, end to end: the keeper creates the period's market with its first
// stake, stakes for our other wallets right after (minting the test USDC it lacks from the TestUSDC
// faucet), graduates the pool once the rule holds, and pushes every staker's tokens, so the maker
// receives its NO as inventory. The rule here is the core's test rule (50 USDC from 4 stakers).
describe("a seeded series on the hunch stack", () => {
  const OTHER = getAddress("0x00000000000000000000000000000000000000c1");
  let maker: Address;
  let seriesDeployment: Deployment;
  let seriesFile: string;

  beforeAll(async () => {
    if (!chain) return;
    maker = privateKeyToAccount(generatePrivateKey()).address;
    // Template 1 needs Perpl's perp info (its funding scaling exponent). Perp id 1 also makes the test
    // MockResolver read the params as a block-clock window: lock, close, then the settlement deadline.
    const perpl = await chain.deploy(deployer, "mockPerpl");
    await chain.send(deployer, perpl, abiOf("mockPerpl"), "listPerp", [1n, "BTC Perp", "BTC", 1n, 0n, 1n]);
    const head = await chain.client.getBlockNumber();
    const now = (await chain.client.getBlock()).timestamp;
    const hunch = deployment.stacks?.hunch;
    seriesDeployment = {
      ...deployment,
      wallets: { ...deployment.wallets, maker },
      stacks: { hunch: { ...hunch, guardian: deployer.address } },
      external: { ...deployment.external, perpl: { exchange: perpl, perps: { BTC: 1 } } },
    };
    seriesFile = join(dir, "series.json");
    writeFileSync(
      seriesFile,
      JSON.stringify({
        series: [
          {
            id: "btc-seeded",
            template: 1,
            asset: "BTC",
            schedule: {
              anchorBlock: Number(head + 200n),
              everyBlocks: 100_000,
              windowBlocks: 50,
              createBeforeLockBlocks: 1_000,
              minLeadBlocks: 10,
            },
            strike: { rule: "fixed", value: String(now + 30n * 86_400n) },
            firstStake: { side: "yes", usdc: "25" },
            seed: {
              stakes: [
                { for: "maker", side: "no", usdc: "15" },
                { for: "guardian", side: "no", usdc: "10" },
                { for: OTHER, side: "yes", usdc: "5" },
              ],
            },
          },
        ],
      }),
    );
  });

  it("creates, seeds, graduates and pushes the maker its tokens", async (ctx) => {
    if (!chain) return ctx.skip();
    const config = parseConfig({
      KEEPER_ENABLED: "1",
      KEEPER_PRIVATE_KEY: keeperKey,
      KEEPER_RPC_URL: chain.url,
      KEEPER_RPC_RPS: "200",
      KEEPER_STATE_FILE: join(dir, "series-state.json"),
      KEEPER_HEALTH_FILE: join(dir, "series-health.json"),
      KEEPER_MAX_GAS_PRICE_GWEI: "10000",
      KEEPER_SERIES_FILE: seriesFile,
      KEEPER_SERIES_ENABLED: "1",
    });
    const [keeper] = buildKeepers(config, seriesDeployment);
    if (!keeper) throw new Error("no keeper");
    const keeperAddress = keeper.keeper;
    expect(await c().balance(core.usdc, keeperAddress)).toBe(0n);

    // Cycle 1: mint 55 test USDC (the keeper held none), approve once, create, seed three holders.
    lines.length = 0;
    await keeper.cycle();
    const txs = events("tx").map((l) => [l.action, l.status]);
    expect(txs).toEqual([
      ["mintTestUsdc", "success"],
      ["approveFirstStake", "success"],
      ["createMarket", "success"],
      ["seedStake", "success"],
      ["seedStake", "success"],
      ["seedStake", "success"],
    ]);
    const seeded = events("series-seed");
    expect(seeded.map((l) => [l.for, l.address, l.side, l.usdc, l.ours])).toEqual([
      ["maker", maker, "no", "15", true],
      ["guardian", deployer.address, "no", "10", true],
      [OTHER, OTHER, "yes", "5", true],
    ]);
    const created = getAddress(events("series-created")[0]?.market as Address);
    expect(await c().readMarket<[bigint, bigint, number]>(created, "poolTotals")).toEqual([
      30n * USDC,
      25n * USDC,
      4,
    ]);
    expect(await c().readMarket<boolean>(created, "graduationRuleMet")).toBe(true);
    expect(await c().balance(core.usdc, keeperAddress)).toBe(0n);

    // Cycle 2: the graduate job sees the rule met and graduates into a new Hunch order book.
    lines.length = 0;
    await keeper.cycle();
    expect(events("tx").find((l) => l.action === "graduate")).toMatchObject({
      market: created,
      status: "success",
    });
    expect(events("tx").filter((l) => l.action === "seedStake")).toEqual([]);
    expect(await c().readMarket<number>(created, "phase")).toBe(Phase.Graduated);
    const book = getAddress(await c().readMarket<Address>(created, "book"));
    expect(getAddress(await c().read<Address>(book, abiOf("hunchOrderBook"), "market"))).toBe(created);

    // Cycle 3 (log scans stay 10 blocks behind the head): every staker's tokens are pushed; the maker
    // holds its NO as inventory.
    await c().test.mine({ blocks: 20 });
    lines.length = 0;
    await keeper.cycle();
    expect(events("tx").some((l) => l.action === "claimTokensFor" && l.status === "success")).toBe(true);
    const [, no] = await c().readMarket<[Address, Address]>(created, "tokens");
    // 15 of the 25 USDC on NO, of a 55 USDC pool: 15 * 55 / 25 = 33 NO.
    expect(await c().read<bigint>(no, erc20Abi as Abi, "balanceOf", [maker])).toBe(33n * USDC);

    // The health record names the seed, every stake ours.
    const health = JSON.parse(readFileSync(join(dir, "series-health.hunch.json"), "utf8")) as HealthSnapshot;
    const info = health.jobs.series.info as { series: { seed?: { status: string }[] }[] };
    expect(info.series[0]?.seed?.map((s) => s.status)).toEqual(["staked", "staked", "staked"]);
  });
});

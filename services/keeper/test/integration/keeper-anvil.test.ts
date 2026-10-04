import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Deployment,
  deployments,
  encodePerplFundingParams,
  marketAbi,
  monadTestnet,
  Outcome,
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
  erc20Abi,
  getAddress,
  type Hex,
  http,
  keccak256,
  type PrivateKeyAccount,
  type PublicClient,
  parseEther,
  type TestClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseConfig } from "../../src/config.js";
import type { HealthSnapshot } from "../../src/health.js";
import { Keeper } from "../../src/keeper.js";
import { setLogSink } from "../../src/log.js";
import type { KeeperState } from "../../src/state.js";
import { type Anvil, type Artifact, artifact, startAnvil } from "./anvil.js";
import { MULTICALL3_ADDRESS, MULTICALL3_CODEHASH, MULTICALL3_RUNTIME } from "./multicall3.js";

// The keeper's whole loop against Hunch Book's real core contracts (factory, vault, market, outcome
// tokens) on a local anvil chain: graduate a pool, push every staker's tokens with claimTokensFor,
// back off while the resolver has no answer, settle once it has one, push pool payouts with
// claimPoolFor, and void a market whose settlement deadline passed.
//
// Two stand-ins come from the contracts' own test mocks: MockGraduator (gives each market a
// placeholder book instead of creating one on Kuru) and MockResolver (answers whatever the test sets,
// standing in for "what the source says"). MockResolver decodes params as a Window, and the keeper
// decodes template 1 params as PerplFundingParams. The test's params satisfy both at once: perpId 1
// reads as blockClock = true, startBlock and endBlock as lock and close, and threshold as the
// settlement deadline. So the keeper runs its real Perpl settler (evidence 0x once block > endBlock).
//
// Skips (does not fail) when anvil is missing or contracts/out has not been built.

const testnet = deployments["monad-testnet"];
const USDC = 1_000_000n;
const ARTIFACTS = {
  usdc: artifact("TestUSDC.sol", "TestUSDC"),
  market: artifact("Market.sol", "Market"),
  factory: artifact("HunchBookFactory.sol", "HunchBookFactory"),
  graduator: artifact("MockGraduator.sol", "MockGraduator"),
  resolver: artifact("MockResolver.sol", "MockResolver"),
};
const built = Object.values(ARTIFACTS).every((a) => a !== null);
if (!built)
  console.warn(
    "contracts/out is missing: run `forge build` in contracts/ to run the keeper integration tests",
  );
const art = (name: keyof typeof ARTIFACTS) => ARTIFACTS[name] as Artifact;

const lines: Record<string, unknown>[] = [];
/** Every transaction line, never cleared. */
const sent: Record<string, unknown>[] = [];
let anvil: Anvil | null = null;
let client: PublicClient;
let test: TestClient;
let deployer: PrivateKeyAccount;
let stakers: PrivateKeyAccount[] = [];
let usdc: Address;
let vault: Address;
let factory: Address;
let resolver: Address;
let deployment: Deployment;
let keeperKey: Hex;
let dir: string;
const markets: Record<"a" | "b" | "c", Address> = { a: "0x", b: "0x", c: "0x" } as Record<
  "a" | "b" | "c",
  Address
>;

async function send(
  from: PrivateKeyAccount,
  address: Address,
  abi: Abi,
  functionName: string,
  args: unknown[] = [],
): Promise<void> {
  const wallet = createWalletClient({ account: from, chain: monadTestnet, transport: http(anvil?.url) });
  const hash = await wallet.writeContract({
    address,
    abi,
    functionName,
    args,
    chain: monadTestnet,
    account: from,
  });
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${functionName} reverted`);
}

async function deploy(name: keyof typeof ARTIFACTS, args: unknown[] = []): Promise<Address> {
  const a = art(name);
  const wallet = createWalletClient({ account: deployer, chain: monadTestnet, transport: http(anvil?.url) });
  const hash = await wallet.deployContract({
    abi: a.abi,
    bytecode: a.bytecode,
    args,
    chain: monadTestnet,
    account: deployer,
  });
  const receipt = await client.waitForTransactionReceipt({ hash });
  return getAddress(receipt.contractAddress as Address);
}

const read = <T>(address: Address, functionName: string, args: unknown[] = []): Promise<T> =>
  client.readContract({ address, abi: marketAbi, functionName, args } as never) as Promise<T>;

const balance = (token: Address, who: Address): Promise<bigint> =>
  client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [who] });

/** Template 1 params that MockResolver also reads as Window(blockClock = true, lock, close, deadline). */
function params(lock: bigint, close: bigint, deadline: bigint): Hex {
  return encodePerplFundingParams({
    perpId: 1n,
    startBlock: lock,
    endBlock: close,
    threshold: deadline,
    expectedScalingExp: 0,
  });
}

function makeKeeper(enabled: boolean): Keeper {
  const config = parseConfig({
    KEEPER_ENABLED: enabled ? "1" : "0",
    KEEPER_PRIVATE_KEY: enabled ? keeperKey : undefined,
    KEEPER_RPC_URL: anvil?.url,
    KEEPER_RPC_RPS: "200",
    KEEPER_STATE_FILE: join(dir, enabled ? "state.json" : "dry-state.json"),
    KEEPER_HEALTH_FILE: join(dir, enabled ? "health.json" : "dry-health.json"),
    KEEPER_MAX_GAS_PRICE_GWEI: "10000",
    KEEPER_SETTLE_RETRY_SECONDS: "1",
    KEEPER_SETTLE_RETRY_MAX_SECONDS: "1",
    KEEPER_CLAIM_BATCH: "3",
  });
  return new Keeper(config, deployment);
}

const events = (event: string) => lines.filter((l) => l.event === event);
const health = (): HealthSnapshot => JSON.parse(readFileSync(join(dir, "health.json"), "utf8"));

beforeAll(async () => {
  if (!built) return;
  // viem only reads through Multicall3 at blocks after the one where Monad testnet's copy was created.
  anvil = await startAnvil(testnet.chainId, (monadTestnet.contracts?.multicall3?.blockCreated ?? 0) + 1);
  if (!anvil) return;
  setLogSink((line) => {
    const entry = JSON.parse(line);
    lines.push(entry);
    if (entry.event === "tx") sent.push(entry);
  });
  dir = mkdtempSync(join(tmpdir(), "keeper-it-"));
  const transport = http(anvil.url);
  client = createPublicClient({ chain: monadTestnet, transport }) as PublicClient;
  test = createTestClient({ mode: "anvil", chain: monadTestnet, transport });
  await test.setCode({ address: MULTICALL3_ADDRESS, bytecode: MULTICALL3_RUNTIME });

  deployer = privateKeyToAccount(generatePrivateKey());
  stakers = Array.from({ length: 5 }, () => privateKeyToAccount(generatePrivateKey()));
  keeperKey = generatePrivateKey();
  for (const a of [deployer, ...stakers, privateKeyToAccount(keeperKey)]) {
    await test.setBalance({ address: a.address, value: parseEther("100") });
  }

  const deployBlock = Number(await client.getBlockNumber());
  usdc = await deploy("usdc");
  const implementation = await deploy("market");
  const caps = {
    poolCap: 5_000n * USDC,
    walletCap: 1_000n * USDC,
    minStake: USDC,
    creatorMinStake: 5n * USDC,
  };
  // The fee recipient receives the token rounding dust; it is its own address so balances stay exact.
  const feeRecipient = privateKeyToAccount(generatePrivateKey()).address;
  factory = await deploy("factory", [
    usdc,
    implementation,
    deployer.address,
    feeRecipient,
    caps,
    50_000n * USDC,
  ]);
  vault = getAddress(
    (await client.readContract({
      address: factory,
      abi: art("factory").abi,
      functionName: "vault",
    })) as Address,
  );
  const graduator = await deploy("graduator");
  resolver = await deploy("resolver");
  await send(deployer, factory, art("factory").abi, "setGraduator", [graduator]);
  const rule = { minPool: 50n * USDC, minStakers: 4, minChanceBps: 300, maxChanceBps: 9_700 };
  await send(deployer, factory, art("factory").abi, "addTemplate", [TemplateId.PerplFunding, resolver, rule]);

  for (const a of [deployer, ...stakers]) {
    await send(a, usdc, art("usdc").abi, "mint", [a.address, 1_000n * USDC]);
    await send(a, usdc, erc20Abi as Abi, "approve", [vault, 2n ** 255n]);
  }

  const head = await client.getBlockNumber();
  const now = (await client.getBlock()).timestamp;
  const create = async (p: Hex, side: number, stake: bigint) => {
    await send(deployer, factory, art("factory").abi, "createMarket", [
      TemplateId.PerplFunding,
      p,
      side,
      stake,
    ]);
    const count = (await client.readContract({
      address: factory,
      abi: art("factory").abi,
      functionName: "marketCount",
    })) as bigint;
    return getAddress(
      (await client.readContract({
        address: factory,
        abi: art("factory").abi,
        functionName: "marketAt",
        args: [count - 1n],
      })) as Address,
    );
  };
  // A: meets the rule (5 stakers, 75 USDC, 60% YES); graduates.
  markets.a = await create(params(head + 400n, head + 450n, now + 30n * 86_400n), Side.Yes, 5n * USDC);
  for (const [i, s] of stakers.slice(0, 4).entries()) {
    await send(s, markets.a, marketAbi as Abi, "stake", [
      i < 2 ? Side.Yes : Side.No,
      i < 2 ? 20n * USDC : 15n * USDC,
    ]);
  }
  // B: two stakers, stays a pool, settles as a pool.
  markets.b = await create(params(head + 401n, head + 451n, now + 30n * 86_400n), Side.Yes, 5n * USDC);
  await send(stakers[4] as PrivateKeyAccount, markets.b, marketAbi as Abi, "stake", [Side.No, 3n * USDC]);
  // C: a pool whose settlement deadline passes before the resolver answers; voids.
  markets.c = await create(params(head + 402n, head + 452n, now + 7_200n), Side.No, 6n * USDC);
  await send(stakers[4] as PrivateKeyAccount, markets.c, marketAbi as Abi, "stake", [Side.Yes, 2n * USDC]);

  const wallets = { maker: testnet.wallets.maker, keeper: privateKeyToAccount(keeperKey).address };
  deployment = { ...testnet, wallets, hunchBook: { factory, vault, usdc, graduator, deployBlock } };
}, 120_000);

afterAll(() => {
  setLogSink((line) => console.log(line));
  // Gas used per keeper transaction on this chain, for the README's gas table.
  if (sent.length)
    console.info(JSON.stringify(sent.map((t) => ({ action: t.action, users: t.users, gasUsed: t.gasUsed }))));
  anvil?.stop();
});

describe("the keeper against Hunch Book's core contracts on anvil", () => {
  it("runs on a chain that has the real Multicall3 code", async (ctx) => {
    if (!anvil) return ctx.skip();
    const code = await client.getCode({ address: MULTICALL3_ADDRESS });
    expect(keccak256(code as Hex)).toBe(MULTICALL3_CODEHASH);
  });

  it("dry run: plans and simulates the graduation, sends nothing", async (ctx) => {
    if (!anvil) return ctx.skip();
    const dry = makeKeeper(false);
    dry.verbosePlan = true;
    const nonce = await client.getTransactionCount({ address: dry.keeper });
    await dry.cycle();
    const plan = events("plan").find((l) => l.market === markets.a && l.job === "graduate");
    expect(plan).toMatchObject({ action: "graduate", phase: "Pool" });
    expect(events("plan").find((l) => l.market === markets.b && l.job === "graduate")?.reason).toMatch(
      /rule not met: pool 8 of 50 USDC; 2 of 4 stakers/,
    );
    expect(events("dry-run").find((l) => l.action === "graduate")).toMatchObject({
      market: markets.a,
      simulation: "ok",
    });
    expect(await read<number>(markets.a, "phase")).toBe(Phase.Pool);
    expect(await client.getTransactionCount({ address: dry.keeper })).toBe(nonce);
  });

  let keeper: Keeper;

  it("graduates the pool that meets its rule", async (ctx) => {
    if (!anvil) return ctx.skip();
    keeper = makeKeeper(true);
    lines.length = 0;
    await keeper.cycle();
    expect(events("tx").find((l) => l.action === "graduate")).toMatchObject({
      market: markets.a,
      status: "success",
    });
    expect(await read<number>(markets.a, "phase")).toBe(Phase.Graduated);
    expect(health().jobs.graduate.lastAction).toMatchObject({ market: markets.a, status: "success" });
  });

  it("finds every staker from the logs and pushes their tokens in batches", async (ctx) => {
    if (!anvil) return ctx.skip();
    lines.length = 0;
    await keeper.cycle();
    const claims = events("tx").filter((l) => l.action === "claimTokensFor");
    // Five stakers (creator + 4) in batches of 3.
    expect(claims.map((l) => [l.status, l.users])).toEqual([
      ["success", 3],
      ["success", 2],
    ]);
    const [yes, no] = await read<[Address, Address]>(markets.a, "tokens");
    expect(await balance(yes, markets.a)).toBe(0n);
    expect(await balance(no, markets.a)).toBe(0n);
    // 75 USDC pool, 45 on YES: the creator's 5 USDC of YES is worth 5 * 75 / 45 YES tokens.
    expect(await balance(yes, deployer.address)).toBe((5n * USDC * 75n) / 45n);
    expect(await balance(no, (stakers[2] as PrivateKeyAccount).address)).toBe((15n * USDC * 75n) / 30n);

    const state = JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) as KeeperState;
    const a = state.markets[markets.a];
    expect(a?.createdBlock).toBeGreaterThan(0);
    expect(a?.stakers).toHaveLength(5);
    expect(a?.stakerCursor).toBeGreaterThan(a?.stakingClosedAt ?? Number.POSITIVE_INFINITY);
    expect(state.factoryCursor).toBeGreaterThan(0);
  });

  it("backs off while the resolver has no answer", async (ctx) => {
    if (!anvil) return ctx.skip();
    await test.mine({ blocks: 500 });
    lines.length = 0;
    await keeper.cycle();
    const skipped = events("tx-skipped").filter((l) => l.action === "settle");
    expect(skipped.map((l) => l.market).sort()).toEqual([markets.a, markets.b, markets.c].sort());
    expect(skipped.every((l) => String(l.reason).includes("NotResolved"))).toBe(true);
    expect(events("settle-later").length).toBe(3);
    expect(await read<number>(markets.a, "outcome")).toBe(Outcome.Unresolved);
  });

  it("settles once the resolver answers, and voids the market past its deadline", async (ctx) => {
    if (!anvil) return ctx.skip();
    await test.increaseTime({ seconds: 3 * 3_600 });
    await test.mine({ blocks: 1 });
    await send(deployer, resolver, art("resolver").abi, "setAnswer", [Outcome.Yes]);
    await new Promise((r) => setTimeout(r, 1_100)); // past the 1 s retry wait
    lines.length = 0;
    await keeper.cycle();
    const settles = events("tx").filter((l) => l.action === "settle");
    expect(settles.map((l) => l.market).sort()).toEqual([markets.a, markets.b].sort());
    expect(settles.every((l) => l.status === "success" && l.settler === "perpl-funding")).toBe(true);
    expect(events("tx").find((l) => l.action === "voidIfExpired")).toMatchObject({
      market: markets.c,
      status: "success",
    });
    expect(await read<number>(markets.a, "phase")).toBe(Phase.Settled);
    expect(await read<number>(markets.a, "outcome")).toBe(Outcome.Yes);
    expect(await read<number>(markets.b, "outcome")).toBe(Outcome.Yes);
    expect(await read<number>(markets.c, "phase")).toBe(Phase.Voided);
    expect(health().jobs.settle.lastAction?.url).toMatch(/\/tx\/0x[0-9a-f]{64}$/);
  });

  it("pushes pool payouts to winners and refunds after the void", async (ctx) => {
    if (!anvil) return ctx.skip();
    const staker = (stakers[4] as PrivateKeyAccount).address;
    const before = { creator: await balance(usdc, deployer.address), staker: await balance(usdc, staker) };
    lines.length = 0;
    await keeper.cycle();
    // A (graduated, settled, every token claimed) has nothing left: done in this cycle.
    expect(events("market-done").map((l) => l.market)).toEqual([markets.a]);
    const pays = events("tx").filter((l) => l.action === "claimPoolFor");
    expect(pays.map((l) => l.market).sort()).toEqual([markets.b, markets.c].sort());
    // B settled YES: the creator (5 YES) wins the 3 NO, less the 2% fee on winnings (rounded up).
    const fee = (3n * USDC * 200n + 9_999n) / 10_000n;
    // C voided: everyone gets their stake back (creator 6, staker 2).
    expect((await balance(usdc, deployer.address)) - before.creator).toBe(
      5n * USDC + 3n * USDC - fee + 6n * USDC,
    );
    expect((await balance(usdc, staker)) - before.staker).toBe(2n * USDC);

    // B and C have nothing left either once the payouts are out. Done markets are not read again.
    lines.length = 0;
    await keeper.cycle();
    expect(
      events("market-done")
        .map((l) => l.market)
        .sort(),
    ).toEqual([markets.b, markets.c].sort());
    lines.length = 0;
    const summary = await keeper.cycle();
    expect(summary.markets).toBe(0);
    expect(health().markets).toMatchObject({ total: 3, done: 3 });
  });
});

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Deployment, marketAbi, Outcome, Phase, Side } from "@hunch-book/shared";
import { type Abi, type Address, type Hex, keccak256, type PrivateKeyAccount } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseConfig } from "../../src/config.js";
import type { HealthSnapshot } from "../../src/health.js";
import { Keeper } from "../../src/keeper.js";
import { setLogSink } from "../../src/log.js";
import type { KeeperState } from "../../src/state.js";
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
import { MULTICALL3_ADDRESS, MULTICALL3_CODEHASH } from "./multicall3.js";

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

const lines: Record<string, unknown>[] = [];
/** Every transaction line, never cleared. */
const sent: Record<string, unknown>[] = [];
let chain: LocalChain | null = null;
let deployer: PrivateKeyAccount;
let stakers: PrivateKeyAccount[] = [];
let core: Core;
let deployment: Deployment;
let keeperKey: Hex;
let dir: string;
const markets = {} as Record<"a" | "b" | "c", Address>;

function makeKeeper(enabled: boolean): Keeper {
  const config = parseConfig({
    KEEPER_ENABLED: enabled ? "1" : "0",
    KEEPER_PRIVATE_KEY: enabled ? keeperKey : undefined,
    KEEPER_RPC_URL: chain?.url,
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
const c = () => chain as LocalChain;

beforeAll(async () => {
  chain = await LocalChain.start();
  if (!chain) return;
  setLogSink((line) => {
    const entry = JSON.parse(line);
    lines.push(entry);
    if (entry.event === "tx") sent.push(entry);
  });
  dir = mkdtempSync(join(tmpdir(), "keeper-it-"));
  deployer = await chain.account();
  stakers = [];
  for (let i = 0; i < 5; i++) stakers.push(await chain.account());
  keeperKey = generatePrivateKey();
  await chain.fundedAccount(keeperKey);

  core = await deployCore(chain, deployer, stakers);
  const graduator = await chain.deploy(deployer, "mockGraduator");
  await chain.send(deployer, core.factory, abiOf("factory"), "setGraduator", [graduator]);

  const head = await chain.client.getBlockNumber();
  const now = (await chain.client.getBlock()).timestamp;
  const stake = (who: PrivateKeyAccount, market: Address, side: number, amount: bigint) =>
    c().send(who, market, marketAbi as Abi, "stake", [side, amount]);
  // A: meets the rule (5 stakers, 75 USDC, 60% YES); graduates.
  markets.a = await createMarket(
    chain,
    core,
    deployer,
    windowParams(head + 400n, head + 450n, now + 30n * 86_400n),
    Side.Yes,
    5n * USDC,
  );
  for (const [i, s] of stakers.slice(0, 4).entries()) {
    await stake(s, markets.a, i < 2 ? Side.Yes : Side.No, i < 2 ? 20n * USDC : 15n * USDC);
  }
  // B: two stakers, stays a pool, settles as a pool.
  markets.b = await createMarket(
    chain,
    core,
    deployer,
    windowParams(head + 401n, head + 451n, now + 30n * 86_400n),
    Side.Yes,
    5n * USDC,
  );
  await stake(stakers[4] as PrivateKeyAccount, markets.b, Side.No, 3n * USDC);
  // C: a pool whose settlement deadline passes before the resolver answers; voids.
  markets.c = await createMarket(
    chain,
    core,
    deployer,
    windowParams(head + 402n, head + 452n, now + 7_200n),
    Side.No,
    6n * USDC,
  );
  await stake(stakers[4] as PrivateKeyAccount, markets.c, Side.Yes, 2n * USDC);

  const wallets = { maker: testnet.wallets.maker, keeper: privateKeyToAccount(keeperKey).address };
  const { factory, vault, usdc, deployBlock } = core;
  deployment = { ...testnet, wallets, hunchBook: { factory, vault, usdc, graduator, deployBlock } };
}, 120_000);

afterAll(() => {
  setLogSink((line) => console.log(line));
  // Gas used per keeper transaction on this chain, for the README's gas table.
  if (sent.length) {
    console.info(JSON.stringify(sent.map((t) => ({ action: t.action, users: t.users, gasUsed: t.gasUsed }))));
  }
  chain?.stop();
});

describe("the keeper against Hunch Book's core contracts on anvil", () => {
  it("runs on a chain that has the real Multicall3 code", async (ctx) => {
    if (!chain) return ctx.skip();
    const code = await chain.client.getCode({ address: MULTICALL3_ADDRESS });
    expect(keccak256(code as Hex)).toBe(MULTICALL3_CODEHASH);
  });

  it("dry run: plans and simulates the graduation, sends nothing", async (ctx) => {
    if (!chain) return ctx.skip();
    const dry = makeKeeper(false);
    dry.verbosePlan = true;
    const nonce = await chain.client.getTransactionCount({ address: dry.keeper });
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
    expect(await chain.readMarket<number>(markets.a, "phase")).toBe(Phase.Pool);
    expect(await chain.client.getTransactionCount({ address: dry.keeper })).toBe(nonce);
  });

  let keeper: Keeper;

  it("graduates the pool that meets its rule", async (ctx) => {
    if (!chain) return ctx.skip();
    keeper = makeKeeper(true);
    lines.length = 0;
    await keeper.cycle();
    expect(events("tx").find((l) => l.action === "graduate")).toMatchObject({
      market: markets.a,
      status: "success",
    });
    expect(await chain.readMarket<number>(markets.a, "phase")).toBe(Phase.Graduated);
    expect(health().jobs.graduate.lastAction).toMatchObject({ market: markets.a, status: "success" });
  });

  it("finds every staker from the logs and pushes their tokens in batches", async (ctx) => {
    if (!chain) return ctx.skip();
    lines.length = 0;
    await keeper.cycle();
    const claims = events("tx").filter((l) => l.action === "claimTokensFor");
    // Five stakers (creator + 4) in batches of 3.
    expect(claims.map((l) => [l.status, l.users])).toEqual([
      ["success", 3],
      ["success", 2],
    ]);
    const [yes, no] = await chain.readMarket<[Address, Address]>(markets.a, "tokens");
    expect(await chain.balance(yes, markets.a)).toBe(0n);
    expect(await chain.balance(no, markets.a)).toBe(0n);
    // 75 USDC pool, 45 on YES: the creator's 5 USDC of YES is worth 5 * 75 / 45 YES tokens.
    expect(await chain.balance(yes, deployer.address)).toBe((5n * USDC * 75n) / 45n);
    expect(await chain.balance(no, (stakers[2] as PrivateKeyAccount).address)).toBe((15n * USDC * 75n) / 30n);

    const state = JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) as KeeperState;
    const a = state.markets[markets.a];
    expect(a?.createdBlock).toBeGreaterThan(0);
    expect(a?.stakers).toHaveLength(5);
    expect(a?.stakerCursor).toBeGreaterThan(a?.stakingClosedAt ?? Number.POSITIVE_INFINITY);
    expect(state.factoryCursor).toBeGreaterThan(0);
  });

  it("backs off while the resolver has no answer", async (ctx) => {
    if (!chain) return ctx.skip();
    await chain.test.mine({ blocks: 500 });
    lines.length = 0;
    await keeper.cycle();
    const skipped = events("tx-skipped").filter((l) => l.action === "settle");
    expect(skipped.map((l) => l.market).sort()).toEqual([markets.a, markets.b, markets.c].sort());
    expect(skipped.every((l) => String(l.reason).includes("NotResolved"))).toBe(true);
    expect(events("settle-later").length).toBe(3);
    expect(await chain.readMarket<number>(markets.a, "outcome")).toBe(Outcome.Unresolved);
  });

  it("settles once the resolver answers, and voids the market past its deadline", async (ctx) => {
    if (!chain) return ctx.skip();
    await chain.test.increaseTime({ seconds: 3 * 3_600 });
    await chain.test.mine({ blocks: 1 });
    await chain.send(deployer, core.resolver, abiOf("mockResolver"), "setAnswer", [Outcome.Yes]);
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
    expect(await chain.readMarket<number>(markets.a, "phase")).toBe(Phase.Settled);
    expect(await chain.readMarket<number>(markets.a, "outcome")).toBe(Outcome.Yes);
    expect(await chain.readMarket<number>(markets.b, "outcome")).toBe(Outcome.Yes);
    expect(await chain.readMarket<number>(markets.c, "phase")).toBe(Phase.Voided);
    expect(health().jobs.settle.lastAction?.url).toMatch(/\/tx\/0x[0-9a-f]{64}$/);
  });

  it("pushes pool payouts to winners and refunds after the void", async (ctx) => {
    if (!chain) return ctx.skip();
    const staker = (stakers[4] as PrivateKeyAccount).address;
    const before = {
      creator: await chain.balance(core.usdc, deployer.address),
      staker: await chain.balance(core.usdc, staker),
    };
    lines.length = 0;
    await keeper.cycle();
    // A (graduated, settled, every token claimed) has nothing left: done in this cycle.
    expect(events("market-done").map((l) => l.market)).toEqual([markets.a]);
    const pays = events("tx").filter((l) => l.action === "claimPoolFor");
    expect(pays.map((l) => l.market).sort()).toEqual([markets.b, markets.c].sort());
    // B settled YES: the creator (5 YES) wins the 3 NO, less the 2% fee on winnings (rounded up).
    const fee = (3n * USDC * 200n + 9_999n) / 10_000n;
    // C voided: everyone gets their stake back (creator 6, staker 2).
    expect((await chain.balance(core.usdc, deployer.address)) - before.creator).toBe(
      5n * USDC + 3n * USDC - fee + 6n * USDC,
    );
    expect((await chain.balance(core.usdc, staker)) - before.staker).toBe(2n * USDC);

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

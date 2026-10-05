import { collateralVaultAbi, encodePerplFundingParams, Outcome, Phase, Side } from "@hunch-book/shared";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { beforeEach, describe, expect, it } from "vitest";
import {
  atomicSupported,
  collectAll,
  collectCalls,
  HunchError,
  type MarketInfo,
  type Position,
  planCollect,
  sendCalls,
} from "../src/index.js";
import { FakeChain } from "./fake-chain.js";
import {
  addr,
  blockWindow,
  type FakeMarket,
  Ledger,
  registerFactory,
  registerMarket,
  registerToken,
  USDC,
  VAULT,
} from "./fixtures.js";

const key = generatePrivateKey();
const me = privateKeyToAccount(key).address;
const CHAIN_HEX = "0x279f"; // 10143, Monad testnet

const settledYes: FakeMarket = {
  address: addr(0x201),
  id: 1,
  templateId: 1,
  params: encodePerplFundingParams({
    perpId: 16n,
    startBlock: 500n,
    endBlock: 900n,
    threshold: 0n,
    expectedScalingExp: 2,
  }),
  phase: Phase.Settled,
  outcome: Outcome.Yes,
  graduated: true,
  book: addr(0x3001),
  tokens: { yes: addr(0x2011), no: addr(0x2012) },
  window: blockWindow(500n, 900n, 1_900_000_000n),
  resolver: addr(0xaa),
};
const voided: FakeMarket = {
  ...settledYes,
  address: addr(0x202),
  id: 2,
  phase: Phase.Voided,
  outcome: Outcome.Unresolved,
  tokens: { yes: addr(0x2021), no: addr(0x2022) },
};
const poolSettled: FakeMarket = {
  ...settledYes,
  address: addr(0x203),
  id: 3,
  graduated: false,
  book: undefined,
  tokens: { yes: addr(0x2031), no: addr(0x2032) },
};
const open: FakeMarket = {
  ...settledYes,
  address: addr(0x204),
  id: 4,
  phase: Phase.Graduated,
  tokens: { yes: addr(0x2041), no: addr(0x2042) },
};

let chain: FakeChain;
let ledger: Ledger;

beforeEach(() => {
  chain = new FakeChain();
  ledger = new Ledger();
  const markets = [settledYes, voided, poolSettled, open];
  registerFactory(chain, markets);
  for (const m of markets) {
    registerMarket(chain, m);
    registerToken(chain, m.tokens?.yes ?? addr(1), ledger);
    registerToken(chain, m.tokens?.no ?? addr(2), ledger);
  }
  registerToken(chain, USDC, ledger, "Hunch Book Test USDC");
  // Market 1: 3 YES held and 2 YES still to claim. Market 2 (void): 5.000001 YES (the odd unit stays)
  // and 4 NO. Market 3: a pool payout. Market 4 is still trading.
  chain.register(settledYes.address, [], { claimableTokens: () => [2_000_000n, 0n] });
  ledger.set(settledYes.tokens?.yes ?? addr(1), me, 3_000_000n);
  ledger.set(voided.tokens?.yes ?? addr(1), me, 5_000_001n);
  ledger.set(voided.tokens?.no ?? addr(1), me, 4_000_000n);
  chain.register(poolSettled.address, [], { claimablePool: () => [7_500_000n, 150_000n] });
  ledger.set(open.tokens?.yes ?? addr(1), me, 9_000_000n);
  chain.register(VAULT, collateralVaultAbi, { redeem: () => 0n });
});

const names = () =>
  chain.sent.map(
    (t) => `${t.functionName}${t.functionName === "redeem" ? `:${String(t.args[0]).slice(-3)}` : ""}`,
  );

describe("collectCalls", () => {
  const info = (over: Partial<MarketInfo>): MarketInfo =>
    ({
      address: addr(0x301),
      id: 9n,
      phase: Phase.Settled,
      outcome: Outcome.No,
      graduated: true,
      ...over,
    }) as MarketInfo;
  const position = (over: Partial<Position>): Position => ({
    market: addr(0x301),
    stake: { yes: 0n, no: 0n },
    claimableTokens: { yes: 0n, no: 0n },
    claimablePool: { paid: 0n, fee: 0n },
    balances: { yes: 0n, no: 0n },
    ...over,
  });

  it("claims, then redeems the winning side including what was just claimed", () => {
    const calls = collectCalls(
      info({}),
      position({ claimableTokens: { yes: 1n, no: 4n }, balances: { yes: 7n, no: 6n } }),
      VAULT,
      me,
    );
    expect(calls.map((c) => c.kind)).toEqual(["claimTokens", "redeem"]);
    expect(calls[1]?.args).toEqual([addr(0x301), Side.No, 10n, me]);
    expect(calls[1]?.address).toBe(VAULT);
  });

  it("redeems both sides of a void, an even amount each", () => {
    const calls = collectCalls(
      info({ phase: Phase.Voided, outcome: Outcome.Unresolved }),
      position({ balances: { yes: 5n, no: 1n } }),
      VAULT,
      me,
    );
    expect(calls.map((c) => [c.side, c.amount])).toEqual([[Side.Yes, 4n]]);
  });

  it("claims a pool payout on a market that never graduated, and nothing else", () => {
    const calls = collectCalls(
      info({ graduated: false }),
      position({ claimablePool: { paid: 3n, fee: 0n }, balances: { yes: 9n, no: 0n } }),
      VAULT,
      me,
    );
    expect(calls.map((c) => c.kind)).toEqual(["claimPool"]);
  });

  it("needs nothing from a market still trading, or a losing position", () => {
    expect(
      collectCalls(info({ phase: Phase.Graduated }), position({ balances: { yes: 1n, no: 1n } }), VAULT, me),
    ).toEqual([]);
    expect(
      collectCalls(info({ outcome: Outcome.Yes }), position({ balances: { yes: 0n, no: 5n } }), VAULT, me),
    ).toEqual([]);
  });
});

describe("atomicSupported", () => {
  it("reads EIP-5792 capabilities, per chain or for one chain", () => {
    expect(atomicSupported({ atomic: { status: "supported" } }, 10143)).toBe(true);
    expect(atomicSupported({ 10143: { atomic: { status: "ready" } } }, 10143)).toBe(true);
    expect(atomicSupported({ [CHAIN_HEX]: { atomic: { status: "supported" } } }, 10143)).toBe(true);
    expect(atomicSupported({ 10143: { atomic: { status: "unsupported" } } }, 10143)).toBe(false);
    expect(atomicSupported({ 1: { atomic: { status: "supported" } } }, 10143)).toBe(false);
    expect(atomicSupported(undefined, 10143)).toBe(false);
  });
});

describe("planCollect and collectAll", () => {
  it("plans every settled market for the wallet, skipping open ones", async () => {
    const ctx = chain.context({ key });
    const calls = await planCollect(ctx, [
      settledYes.address,
      voided.address,
      poolSettled.address,
      open.address,
    ]);
    expect(calls.map((c) => c.label)).toEqual([
      "Claim 2 YES and 0 NO on market #1",
      "Redeem 5 YES on market #1",
      "Redeem 5 YES on market #2",
      "Redeem 4 NO on market #2",
      "Claim 7.5 USDC from market #3's pool",
    ]);
  });

  it("sends one transaction at a time when the wallet cannot batch", async () => {
    const ctx = chain.context({ key });
    const result = await collectAll(ctx, [settledYes.address, voided.address, poolSettled.address]);
    expect(result.mode).toBe("sequential");
    expect(result.transactions).toHaveLength(5);
    expect(names()).toEqual(["claimTokens", "redeem:201", "redeem:202", "redeem:202", "claimPool"]);
  });

  it("sends one atomic batch when the wallet supports it on this chain", async () => {
    chain.capabilities = { [CHAIN_HEX]: { atomic: { status: "supported" } } };
    const ctx = chain.context({ key });
    const result = await collectAll(ctx, [settledYes.address, voided.address, poolSettled.address]);
    expect(result.mode).toBe("atomic");
    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0]?.url).toContain("/tx/0x");
    expect(names()).toEqual(["claimTokens", "redeem:201", "redeem:202", "redeem:202", "claimPool"]);
    expect(new Set(chain.sent.map((t) => t.hash)).size).toBe(1);
  });

  it("does not batch a single call unless asked", async () => {
    chain.capabilities = { [CHAIN_HEX]: { atomic: { status: "supported" } } };
    const ctx = chain.context({ key });
    expect((await collectAll(ctx, [poolSettled.address])).mode).toBe("sequential");
    expect((await collectAll(ctx, [poolSettled.address], { mode: "atomic" })).mode).toBe("atomic");
  });

  it("refuses an atomic batch the wallet cannot send", async () => {
    const ctx = chain.context({ key });
    await expect(
      sendCalls(ctx, [{ address: VAULT, abi: collateralVaultAbi, functionName: "redeem" }], {
        mode: "atomic",
      }),
    ).rejects.toBeInstanceOf(HunchError);
  });

  it("reports a failed batch as moving nothing", async () => {
    chain.capabilities = { [CHAIN_HEX]: { atomic: { status: "supported" } } };
    chain.register(VAULT, collateralVaultAbi, {
      redeem: () => {
        throw new Error("boom");
      },
    });
    const ctx = chain.context({ key });
    await expect(collectAll(ctx, [settledYes.address, voided.address])).rejects.toThrow(/nothing moved/);
  });

  it("sends nothing when there is nothing to collect", async () => {
    const ctx = chain.context({ key });
    const result = await collectAll(ctx, [open.address]);
    expect(result.transactions).toEqual([]);
    expect(chain.sent).toEqual([]);
  });
});

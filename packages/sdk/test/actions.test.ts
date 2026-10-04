import {
  encodePerplFundingParams,
  hunchRouterAbi,
  marketAbi,
  marketKey,
  Outcome,
  Phase,
  Side,
  testUsdcAbi,
} from "@hunch-book/shared";
import {
  type Abi,
  type Address,
  encodeAbiParameters,
  getAddress,
  type Hex,
  keccak256,
  maxUint256,
  verifyTypedData,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { beforeEach, describe, expect, it } from "vitest";
import {
  authorizationNonce,
  buildStakeAuthorization,
  createMarket,
  HunchError,
  mintTestUsdc,
  settle,
  signStakeAuthorization,
  stake,
  stakeWithAuthorization,
  toSide,
  trade,
} from "../src/index.js";
import { FakeChain, Revert } from "./fake-chain.js";
import {
  addr,
  blockWindow,
  type FakeMarket,
  Ledger,
  ROUTER,
  registerBook,
  registerFactory,
  registerMarket,
  registerResolver,
  registerToken,
  USDC,
  VAULT,
} from "./fixtures.js";

const key = generatePrivateKey();
const me = privateKeyToAccount(key).address;
const YES = addr(0x2001);
const NO = addr(0x2002);
const BOOK = addr(0x3000);
const HASH: Hex = `0x${"cd".repeat(32)}`;

let chain: FakeChain;
let ledger: Ledger;
let pool: FakeMarket;
let trading: FakeMarket;

beforeEach(() => {
  chain = new FakeChain();
  ledger = new Ledger();
  pool = {
    address: addr(0x101),
    id: 1,
    templateId: 1,
    params: encodePerplFundingParams({
      perpId: 16n,
      startBlock: 2_000n,
      endBlock: 900n,
      threshold: 0n,
      expectedScalingExp: 2,
    }),
    phase: Phase.Closed,
    window: blockWindow(500n, 900n, 1_900_000_000n),
    resolver: addr(0xaa),
  };
  trading = {
    address: addr(0x102),
    id: 2,
    templateId: 1,
    params: encodePerplFundingParams({
      perpId: 16n,
      startBlock: 2_001n,
      endBlock: 90_000n,
      threshold: 0n,
      expectedScalingExp: 2,
    }),
    phase: Phase.Graduated,
    graduated: true,
    book: BOOK,
    tokens: { yes: YES, no: NO },
    window: blockWindow(500n, 90_000n, 1_900_000_000n),
    resolver: addr(0xaa),
  };
  registerFactory(chain, [pool, trading]);
  registerMarket(chain, pool);
  registerMarket(chain, trading);
  registerResolver(chain, addr(0xaa), (_p, evidence) =>
    evidence === "0x" ? [Outcome.Yes, HASH] : [Outcome.Unresolved, HASH],
  );
  registerToken(chain, USDC, ledger, "Hunch Book Test USDC");
  registerToken(chain, YES, ledger);
  registerToken(chain, NO, ledger);
  chain.register(USDC, testUsdcAbi, { mint: () => undefined });
  registerBook(chain, BOOK, YES, {
    bids: [{ price: 410_000n, size: 100_000_000n }],
    asks: [{ price: 430_000n, size: 100_000_000n }],
  });
  chain.register(ROUTER, hunchRouterAbi, {
    buyYes: ([, , minOut]) => minOut,
    sellYes: () => 0n,
    buyNo: () => 0n,
    sellNo: () => 0n,
  });
});

const sentNames = () =>
  chain.sent.map(
    (t) =>
      `${t.to === USDC ? "usdc" : t.to === YES ? "yes" : t.to === ROUTER ? "router" : t.to}.${t.functionName}`,
  );

describe("actions", () => {
  it("approves the vault once, then stakes, and returns the explorer link", async () => {
    const ctx = chain.context({ key });
    const tx = await stake(ctx, pool.address, "yes", 5_000_000n);
    expect(sentNames()).toEqual(["usdc.approve", `${pool.address}.stake`]);
    expect(chain.sent[0]?.args).toEqual([VAULT, 5_000_000n]);
    expect(chain.sent[1]?.args).toEqual([Side.Yes, 5_000_000n]);
    expect(tx.url).toBe(`https://testnet.monadscan.com/tx/${tx.hash}`);
    expect(tx.status).toBe("success");
    // The allowance now covers the next stake: no second approval.
    await stake(ctx, pool.address, Side.No, 5_000_000n);
    expect(sentNames().filter((n) => n === "usdc.approve")).toHaveLength(1);
  });

  it("refuses to act without a wallet, in plain words", async () => {
    await expect(stake(chain.context(), pool.address, "yes", 1n)).rejects.toThrow(
      /create the client with a walletClient/,
    );
    expect(() => toSide("maybe" as never)).toThrow(HunchError);
  });

  it("names the existing market instead of sending a duplicate createMarket", async () => {
    const ctx = chain.context({ key });
    await expect(
      createMarket(ctx, { templateId: 1, params: pool.params, side: "yes", firstStake: 5_000_000n }),
    ).rejects.toThrow(new RegExp(`already exists: ${pool.address}`));
    const created = await createMarket(ctx, {
      templateId: 1,
      params: { perpId: 16n, startBlock: 3_000n, endBlock: 20_000n, threshold: 5n, expectedScalingExp: 2 },
      side: "no",
      firstStake: 5_000_000n,
    });
    expect(created.market).toBe(addr(0xbeef));
    const call = chain.sent.at(-1);
    expect(call?.functionName).toBe("createMarket");
    expect(call?.args.slice(2)).toEqual([Side.No, 5_000_000n]);
    expect(marketKey(1, call?.args[1] as Hex)).not.toBe(marketKey(1, pool.params));
  });

  it("decodes a revert from the simulation before anything is signed", async () => {
    chain.register(pool.address, marketAbi, {
      stake: () => {
        throw new Revert(marketAbi, "PoolCapExceeded");
      },
    });
    ledger.approve(USDC, me, VAULT, maxUint256);
    const error = await stake(chain.context({ key }), pool.address, "yes", 1n).catch((e) => e);
    expect(error).toBeInstanceOf(HunchError);
    expect(error.message).toBe("That stake would take the pool over its cap.");
    expect(error.code).toBe("PoolCapExceeded");
    expect(chain.sent).toHaveLength(0);
  });

  it("trades through the router with the quote's limit, a deadline and an exact approval", async () => {
    const ctx = chain.context({ key });
    const result = await trade(ctx, trading.address, "buyYes", 43_000_000n, {
      slippageBps: 100n,
      deadlineSeconds: 60n,
    });
    expect(result.quote.tokens).toBe(100_000_000n);
    expect(sentNames()).toEqual(["usdc.approve", "router.buyYes"]);
    expect(chain.sent[0]?.args).toEqual([ROUTER, 43_000_000n]);
    const [market, amount, limit, deadline] = (chain.sent[1]?.args ?? []) as [
      Address,
      bigint,
      bigint,
      bigint,
    ];
    expect(market).toBe(trading.address);
    expect(amount).toBe(43_000_000n);
    expect(limit).toBe(99_000_000n);
    expect(deadline).toBe(chain.block.timestamp - 1n + 60n);
    expect(result.result).toBe(99_000_000n);
  });

  it("refuses a trade the book cannot fill, and a trade on a market that is not trading", async () => {
    const ctx = chain.context({ key });
    await expect(trade(ctx, trading.address, "sellYes", 500_000_000n)).rejects.toThrow(
      /cannot fill the whole amount/,
    );
    await expect(trade(ctx, pool.address, "buyYes", 1_000_000n)).rejects.toThrow(/not trading on the book/);
  });

  it("settles with evidence found automatically, and refuses when there is none", async () => {
    const ctx = chain.context({ key });
    chain.block = { number: 1_000n, timestamp: 1_800_000_000n };
    const tx = await settle(ctx, pool.address);
    expect(tx.method).toBe("settle");
    expect(tx.outcome).toBe(Outcome.Yes);
    expect(chain.sent.at(-1)).toMatchObject({ functionName: "settle", args: ["0x"] });
    await expect(settle(ctx, trading.address)).rejects.toThrow(/Waiting for block 90001/);
  });

  it("builds a stake authorisation bound to market, user and side, and the user's signature verifies", async () => {
    const ctx = chain.context({ key });
    const salt: Hex = `0x${"11".repeat(32)}`;
    const auth = await buildStakeAuthorization(ctx, {
      market: pool.address,
      user: me,
      side: "no",
      amount: 7_000_000n,
      salt,
      validBefore: 1_900_000_000n,
    });
    expect(auth.nonce).toBe(
      keccak256(
        encodeAbiParameters(
          [
            { type: "uint256" },
            { type: "address" },
            { type: "address" },
            { type: "uint8" },
            { type: "bytes32" },
          ],
          [10143n, pool.address, me, 1, salt],
        ),
      ),
    );
    expect(auth.nonce).toBe(authorizationNonce(10143, pool.address, me, Side.No, salt));
    expect(auth.typedData.domain).toEqual({
      name: "Hunch Book Test USDC",
      version: "1",
      chainId: 10143,
      verifyingContract: getAddress(USDC),
    });
    expect(auth.typedData.message).toMatchObject({
      from: me,
      to: pool.address,
      value: 7_000_000n,
      validAfter: 0n,
    });
    const signed = await signStakeAuthorization(ctx, auth);
    expect(await verifyTypedData({ address: me, ...auth.typedData, signature: signed.signature })).toBe(true);
    await stakeWithAuthorization(ctx, signed);
    expect(chain.sent.at(-1)?.args).toEqual([
      me,
      Side.No,
      7_000_000n,
      0n,
      1_900_000_000n,
      salt,
      signed.signature,
    ]);
    // Someone else cannot sign it.
    const other = chain.context({ key: generatePrivateKey() });
    await expect(signStakeAuthorization(other, auth)).rejects.toThrow(/Only the user/);
  });

  it("mints test USDC on testnet only, up to the faucet limit", async () => {
    const ctx = chain.context({ key });
    await mintTestUsdc(ctx, 10_000_000_000n);
    expect(chain.sent.at(-1)).toMatchObject({ functionName: "mint", args: [me, 10_000_000_000n] });
    await expect(mintTestUsdc(ctx, 10_000_000_001n)).rejects.toThrow(/at most 10,000 USDC/);
  });

  it("keeps ABIs usable as plain Abi values", () => {
    expect((marketAbi as Abi).length).toBeGreaterThan(0);
  });
});

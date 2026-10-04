import {
  deployments,
  hunchBookFactoryAbi,
  marketAbi,
  monadTestnet,
  Phase,
  testUsdcAbi,
} from "@hunch-book/shared";
import { type Address, BaseError, ContractFunctionRevertedError, createPublicClient, http } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { prepareRelayedStake } from "../src/lib/relayer/client";
import { readUsdcDomain, stakeAuthorizationNonce, stakeTypedData } from "../src/lib/relayer/typedData";
import { withKnownErrors } from "../src/lib/wallet/errors";

// Opt-in check against Monad testnet with eth_call only (nothing is sent): the typed data the app
// builds is accepted by the real test USDC and the real Market. Run with HUNCH_LIVE_TESTS=1.

const live = process.env.HUNCH_LIVE_TESTS === "1";
const testnet = deployments["monad-testnet"];

describe.skipIf(!live)("relayed stakes against Monad testnet (eth_call)", () => {
  const client = createPublicClient({ chain: monadTestnet, transport: http(testnet.rpc) });
  const usdc = testnet.hunchBook.usdc as Address;
  const factory = testnet.hunchBook.factory as Address;

  it("reads test USDC's domain and the market's nonce rule matches ours", async () => {
    const domain = await readUsdcDomain(client, usdc, testnet.chainId);
    expect(domain.name).toBe("Hunch Book Test USDC");
    const market = await client.readContract({
      address: factory,
      abi: hunchBookFactoryAbi,
      functionName: "marketAt",
      args: [0n],
    });
    const user = privateKeyToAccount(generatePrivateKey()).address;
    const salt = `0x${"5a".repeat(32)}` as const;
    for (const side of [0, 1] as const) {
      const onchain = await client.readContract({
        address: market,
        abi: marketAbi,
        functionName: "authorizationNonce",
        args: [user, side, salt],
      });
      expect(onchain).toBe(stakeAuthorizationNonce({ chainId: testnet.chainId, market, user, side, salt }));
    }
  });

  it("test USDC accepts the signature (a zero-value receiveWithAuthorization)", async () => {
    const domain = await readUsdcDomain(client, usdc, testnet.chainId);
    const signer = privateKeyToAccount(generatePrivateKey());
    const payee = privateKeyToAccount(generatePrivateKey()).address;
    const now = Math.floor(Date.now() / 1000);
    const auth = {
      market: payee,
      user: signer.address,
      side: 0 as const,
      amount: 0n,
      validAfter: BigInt(now - 600),
      validBefore: BigInt(now + 600),
      salt: `0x${"77".repeat(32)}` as const,
    };
    const typed = stakeTypedData(domain, auth);
    const signature = await signer.signTypedData(typed);
    const r = `0x${signature.slice(2, 66)}` as const;
    const s = `0x${signature.slice(66, 130)}` as const;
    const v = Number.parseInt(signature.slice(130, 132), 16);
    await client.simulateContract({
      address: usdc,
      abi: testUsdcAbi,
      functionName: "receiveWithAuthorization",
      args: [signer.address, payee, 0n, auth.validAfter, auth.validBefore, typed.message.nonce, v, r, s],
      account: payee,
    });
  });

  it("a pool market gets past the signature check (it then stops at the empty balance)", async () => {
    const count = await client.readContract({
      address: factory,
      abi: hunchBookFactoryAbi,
      functionName: "marketCount",
    });
    let pool: Address | undefined;
    for (let i = Number(count) - 1; i >= 0 && !pool; i--) {
      const m = await client.readContract({
        address: factory,
        abi: hunchBookFactoryAbi,
        functionName: "marketAt",
        args: [BigInt(i)],
      });
      const phase = await client.readContract({ address: m, abi: marketAbi, functionName: "phase" });
      if (Number(phase) === Phase.Pool) pool = m;
    }
    if (!pool) return; // no market is in its pool phase right now
    const caps = await client.readContract({ address: pool, abi: marketAbi, functionName: "caps" });
    const signer = privateKeyToAccount(generatePrivateKey());
    const { auth, typedData } = await prepareRelayedStake({
      client,
      chainId: testnet.chainId,
      usdc,
      market: pool,
      user: signer.address,
      side: 1,
      amount: BigInt(caps.minStake),
      nowSeconds: Date.now() / 1000,
    });
    const signature = await signer.signTypedData(typedData);
    let name: string | undefined;
    try {
      await client.simulateContract({
        address: pool,
        abi: withKnownErrors(marketAbi),
        functionName: "stakeWithAuthorization",
        args: [auth.user, auth.side, auth.amount, auth.validAfter, auth.validBefore, auth.salt, signature],
        account: privateKeyToAccount(generatePrivateKey()).address,
      });
    } catch (error) {
      const revert =
        error instanceof BaseError ? error.walk((e) => e instanceof ContractFunctionRevertedError) : null;
      name = revert instanceof ContractFunctionRevertedError ? revert.data?.errorName : undefined;
    }
    // A bad signature would revert InvalidSignature; a good one reaches the transfer and finds no USDC.
    expect(name).toBe("InsufficientBalance");
  });
});

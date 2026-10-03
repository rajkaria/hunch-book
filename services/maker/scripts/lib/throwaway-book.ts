import { kuruRouterAbi } from "@hunch-book/shared";
import {
  type Account,
  type Address,
  type Chain,
  decodeEventLog,
  getAddress,
  isAddressEqual,
  type PublicClient,
  type WalletClient,
} from "viem";
import type { SetOps } from "../../src/inventory.js";
import { mockTokenAbi, mockTokenBytecode } from "./mock-token.js";

// Helpers for a throwaway Kuru book on mock 6-decimal tokens: the fork integration test and the
// testnet smoke script use them. Never used against real Hunch Book markets.

export interface Signer {
  publicClient: PublicClient;
  walletClient: WalletClient;
  account: Account;
  chain: Chain;
}

async function confirm(signer: Signer, hash: `0x${string}`) {
  const receipt = await signer.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`transaction ${hash} reverted`);
  return receipt;
}

export async function deployMockToken(signer: Signer, name: string, symbol: string): Promise<Address> {
  const hash = await signer.walletClient.deployContract({
    abi: mockTokenAbi,
    bytecode: mockTokenBytecode,
    args: [name, symbol],
    account: signer.account,
    chain: signer.chain,
  });
  const receipt = await confirm(signer, hash);
  if (!receipt.contractAddress) throw new Error("no contract address in the deploy receipt");
  return getAddress(receipt.contractAddress);
}

export async function mintMock(signer: Signer, token: Address, to: Address, amount: bigint): Promise<void> {
  await confirm(
    signer,
    await signer.walletClient.writeContract({
      address: token,
      abi: mockTokenAbi,
      functionName: "mint",
      args: [to, amount],
      account: signer.account,
      chain: signer.chain,
    }),
  );
}

async function burnMock(signer: Signer, token: Address, from: Address, amount: bigint): Promise<void> {
  await confirm(
    signer,
    await signer.walletClient.writeContract({
      address: token,
      abi: mockTokenAbi,
      functionName: "burn",
      args: [from, amount],
      account: signer.account,
      chain: signer.chain,
    }),
  );
}

/** Creates a YES/USDC-style Kuru book with Hunch Book's parameters (docs/PROTOCOL.md §8.1). */
export async function createKuruBook(
  signer: Signer,
  router: Address,
  base: Address,
  quote: Address,
  maxSize: bigint,
): Promise<{ book: Address; hash: `0x${string}` }> {
  const hash = await signer.walletClient.writeContract({
    address: router,
    abi: kuruRouterAbi,
    functionName: "deployProxy",
    args: [0, base, quote, 1_000_000n, 1_000_000, 1_000, 1_000_000n, maxSize, 0n, 0n, 30n],
    account: signer.account,
    chain: signer.chain,
  });
  const receipt = await confirm(signer, hash);
  for (const log of receipt.logs) {
    if (!isAddressEqual(log.address, router)) continue;
    try {
      const event = decodeEventLog({ abi: kuruRouterAbi, data: log.data, topics: log.topics });
      if (event.eventName === "MarketRegistered") return { book: getAddress(event.args.market), hash };
    } catch {
      // not the event we want
    }
  }
  throw new Error("MarketRegistered not found in the deployProxy receipt");
}

/**
 * Stands in for the vault's mintSets / mergeSets with mock tokens: mint burns `amount` USDC and mints
 * `amount` YES and NO; merge does the reverse. Same 1 USDC ⇄ 1 YES + 1 NO economics.
 */
export function mockSetOps(signer: Signer, tokens: { yes: Address; no: Address; usdc: Address }): SetOps {
  const me = signer.account.address;
  return {
    async mint(amount) {
      await burnMock(signer, tokens.usdc, me, amount);
      await mintMock(signer, tokens.yes, me, amount);
      await mintMock(signer, tokens.no, me, amount);
      return true;
    },
    async merge(amount) {
      await burnMock(signer, tokens.yes, me, amount);
      await burnMock(signer, tokens.no, me, amount);
      await mintMock(signer, tokens.usdc, me, amount);
      return true;
    },
  };
}

import {
  deployments,
  encodePerplFundingParams,
  marketAbi,
  monadTestnet,
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
  type PrivateKeyAccount,
  type PublicClient,
  parseEther,
  type TestClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { type Anvil, type Artifact, artifact, startAnvil } from "./anvil.js";
import { MULTICALL3_ADDRESS, MULTICALL3_RUNTIME } from "./multicall3.js";

// A local anvil chain with Hunch Book's real core contracts (factory, vault, market, outcome tokens,
// test USDC) deployed from contracts/out, for the keeper's integration tests.

export const USDC = 1_000_000n;
export const testnet = deployments["monad-testnet"];

export const ARTIFACTS = {
  usdc: artifact("TestUSDC.sol", "TestUSDC"),
  market: artifact("Market.sol", "Market"),
  factory: artifact("HunchBookFactory.sol", "HunchBookFactory"),
  graduator: artifact("Graduator.sol", "Graduator"),
  mockGraduator: artifact("MockGraduator.sol", "MockGraduator"),
  mockResolver: artifact("MockResolver.sol", "MockResolver"),
  mockKuruRouter: artifact("MockKuruRouter.sol", "MockKuruRouter"),
  mockKuruMarginAccount: artifact("MockKuruMarginAccount.sol", "MockKuruMarginAccount"),
  // Templates 3, 4 and 6, with stand-ins for Chainlink and Perpl (the resolvers' own test mocks).
  touchResolver: artifact("ChainlinkTouchResolver.sol", "ChainlinkTouchResolver"),
  spikeResolver: artifact("PerplFundingSpikeResolver.sol", "PerplFundingSpikeResolver"),
  parlayResolver: artifact("MarketOutcomeResolver.sol", "MarketOutcomeResolver"),
  mockFeed: artifact("MockChainlinkAggregator.sol", "MockChainlinkAggregator"),
  mockPerpl: artifact("MockPerplExchange.sol", "MockPerplExchange"),
  // Template 7, with the snapshot tests' stand-in source.
  snapshotResolver: artifact("SnapshotResolver.sol", "SnapshotResolver"),
  mockSnapshotSource: artifact("SnapshotMocks.sol", "MockSnapshotSource"),
  // The periphery, the router and the periphery tests' Kuru book stand-in.
  router: artifact("HunchRouter.sol", "HunchRouter"),
  autoRedeemer: artifact("AutoRedeemer.sol", "AutoRedeemer"),
  conditionalOrders: artifact("ConditionalOrders.sol", "ConditionalOrders"),
  oracle: artifact("ImpliedProbabilityOracle.sol", "ImpliedProbabilityOracle"),
  peripheryBook: artifact("PeripheryBook.sol", "PeripheryBook"),
  // Kuru v2: GraduatorV2, the limiter feeds' factory, and the contracts' mock of Kuru's v2 exchange.
  graduatorV2: artifact("GraduatorV2.sol", "GraduatorV2"),
  adapterFactory: artifact("OutcomeTokenPriceAdapterFactory.sol", "OutcomeTokenPriceAdapterFactory"),
  mockKuruAccountCoreV2: artifact("MockKuruV2.sol", "MockKuruAccountCoreV2"),
  mockKuruSpotRouterV2: artifact("MockKuruV2.sol", "MockKuruSpotRouterV2"),
  mockKuruLimiterV2: artifact("MockKuruV2.sol", "MockKuruWithdrawalLimiterV2"),
  // Hunch Book's own order book: the factory deploys its margin account and the book implementation.
  hunchBookFactory: artifact("HunchOrderBookFactory.sol", "HunchOrderBookFactory"),
  hunchOrderBook: artifact("HunchOrderBook.sol", "HunchOrderBook"),
  hunchMarginAccount: artifact("HunchMarginAccount.sol", "HunchMarginAccount"),
};
export type ArtifactName = keyof typeof ARTIFACTS;

export const artifactsBuilt = Object.values(ARTIFACTS).every((a) => a !== null);
if (!artifactsBuilt) {
  console.warn(
    "contracts/out is missing: run `forge build` in contracts/ to run the keeper integration tests",
  );
}

export const abiOf = (name: ArtifactName): Abi => (ARTIFACTS[name] as Artifact).abi;

/** Template 1 params that MockResolver also reads as Window(blockClock = true, lock, close, deadline). */
export function windowParams(lock: bigint, close: bigint, deadline: bigint): Hex {
  return encodePerplFundingParams({
    perpId: 1n,
    startBlock: lock,
    endBlock: close,
    threshold: deadline,
    expectedScalingExp: 0,
  });
}

export class LocalChain {
  readonly client: PublicClient;
  readonly test: TestClient;

  private constructor(private readonly anvil: Anvil) {
    const transport = http(anvil.url);
    this.client = createPublicClient({ chain: monadTestnet, transport }) as PublicClient;
    this.test = createTestClient({ mode: "anvil", chain: monadTestnet, transport });
  }

  get url(): string {
    return this.anvil.url;
  }

  /** Null (the suite skips) when anvil or contracts/out is missing. */
  static async start(): Promise<LocalChain | null> {
    if (!artifactsBuilt) return null;
    // viem only reads through Multicall3 at blocks after the one where Monad testnet's copy was created.
    const anvil = await startAnvil(
      testnet.chainId,
      (monadTestnet.contracts?.multicall3?.blockCreated ?? 0) + 1,
    );
    if (!anvil) return null;
    const chain = new LocalChain(anvil);
    await chain.test.setCode({ address: MULTICALL3_ADDRESS, bytecode: MULTICALL3_RUNTIME });
    return chain;
  }

  stop(): void {
    this.anvil.stop();
  }

  async account(): Promise<PrivateKeyAccount> {
    return this.fundedAccount(generatePrivateKey());
  }

  async fundedAccount(key: Hex): Promise<PrivateKeyAccount> {
    const account = privateKeyToAccount(key);
    await this.test.setBalance({ address: account.address, value: parseEther("100") });
    return account;
  }

  private wallet(from: PrivateKeyAccount) {
    return createWalletClient({ account: from, chain: monadTestnet, transport: http(this.anvil.url) });
  }

  async deploy(from: PrivateKeyAccount, name: ArtifactName, args: unknown[] = []): Promise<Address> {
    const a = ARTIFACTS[name] as Artifact;
    const hash = await this.wallet(from).deployContract({
      abi: a.abi,
      bytecode: a.bytecode,
      args,
      chain: monadTestnet,
      account: from,
    });
    const receipt = await this.client.waitForTransactionReceipt({ hash });
    return getAddress(receipt.contractAddress as Address);
  }

  async send(
    from: PrivateKeyAccount,
    address: Address,
    abi: Abi,
    functionName: string,
    args: unknown[] = [],
  ): Promise<void> {
    const hash = await this.wallet(from).writeContract({
      address,
      abi,
      functionName,
      args,
      chain: monadTestnet,
      account: from,
    });
    const receipt = await this.client.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${functionName} reverted`);
  }

  read<T>(address: Address, abi: Abi, functionName: string, args: unknown[] = []): Promise<T> {
    return this.client.readContract({ address, abi, functionName, args }) as Promise<T>;
  }

  readMarket<T>(market: Address, functionName: string, args: unknown[] = []): Promise<T> {
    return this.read<T>(market, marketAbi as Abi, functionName, args);
  }

  balance(token: Address, who: Address): Promise<bigint> {
    return this.client.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [who],
    });
  }
}

export interface Core {
  deployBlock: number;
  usdc: Address;
  factory: Address;
  vault: Address;
  resolver: Address;
  feeRecipient: Address;
}

/**
 * Test USDC, the market implementation, a factory (which deploys the vault), a MockResolver
 * registered as template 1 with a small graduation rule (50 USDC from 4 stakers), and USDC with vault
 * approval for every account in `stakers`. The caller wires the graduator.
 */
export async function deployCore(
  chain: LocalChain,
  deployer: PrivateKeyAccount,
  stakers: PrivateKeyAccount[],
) {
  const deployBlock = Number(await chain.client.getBlockNumber());
  const usdc = await chain.deploy(deployer, "usdc");
  const implementation = await chain.deploy(deployer, "market");
  const caps = {
    poolCap: 5_000n * USDC,
    walletCap: 1_000n * USDC,
    minStake: USDC,
    creatorMinStake: 5n * USDC,
  };
  // The fee recipient receives token rounding dust; it is its own address so balances stay exact.
  const feeRecipient = privateKeyToAccount(generatePrivateKey()).address;
  const factory = await chain.deploy(deployer, "factory", [
    usdc,
    implementation,
    deployer.address,
    feeRecipient,
    caps,
    50_000n * USDC,
  ]);
  const vault = getAddress(await chain.read<Address>(factory, abiOf("factory"), "vault"));
  const resolver = await chain.deploy(deployer, "mockResolver");
  const rule = { minPool: 50n * USDC, minStakers: 4, minChanceBps: 300, maxChanceBps: 9_700 };
  await chain.send(deployer, factory, abiOf("factory"), "addTemplate", [
    TemplateId.PerplFunding,
    resolver,
    rule,
  ]);
  for (const a of [deployer, ...stakers]) {
    await chain.send(a, usdc, abiOf("usdc"), "mint", [a.address, 1_000n * USDC]);
    await chain.send(a, usdc, erc20Abi as Abi, "approve", [vault, 2n ** 255n]);
  }
  return { deployBlock, usdc, factory, vault, resolver, feeRecipient } satisfies Core;
}

/** Creates a template-1 market from `creator` and returns its address. */
export async function createMarket(
  chain: LocalChain,
  core: Core,
  creator: PrivateKeyAccount,
  params: Hex,
  side: number,
  stake: bigint,
): Promise<Address> {
  await chain.send(creator, core.factory, abiOf("factory"), "createMarket", [
    TemplateId.PerplFunding,
    params,
    side,
    stake,
  ]);
  const count = await chain.read<bigint>(core.factory, abiOf("factory"), "marketCount");
  return getAddress(await chain.read<Address>(core.factory, abiOf("factory"), "marketAt", [count - 1n]));
}

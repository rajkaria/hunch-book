import {
  chainsByNetwork,
  collateralOf,
  deployments,
  hunchBookFactoryAbi,
  marketAbi,
  type Network,
  stacksOf,
  txUrl,
} from "@hunch-book/shared";
import {
  type Abi,
  type Address,
  createPublicClient,
  createWalletClient,
  erc20Abi,
  type Hex,
  http,
  type PublicClient,
  type TypedDataDomain,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { appNetwork } from "../config";
import { describeTxError, withKnownErrors } from "../wallet/errors";
import { parseRelayerConfig, type RelayerConfig } from "./config";
import type { DripChain, RelayerDeps } from "./drip";
import type { MarketCheck, RelayChain } from "./relay";
import type { RelayStakeRequest } from "./request";
import { KvStore, MemoryStore, type RelayStore } from "./store";
import { readUsdcDomain, usdcDomainAbi } from "./typedData";

// The live dependencies behind the relayer routes: viem clients over the network's RPC and the
// relayer key from RELAYER_PRIVATE_KEY. Server only. Transactions from the key are sent one at a
// time per network, so two requests never race for the same nonce.

const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;

/** Monad charges for the gas limit, so the limit is the estimate plus 10%, never more. */
const withHeadroom = (gas: bigint) => (gas * 110n) / 100n;

class Serial {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.tail.then(task, task);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

interface NetworkClients {
  publicClient: PublicClient;
  send: <T>(task: () => Promise<T>) => Promise<T>;
  wallet: ReturnType<typeof createWalletClient>;
  relayer: Address;
  domain?: Promise<TypedDataDomain>;
}

let cached: { config: RelayerConfig; store: RelayStore } | undefined;
const clients = new Map<Network, NetworkClients>();

function base(): { config: RelayerConfig; store: RelayStore } {
  if (!cached) {
    const config = parseRelayerConfig(process.env, appNetwork);
    const store: RelayStore = config.kv ? new KvStore(config.kv.url, config.kv.token) : new MemoryStore();
    cached = { config, store };
  }
  return cached;
}

function clientsFor(network: Network): NetworkClients {
  const existing = clients.get(network);
  if (existing) return existing;
  const { config } = base();
  if (!config.privateKey) throw new Error("RELAYER_PRIVATE_KEY is not set");
  const chain = chainsByNetwork[network];
  const transport = http(config.rpc[network], { timeout: 15_000, retryCount: 1 });
  const account = privateKeyToAccount(config.privateKey);
  const serial = new Serial();
  const made: NetworkClients = {
    publicClient: createPublicClient({ chain, transport }) as PublicClient,
    wallet: createWalletClient({ account, chain, transport }),
    relayer: account.address,
    send: (task) => serial.run(task),
  };
  clients.set(network, made);
  return made;
}

function dripChain(network: Network): DripChain {
  const c = clientsFor(network);
  const deployment = deployments[network];
  return {
    relayer: c.relayer,
    getBalance: (address) => c.publicClient.getBalance({ address }),
    getTransactionCount: (address) => c.publicClient.getTransactionCount({ address, blockTag: "pending" }),
    getCode: (address) => c.publicClient.getCode({ address }),
    sendValue: (to, value) =>
      c.send(async () => {
        const gas = await c.publicClient.estimateGas({ account: c.relayer, to, value });
        return c.wallet.sendTransaction({
          account: c.wallet.account ?? c.relayer,
          chain: c.wallet.chain,
          to,
          value,
          gas: withHeadroom(gas),
        });
      }),
    txUrl: (hash) => txUrl(deployment, hash),
  };
}

function relayChain(network: Network): RelayChain {
  const c = clientsFor(network);
  const deployment = deployments[network];
  // Every stack's factory: a relayed stake is for a market of any of them.
  const factories = stacksOf(deployment).flatMap((s) => (s.contracts.factory ? [s.contracts.factory] : []));
  const usdc = collateralOf(deployment);
  const chainId = deployment.chainId;
  const requireDeployed = (): { factories: Address[]; usdc: Address } => {
    if (factories.length === 0 || !usdc) throw new Error(`Hunch Book is not deployed on ${network}.`);
    return { factories, usdc };
  };
  return {
    relayer: c.relayer,
    chainId,
    async checkMarket(r: RelayStakeRequest): Promise<MarketCheck> {
      const d = requireDeployed();
      const answers = await Promise.all(
        d.factories.map((factory) =>
          c.publicClient.readContract({
            address: factory,
            abi: hunchBookFactoryAbi,
            functionName: "isMarket",
            args: [r.market],
          }),
        ),
      );
      const isMarket = answers.some(Boolean);
      if (!isMarket) return { isMarket, phase: -1, nonce: "0x", minStake: 0n };
      const [phase, nonce, caps] = await c.publicClient.multicall({
        allowFailure: false,
        multicallAddress: MULTICALL3,
        contracts: [
          { address: r.market, abi: marketAbi, functionName: "phase" },
          {
            address: r.market,
            abi: marketAbi,
            functionName: "authorizationNonce",
            args: [r.user, r.side, r.salt],
          },
          { address: r.market, abi: marketAbi, functionName: "caps" },
        ],
      });
      return { isMarket, phase: Number(phase), nonce, minStake: BigInt(caps.minStake) };
    },
    usdcDomain() {
      const d = requireDeployed();
      c.domain ??= readUsdcDomain(c.publicClient, d.usdc, chainId).catch((error) => {
        c.domain = undefined;
        throw error;
      });
      return c.domain;
    },
    async tokenState(user: Address, nonce: Hex) {
      const d = requireDeployed();
      const [used, balance] = await c.publicClient.multicall({
        allowFailure: false,
        multicallAddress: MULTICALL3,
        contracts: [
          { address: d.usdc, abi: usdcDomainAbi, functionName: "authorizationState", args: [user, nonce] },
          { address: d.usdc, abi: erc20Abi, functionName: "balanceOf", args: [user] },
        ],
      });
      return { used, balance };
    },
    submit(r: RelayStakeRequest) {
      return c.send(async () => {
        const request = {
          address: r.market,
          abi: withKnownErrors(marketAbi as Abi),
          functionName: "stakeWithAuthorization",
          args: [r.user, r.side, r.amount, r.validAfter, r.validBefore, r.salt, r.signature],
          account: c.relayer,
        } as const;
        try {
          await c.publicClient.simulateContract(request);
          const gas = await c.publicClient.estimateContractGas(request);
          return await c.wallet.writeContract({
            ...request,
            account: c.wallet.account ?? c.relayer,
            chain: c.wallet.chain,
            gas: withHeadroom(gas),
          });
        } catch (error) {
          throw new Error(describeTxError(error));
        }
      });
    },
    txUrl: (hash) => txUrl(deployment, hash),
  };
}

export function dripDeps(): RelayerDeps<DripChain> {
  const { config, store } = base();
  return { config, store, chain: dripChain, now: Date.now, defaultNetwork: appNetwork };
}

export function relayDeps(): RelayerDeps<RelayChain> {
  const { config, store } = base();
  return { config, store, chain: relayChain, now: Date.now, defaultNetwork: appNetwork };
}

export function relayerConfig(): RelayerConfig {
  return base().config;
}

/**
 * The caller's IP for per-IP caps. On Vercel, x-forwarded-for is set by the platform; elsewhere the
 * first hop is used. Requests without one share a single bucket.
 */
export function clientIp(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || headers.get("x-real-ip")?.trim() || "unknown";
}

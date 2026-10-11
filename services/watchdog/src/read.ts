import {
  collateralOf,
  collateralVaultAbi,
  type Deployment,
  hunchBookFactoryAbi,
  marketAbi,
  type Network,
  type Stack,
  stacksOf,
} from "@hunch-book/shared";
import { type Address, erc20Abi, type PublicClient } from "viem";
import type { MarketSnapshot, ServiceHealth, Snapshot, VaultSnapshot } from "./checks.js";

// Reads one snapshot of the chain with four multicalls per stack, however many markets it has, so a
// rate-limited public RPC sees a handful of requests per run. Every value comes from contracts listed
// in deployments/<network>.json; the only offchain inputs are the optional health URLs.

export interface ReadOptions {
  network: Network;
  deployment: Deployment;
  keeperHealthUrl?: string;
  makerHealthUrl?: string;
  fetchImpl?: typeof fetch;
}

const BLOCK_SAMPLE = 10_000n;

/** The reads each market gets, in this order, in its stack's one market multicall. */
const MARKET_READS = [
  "templateId",
  "phase",
  "outcome",
  "window",
  "graduated",
  "graduationRuleMet",
  "tokens",
] as const;

interface MarketWindow {
  blockClock: boolean;
  lock: bigint;
  close: bigint;
  settleDeadline: bigint;
}

async function readHealth(
  name: "keeper" | "maker",
  url: string | undefined,
  fetchImpl: typeof fetch,
): Promise<ServiceHealth | undefined> {
  if (!url) return undefined;
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return { name, error: `HTTP ${res.status}` };
    const body = (await res.json()) as { lastCycleAt?: string };
    return { name, lastCycleAt: body.lastCycleAt };
  } catch (error) {
    return { name, error: error instanceof Error ? error.name : "unreachable" };
  }
}

/** One stack's vault and markets at `blockNumber`. */
async function readStack(
  client: PublicClient,
  stack: Stack,
  usdc: Address,
  blockNumber: bigint,
): Promise<{ vault: VaultSnapshot; markets: MarketSnapshot[] }> {
  const factory = stack.contracts.factory as Address;
  const vault = stack.contracts.vault;
  if (!vault) throw new Error(`stack ${stack.name} has a factory but no vault in the deployments file`);
  const at = { blockNumber };
  const [vaultBalance, vaultObligations, count] = await client.multicall({
    ...at,
    allowFailure: false,
    contracts: [
      { address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [vault] },
      { address: vault, abi: collateralVaultAbi, functionName: "totalObligations" },
      { address: factory, abi: hunchBookFactoryAbi, functionName: "marketCount" },
    ],
  });
  const snapshotVault = {
    stack: stack.name,
    address: vault,
    balance: vaultBalance,
    obligations: vaultObligations,
  };
  if (count === 0n) return { vault: snapshotVault, markets: [] };

  const addresses = (await client.multicall({
    ...at,
    allowFailure: false,
    contracts: Array.from({ length: Number(count) }, (_, i) => ({
      address: factory,
      abi: hunchBookFactoryAbi,
      functionName: "marketAt" as const,
      args: [BigInt(i)] as const,
    })),
  })) as Address[];

  // Every market's fields in one multicall, then every market's supplies and ledger in one more.
  const fields = (await client.multicall({
    ...at,
    allowFailure: false,
    contracts: addresses.flatMap((address) =>
      MARKET_READS.map((functionName) => ({ address, abi: marketAbi, functionName })),
    ),
  })) as unknown[];
  const read = addresses.map((address, i) => {
    const f = fields.slice(i * MARKET_READS.length, (i + 1) * MARKET_READS.length);
    return {
      address,
      templateId: Number(f[0]),
      phase: Number(f[1]),
      outcome: Number(f[2]),
      window: f[3] as MarketWindow,
      graduated: f[4] as boolean,
      ruleMet: f[5] as boolean,
      tokens: f[6] as readonly [Address, Address],
    };
  });
  const supplies = (await client.multicall({
    ...at,
    allowFailure: false,
    contracts: read.flatMap((m) => [
      { address: m.tokens[0], abi: erc20Abi, functionName: "totalSupply" },
      { address: m.tokens[1], abi: erc20Abi, functionName: "totalSupply" },
      { address: vault, abi: collateralVaultAbi, functionName: "ledger", args: [m.address] },
    ]),
  })) as unknown[];

  const markets = read.map(
    (m, i): MarketSnapshot => ({
      address: m.address,
      stack: stack.name,
      templateId: m.templateId,
      phase: m.phase,
      outcome: m.outcome,
      blockClock: m.window.blockClock,
      lock: m.window.lock,
      close: m.window.close,
      settleDeadline: m.window.settleDeadline,
      graduated: m.graduated,
      ruleMet: m.ruleMet,
      yesSupply: supplies[i * 3] as bigint,
      noSupply: supplies[i * 3 + 1] as bigint,
      sets: (supplies[i * 3 + 2] as { sets: bigint }).sets,
    }),
  );
  return { vault: snapshotVault, markets };
}

/**
 * Every stack's vault and markets (the primary first), the service wallets' gas and the services'
 * health, all at one block. New markets on testnet go to the `hunch` stack, so every stack is read.
 */
export async function readSnapshot(client: PublicClient, o: ReadOptions): Promise<Snapshot> {
  const stacks = stacksOf(o.deployment);
  const fallbackUsdc = collateralOf(o.deployment);
  if (stacks.length === 0 || !fallbackUsdc) throw new Error(`${o.network} has no Hunch Book deployment yet`);

  const head = await client.getBlock();
  const earlier = await client.getBlock({ blockNumber: head.number - BLOCK_SAMPLE });
  const secondsPerBlock = Number(head.timestamp - earlier.timestamp) / Number(BLOCK_SAMPLE);
  const at = { blockNumber: head.number };

  const vaults: VaultSnapshot[] = [];
  const markets: MarketSnapshot[] = [];
  // One stack after another, so the RPC never sees more than one multicall in flight.
  for (const stack of stacks) {
    const read = await readStack(client, stack, stack.contracts.usdc ?? fallbackUsdc, head.number);
    vaults.push(read.vault);
    markets.push(...read.markets);
  }

  const keeper = await client.getBalance({ address: o.deployment.wallets.keeper, ...at });
  const maker = await client.getBalance({ address: o.deployment.wallets.maker, ...at });

  const fetchImpl = o.fetchImpl ?? fetch;
  const services = (
    await Promise.all([
      readHealth("keeper", o.keeperHealthUrl, fetchImpl),
      readHealth("maker", o.makerHealthUrl, fetchImpl),
    ])
  ).filter((h): h is ServiceHealth => h !== undefined);

  return {
    network: o.network,
    block: head.number,
    timestamp: Number(head.timestamp),
    secondsPerBlock,
    vaults,
    markets,
    balances: { keeper, maker },
    services,
  };
}

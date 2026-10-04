import {
  chainsByNetwork,
  collateralOf,
  collateralVaultAbi,
  type Deployment,
  hunchBookFactoryAbi,
  marketAbi,
  type Network,
} from "@hunch-book/shared";
import { type Address, createPublicClient, erc20Abi, http, type PublicClient } from "viem";
import type { MarketSnapshot, ServiceHealth, Snapshot } from "./checks.js";

// Reads one snapshot of the chain with a handful of multicalls. Every value comes from contracts
// listed in deployments/<network>.json; the only offchain inputs are the optional health URLs.

export interface ReadOptions {
  network: Network;
  deployment: Deployment;
  rpcUrl: string;
  keeperHealthUrl?: string;
  makerHealthUrl?: string;
  fetchImpl?: typeof fetch;
}

const BLOCK_SAMPLE = 10_000n;

export function makeClient(network: Network, rpcUrl: string): PublicClient {
  return createPublicClient({ chain: chainsByNetwork[network], transport: http(rpcUrl, { retryCount: 3 }) });
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

export async function readSnapshot(client: PublicClient, o: ReadOptions): Promise<Snapshot> {
  const { factory, vault } = o.deployment.hunchBook;
  const usdc = collateralOf(o.deployment);
  if (!factory || !vault || !usdc) throw new Error(`${o.network} has no Hunch Book deployment yet`);

  const head = await client.getBlock();
  const earlier = await client.getBlock({ blockNumber: head.number - BLOCK_SAMPLE });
  const secondsPerBlock = Number(head.timestamp - earlier.timestamp) / Number(BLOCK_SAMPLE);
  const at = { blockNumber: head.number };

  const [vaultBalance, vaultObligations, count] = await client.multicall({
    ...at,
    allowFailure: false,
    contracts: [
      { address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [vault] },
      { address: vault, abi: collateralVaultAbi, functionName: "totalObligations" },
      { address: factory, abi: hunchBookFactoryAbi, functionName: "marketCount" },
    ],
  });

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

  const markets: MarketSnapshot[] = [];
  for (const address of addresses) {
    const m = { address, abi: marketAbi } as const;
    const [templateId, phase, outcome, window, graduated, ruleMet, tokens] = await client.multicall({
      ...at,
      allowFailure: false,
      contracts: [
        { ...m, functionName: "templateId" },
        { ...m, functionName: "phase" },
        { ...m, functionName: "outcome" },
        { ...m, functionName: "window" },
        { ...m, functionName: "graduated" },
        { ...m, functionName: "graduationRuleMet" },
        { ...m, functionName: "tokens" },
      ],
    });
    const [yes, no] = tokens;
    const [yesSupply, noSupply, ledger] = await client.multicall({
      ...at,
      allowFailure: false,
      contracts: [
        { address: yes, abi: erc20Abi, functionName: "totalSupply" },
        { address: no, abi: erc20Abi, functionName: "totalSupply" },
        { address: vault, abi: collateralVaultAbi, functionName: "ledger", args: [address] },
      ],
    });
    markets.push({
      address,
      templateId: Number(templateId),
      phase: Number(phase),
      outcome: Number(outcome),
      blockClock: window.blockClock,
      lock: window.lock,
      close: window.close,
      settleDeadline: window.settleDeadline,
      graduated,
      ruleMet,
      yesSupply,
      noSupply,
      sets: (ledger as { sets: bigint }).sets,
    });
  }

  const [keeper, maker] = await Promise.all([
    client.getBalance({ address: o.deployment.wallets.keeper, ...at }),
    client.getBalance({ address: o.deployment.wallets.maker, ...at }),
  ]);

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
    vaultBalance,
    vaultObligations,
    markets,
    balances: { keeper, maker },
    services,
  };
}

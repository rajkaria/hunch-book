import {
  collateralOf,
  collateralVaultAbi,
  type Deployment,
  hunchBookFactoryAbi,
  Phase,
} from "@hunch-book/shared";
import { type Abi, type Address, erc20Abi, type PublicClient } from "viem";
import { MULTICALL3 } from "../chain/client";
import { readVaultBooks } from "../chain/landing";
import { listMarkets } from "../chain/reads";
import type { MarketView } from "../market/types";
import { findSettlementTx, type VerifyClient } from "../verify/read";
import {
  countMarkets,
  type LedgerRead,
  type MarketSolvency,
  marketBacking,
  type ProofData,
  type SettlementTiming,
  type VaultBalance,
  vaultBalance,
} from "./metrics";

// The proof page from the chain alone: market counts from the factory, the vault's books, and each
// listed market's ledger and token supplies. Wallets, all-time fills and timings across every market
// need the indexer; the latest settlements can be timed from archive reads on request.

export type ProofClient = Pick<PublicClient, "readContract" | "multicall" | "getBlock">;

type Result = { status: "success"; result: unknown } | { status: "failure"; error: Error };

interface LedgerTuple {
  pool: bigint;
  sets: bigint;
}

/** The vault's balance and obligations, read together. Null when the vault or USDC is unknown. */
export async function readVault(client: ProofClient, deployment: Deployment): Promise<VaultBalance | null> {
  const vault = deployment.hunchBook.vault;
  const usdc = collateralOf(deployment);
  if (!vault || !usdc) return null;
  const books = await readVaultBooks(client, vault, usdc);
  return vaultBalance(books.balance, books.obligations);
}

/** Each market's ledger and its YES and NO supply, in one multicall. */
export async function readBacking(
  client: ProofClient,
  vault: Address,
  markets: readonly MarketView[],
): Promise<MarketSolvency[]> {
  if (markets.length === 0) return [];
  const PER = 3;
  const results = (await client.multicall({
    contracts: markets.flatMap((m) => [
      { address: vault, abi: collateralVaultAbi as Abi, functionName: "ledger", args: [m.address] },
      { address: m.tokens.yes, abi: erc20Abi as Abi, functionName: "totalSupply" },
      { address: m.tokens.no, abi: erc20Abi as Abi, functionName: "totalSupply" },
    ]) as never,
    allowFailure: true,
    multicallAddress: MULTICALL3,
  })) as Result[];
  return markets.map((m, i) => {
    const ledger = results[i * PER];
    const yes = results[i * PER + 1];
    const no = results[i * PER + 2];
    const l: LedgerRead | null =
      ledger?.status === "success"
        ? {
            pool: BigInt((ledger.result as LedgerTuple).pool),
            sets: BigInt((ledger.result as LedgerTuple).sets),
          }
        : null;
    const supply =
      yes?.status === "success" && no?.status === "success"
        ? { yes: yes.result as bigint, no: no.result as bigint }
        : null;
    return marketBacking(m, l, supply);
  });
}

/** Everything the chain can answer for the proof page. */
export async function readProofFromChain(
  client: ProofClient,
  deployment: Deployment,
): Promise<ProofData & { listed: MarketView[] }> {
  const factory = deployment.hunchBook.factory;
  if (!factory) throw new Error("The contracts are not deployed on this network.");
  const [list, vault] = await Promise.all([listMarkets(client, deployment), readVault(client, deployment)]);
  const markets = list.status === "ok" ? list.data.markets : [];
  const total =
    list.status === "ok"
      ? list.data.total
      : Number(
          await client.readContract({
            address: factory,
            abi: hunchBookFactoryAbi,
            functionName: "marketCount",
          }),
        );
  const vaultAddress = deployment.hunchBook.vault;
  const perMarket = vaultAddress ? await readBacking(client, vaultAddress, markets) : [];
  return {
    markets: countMarkets(total, markets),
    wallets: null,
    trades: null,
    timing: null,
    settlements: [],
    vault,
    perMarket,
    daily: [],
    negative: [],
    listed: markets,
  };
}

// ---------- settlement timing from archive reads ----------

export type TimingClient = VerifyClient & Pick<PublicClient, "getBlockNumber">;

/** Probes per round when searching past blocks. */
const PROBES = 8n;

/**
 * The first block in (lo, hi] where `hit` holds, given it does not hold at lo, holds at hi, and stays
 * true once it holds. Eight probes per round, so about six rounds for a day of Monad blocks.
 */
export async function firstBlockWhere(
  lo: bigint,
  hi: bigint,
  hit: (block: bigint) => Promise<boolean>,
): Promise<bigint> {
  let a = lo;
  let b = hi;
  while (b - a > 1n) {
    const gap = b - a;
    const count = gap - 1n < PROBES ? gap - 1n : PROBES;
    const probes = [
      ...new Set(Array.from({ length: Number(count) }, (_, n) => a + (gap * BigInt(n + 1)) / (count + 1n))),
    ];
    const hits = await Promise.all(probes.map(hit));
    let nextA = a;
    let nextB = b;
    for (let i = 0; i < probes.length; i++) {
      if (hits[i]) {
        nextB = probes[i] as bigint;
        break;
      }
      nextA = probes[i] as bigint;
    }
    a = nextA;
    b = nextB;
  }
  return b;
}

/** What the vault owes the market for its holders at a block: sets once graduated, else the pool. */
async function owedAt(
  client: TimingClient,
  vault: Address,
  m: MarketView,
  block: bigint,
): Promise<bigint | null> {
  try {
    const ledger = (await client.readContract({
      address: vault,
      abi: collateralVaultAbi,
      functionName: "ledger",
      args: [m.address],
      blockNumber: block,
    })) as unknown as LedgerTuple;
    return BigInt(m.graduated ? ledger.sets : ledger.pool);
  } catch {
    return null;
  }
}

/**
 * Times one final market from the chain: the settlement (or void) transaction, how long after the
 * close it came, and when the first redemption or pool claim followed (the first block where what the
 * vault owes the market's holders dropped).
 */
export async function measureSettlement(
  client: TimingClient,
  deployment: Deployment,
  m: MarketView,
  head: bigint,
): Promise<SettlementTiming | null> {
  const from = m.window.blockClock ? m.window.close : BigInt(deployment.hunchBook.deployBlock ?? 0);
  const tx = await findSettlementTx(client, m, from, head);
  if (!tx) return null;
  const latency = m.window.blockClock ? tx.block - m.window.close : BigInt(tx.time) - m.window.close;
  let toFirstRedemption: bigint | null = null;
  const vault = deployment.hunchBook.vault;
  if (vault) {
    const atSettle = await owedAt(client, vault, m, tx.block);
    const now = await owedAt(client, vault, m, head);
    if (atSettle !== null && now !== null && now < atSettle) {
      const first = await firstBlockWhere(tx.block, head, async (b) => {
        const owed = await owedAt(client, vault, m, b);
        return owed !== null && owed < atSettle;
      });
      const block = await client.getBlock({ blockNumber: first });
      toFirstRedemption = BigInt(block.timestamp) - BigInt(tx.time);
    }
  }
  return {
    market: m.address,
    number: Number(m.marketId),
    question: m.description,
    voided: tx.kind === "voided",
    outcome:
      tx.kind === "voided" ? null : m.phase === Phase.Settled ? (m.outcome === 2 ? "No" : "Yes") : null,
    early: !m.window.blockClock && latency < 0n,
    latency,
    latencyUnit: m.window.blockClock ? "blocks" : "seconds",
    settledAt: tx.time,
    block: tx.block,
    tx: tx.hash,
    toFirstRedemption,
  };
}

/** The markets to time from the chain: the newest final ones. */
export function latestFinal(markets: readonly MarketView[], count = 5): MarketView[] {
  return markets.filter((m) => m.phase === Phase.Settled || m.phase === Phase.Voided).slice(0, count);
}

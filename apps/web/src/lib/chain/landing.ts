import {
  collateralOf,
  collateralVaultAbi,
  type Deployment,
  type GraduationRule,
  hunchBookFactoryAbi,
  Phase,
  stacksOf,
  TemplateId,
} from "@hunch-book/shared";
import { type Address, erc20Abi } from "viem";
import type { TitleClock } from "../market/title";
import type { MarketView } from "../market/types";
import { MULTICALL3, type ReadClient } from "./client";
import { listMarkets, MARKET_LIST_LIMIT, measureMsPerBlock, readChainHead } from "./reads";

// What the landing page shows from the chain. Every field is either read now or absent:
// a failed read hides that line, it never falls back to a made-up number.

export interface VaultBooks {
  /** USDC the vault holds, in base units. */
  balance: bigint;
  /** USDC the vault owes: every pool, every complete set and unpaid fees. Balance never drops below it. */
  obligations: bigint;
}

/** Counts over the markets the page read (the newest MARKET_LIST_LIMIT). */
export interface LandingStats {
  /** How many markets the counts cover. Equal to marketCount unless there are more than the limit. */
  listed: number;
  /** Markets that graduated into their own Kuru book. */
  graduated: number;
  /** Of those, how many were created by Hunch Book's own wallets. */
  graduatedByUs: number;
  /** Markets created by Hunch Book's own wallets. */
  createdByUs: number;
  /** Markets open right now: pools taking stakes plus books trading. */
  open: number;
  /** Markets settled with an answer from their resolver. */
  settled: number;
}

export interface LandingSnapshot {
  marketCount: number;
  /** The newest market from the factory, or null when there are none. */
  newest: MarketView | null;
  /** The market the hero shows: a live book first, then the biggest open pool (see pickFeatured). */
  featured: MarketView | null;
  /** Counts over the listed markets, or null if the list could not be read. */
  stats: LandingStats | null;
  /**
   * The vault's books, read in one call so both numbers come from the same block: the USDC it holds
   * (USDC.balanceOf(vault)) and what it owes (vault.totalObligations: pools, sets and fees).
   */
  vault: VaultBooks | null;
  /** The graduation rule new Perpl funding markets get, from factory.templateOf. */
  rule: GraduationRule | null;
  /** Average block time over the last 10,000 blocks, in milliseconds. */
  msPerBlock: number | null;
  /** The block the snapshot was read at. */
  block: bigint | null;
  /** That block's unix time, so block numbers can be read as estimated clock times. */
  blockTime: number | null;
}

export type LandingRead =
  /** In the browser, while another network than the server's is read. */
  | { status: "loading" }
  | { status: "not-deployed" }
  | { status: "error" }
  | { status: "ok"; data: LandingSnapshot };

/** Addresses that belong to Hunch Book itself: its guardian (the deployer), fee recipient, maker and keeper. */
export function ourAddresses(deployment: Deployment): Address[] {
  const stacks = stacksOf(deployment).map((s) => s.contracts);
  const all = [
    deployment.hunchBook.guardian,
    deployment.hunchBook.feeRecipient,
    ...stacks.flatMap((c) => [c.guardian, c.feeRecipient]),
    deployment.wallets.maker,
    deployment.wallets.keeper,
  ].filter((a): a is Address => Boolean(a));
  return all.filter((a, i) => all.findIndex((b) => b.toLowerCase() === a.toLowerCase()) === i);
}

/** True when a market was created by one of Hunch Book's own wallets. */
export function isSeededByUs(deployment: Deployment, creator: Address): boolean {
  const c = creator.toLowerCase();
  return ourAddresses(deployment).some((a) => a.toLowerCase() === c);
}

/** Lower comes first: a live book, then a pool taking stakes, then markets waiting to settle, then done. */
const PHASE_RANK: Record<Phase, number> = {
  [Phase.Graduated]: 0,
  [Phase.Pool]: 1,
  [Phase.Closed]: 2,
  [Phase.PoolLocked]: 3,
  [Phase.Settled]: 4,
  [Phase.Voided]: 5,
};

/**
 * The market to put in the hero: the most active one by a simple, stated rule. A market trading on
 * its Kuru book beats a pool, a pool beats one waiting to settle, and within a phase the bigger pool
 * wins (newest first on a tie).
 */
export function pickFeatured(markets: readonly MarketView[]): MarketView | null {
  let best: MarketView | null = null;
  for (const m of markets) {
    if (!best) {
      best = m;
      continue;
    }
    const rank = (PHASE_RANK[m.phase] ?? 9) - (PHASE_RANK[best.phase] ?? 9);
    if (rank < 0) best = m;
    else if (rank === 0) {
      if (m.pool.total > best.pool.total) best = m;
      else if (m.pool.total === best.pool.total && m.marketId > best.marketId) best = m;
    }
  }
  return best;
}

/** Counts for the live numbers strip, with our own markets counted apart. */
export function summarize(deployment: Deployment, markets: readonly MarketView[]): LandingStats {
  let graduated = 0;
  let graduatedByUs = 0;
  let createdByUs = 0;
  let open = 0;
  let settledCount = 0;
  for (const m of markets) {
    const ours = isSeededByUs(deployment, m.creator);
    if (ours) createdByUs++;
    if (m.graduated) {
      graduated++;
      if (ours) graduatedByUs++;
    }
    if (m.phase === Phase.Pool || m.phase === Phase.Graduated) open++;
    if (m.phase === Phase.Settled) settledCount++;
  }
  return { listed: markets.length, graduated, graduatedByUs, createdByUs, open, settled: settledCount };
}

const settled = <T>(r: PromiseSettledResult<T>): T | null => (r.status === "fulfilled" ? r.value : null);

/** The vault's balance and obligations in one eth_call (Multicall3), so they describe the same block. */
export async function readVaultBooks(client: ReadClient, vault: Address, usdc: Address): Promise<VaultBooks> {
  const [balance, obligations] = await client.multicall({
    contracts: [
      { address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [vault] },
      { address: vault, abi: collateralVaultAbi, functionName: "totalObligations" },
    ],
    allowFailure: true,
    multicallAddress: MULTICALL3,
  });
  if (balance?.status !== "success" || obligations?.status !== "success") {
    throw new Error("Could not read the vault's books.");
  }
  return { balance: balance.result, obligations: obligations.result };
}

/** The snapshot's chain clock, for titles that read block numbers as times; null if any part is missing. */
export function landingClock(
  data: Pick<LandingSnapshot, "block" | "blockTime" | "msPerBlock">,
): TitleClock | null {
  if (data.block === null || data.blockTime === null || data.msPerBlock === null) return null;
  return { blockNumber: data.block, timestamp: data.blockTime, msPerBlock: data.msPerBlock };
}

/** Every stack's vault books, summed (each stack has its own vault). */
export async function readAllVaultBooks(
  client: ReadClient,
  deployment: Deployment,
  usdc: Address,
): Promise<VaultBooks | null> {
  const vaults = stacksOf(deployment).flatMap((s) => (s.contracts.vault ? [s.contracts.vault] : []));
  if (vaults.length === 0) return null;
  const books = await Promise.all(vaults.map((v) => readVaultBooks(client, v, usdc)));
  return {
    balance: books.reduce((sum, b) => sum + b.balance, 0n),
    obligations: books.reduce((sum, b) => sum + b.obligations, 0n),
  };
}

/** Reads the landing page's live data. Never throws. */
export async function readLandingSnapshot(
  client: ReadClient,
  deployment: Deployment,
  timeoutMs = 6_000,
): Promise<LandingRead> {
  const factory = deployment.hunchBook.factory;
  if (!factory) return { status: "not-deployed" };

  const work = (async (): Promise<LandingRead> => {
    // Markets of every stack (testnet: the Kuru v2 stack next to the primary one).
    const counts = await Promise.all(
      stacksOf(deployment).map(async (s) =>
        Number(
          await client.readContract({
            address: s.contracts.factory as Address,
            abi: hunchBookFactoryAbi,
            functionName: "marketCount",
          }),
        ),
      ),
    );
    const count = counts.reduce((sum, c) => sum + c, 0);
    const usdc = collateralOf(deployment);
    const [list, template, pace, books] = await Promise.allSettled([
      (async () => {
        if (count === 0) return [];
        const result = await listMarkets(client, deployment, { limit: MARKET_LIST_LIMIT });
        return result.status === "ok" ? result.data.markets : [];
      })(),
      client.readContract({
        address: factory,
        abi: hunchBookFactoryAbi,
        functionName: "templateOf",
        args: [TemplateId.PerplFunding],
      }),
      (async () => {
        const head = await readChainHead(client);
        return {
          block: head.blockNumber,
          time: head.timestamp,
          ms: await measureMsPerBlock(client, head.blockNumber),
        };
      })(),
      usdc ? readAllVaultBooks(client, deployment, usdc) : Promise.resolve(null),
    ]);
    const tmpl = settled(template);
    const rule: GraduationRule | null =
      tmpl && BigInt(tmpl.rule.minPool) > 0n
        ? {
            minPool: BigInt(tmpl.rule.minPool),
            minStakers: Number(tmpl.rule.minStakers),
            minChanceBps: Number(tmpl.rule.minChanceBps),
            maxChanceBps: Number(tmpl.rule.maxChanceBps),
          }
        : null;
    const markets = settled(list);
    return {
      status: "ok",
      data: {
        marketCount: count,
        newest: markets?.[0] ?? null,
        featured: markets ? pickFeatured(markets) : null,
        stats: markets ? summarize(deployment, markets) : null,
        vault: settled(books),
        rule,
        msPerBlock: settled(pace)?.ms ?? null,
        block: settled(pace)?.block ?? null,
        blockTime: settled(pace)?.time ?? null,
      },
    };
  })();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<LandingRead>((resolve) => {
    timer = setTimeout(() => resolve({ status: "error" }), timeoutMs);
  });
  try {
    return await Promise.race([work, timeout]);
  } catch {
    return { status: "error" };
  } finally {
    clearTimeout(timer);
  }
}

import { collateralVaultAbi, type Deployment, splitFee, stackNamed, stacksOf } from "@hunch-book/shared";
import { type Address, type Hex, isAddressEqual } from "viem";
import type { ReadClient } from "../chain/client";
import { isSeededByUs } from "../chain/landing";
import { listMarkets } from "../chain/reads";
import type { IndexerClient } from "../indexer/client";
import { address, big, hash } from "../indexer/parse";
import { CREATOR_QUERY, type CreatorResult } from "../indexer/queries";
import { phaseLabel } from "../market/logic";
import { marketTag, marketVenueLabel } from "../stacks";

// A creator's page (C-7): the markets an address created, their state and volume, and the creator's
// share of Hunch Book's fee (CREATOR_SHARE_BPS of every fee). What the vaults owe the creator now is
// always read live from each stack's vault (a market's fees accrue in its own stack's vault); the
// all-time totals, per-market earnings and withdrawals come from the indexer.

export interface CreatorMarket {
  market: Address;
  number: number | null;
  /** Read from the chain: "#3", "#3 · Kuru" (lib/stacks.ts marketTag), which tells stacks apart. */
  tag?: string;
  question: string | null;
  stage: string;
  /** USDC staked in the pool. */
  pool: bigint;
  stakers: number;
  /** Indexer only: book volume and fills. */
  volume: bigint | null;
  fills: number | null;
  /** Indexer only: the creator's share of the fees this market paid. */
  earned: bigint | null;
  createdAt: number | null;
  createdTx: Hex | null;
}

export interface Withdrawal {
  amount: bigint;
  time: number;
  block: bigint;
  tx: Hex;
}

export interface CreatorData {
  creator: Address;
  /** One of Hunch Book's own wallets. */
  isOurs: boolean;
  markets: CreatorMarket[];
  /** Chain reads only: how many markets the factory has, and how many the list covered. */
  scanned: { covered: number; total: number } | null;
  /** Indexer only. */
  earned: bigint | null;
  withdrawn: bigint | null;
  withdrawals: Withdrawal[] | null;
}

const STAGE: Record<string, string> = {
  Pool: "Pool",
  Graduated: "Trading",
  Settled: "Settled",
  Voided: "Voided",
};

/** Rows per list on the creator page. */
export const CREATOR_LIMIT = 200;

export function creatorFromIndexer(creator: Address, r: CreatorResult): CreatorData {
  const earnedBy = new Map<string, bigint>();
  for (const a of r.accruals) {
    const key = a.market?.id?.toLowerCase();
    if (!key) continue;
    earnedBy.set(key, (earnedBy.get(key) ?? 0n) + splitFee(big(a.amount)).creator);
  }
  return {
    creator,
    isOurs: r.Creator_by_pk?.isOurs ?? false,
    markets: r.Market.map((m) => ({
      market: address(m.id),
      number: m.number,
      question: m.question,
      stage:
        m.stage === "Settled" ? `Settled ${m.outcome === "No" ? "NO" : "YES"}` : (STAGE[m.stage] ?? m.stage),
      pool: big(m.poolTotal),
      stakers: m.stakerCount,
      volume: big(m.volume),
      fills: m.fillCount,
      earned: earnedBy.get(m.id.toLowerCase()) ?? 0n,
      createdAt: Number(big(m.createdAt)),
      createdTx: hash(m.createdTx),
    })),
    scanned: null,
    earned: r.Creator_by_pk ? big(r.Creator_by_pk.feesAccrued) : 0n,
    withdrawn: r.Creator_by_pk ? big(r.Creator_by_pk.feesWithdrawn) : 0n,
    withdrawals: r.withdrawals.map((w) => ({
      amount: big(w.amount),
      time: Number(big(w.timestamp)),
      block: big(w.block),
      tx: hash(w.tx),
    })),
  };
}

export async function creatorFromIndexerClient(
  client: IndexerClient,
  creator: Address,
): Promise<CreatorData> {
  const result = await client.query<CreatorResult>(CREATOR_QUERY, {
    id: creator.toLowerCase(),
    limit: CREATOR_LIMIT,
  });
  return creatorFromIndexer(creator, result);
}

/** The creator's markets among the newest ones the chain lists. */
export async function creatorFromChain(
  client: ReadClient,
  deployment: Deployment,
  creator: Address,
): Promise<CreatorData> {
  const list = await listMarkets(client, deployment);
  const markets = list.status === "ok" ? list.data.markets : [];
  return {
    creator,
    isOurs: isSeededByUs(deployment, creator),
    markets: markets
      .filter((m) => isAddressEqual(m.creator, creator))
      .map((m) => ({
        market: m.address,
        number: Number(m.marketId),
        tag: marketTag(m),
        question: m.description,
        stage: phaseLabel(m.phase),
        pool: m.pool.total,
        stakers: m.pool.stakers,
        volume: null,
        fills: null,
        earned: null,
        createdAt: null,
        createdTx: null,
      })),
    scanned: list.status === "ok" ? { covered: markets.length, total: list.data.total } : null,
    earned: null,
    withdrawn: null,
    withdrawals: null,
  };
}

/** What the vault owes the creator right now: what `withdrawCreatorFees` would pay. */
export async function readCreatorFees(
  client: Pick<ReadClient, "readContract">,
  deployment: Deployment,
  creator: Address,
  stackName = "primary",
): Promise<bigint | null> {
  const vault = stackNamed(deployment, stackName)?.contracts.vault;
  if (!vault) return null;
  return client.readContract({
    address: vault,
    abi: collateralVaultAbi,
    functionName: "creatorFees",
    args: [creator],
  });
}

/** What one stack's vault owes the creator. */
export interface StackFees {
  /** "primary" or a key under `stacks`. */
  stack: string;
  /** "Kuru", "Kuru v2" or "Hunch order book": the stack's venue, to tell vaults apart. */
  label: string;
  vault: Address;
  fees: bigint;
}

/** What every stack's vault owes the creator right now: what `withdrawCreatorFees` on each would pay. */
export async function readCreatorFeesByStack(
  client: Pick<ReadClient, "readContract">,
  deployment: Deployment,
  creator: Address,
): Promise<StackFees[]> {
  const stacks = stacksOf(deployment).flatMap((st) =>
    st.contracts.vault ? [{ stack: st, vault: st.contracts.vault }] : [],
  );
  const fees = await Promise.all(
    stacks.map(({ vault }) =>
      client.readContract({
        address: vault,
        abi: collateralVaultAbi,
        functionName: "creatorFees",
        args: [creator],
      }),
    ),
  );
  return stacks.map(({ stack, vault }, i) => ({
    stack: stack.name,
    label: marketVenueLabel(stack),
    vault,
    fees: fees[i] ?? 0n,
  }));
}

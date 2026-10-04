import { formatBps, formatUsdc, type MarketInfo } from "@hunch-book/sdk";
import { collateralVaultAbi } from "@hunch-book/shared";
import { cached } from "./cache";
import type { ApiDeps } from "./deps";
import { allMarkets, PHASE_NAMES } from "./markets";

// Protocol totals. From the chain: markets by phase and template, USDC still in open pools, and the
// vault's balance against everything it owes (the solvency check of docs/PROTOCOL.md §5.1). From the
// indexer, when configured: wallets, fills and volume, each with the part that is Hunch Book's own
// (our maker bot's fills are counted separately, CLAUDE.md rule 4).

const ACTIVITY_QUERY = `query Stats($id: String!) {
  ProtocolStats_by_pk(id: $id) {
    wallets ourWallets externalWallets stakeCount stakedUsdc stakeCountOurs stakedUsdcOurs
    fillCount fillCountOurMaker fillCountBetweenOthers volume volumeOurMaker volumeBetweenOthers
    ourMakerShareBps ourMakerVolumeShareBps routerTradeCount routerVolume redemptionCount redeemedUsdc
    updatedAtBlock
  }
}`;

type Activity = Record<string, string | number>;

async function indexerActivity(deps: ApiDeps): Promise<Activity | null> {
  if (!deps.indexerUrl) return null;
  const res = await deps.fetch(deps.indexerUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: ACTIVITY_QUERY, variables: { id: String(deps.deployment.chainId) } }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`The indexer answered HTTP ${res.status}.`);
  const body = (await res.json()) as { data?: { ProtocolStats_by_pk?: Activity | null } };
  return body.data?.ProtocolStats_by_pk ?? null;
}

const usdc = (v: string | number | undefined): string | null =>
  v === undefined ? null : formatUsdc(BigInt(v));

function activityJson(a: Activity) {
  return {
    wallets: { total: Number(a.wallets), ours: Number(a.ourWallets), others: Number(a.externalWallets) },
    stakes: {
      count: Number(a.stakeCount),
      usdc: usdc(a.stakedUsdc),
      countOurs: Number(a.stakeCountOurs),
      usdcOurs: usdc(a.stakedUsdcOurs),
    },
    fills: {
      count: Number(a.fillCount),
      againstOurMaker: Number(a.fillCountOurMaker),
      betweenOthers: Number(a.fillCountBetweenOthers),
      ourMakerShare: formatBps(Number(a.ourMakerShareBps)),
    },
    volume: {
      usdc: usdc(a.volume),
      againstOurMakerUsdc: usdc(a.volumeOurMaker),
      betweenOthersUsdc: usdc(a.volumeBetweenOthers),
      ourMakerShare: formatBps(Number(a.ourMakerVolumeShareBps)),
    },
    routerTrades: { count: Number(a.routerTradeCount), usdc: usdc(a.routerVolume) },
    redemptions: { count: Number(a.redemptionCount), usdc: usdc(a.redeemedUsdc) },
    indexedToBlock: String(a.updatedAtBlock),
  };
}

function countBy<K extends string | number>(
  markets: MarketInfo[],
  key: (m: MarketInfo) => K,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of markets) out[String(key(m))] = (out[String(key(m))] ?? 0) + 1;
  return out;
}

export async function protocolStats(deps: ApiDeps) {
  return cached(
    `stats:${deps.network}`,
    30_000,
    async () => {
      const client = deps.sdk.context.publicClient;
      const vault = deps.deployment.hunchBook.vault;
      const [markets, head, activity] = await Promise.all([
        allMarkets(deps),
        client.getBlock({ blockTag: "latest" }),
        indexerActivity(deps).catch(() => null),
      ]);
      let vaultJson: Record<string, unknown> | null = null;
      if (vault) {
        const reads = await client.multicall({
          contracts: [
            { address: vault, abi: collateralVaultAbi, functionName: "totalCollateral" },
            { address: vault, abi: collateralVaultAbi, functionName: "totalObligations" },
            { address: vault, abi: collateralVaultAbi, functionName: "surplus" },
            { address: vault, abi: collateralVaultAbi, functionName: "collateralCap" },
          ],
          allowFailure: true,
          multicallAddress: deps.sdk.context.multicallAddress,
          blockNumber: head.number,
        });
        const v = (i: number): bigint | null =>
          reads[i]?.status === "success" ? (reads[i]?.result as bigint) : null;
        const surplus = v(2);
        vaultJson = {
          address: vault,
          usdcHeld: v(0) === null ? null : formatUsdc(v(0) as bigint),
          owedUsdc: v(1) === null ? null : formatUsdc(v(1) as bigint),
          surplusUsdc: surplus === null ? null : formatUsdc(surplus),
          solvent: surplus === null ? null : surplus >= 0n,
          capUsdc: v(3) === null ? null : formatUsdc(v(3) as bigint),
        };
      }
      const byPhase = Object.fromEntries(PHASE_NAMES.map((p) => [p, 0]));
      Object.assign(
        byPhase,
        countBy(markets, (m) => m.phaseName),
      );
      const openPools = markets.filter((m) => m.phaseName === "pool" || m.phaseName === "pool-locked");
      return {
        network: deps.network,
        chainId: deps.deployment.chainId,
        asOf: { block: head.number.toString(), time: new Date(Number(head.timestamp) * 1000).toISOString() },
        markets: {
          total: markets.length,
          byPhase,
          byTemplate: countBy(markets, (m) => m.templateId),
          graduatedEver: markets.filter((m) => m.graduated).length,
        },
        pools: {
          open: openPools.length,
          stakedUsdc: formatUsdc(openPools.reduce((s, m) => s + m.pool.total, 0n)),
        },
        vault: vaultJson,
        activity: activity ? activityJson(activity) : null,
        sources: {
          chain: deps.deployment.explorer,
          indexer: deps.indexerUrl ? "configured" : "not configured: activity totals are null",
        },
      };
    },
    deps.now(),
  );
}

export type ProtocolStats = Awaited<ReturnType<typeof protocolStats>>;

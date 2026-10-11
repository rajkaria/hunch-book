import { formatBps, formatUsdc, type MarketInfo } from "@hunch-book/sdk";
import { collateralOf, collateralVaultAbi, stacksOf } from "@hunch-book/shared";
import { erc20Abi } from "viem";
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
    fillCount fillCountOurMaker fillCountBetweenOthers fillCountMakerUnknown volume volumeOurMaker
    volumeBetweenOthers volumeMakerUnknown ourMakerShareBps ourMakerVolumeShareBps routerTradeCount routerVolume redemptionCount redeemedUsdc
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
      // Kuru v2 swaps do not name their makers: counted neither as ours nor as between others.
      makerUnknown: Number(a.fillCountMakerUnknown ?? 0),
      ourMakerShare: formatBps(Number(a.ourMakerShareBps)),
    },
    volume: {
      usdc: usdc(a.volume),
      againstOurMakerUsdc: usdc(a.volumeOurMaker),
      betweenOthersUsdc: usdc(a.volumeBetweenOthers),
      makerUnknownUsdc: usdc(a.volumeMakerUnknown ?? 0),
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
      // Every stack's vault, each solvent on its own; the totals below add them up.
      const fallbackUsdc = collateralOf(deps.deployment);
      const held = stacksOf(deps.deployment).flatMap((st) => {
        const usdc = st.contracts.usdc ?? fallbackUsdc;
        return st.contracts.vault && usdc ? [{ vault: st.contracts.vault, usdc }] : [];
      });
      const vaults = held.map((h) => h.vault);
      const vault = vaults[0];
      const [markets, head, activity] = await Promise.all([
        allMarkets(deps),
        client.getBlock({ blockTag: "latest" }),
        indexerActivity(deps).catch(() => null),
      ]);
      let vaultJson: Record<string, unknown> | null = null;
      if (vault) {
        // Per vault, at one block: the USDC it holds, then its books. totalCollateral is only what sits in
        // markets (every pool and complete set); totalObligations adds the protocol and creator fees not
        // withdrawn yet. Solvent means the USDC held covers the obligations: surplus = held - owed >= 0.
        const PER = 5;
        const reads = await client.multicall({
          contracts: held.flatMap(({ vault: address, usdc }) => [
            { address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [address] },
            { address, abi: collateralVaultAbi, functionName: "totalCollateral" },
            { address, abi: collateralVaultAbi, functionName: "totalObligations" },
            { address, abi: collateralVaultAbi, functionName: "surplus" },
            { address, abi: collateralVaultAbi, functionName: "collateralCap" },
          ]),
          allowFailure: true,
          multicallAddress: deps.sdk.context.multicallAddress,
          blockNumber: head.number,
        });
        // Field i of every vault, summed; null if any vault's read failed.
        const sum = (i: number): bigint | null => {
          let total = 0n;
          for (let k = 0; k < vaults.length; k++) {
            const r = reads[k * PER + i];
            if (r?.status !== "success") return null;
            total += r.result as bigint;
          }
          return total;
        };
        const usdcText = (v: bigint | null): string | null => (v === null ? null : formatUsdc(v));
        const surpluses = vaults.map((_, k) => reads[k * PER + 3]);
        const solvent = surpluses.every((r) => r?.status === "success")
          ? surpluses.every((r) => (r?.result as bigint) >= 0n)
          : null;
        const inMarkets = sum(1);
        const owed = sum(2);
        vaultJson = {
          address: vault,
          addresses: vaults,
          usdcHeld: usdcText(sum(0)),
          inMarketsUsdc: usdcText(inMarkets),
          feesOwedUsdc: inMarkets === null || owed === null ? null : usdcText(owed - inMarkets),
          owedUsdc: usdcText(owed),
          surplusUsdc: usdcText(sum(3)),
          solvent,
          capUsdc: usdcText(sum(4)),
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

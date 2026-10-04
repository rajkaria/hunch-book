"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { getPublicClient } from "../chain/client";
import { appDeployment, appNetwork, isDeployed } from "../config";
import { getIndexerClient } from "../indexer/client";
import { PROOF_QUERY, type ProofResult } from "../indexer/queries";
import { type Sourced, withIndexer } from "../indexer/source";
import type { MarketView } from "../market/types";
import { measureSettlement, readProofFromChain, readVault } from "./chain";
import { type ProofData, proofFromIndexer, type SettlementTiming, type VaultBalance } from "./metrics";

export interface ProofView extends ProofData {
  /** The vault's books read from the chain now, next to the indexer's replay. */
  liveVault: VaultBalance | null;
  /** Chain reads only: the markets the counts cover. */
  listed: MarketView[] | null;
}

/** Days of daily activity the page shows. */
export const PROOF_DAYS = 30;

export async function readProof(): Promise<Sourced<ProofView>> {
  const client = getPublicClient();
  const deployment = appDeployment;
  return withIndexer<ProofView>({
    indexer: getIndexerClient(),
    fromIndexer: async (indexer) => {
      const [result, liveVault] = await Promise.all([
        indexer.query<ProofResult>(PROOF_QUERY, {
          chainId: String(deployment.chainId),
          chain: deployment.chainId,
          days: PROOF_DAYS,
          markets: 200,
          settlements: 50,
        }),
        readVault(client, deployment).catch(() => null),
      ]);
      if (!result.ProtocolStats_by_pk) throw new Error("The indexer has no totals for this chain yet.");
      return { ...proofFromIndexer(result), liveVault, listed: null };
    },
    fromChain: async () => {
      const data = await readProofFromChain(client, deployment);
      return { ...data, liveVault: data.vault };
    },
  });
}

export function useProof() {
  return useQuery({
    queryKey: ["proof", appNetwork],
    queryFn: readProof,
    enabled: isDeployed(appDeployment),
    refetchInterval: 15_000,
  });
}

/**
 * Times the given final markets from archive reads, one after another, once asked to. Each search is a
 * few dozen eth_calls, so it runs only when the visitor presses the button.
 */
export function useChainTimings(markets: readonly MarketView[]) {
  const [started, setStarted] = useState(false);
  const query = useQuery({
    queryKey: ["proof-timings", appNetwork, markets.map((m) => m.address.toLowerCase()).join(",")],
    queryFn: async () => {
      const client = getPublicClient();
      const head = await client.getBlockNumber();
      const out: SettlementTiming[] = [];
      for (const m of markets) {
        const timing = await measureSettlement(client, appDeployment, m, head).catch(() => null);
        if (timing) out.push(timing);
      }
      return out;
    },
    enabled: started && markets.length > 0,
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
    retry: 0,
  });
  return { ...query, started, start: () => setStarted(true) };
}

"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { getPublicClient } from "../chain/client";
import { appDeployment, appNetwork, isDeployed } from "../config";
import { getIndexerClient } from "../indexer/client";
import type { Sourced } from "../indexer/source";
import type { MarketView } from "../market/types";
import { fetchServed } from "../served/fetch";
import { measureSettlement } from "./chain";
import type { SettlementTiming } from "./metrics";
import { type ProofView, readProofFrom } from "./read";

export { PROOF_DAYS, type ProofView } from "./read";

/** The proof figures read from this browser: the indexer when it answers, else the chain. */
export async function readProof(): Promise<Sourced<ProofView>> {
  return readProofFrom({ client: getPublicClient(), deployment: appDeployment, indexer: getIndexerClient() });
}

/**
 * The proof figures: one request to the server's cached read (lib/served), stamped with when the server
 * read them; if that fails, read from this browser.
 */
export async function readProofServedFirst(): Promise<Sourced<ProofView>> {
  try {
    const served = await fetchServed<Sourced<ProofView>>("proof", appNetwork);
    return { ...served.data, readAt: served.readAt };
  } catch {
    return readProof();
  }
}

export function useProof() {
  return useQuery({
    queryKey: ["proof", appNetwork],
    queryFn: readProofServedFirst,
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

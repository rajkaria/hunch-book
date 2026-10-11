import type { Deployment } from "@hunch-book/shared";
import type { IndexerClient } from "../indexer/client";
import { PROOF_QUERY, type ProofResult } from "../indexer/queries";
import { type Sourced, withIndexer } from "../indexer/source";
import type { MarketView, ReadResult } from "../market/types";
import { type ProofClient, readProofFromChain, readVault } from "./chain";
import { type ProofData, proofFromIndexer, type VaultBalance } from "./metrics";

// The proof page's read, with no browser state: the server runs it for /api/read/proof and the browser
// runs it itself only if that request fails.

export interface ProofView extends ProofData {
  /** The vault's books read from the chain now, next to the indexer's replay. */
  liveVault: VaultBalance | null;
  /** Chain reads only: the markets the counts cover. */
  listed: MarketView[] | null;
}

/** Days of daily activity the page shows. */
export const PROOF_DAYS = 30;

/**
 * The proof figures from the indexer when it answers and has caught up, else from the chain. `readList`,
 * when given, supplies the market list already read (the server's cached list), so the chain path does
 * not read it again.
 */
export async function readProofFrom({
  client,
  deployment,
  indexer,
  readList,
}: {
  client: ProofClient;
  deployment: Deployment;
  indexer: IndexerClient | null;
  readList?: () => Promise<ReadResult<{ markets: MarketView[]; total: number }>>;
}): Promise<Sourced<ProofView>> {
  return withIndexer<ProofView>({
    indexer,
    fromIndexer: async (connected) => {
      const [result, liveVault] = await Promise.all([
        connected.query<ProofResult>(PROOF_QUERY, {
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
      const data = await readProofFromChain(client, deployment, readList);
      return { ...data, liveVault: data.vault };
    },
  });
}

import { type IndexerClient, IndexerError } from "./client";

// Every page that can read the indexer also reads the chain. This picks the source per request: the
// indexer when the build has an endpoint for the active network and it answers, is on the right chain
// and has caught up; otherwise the chain, with the reason kept for the page's source tag.

export type DataSource = "indexer" | "chain";

export interface Sourced<T> {
  source: DataSource;
  data: T;
  /** Why the chain was read although an indexer is configured. */
  fallback?: string;
  /** The last block the indexer had processed, when it said. */
  indexedBlock?: bigint;
}

/** How far behind the chain head (in blocks) a caught-up indexer may still be: about two minutes. */
export const MAX_LAG_BLOCKS = 300n;

/** Plain words for why the indexer was skipped. */
export function fallbackReason(error: unknown): string {
  if (error instanceof IndexerError) {
    switch (error.kind) {
      case "timeout":
        return "The indexer did not answer in time, so this reads the chain directly.";
      case "wrong-chain":
        return "The configured indexer serves another chain, so this reads the chain directly.";
      case "behind":
        return `${error.message} This reads the chain directly until it catches up.`;
      default:
        return "The indexer did not answer, so this reads the chain directly.";
    }
  }
  return "The indexer did not answer, so this reads the chain directly.";
}

/**
 * Reads from the indexer when it can, else from the chain. Never throws for an indexer problem; a
 * chain read that fails still throws, like any other chain read.
 */
export async function withIndexer<T>({
  indexer,
  fromIndexer,
  fromChain,
}: {
  indexer: IndexerClient | null;
  fromIndexer: (client: IndexerClient) => Promise<T>;
  fromChain: () => Promise<T>;
}): Promise<Sourced<T>> {
  if (!indexer) return { source: "chain", data: await fromChain() };
  if (!indexer.available()) {
    return {
      source: "chain",
      data: await fromChain(),
      fallback: "The indexer failed a moment ago, so this reads the chain directly.",
    };
  }
  try {
    const status = await indexer.status();
    if (status) {
      const lag = status.sourceBlock === null ? 0n : status.sourceBlock - status.progressBlock;
      if (!status.isReady || lag > MAX_LAG_BLOCKS) {
        throw new IndexerError(
          "behind",
          `The indexer is catching up (block ${status.progressBlock.toString()}${
            status.sourceBlock === null ? "" : ` of ${status.sourceBlock.toString()}`
          }).`,
        );
      }
    }
    const data = await fromIndexer(indexer);
    return status
      ? { source: "indexer", data, indexedBlock: status.progressBlock }
      : { source: "indexer", data };
  } catch (error) {
    return { source: "chain", data: await fromChain(), fallback: fallbackReason(error) };
  }
}

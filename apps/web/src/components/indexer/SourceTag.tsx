import { REPO_URL } from "@/lib/config";
import { formatInt } from "@/lib/format";
import { QUERIES_PATH } from "@/lib/indexer/queries";
import type { DataSource } from "@/lib/indexer/source";
import { Badge } from "../ui";
import s from "./source.module.css";

/** Where the app's indexer queries live, linked from every figure that comes from the indexer. */
export const QUERIES_URL = `${REPO_URL}/blob/main/${QUERIES_PATH}`;
/** How the indexer counts each figure. */
export const INDEXER_DOCS_URL = `${REPO_URL}/blob/main/docs/INDEXER.md`;

/**
 * Says where a panel's numbers come from: the indexer (with the block it has reached) or the chain
 * itself, and why the chain when an indexer is configured but was skipped.
 */
export function SourceTag({
  source,
  fallback,
  indexedBlock,
}: {
  source: DataSource;
  fallback?: string;
  indexedBlock?: bigint;
}) {
  return (
    <span className={s.wrap}>
      {source === "indexer" ? (
        <Badge tone="violet" dot>
          From the indexer
        </Badge>
      ) : (
        <Badge tone="cyan" dot>
          Live from chain
        </Badge>
      )}
      {source === "indexer" && indexedBlock !== undefined ? (
        <span className={s.note}>indexed to block {formatInt(indexedBlock)}</span>
      ) : null}
      {fallback ? <span className={s.note}>{fallback}</span> : null}
    </span>
  );
}

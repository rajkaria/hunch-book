"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import type { Address } from "viem";
import { getPublicClient } from "../chain/client";
import { appDeployment, appNetwork, isDeployed } from "../config";
import { getIndexerClient } from "../indexer/client";
import { TAPE_QUERY, type TradeRow } from "../indexer/queries";
import { type Sourced, withIndexer } from "../indexer/source";
import type { MarketView } from "../market/types";
import { marketTag } from "../stacks";
import { type BookInfo, byNewest, type Fill, fillFromRow, isBetweenOthers, TapeScanner } from "./fills";

/** The tape polls this often, in milliseconds. */
export const TAPE_POLL_MS = 2_000;

export interface TapeData {
  fills: Fill[];
  /** Chain reads only: the oldest and newest block read. */
  window: { from: bigint; to: bigint } | null;
  /** Chain reads only: how many books were read. */
  books: number | null;
}

/** The books of graduated markets, for reading fills from logs. */
export function booksOf(markets: readonly MarketView[]): BookInfo[] {
  return markets.flatMap((m) =>
    m.graduated && m.book
      ? [
          {
            book: m.book,
            market: m.address,
            marketNumber: Number(m.marketId),
            question: m.description,
            kuruVersion: m.kuruVersion ?? 1,
            tag: marketTag(m),
          },
        ]
      : [],
  );
}

// One scanner per network and set of books, kept across page changes so the tape never re-reads blocks.
const scanners = new Map<string, TapeScanner>();

function scannerFor(books: readonly BookInfo[]): TapeScanner {
  const key = `${appNetwork}:${books
    .map((b) => b.book.toLowerCase())
    .sort()
    .join(",")}`;
  let scanner = scanners.get(key);
  if (!scanner) {
    scanner = new TapeScanner(getPublicClient(), appDeployment, books);
    scanners.set(key, scanner);
  }
  return scanner;
}

export async function readTape({
  market,
  books,
  limit,
  othersOnly = false,
}: {
  market?: Address;
  books: readonly BookInfo[];
  limit: number;
  /** Only fills where neither side is one of our wallets. */
  othersOnly?: boolean;
}): Promise<Sourced<TapeData>> {
  return withIndexer<TapeData>({
    indexer: getIndexerClient(),
    fromIndexer: async (client) => {
      const where = {
        ...(market ? { market_id: { _eq: market.toLowerCase() } } : {}),
        ...(othersOnly ? { betweenOthers: { _eq: true } } : {}),
      };
      const data = await client.query<{ Trade: TradeRow[] }>(TAPE_QUERY, { where, limit });
      return { fills: data.Trade.map(fillFromRow).sort(byNewest), window: null, books: null };
    },
    fromChain: async () => {
      const scanner = scannerFor(books);
      const snap = await scanner.poll();
      const fills = snap.fills.filter(
        (f) =>
          (!market || f.market?.toLowerCase() === market.toLowerCase()) &&
          (!othersOnly || isBetweenOthers(f)),
      );
      return {
        fills: fills.slice(0, limit),
        window: snap.from !== null && snap.to !== null ? { from: snap.from, to: snap.to } : null,
        books: snap.books,
      };
    },
  });
}

/**
 * The live tape: the newest fills on our books (or one market's), polled every two seconds, from the
 * indexer or from recent blocks. `books` names the books to read when it falls back to the chain.
 */
export function useTape({
  market,
  books,
  limit = 50,
  othersOnly = false,
  enabled = true,
}: {
  market?: Address;
  books: readonly BookInfo[] | null;
  limit?: number;
  othersOnly?: boolean;
  enabled?: boolean;
}) {
  const queryClient = useQueryClient();
  const [extending, setExtending] = useState(false);
  const booksKey = useMemo(
    () =>
      (books ?? [])
        .map((b) => b.book.toLowerCase())
        .sort()
        .join(","),
    [books],
  );
  const queryKey = useMemo(
    () => ["tape", appNetwork, market?.toLowerCase() ?? "all", booksKey, limit, othersOnly] as const,
    [market, booksKey, limit, othersOnly],
  );
  const query = useQuery({
    queryKey,
    queryFn: () => readTape({ market, books: books ?? [], limit, othersOnly }),
    enabled: enabled && isDeployed(appDeployment) && books !== null,
    refetchInterval: TAPE_POLL_MS,
    refetchIntervalInBackground: false,
  });

  /** Chain reads only: reads further back, then refreshes the tape. */
  const loadOlder = useCallback(async () => {
    if (!books || books.length === 0) return;
    setExtending(true);
    try {
      await scannerFor(books).extend();
      await queryClient.invalidateQueries({ queryKey });
    } finally {
      setExtending(false);
    }
  }, [books, queryClient, queryKey]);

  return { ...query, loadOlder, extending };
}

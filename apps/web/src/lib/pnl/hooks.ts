"use client";

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import type { Address } from "viem";
import { getPublicClient } from "../chain/client";
import { appDeployment, appNetwork, isDeployed } from "../config";
import { getIndexerClient } from "../indexer/client";
import { type Sourced, withIndexer } from "../indexer/source";
import type { PortfolioEntry } from "../market/types";
import { readEntries } from "./chain";
import type { MarketLabel } from "./csv";
import { eventsFromChain, eventsFromHistory, fetchHistory, markOf, missingMarkets } from "./history";
import { type MarketPnl, marketPnl, type PnlEvent, type PnlTotals, pnlTotals } from "./ledger";

/** The wallet's events from the indexer, or null when the page should rebuild them from chain state. */
export function useHistory(user: Address | undefined) {
  return useQuery({
    queryKey: ["pnl-history", appNetwork, user?.toLowerCase() ?? "0x"],
    queryFn: (): Promise<Sourced<PnlEvent[] | null>> =>
      withIndexer<PnlEvent[] | null>({
        indexer: getIndexerClient(),
        fromIndexer: async (client) => eventsFromHistory(await fetchHistory(client, user as Address)),
        fromChain: async () => null,
      }),
    enabled: Boolean(user) && isDeployed(appDeployment),
    refetchInterval: 30_000,
  });
}

export interface PortfolioPnl {
  rows: MarketPnl[];
  totals: PnlTotals;
  events: PnlEvent[];
  labels: Map<string, MarketLabel>;
  source: "indexer" | "chain";
  fallback?: string;
  indexedBlock?: bigint;
  isPending: boolean;
}

/** P&L per market and in total for the connected wallet, from its history and the portfolio's reads. */
export function usePortfolioPnl(user: Address | undefined, entries: readonly PortfolioEntry[]): PortfolioPnl {
  const history = useHistory(user);
  const indexed = history.data?.source === "indexer" ? history.data.data : null;
  const missing = useMemo(() => (indexed ? missingMarkets(indexed, entries) : []), [indexed, entries]);
  const extra = useQuery({
    queryKey: [
      "pnl-extra",
      appNetwork,
      user?.toLowerCase() ?? "0x",
      missing.map((a) => a.toLowerCase()).join(","),
    ],
    queryFn: () => readEntries(getPublicClient(), user as Address, missing),
    enabled: Boolean(user) && missing.length > 0,
    refetchInterval: 30_000,
  });

  return useMemo(() => {
    const events = indexed ?? eventsFromChain(entries);
    const all = [...entries, ...(extra.data ?? [])];
    const byMarket = new Map<string, PnlEvent[]>();
    for (const e of events) {
      const key = e.market.toLowerCase();
      byMarket.set(key, [...(byMarket.get(key) ?? []), e]);
    }
    const rows = all
      .map((entry) =>
        marketPnl(
          entry.market.address,
          byMarket.get(entry.market.address.toLowerCase()) ?? [],
          markOf(entry),
        ),
      )
      .filter((r) => r.spent + r.received + r.costBasis > 0n || r.held.yes + r.held.no > 0n);
    const labels = new Map<string, MarketLabel>(
      all.map((e) => [
        e.market.address.toLowerCase(),
        { number: Number(e.market.marketId), question: e.market.description },
      ]),
    );
    return {
      rows,
      totals: pnlTotals(rows),
      events,
      labels,
      source: history.data?.source ?? "chain",
      fallback: history.data?.fallback,
      indexedBlock: history.data?.indexedBlock,
      isPending: history.isPending || (missing.length > 0 && extra.isPending),
    };
  }, [indexed, entries, extra.data, extra.isPending, history.data, history.isPending, missing.length]);
}

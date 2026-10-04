"use client";

import Link from "next/link";
import { useMemo } from "react";
import { useConnection } from "wagmi";
import { useNow } from "@/lib/hooks";
import type { MarketView } from "@/lib/market/types";
import { booksOf, useTape } from "@/lib/tape/hooks";
import { useTxTimings } from "@/lib/wallet/txTiming";
import { SourceTag } from "../indexer/SourceTag";
import { LoadingRows } from "../states";
import { Panel } from "../ui";
import { FillTable } from "./FillTable";
import { ChainWindow } from "./TapeView";
import s from "./tape.module.css";

/** The last few fills on one market's book, live, with a link to the full tape. */
export function MarketTape({ m, limit = 8 }: { m: MarketView; limit?: number }) {
  const books = useMemo(() => booksOf([m]), [m]);
  const tape = useTape({ market: m.address, books, limit, enabled: books.length > 0 });
  const now = useNow();
  const timings = useTxTimings();
  const user = useConnection().address;
  if (books.length === 0) return null;
  const data = tape.data?.data;
  return (
    <Panel
      title="Trades"
      labelledBy="market-tape-title"
      aside={
        tape.data ? (
          <SourceTag
            source={tape.data.source}
            fallback={tape.data.fallback}
            indexedBlock={tape.data.indexedBlock}
          />
        ) : undefined
      }
    >
      {tape.isPending ? (
        <LoadingRows rows={1} label="Loading trades" />
      ) : tape.isError ? (
        <p className={s.empty}>Could not read this book's fills just now. It tries again in a moment.</p>
      ) : !data || data.fills.length === 0 ? (
        <p className={s.empty}>No fills on this book {data?.window ? "in the blocks read so far" : "yet"}.</p>
      ) : (
        <FillTable
          fills={data.fills}
          now={now}
          user={user}
          timings={timings}
          showMarket={false}
          compact
          caption="This market's latest fills, newest first"
        />
      )}
      {data && tape.data?.source === "chain" ? (
        <ChainWindow data={data} onOlder={() => void tape.loadOlder()} extending={tape.extending} />
      ) : null}
      <div className={s.foot}>
        <span>Live: updates every 2 seconds. Our maker bot is labelled ours.</span>
        <Link href={`/tape?market=${m.address}`}>Full tape →</Link>
      </div>
    </Panel>
  );
}

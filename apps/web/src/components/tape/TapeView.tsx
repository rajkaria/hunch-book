"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { Address } from "viem";
import { useConnection } from "wagmi";
import { appNetworkLabel } from "@/lib/config";
import { formatChance, formatInt, formatUsdc } from "@/lib/format";
import { useMarkets, useNow } from "@/lib/hooks";
import type { MarketView } from "@/lib/market/types";
import { type Fill, isBetweenOthers, tapeStats } from "@/lib/tape/fills";
import { booksOf, TAPE_POLL_MS, type TapeData, useTape } from "@/lib/tape/hooks";
import { useTxTimings } from "@/lib/wallet/txTiming";
import { SourceTag } from "../indexer/SourceTag";
import { ErrorState, LoadingRows } from "../states";
import { Badge, Button, Panel, Stat } from "../ui";
import { FillTable } from "./FillTable";
import s from "./tape.module.css";

/** Seconds a window of blocks spans at Monad's 400 ms blocks, as "about 7 minutes". */
export function windowText(window: { from: bigint; to: bigint }, msPerBlock = 400): string {
  const blocks = window.to - window.from + 1n;
  const minutes = Math.max(1, Math.round((Number(blocks) * msPerBlock) / 60_000));
  const span = minutes >= 120 ? `about ${Math.round(minutes / 60)} hours` : `about ${minutes} minutes`;
  return `blocks ${formatInt(window.from)} to ${formatInt(window.to)} (${formatInt(blocks)} blocks, ${span})`;
}

/** What the chain tape read, and a way to read further back. */
export function ChainWindow({
  data,
  onOlder,
  extending,
}: {
  data: TapeData;
  onOlder: () => void;
  extending: boolean;
}) {
  if (!data.window) return null;
  return (
    <div className={s.foot}>
      <span>
        Read from {windowText(data.window)} on {data.books ?? 0} {data.books === 1 ? "book" : "books"}. The
        indexer keeps the full history.
      </span>
      <Button size="sm" onClick={onOlder} loading={extending}>
        Look further back
      </Button>
    </div>
  );
}

function TapeStats({ fills }: { fills: readonly Fill[] }) {
  const stats = tapeStats(fills);
  return (
    <div className={s.stats}>
      <Stat label="Fills listed" value={formatInt(stats.fills)} />
      <Stat
        label="Against our maker"
        value={formatInt(stats.ourMakerFills)}
        hint={
          stats.ourMakerShareBps === null ? "no fills" : `${formatChance(stats.ourMakerShareBps)} of fills`
        }
      />
      <Stat
        label="Between other parties"
        value={formatInt(stats.betweenOthers)}
        hint="neither side is ours"
      />
      <Stat label="Volume listed" value={formatUsdc(stats.volume)} hint="USDC" />
    </div>
  );
}

/** The full tape: every fill on Hunch Book's books (or one market's), live. */
export function TapeView({ market }: { market?: Address }) {
  const markets = useMarkets();
  const list: MarketView[] | null = markets.data?.status === "ok" ? markets.data.data.markets : null;
  const books = useMemo(() => (list ? booksOf(list) : markets.isError ? [] : null), [list, markets.isError]);
  const tape = useTape({ market, books, limit: 50 });
  const now = useNow();
  const timings = useTxTimings();
  const user = useConnection().address;
  const [othersOnly, setOthersOnly] = useState(false);
  const focus = market ? list?.find((m) => m.address.toLowerCase() === market.toLowerCase()) : undefined;

  if (markets.data?.status === "not-deployed") return null;
  const data = tape.data?.data;
  const fills = data ? (othersOnly ? data.fills.filter(isBetweenOthers) : data.fills) : [];

  return (
    <Panel
      title={market ? `Fills on market ${focus ? `#${focus.marketId.toString()}` : ""}`.trim() : "Every fill"}
      labelledBy="tape-title"
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
      <div className={s.head}>
        <div className={s.controls}>
          <Badge tone="accent" live>
            Live on {appNetworkLabel}
          </Badge>
          <span className={s.subtle}>updates every {TAPE_POLL_MS / 1000} seconds</span>
          {market ? <Link href="/tape">All markets</Link> : null}
        </div>
        <label className={s.toggle}>
          <input type="checkbox" checked={othersOnly} onChange={(e) => setOthersOnly(e.target.checked)} />
          Only fills between other parties
        </label>
      </div>

      {tape.isPending || books === null ? (
        <LoadingRows rows={2} label="Loading fills" />
      ) : tape.isError ? (
        <ErrorState title="Could not read the fills" onRetry={() => void tape.refetch()} />
      ) : (
        <>
          <TapeStats fills={fills} />
          {books.length === 0 && data?.window === null && tape.data?.source === "chain" ? (
            <p className={s.empty}>No market has graduated to a Kuru book yet, so there are no fills.</p>
          ) : fills.length === 0 ? (
            <p className={s.empty}>
              {othersOnly ? "No fills between other parties" : "No fills"}{" "}
              {data?.window ? "in the blocks read so far." : "yet."}
            </p>
          ) : (
            <FillTable
              fills={fills}
              now={now}
              user={user}
              timings={timings}
              showMarket={!market}
              caption="Fills on Hunch Book's Kuru books, newest first"
            />
          )}
          {data && tape.data?.source === "chain" ? (
            <ChainWindow data={data} onOlder={() => void tape.loadOlder()} extending={tape.extending} />
          ) : null}
        </>
      )}
      <p className={s.foot}>
        Side is the taker's: Buy YES lifted an ask, Sell YES hit a bid. Price is USDC per YES. Our maker bot
        and our other wallets are labelled ours. For trades you send from this app, "included in" is measured
        in your browser, from your wallet's signature to the receipt.
      </p>
    </Panel>
  );
}

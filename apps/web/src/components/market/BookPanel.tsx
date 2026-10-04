"use client";

import { addressUrl, type DepthRow, midPrice, ONE_USDC, withCumulative } from "@hunch-book/shared";
import { type BookSnapshot, BookState } from "@/lib/chain/kuru";
import { appDeployment } from "@/lib/config";
import { formatChance, formatFixed, formatInt } from "@/lib/format";
import { useBook, useNow } from "@/lib/hooks";
import type { MarketView } from "@/lib/market/types";
import { bookPriceE6, formatPriceE6 } from "@/lib/trade/ticket";
import { AddressLink, Panel } from "../ui";
import s from "./market.module.css";
import t from "./trade.module.css";

/** Levels shown per side. */
export const LADDER_LEVELS = 8;

/** A size in book units to tokens with two decimals. */
const size = (v: bigint, book: BookSnapshot): string =>
  formatFixed((v * ONE_USDC) / book.params.sizePrecision, 6, { minDecimals: 2, maxDecimals: 2 });

export interface LadderRow extends DepthRow {
  /** Our maker's size at this level, or null when not known. */
  ours: bigint | null;
}

/** The ladder rows for one side, best first, with cumulative size and our maker's share. */
export function ladderRows(
  book: BookSnapshot,
  sideName: "bids" | "asks",
  limit = LADDER_LEVELS,
): LadderRow[] {
  const owned = book.owned?.[sideName] ?? null;
  return withCumulative(book[sideName])
    .slice(0, limit)
    .map((row, i) => ({ ...row, ours: owned ? (owned[i] ?? null) : null }));
}

/** The spread and mid in 1e6 USDC per YES, or nulls when a side is empty. */
export function spreadAndMid(book: BookSnapshot): { spreadE6: bigint | null; midE6: bigint | null } {
  const bid = book.bids[0]?.price;
  const ask = book.asks[0]?.price;
  const mid = midPrice(book);
  return {
    spreadE6:
      bid !== undefined && ask !== undefined ? bookPriceE6(ask - bid, book.params.pricePrecision) : null,
    midE6: mid === null ? null : bookPriceE6(mid, book.params.pricePrecision),
  };
}

function OursTag({ ours, total, book }: { ours: bigint | null; total: bigint; book: BookSnapshot }) {
  if (ours === null || ours === 0n) return null;
  const all = ours >= total;
  return (
    <span className={t.ours} title={`Hunch maker (ours): ${size(ours, book)} YES at this price`}>
      {all ? "ours" : `ours ${size(ours, book)}`}
    </span>
  );
}

function Row({
  row,
  book,
  kind,
  maxCumulative,
}: {
  row: LadderRow;
  book: BookSnapshot;
  kind: "bid" | "ask";
  maxCumulative: bigint;
}) {
  const width = maxCumulative === 0n ? 0 : Number((row.cumulative * 100n) / maxCumulative);
  return (
    <tr
      className={`${t.levelRow} ${kind === "ask" ? t.askRow : t.bidRow}`}
      style={{ backgroundSize: `${width}% 100%` }}
    >
      <td className={kind === "ask" ? t.askPrice : t.bidPrice}>
        {formatPriceE6(bookPriceE6(row.price, book.params.pricePrecision))}
      </td>
      <td>
        {size(row.size, book)}
        <OursTag ours={row.ours} total={row.size} book={book} />
      </td>
      <td>{size(row.cumulative, book)}</td>
    </tr>
  );
}

export function BookLadder({ book, nowSeconds }: { book: BookSnapshot; nowSeconds: number | null }) {
  const asks = ladderRows(book, "asks");
  const bids = ladderRows(book, "bids");
  const maxCumulative = [asks.at(-1)?.cumulative ?? 0n, bids.at(-1)?.cumulative ?? 0n].reduce((a, b) =>
    a > b ? a : b,
  );
  const { spreadE6, midE6 } = spreadAndMid(book);
  const age = nowSeconds === null ? null : Math.max(0, nowSeconds - Math.floor(book.readAt / 1000));
  return (
    <>
      <div className={t.ladderWrap}>
        <table className={t.ladder}>
          <caption className="visually-hidden">
            Resting orders on the YES/USDC book: asks above, bids below, best prices next to the spread.
          </caption>
          <thead>
            <tr>
              <th scope="col">Price (USDC)</th>
              <th scope="col">Size (YES)</th>
              <th scope="col">Total</th>
            </tr>
          </thead>
          <tbody>
            {asks.length === 0 ? (
              <tr>
                <td colSpan={3} className="subtle">
                  No asks: nobody is selling YES.
                </td>
              </tr>
            ) : (
              [...asks]
                .reverse()
                .map((row) => (
                  <Row key={`a${row.price}`} row={row} book={book} kind="ask" maxCumulative={maxCumulative} />
                ))
            )}
            <tr className={t.spreadRow}>
              <td colSpan={3}>
                {midE6 === null ? (
                  "No two-sided quote, so no mid price yet."
                ) : (
                  <>
                    Mid <strong>{formatPriceE6(midE6)}</strong> ={" "}
                    <strong>{formatChance((midE6 * 10_000n) / ONE_USDC)}</strong> chance of YES · spread{" "}
                    <strong>{formatPriceE6(spreadE6 ?? 0n)}</strong>
                  </>
                )}
              </td>
            </tr>
            {bids.length === 0 ? (
              <tr>
                <td colSpan={3} className="subtle">
                  No bids: nobody is buying YES.
                </td>
              </tr>
            ) : (
              bids.map((row) => (
                <Row key={`b${row.price}`} row={row} book={book} kind="bid" maxCumulative={maxCumulative} />
              ))
            )}
          </tbody>
        </table>
      </div>
      <div className={t.legend}>
        <span>
          <span className={t.ours}>ours</span> Hunch maker (ours):{" "}
          <AddressLink address={appDeployment.wallets.maker} />
        </span>
        <span>
          Block {formatInt(book.block)}
          {age === null ? null : `, read ${age}s ago`}
        </span>
        {book.asks.length > LADDER_LEVELS || book.bids.length > LADDER_LEVELS ? (
          <span>
            Showing the best {LADDER_LEVELS} of {book.asks.length} ask and {book.bids.length} bid levels.
          </span>
        ) : null}
      </div>
    </>
  );
}

/** Depth ladder for a graduated market's Kuru book, refreshed every few seconds. */
export function BookPanel({ m }: { m: MarketView }) {
  const book = useBook(m.book);
  const now = useNow();
  if (!m.book) return null;
  return (
    <Panel
      title="Order book"
      labelledBy="book-title"
      aside={
        <a className="subtle" href={addressUrl(appDeployment, m.book)} target="_blank" rel="noreferrer">
          Kuru book on the explorer
        </a>
      }
    >
      {book.isPending ? (
        <p className={s.laterNote}>Reading the book...</p>
      ) : book.isError || !book.data ? (
        <p className={s.laterNote}>Could not read the book. It retries on its own.</p>
      ) : (
        <>
          {book.data.state !== BookState.Active ? (
            <p className={s.validation}>
              Kuru has paused this book. Orders cannot fill until Kuru resumes it.
            </p>
          ) : null}
          <BookLadder book={book.data} nowSeconds={now} />
          <p className={s.trust}>
            Resting orders on Kuru's YES/USDC book, read with getL2Book(). The mid of the best bid and the
            best ask is the market's chance. NO trades through the same book: buying NO sells YES into the
            bids. After close the Hunch router and Hunch maker (ours) stop, but orders other people left can
            still fill.
          </p>
        </>
      )}
    </Panel>
  );
}

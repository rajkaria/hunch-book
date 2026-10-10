"use client";

import { addressUrl, blockUrl } from "@hunch-book/shared";
import Link from "next/link";
import { type Address, isAddressEqual } from "viem";
import { appDeployment } from "@/lib/config";
import { formatInt, formatUsdc, shortAddress } from "@/lib/format";
import type { Fill } from "@/lib/tape/fills";
import { formatAgo, formatClockUtc, formatPriceE6 } from "@/lib/tape/format";
import type { TxTiming } from "@/lib/wallet/txTiming";
import { TxLink } from "../ui";
import s from "./tape.module.css";

function Party({
  who,
  ourMaker,
  ours,
  you,
  extra,
}: {
  who: Address;
  ourMaker?: boolean;
  ours: boolean;
  you: boolean;
  extra?: string;
}) {
  return (
    <span className={s.party}>
      <a
        className={s.addr}
        href={addressUrl(appDeployment, who)}
        target="_blank"
        rel="noreferrer"
        title={who}
      >
        {shortAddress(who)}
      </a>
      {ourMaker ? (
        <span className={s.ours}>Hunch maker (ours)</span>
      ) : ours ? (
        <span className={s.ours}>ours</span>
      ) : null}
      {you ? <span className={s.you}>you</span> : null}
      {extra ? <span className={s.subtle}>{extra}</span> : null}
    </span>
  );
}

/**
 * Fills as a table: time, market, the taker's side, price, size, USDC, maker and taker (ours labelled),
 * block and transaction. A fill this browser sent shows how long it took to land.
 */
export function FillTable({
  fills,
  now,
  user,
  timings,
  showMarket = true,
  compact = false,
  caption,
}: {
  fills: readonly Fill[];
  now: number | null;
  user?: Address;
  timings: ReadonlyMap<string, TxTiming>;
  showMarket?: boolean;
  compact?: boolean;
  caption: string;
}) {
  return (
    <div className={s.scroll}>
      <table className={compact ? `${s.table} ${s.compact}` : s.table}>
        <caption className="visually-hidden">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Time</th>
            {showMarket ? <th scope="col">Market</th> : null}
            <th scope="col">Side</th>
            <th scope="col" className={s.num}>
              Price
            </th>
            <th scope="col" className={s.num}>
              YES
            </th>
            <th scope="col" className={`${s.num} ${s.wide}`}>
              USDC
            </th>
            <th scope="col">Maker</th>
            <th scope="col" className={s.wide}>
              Taker
            </th>
            <th scope="col" className={s.wide}>
              Block
            </th>
            <th scope="col">Transaction</th>
          </tr>
        </thead>
        <tbody>
          {fills.map((f) => {
            const timing = timings.get(f.tx.toLowerCase());
            const youMaker = Boolean(user && isAddressEqual(user, f.maker));
            const youTaker = Boolean(user && isAddressEqual(user, f.trader));
            return (
              <tr key={f.id} className={youMaker || youTaker ? s.mine : undefined}>
                <td>
                  {f.time === null ? (
                    <span className={s.subtle}>reading time</span>
                  ) : (
                    <span className={s.time}>
                      <span className="mono">{formatClockUtc(f.time)}</span>
                      {now !== null ? <span className={s.subtle}>{formatAgo(f.time, now)}</span> : null}
                    </span>
                  )}
                </td>
                {showMarket ? (
                  <td className={s.market}>
                    {f.market ? (
                      <Link href={`/m/${f.market}`} title={f.question ?? undefined}>
                        {f.marketTag ??
                          (f.marketNumber !== null ? `#${f.marketNumber}` : shortAddress(f.market))}
                        {f.question ? <span className={s.question}> {f.question}</span> : null}
                      </Link>
                    ) : (
                      <span className="mono">{shortAddress(f.book)}</span>
                    )}
                  </td>
                ) : null}
                <td>
                  <span className={f.takerBuysYes ? s.buy : s.sell}>
                    {f.takerBuysYes ? "Buy YES" : "Sell YES"}
                  </span>
                </td>
                <td className={`${s.num} mono`}>{formatPriceE6(f.priceE6)}</td>
                <td className={`${s.num} mono`}>{formatUsdc(f.size)}</td>
                <td className={`${s.num} ${s.wide} mono`}>{formatUsdc(f.notional)}</td>
                <td>
                  {f.makerKnown ? (
                    <Party who={f.maker} ourMaker={f.makerIsOurMaker} ours={f.makerIsOurs} you={youMaker} />
                  ) : (
                    <span className={s.subtle} title="A Kuru v2 swap does not name the orders it filled.">
                      unknown (Kuru v2 swap)
                    </span>
                  )}
                </td>
                <td className={s.wide}>
                  <Party
                    who={f.trader}
                    ours={f.traderIsOurs}
                    you={youTaker}
                    extra={f.viaRouter ? "via router" : undefined}
                  />
                </td>
                <td className={s.wide}>
                  <a
                    className={`${s.addr} mono`}
                    href={blockUrl(appDeployment, f.block)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {formatInt(f.block)}
                  </a>
                </td>
                <td>
                  <span className={s.time}>
                    <TxLink hash={f.tx} />
                    {timing ? (
                      <span
                        className={s.landed}
                        title="Measured in your browser: from your wallet's signature to the receipt."
                      >
                        included in {formatInt(timing.includedMs)} ms
                      </span>
                    ) : null}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

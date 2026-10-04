"use client";

import { templateLabel } from "@hunch-book/shared";
import Link from "next/link";
import { useState } from "react";
import { appDeployment } from "@/lib/config";
import { formatChance, formatInt, formatUtc } from "@/lib/format";
import { useChainClock, useMarkets, useNow } from "@/lib/hooks";
import {
  groupLadders,
  type Ladder,
  ladderOpen,
  liveRungs,
  missingStrikes,
  monotoneBreaks,
  rungLabel,
  senseLabel,
} from "@/lib/ladder/group";
import { createPrefillPath } from "@/lib/ladder/prefill";
import { phaseLabel } from "@/lib/market/logic";
import type { ChainClock, MarketView } from "@/lib/market/types";
import { EmptyState, ErrorState, LoadingRows, NotDeployed } from "../states";
import { ButtonLink, Notice, Panel } from "../ui";
import { LadderChart } from "./LadderChart";
import s from "./ladder.module.css";

function windowText(ladder: Ladder): string {
  const w = ladder.window;
  return w.blockClock
    ? `Locks at block ${formatInt(w.lock)}, closes at block ${formatInt(w.close)}`
    : `Locks ${formatUtc(w.lock)}, closes ${formatUtc(w.close)}`;
}

function MissingStrikes({ ladder, clock, now }: { ladder: Ladder; clock: ChainClock | null; now: number }) {
  const suggestions = missingStrikes(ladder);
  if (suggestions.length === 0) return null;
  const open = ladderOpen(ladder, clock, now);
  return (
    <div className={s.missing}>
      <h3 className={s.missingTitle}>Create the missing strikes</h3>
      {open ? (
        <>
          <p className={s.note}>
            Each one opens the create page with this ladder's exact rule and window, and the new{" "}
            {ladder.shape === "range" ? "range" : ladder.axis === "usd" ? "strike" : "threshold"}. You check
            it and make the first stake.
          </p>
          <div className={s.chips}>
            {suggestions.map((sg) => (
              <ButtonLink
                key={`${sg.x}-${sg.upper ?? ""}`}
                size="sm"
                href={createPrefillPath(
                  ladder.templateId,
                  ladder.sample.withStrike(sg.x, sg.upper),
                  "ladder",
                )}
              >
                + {rungLabel(sg, ladder.axis)}
              </ButtonLink>
            ))}
          </div>
        </>
      ) : (
        <p className={s.note}>
          This ladder's lock has passed, so new rungs on the same window cannot be created. A new ladder needs
          a later window.
        </p>
      )}
    </div>
  );
}

function RungTable({ ladder }: { ladder: Ladder }) {
  return (
    <div className={s.tableWrap}>
      <table className={s.table}>
        <caption className="visually-hidden">Every market in this ladder, lowest strike first</caption>
        <thead>
          <tr>
            <th scope="col">
              {ladder.shape === "range" ? "Range" : ladder.axis === "usd" ? "Strike" : "Threshold"}
            </th>
            <th scope="col">Chance of YES</th>
            <th scope="col">From</th>
            <th scope="col">Phase</th>
          </tr>
        </thead>
        <tbody>
          {ladder.points.map((p) => (
            <tr key={p.market.address}>
              <th scope="row">
                <Link href={`/m/${p.market.address}`}>{rungLabel(p, ladder.axis)}</Link>
              </th>
              <td className="mono">{p.chanceBps === null ? "n/a" : formatChance(p.chanceBps)}</td>
              <td>
                {p.chanceSource === "book" ? "Book mid" : p.chanceSource === "pool" ? "Pool split" : "None"}
              </td>
              <td>{phaseLabel(p.market.phase)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function LadderCard({
  ladder,
  clock,
  now,
}: {
  ladder: Ladder;
  clock: ChainClock | null;
  now: number;
}) {
  const breaks = monotoneBreaks(ladder);
  return (
    <Panel
      title={`${templateLabel(ladder.templateId)} · ${formatInt(ladder.points.length)} ${ladder.points.length === 1 ? "market" : "markets"}`}
      aside={<span className={s.note}>{formatInt(liveRungs(ladder))} live</span>}
    >
      <h3 className={s.title}>{ladder.title}</h3>
      <p className={s.note}>
        {windowText(ladder)}. The curve is each market's own {senseLabel(ladder.sense)}.
      </p>
      {ladder.points.length > 1 ? <LadderChart ladder={ladder} /> : null}
      {breaks.length > 0 ? (
        <Notice tone="warn" title="The curve runs the wrong way here">
          {breaks.map(([a, b]) => (
            <p key={`${a.market.address}-${b.market.address}`}>
              {rungLabel(b, ladder.axis)} is priced at {formatChance(b.chanceBps as bigint)}, against{" "}
              {formatChance(a.chanceBps as bigint)} for {rungLabel(a, ladder.axis)}. At settlement it cannot
              be more likely, so one of the two is mispriced.
            </p>
          ))}
        </Notice>
      ) : null}
      <RungTable ladder={ladder} />
      <MissingStrikes ladder={ladder} clock={clock} now={now} />
    </Panel>
  );
}

export function LadderList({
  markets,
  clock,
  now,
}: {
  markets: MarketView[];
  clock: ChainClock | null;
  now: number;
}) {
  const [singles, setSingles] = useState(false);
  const ladders = groupLadders(markets, appDeployment, { minPoints: singles ? 1 : 2 });
  const multi = groupLadders(markets, appDeployment, { minPoints: 2 }).length;
  return (
    <div className={s.stack}>
      <div className={s.controls}>
        <label className={s.check}>
          <input type="checkbox" checked={singles} onChange={(e) => setSingles(e.target.checked)} />
          Show single markets too, to start a ladder from one
        </label>
        <span className={s.note}>
          {formatInt(multi)} {multi === 1 ? "ladder" : "ladders"} among {formatInt(markets.length)} markets
        </span>
      </div>
      {ladders.length === 0 ? (
        <EmptyState label="Ladders" title={singles ? "No markets can ladder yet" : "No ladders yet"}>
          <p>
            A ladder is two or more markets with the same question, asset and window, at different strikes or
            thresholds: price at a time, price touch, price range and Perpl funding markets can ladder. Show
            single markets to start one with a shortcut, or <Link href="/create">create a market</Link>.
          </p>
        </EmptyState>
      ) : (
        ladders.map((ladder) => <LadderCard key={ladder.key} ladder={ladder} clock={clock} now={now} />)
      )}
    </div>
  );
}

/** The /ladder page body. */
export function LadderView() {
  const query = useMarkets();
  const markets = query.data?.status === "ok" ? query.data.data.markets : [];
  const clock = useChainClock(markets.some((m) => m.window.blockClock));
  const now = useNow(15_000);
  if (query.isPending || (query.data?.status === "ok" && now === null)) {
    return <LoadingRows rows={2} label="Loading ladders" />;
  }
  if (query.isError)
    return <ErrorState title="Could not load markets" onRetry={() => void query.refetch()} />;
  if (query.data.status !== "ok") return <NotDeployed />;
  return <LadderList markets={markets} clock={clock} now={now as number} />;
}

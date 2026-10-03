import Link from "next/link";
import { appDeployment } from "@/lib/config";
import { formatDuration, formatUsdc } from "@/lib/format";
import { chanceDisplay, marketChance, nextMilestone, phaseLabel, phaseTone } from "@/lib/market/logic";
import { fallbackHeadline, templateLabel } from "@/lib/market/params";
import type { ChainClock, MarketView } from "@/lib/market/types";
import { Badge, ChanceBar } from "../ui";
import s from "./markets.module.css";

export function marketHeadline(m: MarketView): string {
  return m.description ?? fallbackHeadline(appDeployment, m.decoded);
}

/** "Locks in 2d 4h", ticking. Block-clock markets say "about", since block times are estimated. */
export function Countdown({
  m,
  clock,
  now,
}: {
  m: MarketView;
  clock: ChainClock | null;
  now: number | null;
}) {
  if (now === null) return null;
  const milestone = nextMilestone(m, clock, now);
  if (!milestone) return null;
  const left = milestone.moment.time - now;
  const about = milestone.moment.estimated ? "about " : "";
  return (
    <span>{left > 0 ? `${milestone.label} ${about}${formatDuration(left)}` : `${milestone.label} now`}</span>
  );
}

export function MarketCard({
  m,
  clock,
  now,
}: {
  m: MarketView;
  clock: ChainClock | null;
  now: number | null;
}) {
  const chance = marketChance(m);
  const shown = chanceDisplay(chance);
  return (
    <li className={s.card}>
      <div className={s.meta}>
        <Badge tone={phaseTone(m.phase)}>{phaseLabel(m.phase)}</Badge>
        <span>{templateLabel(m.templateId)}</span>
        <span className="mono">#{m.marketId.toString()}</span>
        <span className={s.metaRight}>
          <Countdown m={m} clock={clock} now={now} />
        </span>
      </div>
      <h2 className={s.title}>
        <Link className={s.titleLink} href={`/m/${m.address}`}>
          {marketHeadline(m)}
        </Link>
      </h2>
      <div className={s.figures}>
        <div className={s.chance}>
          <span className={s.chanceValue}>{shown.value}</span>
          <span className={s.chanceLabel}>{shown.caption}</span>
        </div>
        <div className={s.barWrap}>
          <ChanceBar bps={chance.bps} />
          <span className={s.poolLine}>
            Pool {formatUsdc(m.pool.total)} USDC · {m.pool.stakers}{" "}
            {m.pool.stakers === 1 ? "staker" : "stakers"}
          </span>
        </div>
      </div>
    </li>
  );
}

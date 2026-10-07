import Link from "next/link";
import { appDeployment } from "@/lib/config";
import { formatUsdc } from "@/lib/format";
import {
  chanceDisplay,
  marketChance,
  milestoneText,
  nextMilestone,
  phaseLabel,
  phaseTone,
} from "@/lib/market/logic";
import { templateLabel } from "@/lib/market/params";
import { marketTitle, type TitleClock } from "@/lib/market/title";
import type { ChainClock, MarketView } from "@/lib/market/types";
import { marketTag } from "@/lib/stacks";
import { CardHealth } from "../health/Health";
import { Badge, ChanceBar } from "../ui";
import s from "./markets.module.css";

/**
 * The market's title (lib/market/title.ts): Perpl block windows read as estimated clock times once the
 * chain clock is known. Pass the clock wherever the component has one.
 */
export function marketHeadline(m: MarketView, clock: TitleClock | null = null): string {
  return marketTitle(m, appDeployment, clock);
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
  return <span>{milestoneText(milestone, now)}</span>;
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
        <span className="mono">{marketTag(m)}</span>
        <span className={s.metaRight}>
          <CardHealth m={m} clock={clock} now={now} />
          <Countdown m={m} clock={clock} now={now} />
        </span>
      </div>
      <h2 className={s.title}>
        <Link className={s.titleLink} href={`/m/${m.address}`}>
          {marketHeadline(m, clock)}
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

import Link from "next/link";
import { appDeployment } from "@/lib/config";
import { formatChance, formatCount } from "@/lib/format";
import { cardBody, compactUsdc, isUrgent, milestoneShort } from "@/lib/market/explorer";
import { milestoneText, nextMilestone, phaseGroup, phaseLabel, phaseTone } from "@/lib/market/logic";
import { templateLabel } from "@/lib/market/params";
import { marketTitle, type TitleClock } from "@/lib/market/title";
import type { ChainClock, MarketView } from "@/lib/market/types";
import { marketTag } from "@/lib/stacks";
import { CardHealth } from "../health/Health";
import { cx } from "../ui";
import s from "./explorer.module.css";
import { VenueChip } from "./VenueChip";

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

/** "62.0%" with the percent sign set smaller, as on the main Hunch cards. */
function ChanceFigure({ bps }: { bps: bigint }) {
  const text = formatChance(bps);
  return (
    <span className={s.chanceValue}>
      {text.slice(0, -1)}
      <span className={s.chanceUnit}>%</span>
    </span>
  );
}

function CardFigures({ m }: { m: MarketView }) {
  const body = cardBody(m);
  if (body.kind === "outcome") {
    return (
      <p className={cx(s.note, body.side === "yes" && s.noteYes, body.side === "no" && s.noteNo)}>
        {body.text}
      </p>
    );
  }
  if (body.kind === "note") return <p className={s.note}>{body.text}</p>;
  const pct = Number(body.bps) / 100;
  return (
    <>
      <div className={s.chanceRow}>
        <ChanceFigure bps={body.bps} />
        <span className={s.chanceCaption}>Chance of YES</span>
      </div>
      <div className={s.track} aria-hidden="true">
        <div className={s.fill} style={{ width: `${pct}%` }} />
      </div>
      {body.tiles ? (
        <div className={s.tiles}>
          {body.tiles.map((tile, i) => (
            <span key={tile.label} className={cx(s.tile, i === 0 ? s.tileYes : s.tileNo)}>
              <span className={s.tileLabel}>{tile.label}</span>
              <span className={s.tileValue}>
                {tile.value}
                {tile.unit ? <span className={s.tileUnit}> {tile.unit}</span> : null}
              </span>
            </span>
          ))}
        </div>
      ) : null}
    </>
  );
}

/**
 * One market in the list, in the main Hunch card's anatomy: phase and venue tags with the countdown
 * across the top, the question, the chance with its bar and the two sides, then a footer line with the
 * pool, the stakers, the health score and the template.
 */
export function MarketCard({
  m,
  clock,
  now,
}: {
  m: MarketView;
  clock: ChainClock | null;
  now: number | null;
}) {
  const milestone = now === null ? null : nextMilestone(m, clock, now);
  const urgent = now !== null && isUrgent(milestone, now);
  const over = phaseGroup(m.phase) === "settled";
  const tone = phaseTone(m.phase);
  const live = tone === "accent";
  return (
    <li className={cx(s.card, urgent && s.cardUrgent, over && s.cardOver)}>
      <div className={s.cardTop}>
        <div className={s.tags}>
          <span className={cx(s.tag, s[`tag-${tone}`])}>
            {live ? <span className={cx(s.dot, s.pulse)} aria-hidden="true" /> : null}
            {phaseLabel(m.phase)}
          </span>
          <VenueChip m={m} />
        </div>
        {milestone && now !== null ? (
          <span className={cx(s.time, urgent && s.timeUrgent)}>
            <span className={cx(s.dot, urgent && s.pulse)} aria-hidden="true" />
            <span aria-hidden="true">{milestoneShort(milestone, now)}</span>
            <span className="visually-hidden">{milestoneText(milestone, now)}</span>
          </span>
        ) : null}
      </div>
      <h2 className={s.title}>
        <Link className={s.titleLink} href={`/m/${m.address}`}>
          {marketHeadline(m, clock)}
        </Link>
      </h2>
      <div className={s.body}>
        <CardFigures m={m} />
      </div>
      <div className={s.foot}>
        <span className={s.footItem}>Pool {compactUsdc(m.pool.total)} USDC</span>
        <span className={s.footItem}>{formatCount(m.pool.stakers, "staker")}</span>
        <CardHealth m={m} clock={clock} now={now} variant="text" className={s.footHealth} />
        <span className={s.footEnd}>
          <span className={s.footTemplate}>{templateLabel(m.templateId)}</span>
          <span className={s.footItem}>{marketTag(m)}</span>
        </span>
      </div>
    </li>
  );
}

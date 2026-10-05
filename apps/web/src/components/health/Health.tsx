"use client";

import type { Health, HealthGrade } from "@/lib/health/score";
import { healthLabel } from "@/lib/health/score";
import { depthWithinBand, viewHealth } from "@/lib/health/view";
import { useBook } from "@/lib/hooks";
import type { ChainClock, MarketView } from "@/lib/market/types";
import { Badge, Panel, type Tone } from "../ui";
import s from "./health.module.css";

const TONE: Record<HealthGrade, Tone> = { good: "yes", fair: "warn", thin: "no", finished: "muted" };
const GRADE_WORD: Record<HealthGrade, string> = {
  good: "good",
  fair: "fair",
  thin: "thin",
  finished: "finished",
};

/** "Health 72", coloured by grade, with every part's reason as its tooltip. Nothing once finished. */
export function HealthBadge({ health }: { health: Health }) {
  if (health.score === null) return null;
  const why = health.parts.map((p) => `${p.name} ${p.points}/${p.max}: ${p.why}`).join("\n");
  return (
    <span title={why} className={s.badge}>
      <Badge tone={TONE[health.grade]}>{healthLabel(health)}</Badge>
    </span>
  );
}

/** The card's badge, from the list's data (spread only: depth needs the full book). */
export function CardHealth({
  m,
  clock,
  now,
}: {
  m: MarketView;
  clock: ChainClock | null;
  now: number | null;
}) {
  if (now === null) return null;
  return <HealthBadge health={viewHealth(m, clock, now)} />;
}

/** The market page's panel: the score and what each part saw, with depth from the full book. */
export function HealthPanel({
  m,
  clock,
  now,
}: {
  m: MarketView;
  clock: ChainClock | null;
  now: number | null;
}) {
  const book = useBook(m.graduated ? m.book : null);
  if (now === null) return null;
  const depth = book.data
    ? depthWithinBand(
        book.data.bids,
        book.data.asks,
        book.data.params.pricePrecision,
        book.data.params.sizePrecision,
      )
    : null;
  const health = viewHealth(m, clock, now, depth);
  if (health.score === null) return null;
  return (
    <Panel
      title="Market health"
      aside={<Badge tone={TONE[health.grade]}>{`${health.score} of 100, ${GRADE_WORD[health.grade]}`}</Badge>}
    >
      <ul className={s.parts}>
        {health.parts.map((p) => (
          <li key={p.name} className={s.part}>
            <span className={s.partName}>{p.name}</span>
            <span className={`${s.partPoints} mono`}>
              {p.points} / {p.max}
            </span>
            <span className={s.partWhy}>{p.why}</span>
          </li>
        ))}
      </ul>
      <p className={s.note}>
        Liquidity, time and source, scored from what anyone can read on chain. 70 and up is good, under 40 is
        thin. How it is worked out: docs/HEALTH.md.
      </p>
    </Panel>
  );
}

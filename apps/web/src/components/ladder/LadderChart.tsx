"use client";

import { Phase } from "@hunch-book/shared";
import { useId, useState } from "react";
import { formatChance } from "@/lib/format";
import { chartGeometry, chartSummary, curvePath } from "@/lib/ladder/chart";
import { type Ladder, type LadderPoint, rungLabel, senseLabel } from "@/lib/ladder/group";
import s from "./ladder.module.css";

const SOURCE_LABEL: Record<LadderPoint["chanceSource"], string> = {
  pool: "pool split",
  book: "book mid",
  "book-empty": "no two-sided quote",
  settled: "settled",
  void: "voided",
  empty: "no stakes yet",
};

function pointClass(p: LadderPoint): string {
  if (p.market.phase === Phase.Settled) return s.pointSettled ?? "";
  if (p.chanceSource === "book") return s.pointBook ?? "";
  return s.pointPool ?? "";
}

/**
 * The ladder's implied probability curve: chance of YES (up) against strike (across), one point per market.
 * Every point is a link to its market and shows its value on hover and on keyboard focus. A data table
 * below repeats every value.
 */
export function LadderChart({ ladder }: { ladder: Ladder }) {
  const [active, setActive] = useState<number | null>(null);
  const titleId = useId();
  const descId = useId();
  const g = chartGeometry(ladder.points, ladder.axis);
  const { box } = g;
  const priced = ladder.points.filter((p) => p.chanceBps !== null);
  const label = (p: LadderPoint) => rungLabel(p, ladder.axis);
  const current = active === null ? null : ladder.points[active];
  const bottom = box.height - box.pad.bottom;

  // The title is one string, so it renders as one text node (split text would not hydrate inside <title>).
  const chartTitle = `${ladder.asset}: ${senseLabel(ladder.sense)}, by ${ladder.axis === "usd" ? "strike" : "threshold"}`;
  return (
    <figure className={s.figure}>
      <div className={s.chartWrap}>
        <svg
          className={s.chart}
          viewBox={`0 0 ${box.width} ${box.height}`}
          aria-labelledby={titleId}
          aria-describedby={descId}
        >
          <title id={titleId}>{chartTitle}</title>
          <desc id={descId}>{chartSummary(ladder.points, label)}</desc>

          {/* biome-ignore lint/a11y/noAriaHiddenOnFocusable: decorative grid, axes and curve; the points and the table carry the data */}
          <g aria-hidden="true">
            {g.yTicks.map((t) => (
              <g key={`y${t.value}`}>
                <line
                  className={s.grid}
                  x1={box.pad.left}
                  x2={box.width - box.pad.right}
                  y1={t.pos}
                  y2={t.pos}
                />
                <text className={s.tick} x={box.pad.left - 8} y={t.pos + 4} textAnchor="end">
                  {t.label}
                </text>
              </g>
            ))}
            {g.xTicks.map((t) => (
              <g key={`x${t.value}`}>
                <line className={s.axisTick} x1={t.pos} x2={t.pos} y1={bottom} y2={bottom + 5} />
                <text className={s.tick} x={t.pos} y={bottom + 20} textAnchor="middle">
                  {t.label}
                </text>
              </g>
            ))}
            <line
              className={s.axis}
              x1={box.pad.left}
              x2={box.width - box.pad.right}
              y1={bottom}
              y2={bottom}
            />
            <text
              className={s.axisLabel}
              x={box.pad.left + (box.width - box.pad.left - box.pad.right) / 2}
              y={box.height - 6}
              textAnchor="middle"
            >
              {ladder.axis === "usd" ? "Strike" : "Threshold (Perpl raw units)"}
            </text>

            {ladder.shape === "strike" && priced.length > 1 ? (
              <path className={s.curve} d={curvePath(ladder.points, g)} />
            ) : null}
            {ladder.shape === "range"
              ? priced.map((p) => (
                  <rect
                    key={`bar-${p.market.address}`}
                    className={s.bar}
                    x={g.x(p.x)}
                    y={g.y(p.chanceBps as bigint) - 3}
                    width={Math.max(2, g.x(p.upper ?? p.x) - g.x(p.x))}
                    height={6}
                    rx={3}
                  />
                ))
              : null}
          </g>

          {ladder.points.map((p, i) => {
            if (p.chanceBps === null) return null;
            const cx =
              ladder.shape === "range" && p.upper !== null ? (g.x(p.x) + g.x(p.upper)) / 2 : g.x(p.x);
            const cy = g.y(p.chanceBps);
            return (
              <a
                key={p.market.address}
                href={`/m/${p.market.address}`}
                aria-label={`${label(p)}: ${formatChance(p.chanceBps)} chance of YES, from the ${SOURCE_LABEL[p.chanceSource]}. Open the market.`}
                onMouseEnter={() => setActive(i)}
                onMouseLeave={() => setActive(null)}
                onFocus={() => setActive(i)}
                onBlur={() => setActive(null)}
                className={s.pointLink}
              >
                <circle className={s.hit} cx={cx} cy={cy} r={14} />
                <circle className={`${s.point} ${pointClass(p)}`} cx={cx} cy={cy} r={active === i ? 7 : 5} />
              </a>
            );
          })}
        </svg>
        {current && current.chanceBps !== null ? (
          <div
            className={s.tooltip}
            style={{
              left: `${(((ladder.shape === "range" && current.upper !== null ? (g.x(current.x) + g.x(current.upper)) / 2 : g.x(current.x)) / box.width) * 100).toFixed(2)}%`,
              top: `${((g.y(current.chanceBps) / box.height) * 100).toFixed(2)}%`,
            }}
            aria-hidden="true"
          >
            <strong>{formatChance(current.chanceBps)}</strong>
            <span>{label(current)}</span>
            <span className={s.tooltipNote}>{SOURCE_LABEL[current.chanceSource]}</span>
          </div>
        ) : null}
      </div>
      <figcaption className={s.legend}>
        <span>
          <span className={`${s.swatch} ${s.pointBook}`} aria-hidden="true" /> Book mid
        </span>
        <span>
          <span className={`${s.swatch} ${s.pointPool}`} aria-hidden="true" /> Pool split
        </span>
        <span>
          <span className={`${s.swatch} ${s.pointSettled}`} aria-hidden="true" /> Settled
        </span>
        <span>Each point is a market. Select one to open it.</span>
      </figcaption>
    </figure>
  );
}

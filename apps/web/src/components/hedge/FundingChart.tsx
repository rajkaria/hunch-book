import type { FundingStep, PerpMeta } from "@/lib/hedge/math";
import { formatUsdNumber, usdPerUnit } from "@/lib/hedge/math";
import s from "./hedge.module.css";

/**
 * Funding per interval, oldest on the left: lime bars when longs paid shorts, coral when shorts paid
 * longs. A summary sentence carries the same information for screen readers.
 */
export function FundingChart({ steps, meta }: { steps: readonly FundingStep[]; meta: PerpMeta }) {
  if (steps.length === 0) return null;
  const values = steps.map((step) => usdPerUnit(step.raw, meta));
  const max = Math.max(...values.map(Math.abs), Number.EPSILON);
  const width = 480;
  const height = 72;
  const mid = height / 2;
  const slot = width / values.length;
  const bar = Math.max(1, slot * 0.7);
  const paid = values.filter((v) => v > 0).length;
  const label = `Funding per interval for the last ${values.length} intervals: longs paid in ${paid}, shorts paid in ${
    values.filter((v) => v < 0).length
  }. Latest ${formatUsdNumber(values.at(-1) ?? 0)} per ${meta.symbol}, largest ${formatUsdNumber(
    values.reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a), 0),
  )}.`;
  return (
    <figure className={s.chart} style={{ margin: 0 }}>
      <svg
        className={s.svg}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={label}
      >
        <line className={s.zero} x1={0} x2={width} y1={mid} y2={mid} />
        {values.map((v, i) => {
          const h = (Math.abs(v) / max) * (mid - 2);
          const x = i * slot + (slot - bar) / 2;
          return (
            <rect
              // biome-ignore lint/suspicious/noArrayIndexKey: bars are positional, oldest first
              key={i}
              className={v >= 0 ? s.barPay : s.barReceive}
              x={x}
              y={v >= 0 ? mid - h : mid}
              width={bar}
              height={Math.max(h, 0.5)}
            />
          );
        })}
      </svg>
      <figcaption className={s.chartCaption}>
        <span>{values.length} intervals ago</span>
        <span>lime: longs paid · coral: shorts paid</span>
        <span>latest</span>
      </figcaption>
    </figure>
  );
}

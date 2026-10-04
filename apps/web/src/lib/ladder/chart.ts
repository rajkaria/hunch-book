import { BPS } from "@hunch-book/shared";
import { formatChance, formatInt } from "../format";
import { type LadderAxis, type LadderPoint, niceStep } from "./group";

// The geometry of the ladder chart (chance of YES against strike), as pure functions: scales, ticks and
// the curve's path. The component draws it as inline SVG.

export interface ChartBox {
  width: number;
  height: number;
  pad: { top: number; right: number; bottom: number; left: number };
}

export const DEFAULT_BOX: ChartBox = {
  width: 640,
  height: 300,
  pad: { top: 18, right: 22, bottom: 44, left: 52 },
};

export interface Tick {
  value: bigint;
  pos: number;
  label: string;
}

export interface ChartGeometry {
  box: ChartBox;
  xMin: bigint;
  xMax: bigint;
  /** Strike to pixels. */
  x: (value: bigint) => number;
  /** Basis points (0 to 10,000) to pixels; 100% at the top. */
  y: (bps: bigint) => number;
  xTicks: Tick[];
  yTicks: Tick[];
}

/** "$120k", "$1.2M", "$950" for USD strikes with 8 decimals; plain integers for Perpl units. */
export function compactStrike(x: bigint, axis: LadderAxis): string {
  if (axis === "perpl") return formatInt(x);
  const usd = Number(x) / 1e8;
  const abs = Math.abs(usd);
  const trim = (n: number) => n.toFixed(n >= 100 || Number.isInteger(n) ? 0 : 1).replace(/\.0$/, "");
  if (abs >= 1e6) return `$${trim(usd / 1e6)}M`;
  if (abs >= 1e4) return `$${trim(usd / 1e3)}k`;
  if (abs >= 1) return `$${usd.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  return `$${usd.toPrecision(2)}`;
}

/** The x domain of a ladder: every strike and upper bound, padded so no point sits on the edge. */
export function xDomain(points: readonly Pick<LadderPoint, "x" | "upper">[]): { min: bigint; max: bigint } {
  const values = points.flatMap((p) => (p.upper === null ? [p.x] : [p.x, p.upper]));
  if (values.length === 0) return { min: 0n, max: 1n };
  let min = values[0] as bigint;
  let max = min;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const span = max - min;
  const pad = span > 0n ? span / 10n : niceStep((min < 0n ? -min : min) / 20n);
  return { min: min - pad, max: max + (pad > 0n ? pad : 1n) };
}

/** Round ticks across [min, max], about `target` of them. */
export function niceTicks(min: bigint, max: bigint, target = 5): bigint[] {
  if (max <= min) return [min];
  const step = niceStep((max - min) / BigInt(Math.max(1, target - 1)));
  const first = min % step === 0n ? min : min >= 0n ? (min / step + 1n) * step : (min / step) * step;
  const ticks: bigint[] = [];
  for (let v = first; v <= max && ticks.length < 12; v += step) ticks.push(v);
  return ticks;
}

export function chartGeometry(
  points: readonly Pick<LadderPoint, "x" | "upper">[],
  axis: LadderAxis,
  box: ChartBox = DEFAULT_BOX,
): ChartGeometry {
  const { min, max } = xDomain(points);
  const innerW = box.width - box.pad.left - box.pad.right;
  const innerH = box.height - box.pad.top - box.pad.bottom;
  const span = Number(max - min) || 1;
  const x = (value: bigint): number => box.pad.left + (Number(value - min) / span) * innerW;
  const y = (bps: bigint): number => box.pad.top + (1 - Number(bps) / Number(BPS)) * innerH;
  const xTicks = niceTicks(min, max).map((value) => ({
    value,
    pos: x(value),
    label: compactStrike(value, axis),
  }));
  const yTicks = [0n, 2_500n, 5_000n, 7_500n, 10_000n].map((value) => ({
    value,
    pos: y(value),
    label: `${Number(value) / 100}%`,
  }));
  return { box, xMin: min, xMax: max, x, y, xTicks, yTicks };
}

/** The curve through every rung that has a chance, as an SVG path. Strike ladders only. */
export function curvePath(points: readonly LadderPoint[], g: Pick<ChartGeometry, "x" | "y">): string {
  return points
    .filter((p) => p.chanceBps !== null)
    .map((p, i) => `${i === 0 ? "M" : "L"}${g.x(p.x).toFixed(1)} ${g.y(p.chanceBps as bigint).toFixed(1)}`)
    .join(" ");
}

/** One sentence for screen readers: the whole curve, rung by rung. */
export function chartSummary(points: readonly LadderPoint[], label: (p: LadderPoint) => string): string {
  const parts = points.map(
    (p) => `${label(p)}: ${p.chanceBps === null ? "no chance yet" : formatChance(p.chanceBps)}`,
  );
  return parts.join("; ");
}

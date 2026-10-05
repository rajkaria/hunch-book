import { formatUsdNumber } from "@/lib/hedge/math";

// Number words shared by the hedge page's parts.

export const fmtUnits = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 6 });
export const fmtCount = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 1 });
export const fmtPct = (n: number | null) =>
  n === null ? "n/a" : `${n.toLocaleString("en-US", { maximumSignificantDigits: 3 })}%`;
export const usdc = (n: number) => `${formatUsdNumber(n).replace("$", "")} USDC`;
/** Tokens to buy, rounded up to the cent so the order is never short. */
export const fmtTokens = (n: number) => `${fmtUnits(Math.ceil(n * 100) / 100)} tokens`;
/** A cover ratio as a percent: 0.75 is "75%". */
export const fmtCover = (cover: number) => `${Math.round(cover * 100)}%`;

export function PaidWords({ usd }: { usd: number }) {
  return usd >= 0 ? <>pays {formatUsdNumber(usd)}</> : <>receives {formatUsdNumber(-usd)}</>;
}

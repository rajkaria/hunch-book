import { formatFixed } from "../format";

// Tape formatting. UTC, so the server and every browser print the same thing.

const pad2 = (n: number): string => n.toString().padStart(2, "0");

/** Unix seconds to "12:04:31 UTC". */
export function formatClockUtc(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  if (Number.isNaN(d.getTime())) return "unknown time";
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())} UTC`;
}

/** Seconds between then and now as "now", "8s ago", "4m ago", "3h ago" or "2d ago". */
export function formatAgo(thenSeconds: number, nowSeconds: number): string {
  const s = Math.max(0, Math.floor(nowSeconds - thenSeconds));
  if (s < 2) return "now";
  if (s < 60) return `${s}s ago`;
  if (s < 3_600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3_600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

/** USDC base units per token to "0.416" (three decimals, rounded down). */
export function formatPriceE6(priceE6: bigint): string {
  return formatFixed(priceE6, 6, { minDecimals: 3, maxDecimals: 3 });
}

import { USDC_DECIMALS } from "@hunch-book/shared";

// Display helpers. Pure functions, no locale surprises: grouping uses commas and times are UTC,
// so the server and the browser render the same string.

const group = (digits: string): string => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/**
 * Formats a fixed-point integer. Rounds toward zero, so a payout is never shown higher than it is.
 * `minDecimals` pads, `maxDecimals` truncates; trailing zeros beyond `minDecimals` are dropped.
 */
export function formatFixed(
  value: bigint,
  decimals: number,
  { minDecimals = 0, maxDecimals = decimals }: { minDecimals?: number; maxDecimals?: number } = {},
): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  let frac = (abs % base).toString().padStart(decimals, "0").slice(0, maxDecimals);
  frac = frac.replace(/0+$/, "");
  if (frac.length < minDecimals) frac = frac.padEnd(minDecimals, "0");
  const body = frac.length > 0 ? `${group(whole.toString())}.${frac}` : group(whole.toString());
  const isZero = whole === 0n && /^0*$/.test(frac);
  return negative && !isZero ? `-${body}` : body;
}

/** USDC base units (6 decimals) to "1,234.56". Always two decimals unless `exact`. */
export function formatUsdc(base: bigint, { exact = false }: { exact?: boolean } = {}): string {
  return exact
    ? formatFixed(base, USDC_DECIMALS, { minDecimals: 2 })
    : formatFixed(base, USDC_DECIMALS, { minDecimals: 2, maxDecimals: 2 });
}

/** A USD price with 8 decimals (Chainlink style) to "$120,000.00" or "$0.035". */
export function formatE8Usd(e8: bigint): string {
  const negative = e8 < 0n;
  const body = formatFixed(negative ? -e8 : e8, 8, { minDecimals: 2 });
  return negative ? `-$${body}` : `$${body}`;
}

/** Basis points (0 to 10,000) to "62.5%". */
export function formatChance(bps: bigint | number | null | undefined): string {
  if (bps === null || bps === undefined) return "n/a";
  const n = typeof bps === "bigint" ? Number(bps) : bps;
  const clamped = Math.min(10_000, Math.max(0, Math.trunc(n)));
  const whole = Math.trunc(clamped / 100);
  const tenth = Math.trunc((clamped % 100) / 10);
  return `${whole}.${tenth}%`;
}

/**
 * NO's chance as shown beside YES's: 100% minus YES as formatChance writes it, so the two always add up
 * to 100.0% (8,625 bps reads YES 86.2% and NO 13.8%, not 13.7%).
 */
export function chanceComplementBps(bps: bigint | number): number {
  const n = typeof bps === "bigint" ? Number(bps) : bps;
  const yesTenths = Math.trunc(Math.min(10_000, Math.max(0, Math.trunc(n))) / 10);
  return (1_000 - yesTenths) * 10;
}

/** Basis points to a short whole percent, for rules like "3% to 97%". */
export function formatBpsPercent(bps: number | bigint): string {
  const n = Number(bps);
  return Number.isInteger(n / 100) ? `${n / 100}%` : `${(n / 100).toFixed(2).replace(/0+$/, "")}%`;
}

/** Seconds to "2d 4h", "3h 12m", "12m 5s" or "45s". Zero or less reads "now". */
export function formatDuration(seconds: number | bigint): string {
  let s = Math.floor(Number(seconds));
  if (!Number.isFinite(s) || s <= 0) return "now";
  const d = Math.floor(s / 86_400);
  s -= d * 86_400;
  const h = Math.floor(s / 3_600);
  s -= h * 3_600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const pad2 = (n: number): string => n.toString().padStart(2, "0");

/** Unix seconds to "Fri 10 Oct 2026, 12:00 UTC". */
export function formatUtc(unixSeconds: number | bigint): string {
  const date = new Date(Number(unixSeconds) * 1000);
  if (Number.isNaN(date.getTime())) return "unknown time";
  return `${DAYS[date.getUTCDay()]} ${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}, ${pad2(
    date.getUTCHours(),
  )}:${pad2(date.getUTCMinutes())} UTC`;
}

/** Unix seconds to "Oct 4, 06:10", in UTC, for titles that say "UTC" once at the end. */
export function formatShortUtc(unixSeconds: number | bigint): string {
  const date = new Date(Number(unixSeconds) * 1000);
  if (Number.isNaN(date.getTime())) return "unknown time";
  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}, ${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}`;
}

/** Integer with thousands separators: 12345678 to "12,345,678". */
export function formatInt(value: number | bigint): string {
  const v = typeof value === "bigint" ? value : BigInt(Math.trunc(value));
  return v < 0n ? `-${group((-v).toString())}` : group(v.toString());
}

/** A count with its noun, singular for exactly one: "1 fill", "2,500 fills", "1 block". */
export function formatCount(value: number | bigint, one: string, many = `${one}s`): string {
  const n = typeof value === "bigint" ? value : BigInt(Math.trunc(value));
  return `${formatInt(n)} ${n === 1n ? one : many}`;
}

/** "0x1234…abcd". */
export function shortAddress(address: string, chars = 4): string {
  if (address.length <= 2 + chars * 2) return address;
  return `${address.slice(0, 2 + chars)}…${address.slice(-chars)}`;
}

/** "0x1234…abcd" for 32-byte hashes. */
export function shortHash(hash: string): string {
  return shortAddress(hash, 6);
}

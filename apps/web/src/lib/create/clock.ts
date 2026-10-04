// Clock times and block numbers. Perpl markets are defined in blocks, so a person picks clock times
// and the app converts them with the chain's measured block pace, and says how sure that estimate is.

/** The latest block: its number and unix timestamp. */
export interface Head {
  number: bigint;
  timestamp: number;
}

/** Milliseconds per block, and how far the pace drifted between two recent spans (a fraction). */
export interface Pace {
  msPerBlock: number;
  /** Relative uncertainty used for estimates, at least MIN_DRIFT. */
  drift: number;
  /** False when no measurement was possible and the chain's nominal block time is used. */
  measured: boolean;
}

/** Blocks per measured span: the pace is read from two block timestamps this far apart. */
export const PACE_SPAN = 10_000n;

/** Even a steady chain gets this much uncertainty: block production can speed up or slow down. */
export const MIN_DRIFT = 0.02;

/** Uncertainty used when the pace could not be measured at all. */
export const NOMINAL_DRIFT = 0.15;

/**
 * The pace from two consecutive spans (the latest PACE_SPAN blocks, and the PACE_SPAN before them).
 * The drift is how much the two disagree, never less than MIN_DRIFT.
 */
export function paceFrom(recentMs: number | null, olderMs: number | null, nominalMs: number): Pace {
  if (recentMs === null || !(recentMs > 0)) {
    return { msPerBlock: nominalMs, drift: NOMINAL_DRIFT, measured: false };
  }
  const drift = olderMs !== null && olderMs > 0 ? Math.abs(recentMs - olderMs) / recentMs : 0;
  return { msPerBlock: recentMs, drift: Math.max(MIN_DRIFT, drift), measured: true };
}

/** The first block expected at or after `unix`, from the head and the pace. Never before the head. */
export function blockAt(unix: number, head: Head, msPerBlock: number): bigint {
  const seconds = unix - head.timestamp;
  if (seconds <= 0) return head.number;
  return head.number + BigInt(Math.ceil((seconds * 1000) / msPerBlock));
}

/** Estimated unix seconds when `block` is produced. */
export function timeAt(block: bigint, head: Head, msPerBlock: number): number {
  return Math.round(head.timestamp + (Number(block - head.number) * msPerBlock) / 1000);
}

/** How many seconds either side of the estimate `block` could land: distance times drift. */
export function uncertaintySeconds(block: bigint, head: Head, pace: Pace): number {
  const away = Math.abs(Number(block - head.number)) * (pace.msPerBlock / 1000);
  return Math.round(away * pace.drift);
}

/** "give or take 4 minutes", "give or take 2 hours", "give or take under a minute". */
export function formatPlusMinus(seconds: number): string {
  if (seconds < 60) return "give or take under a minute";
  if (seconds < 5_400) {
    const minutes = Math.round(seconds / 60);
    return `give or take ${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  const hours = Math.round(seconds / 3_600);
  return `give or take ${hours} hour${hours === 1 ? "" : "s"}`;
}

const pad2 = (n: number): string => n.toString().padStart(2, "0");

/** Unix seconds to a `datetime-local` input value ("2026-10-05T12:00") in the browser's time zone. */
export function toLocalInput(unix: number): string {
  const d = new Date(unix * 1000);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** A `datetime-local` value, read in the browser's time zone, to unix seconds. Null if malformed. */
export function fromLocalInput(value: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const date = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s ?? 0));
  const unix = Math.floor(date.getTime() / 1000);
  return Number.isFinite(unix) ? unix : null;
}

/** "Mon 5 Oct, 17:30 GMT+5:30": the time in the browser's own zone, with the zone named. */
export function formatLocal(unix: number): string {
  const date = new Date(unix * 1000);
  if (Number.isNaN(date.getTime())) return "unknown time";
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZoneName: "short",
  }).format(date);
}

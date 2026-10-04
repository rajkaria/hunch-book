import { toJsonSafe } from "@hunch-book/sdk";

// Responses for the data API: JSON (bigints as decimal strings) or CSV, open CORS for GET, and cache
// headers so a CDN serves repeat requests. Errors carry one plain sentence and are never cached.

export const CORS_HEADERS: Readonly<Record<string, string>> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

export interface CacheTime {
  /** Seconds a browser and the CDN may serve the response without asking again. */
  maxAge: number;
  /** Seconds the CDN may keep serving it while it refreshes in the background. */
  staleWhileRevalidate: number;
}

export const CACHE = {
  /** Lists, details and the feed: prices move every block. */
  live: { maxAge: 15, staleWhileRevalidate: 60 },
  /** Trades and stats. */
  recent: { maxAge: 30, staleWhileRevalidate: 120 },
  /** Settlement evidence: final once settled. */
  slow: { maxAge: 60, staleWhileRevalidate: 600 },
} as const satisfies Record<string, CacheTime>;

const cacheControl = (c: CacheTime): string =>
  `public, max-age=${c.maxAge}, s-maxage=${c.maxAge}, stale-while-revalidate=${c.staleWhileRevalidate}`;

export function json(body: unknown, cache: CacheTime, status = 200): Response {
  return new Response(JSON.stringify(toJsonSafe(body)), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": cacheControl(cache),
      ...CORS_HEADERS,
    },
  });
}

/** One plain-word error: `{ "error": "..." }`, not cached. */
export function problem(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...CORS_HEADERS,
    },
  });
}

/** The CORS preflight answer. */
export function preflight(): Response {
  return new Response(null, { status: 204, headers: { ...CORS_HEADERS } });
}

export function wantsCsv(request: Request): boolean {
  return new URL(request.url).searchParams.get("format")?.toLowerCase() === "csv";
}

/** One CSV cell: quoted when it holds a comma, quote or line break; formulas neutralised. */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let s =
    typeof value === "bigint"
      ? value.toString()
      : typeof value === "object"
        ? JSON.stringify(toJsonSafe(value))
        : String(value);
  // A leading =, +, - or @ makes spreadsheets run the cell as a formula; numbers keep their sign.
  if (/^[=+\-@]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csv(
  rows: readonly Record<string, unknown>[],
  columns: readonly string[],
  filename: string,
  cache: CacheTime,
): Response {
  const lines = [columns.join(","), ...rows.map((r) => columns.map((c) => csvCell(r[c])).join(","))];
  return new Response(`${lines.join("\r\n")}\r\n`, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": cacheControl(cache),
      ...CORS_HEADERS,
    },
  });
}

/** An object as `field,value` rows, nested fields joined with dots, for single-record CSVs. */
export function flatten(value: unknown, prefix = ""): Record<string, unknown>[] {
  const safe = toJsonSafe(value);
  if (safe === null || typeof safe !== "object") return [{ field: prefix || "value", value: safe }];
  const rows: Record<string, unknown>[] = [];
  for (const [k, v] of Object.entries(safe as Record<string, unknown>)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) rows.push(...flatten(v, key));
    else rows.push({ field: key, value: Array.isArray(v) ? JSON.stringify(v) : v });
  }
  return rows;
}

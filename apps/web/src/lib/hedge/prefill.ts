import type { Deployment } from "@hunch-book/shared";
import { lotsFromUnits, type PerpMeta, type PerpPosition, type PositionSide } from "./math";

// Links into the hedge assistant with a position filled in (docs/HEDGE.md, Links into the page):
//   /hedge?perp=BTC&side=long&size=0.5
// `perp` is the perp's name in deployments/<network>.json (any case), `side` is long or short (long when
// left out), `size` is in units of the base asset. The page adds it as a position typed in by hand.
// Anything malformed is ignored. The funding-cost calculator (/calculator) links here.

export interface HedgePrefill {
  /** The perp's name as typed, upper-cased: "BTC". */
  asset: string;
  side: PositionSide;
  /** Units of the base asset. */
  size: number;
}

/** A query string, or the record a Next.js page gets as `searchParams`. */
export type QueryLike = URLSearchParams | Record<string, string | string[] | undefined>;

/** The first value of `key`, trimmed, or undefined. */
export function queryValue(query: QueryLike, key: string): string | undefined {
  const raw = query instanceof URLSearchParams ? (query.get(key) ?? undefined) : query[key];
  return (Array.isArray(raw) ? raw[0] : raw)?.trim() || undefined;
}

/** "BTC" from "btc": letters and digits only, at most 16. Null for anything else. */
export function parseAssetParam(value: string | undefined): string | null {
  return value && /^[A-Za-z0-9]{1,16}$/.test(value) ? value.toUpperCase() : null;
}

/** A positive size written as plain digits ("0.5", "12"), else null. */
export function parseSizeParam(value: string | undefined): number | null {
  if (!value || !/^(\d{1,15}(\.\d{1,18})?|\.\d{1,18})$/.test(value)) return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function parseSideParam(value: string | undefined): PositionSide | null {
  const v = value?.toLowerCase();
  return v === "long" || v === "short" ? v : null;
}

export function parseHedgePrefill(query: QueryLike): HedgePrefill | null {
  const asset = parseAssetParam(queryValue(query, "perp"));
  const size = parseSizeParam(queryValue(query, "size"));
  if (!asset || size === null) return null;
  return { asset, side: parseSideParam(queryValue(query, "side")) ?? "long", size };
}

/** The perp id the deployment lists under `asset` ("btc" finds BTC), or undefined. */
export function perpIdOf(deployment: Pick<Deployment, "external">, asset: string): bigint | undefined {
  const want = asset.trim().toUpperCase();
  const entry = Object.entries(deployment.external.perpl.perps).find(([name]) => name.toUpperCase() === want);
  return entry ? BigInt(entry[1]) : undefined;
}

/** The prefilled position, in lots of this perp. Null when the size rounds to zero lots. */
export function prefillPosition(prefill: HedgePrefill, meta: PerpMeta): PerpPosition | null {
  const lots = lotsFromUnits(prefill.size, meta);
  if (lots <= 0n) return null;
  return {
    perpId: meta.perpId,
    side: prefill.side,
    lots,
    entryPricePNS: null,
    entryBlock: null,
    premiumPnlCNS: null,
    source: "manual",
  };
}

/** The hedge page with a position filled in. `size` is already written out, such as "0.05978". */
export function hedgeUrl(args: { asset: string; side: PositionSide; size: string }): string {
  const q = new URLSearchParams({ perp: args.asset, side: args.side, size: args.size });
  return `/hedge?${q.toString()}`;
}

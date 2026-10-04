import { Side } from "@hunch-book/shared";
import type { Hex } from "viem";
import { appDeployment } from "../config";
import { parsePrefill } from "../ladder/prefill";
import { type LinkSource, parseLinkSource } from "./linked";
import { templateById } from "./templates";

// Values another page can hand the create form in the query string, for example the hedge
// assistant's "Create this market" (docs/HEDGE.md):
//   /create?template=1&asset=BTC&start=<unix>&end=<unix>&threshold=<USD per unit>&side=<yes|no>
// Times stay unix seconds here; the form turns them into local clock inputs in the browser and snaps
// the window to Perpl's grid as it does for typed values. Anything malformed is ignored.

export interface CreatePrefill {
  asset?: string;
  start?: number;
  end?: number;
  threshold?: string;
  side?: Side;
}

type Query = Record<string, string | string[] | undefined>;

const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v)?.trim();

export function parseCreatePrefill(query: Query): CreatePrefill {
  const out: CreatePrefill = {};
  const asset = one(query.asset);
  if (asset && Object.hasOwn(appDeployment.external.perpl.perps, asset)) out.asset = asset;
  const start = one(query.start);
  const end = one(query.end);
  if (start && /^\d{9,11}$/.test(start)) out.start = Number(start);
  if (end && /^\d{9,11}$/.test(end)) out.end = Number(end);
  const threshold = one(query.threshold);
  if (threshold && /^-?\d+(\.\d+)?$/.test(threshold)) out.threshold = threshold;
  const side = one(query.side)?.toLowerCase();
  if (side === "yes") out.side = Side.Yes;
  if (side === "no") out.side = Side.No;
  return out;
}

/**
 * A link that carries a market's exact parameters (lib/ladder/prefill.ts): `?template=<id>&params=<hex>`,
 * with `from` naming the page that sent it. Undefined when either is missing or malformed, or when the
 * template is not one this app can build.
 */
export function parseCreateLink(
  query: Query,
): { templateId: number; params: Hex; from: LinkSource } | undefined {
  const search = new URLSearchParams();
  for (const key of ["template", "params", "from"]) {
    const value = one(query[key]);
    if (value !== undefined) search.set(key, value);
  }
  const link = parsePrefill(search);
  if (!link || !templateById(link.templateId)) return undefined;
  return { ...link, from: parseLinkSource(search.get("from")) };
}

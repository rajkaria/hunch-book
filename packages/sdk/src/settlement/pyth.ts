import { encodeAbiParameters, type Hex, isHex, parseAbi } from "viem";
import type { PythOptions } from "../context.js";

// The signed Pyth update a price market (templates 2 and 5 with source 1) settles with: the first
// update published at or after the close T, within 60 seconds, fetched from Pyth's Hermes service:
//   GET {hermes}/v2/updates/price/{T}?ids[]={id}&encoding=hex&parsed=true
// Historical updates need a Pyth API key, sent as `Authorization: Bearer`.

export const HERMES_URL = "https://hermes.pyth.network";
export const PYTH_MAX_DELAY_SECONDS = 60;

export const pythFeeAbi = parseAbi(["function getUpdateFee(bytes[] updateData) view returns (uint256)"]);
export const resolverPythAbi = parseAbi(["function pyth() view returns (address)"]);

export interface HermesUpdate {
  updateData: Hex[];
  publishTime: number;
  price: string | undefined;
  expo: number | undefined;
}

export type HermesResult =
  | { status: "found"; update: HermesUpdate }
  | { status: "wait"; reason: string }
  | { status: "unsettleable"; reason: string };

interface HermesBody {
  binary?: { data?: string[] };
  parsed?: {
    id?: string;
    price?: { price?: string; expo?: number; publish_time?: number };
    metadata?: { prev_publish_time?: number };
  }[];
}

const strip0x = (s: string): string => (s.startsWith("0x") ? s.slice(2) : s);

/** Checks a Hermes answer against the resolver's rule for T. Pure. */
export function checkHermesUpdate(body: HermesBody, id: Hex, target: bigint): HermesResult {
  const data = body.binary?.data;
  if (!Array.isArray(data) || data.length === 0)
    return { status: "wait", reason: "Hermes returned no update." };
  const updateData = data.map((d) => (d.startsWith("0x") ? d : `0x${d}`) as Hex);
  if (!updateData.every((d) => isHex(d)))
    return { status: "wait", reason: "Hermes returned data that is not hex." };
  const parsed = body.parsed?.find((p) => p.id && strip0x(p.id).toLowerCase() === strip0x(id).toLowerCase());
  const publishTime = parsed?.price?.publish_time;
  if (publishTime === undefined) return { status: "wait", reason: "Hermes returned no price for this id." };
  const t = Number(target);
  if (publishTime < t) return { status: "wait", reason: "Hermes has no update at or after the close yet." };
  if (publishTime > t + PYTH_MAX_DELAY_SECONDS) {
    return {
      status: "unsettleable",
      reason: `Pyth's first update after the close was published ${publishTime - t} seconds after it, more than the 60 the resolver accepts. The market voids at its deadline.`,
    };
  }
  const prev = parsed?.metadata?.prev_publish_time;
  if (prev !== undefined && prev >= t) {
    return {
      status: "unsettleable",
      reason: "Hermes returned an update that is not the first one at or after the close.",
    };
  }
  return {
    status: "found",
    update: { updateData, publishTime, price: parsed?.price?.price, expo: parsed?.price?.expo },
  };
}

export async function fetchHermesUpdate(
  options: PythOptions | undefined,
  id: Hex,
  target: bigint,
): Promise<HermesResult> {
  if (!options?.apiKey) {
    return {
      status: "wait",
      reason: "Settling needs a signed Pyth update. Pass `pyth: { apiKey }` to fetch one from Hermes.",
    };
  }
  const base = options.hermesUrl ?? HERMES_URL;
  const url = `${base}/v2/updates/price/${target}?ids[]=${strip0x(id)}&encoding=hex&parsed=true`;
  const res = await (options.fetch ?? fetch)(url, {
    headers: { accept: "application/json", authorization: `Bearer ${options.apiKey}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 404)
    return { status: "wait", reason: "Hermes has no update at or after the close yet." };
  if (!res.ok) return { status: "wait", reason: `Hermes answered HTTP ${res.status}.` };
  return checkHermesUpdate((await res.json()) as HermesBody, id, target);
}

/** Evidence for a Pyth price market: abi.encode(bytes[] updateData). */
export function pythEvidence(updateData: readonly Hex[]): Hex {
  return encodeAbiParameters([{ type: "bytes[]" }], [updateData]);
}

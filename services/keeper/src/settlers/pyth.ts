import { type Hex, isHex } from "viem";

// Fetches the signed Pyth update for a price id at time T from Pyth's Hermes service:
//   GET {hermes}/v2/updates/price/{T}?ids[]={id}&encoding=hex&parsed=true
// Hermes answers with the first update published at or after T. Historical updates need a Pyth API
// key (PYTH_API_KEY), sent as `Authorization: Bearer`. PriceAtTimeResolver accepts the update only if
// it was published in [T, T + 60 s] and the update before it was published before T
// (parsePriceFeedUpdatesUnique), so the keeper checks the same before it spends gas.

export const PYTH_MAX_DELAY_SECONDS = 60;

export interface HermesUpdate {
  /** The signed update(s), as bytes for `abi.encode(bytes[] updateData)`. */
  updateData: Hex[];
  publishTime: number;
  prevPublishTime: number | undefined;
  price: string | undefined;
  expo: number | undefined;
}

export type HermesResult =
  | { status: "found"; update: HermesUpdate }
  | { status: "wait"; reason: string }
  | { status: "unsettleable"; reason: string };

type Fetch = typeof fetch;

interface HermesBody {
  binary?: { encoding?: string; data?: string[] };
  parsed?: {
    id?: string;
    price?: { price?: string; expo?: number; publish_time?: number };
    metadata?: { prev_publish_time?: number };
  }[];
}

const strip0x = (id: string) => (id.startsWith("0x") ? id.slice(2) : id);

export function hermesUrl(base: string, id: Hex, target: bigint): string {
  return `${base}/v2/updates/price/${target}?ids[]=${strip0x(id)}&encoding=hex&parsed=true`;
}

/** Checks a Hermes answer against the resolver's rule for T. Pure, so it is unit-tested directly. */
export function checkHermesUpdate(body: HermesBody, id: Hex, target: bigint): HermesResult {
  const data = body.binary?.data;
  if (!Array.isArray(data) || data.length === 0) {
    return { status: "wait", reason: "Hermes returned no update data" };
  }
  const updateData = data.map((d) => (d.startsWith("0x") ? d : `0x${d}`) as Hex);
  if (!updateData.every((d) => isHex(d))) {
    return { status: "wait", reason: "Hermes returned update data that is not hex" };
  }
  const parsed = body.parsed?.find((p) => p.id && strip0x(p.id).toLowerCase() === strip0x(id).toLowerCase());
  const publishTime = parsed?.price?.publish_time;
  if (publishTime === undefined) {
    return { status: "wait", reason: "Hermes returned no parsed price for the id" };
  }
  const prevPublishTime = parsed?.metadata?.prev_publish_time;
  const t = Number(target);
  if (publishTime < t) {
    return { status: "wait", reason: `Hermes update published at ${publishTime}, before T (${t})` };
  }
  if (publishTime > t + PYTH_MAX_DELAY_SECONDS) {
    return {
      status: "unsettleable",
      reason: `the first Pyth update after T was published at ${publishTime}, more than ${PYTH_MAX_DELAY_SECONDS} s after T (${t})`,
    };
  }
  if (prevPublishTime !== undefined && prevPublishTime >= t) {
    return {
      status: "unsettleable",
      reason: `the update's previous publish time ${prevPublishTime} is not before T (${t}), so it is not the first update at or after T`,
    };
  }
  return {
    status: "found",
    update: {
      updateData,
      publishTime,
      prevPublishTime,
      price: parsed?.price?.price,
      expo: parsed?.price?.expo,
    },
  };
}

export async function fetchHermesUpdate(opts: {
  baseUrl: string;
  apiKey: string | undefined;
  id: Hex;
  target: bigint;
  fetchFn?: Fetch;
}): Promise<HermesResult> {
  if (!opts.apiKey) {
    return { status: "wait", reason: "PYTH_API_KEY is not set: Hermes needs it for historical updates" };
  }
  const res = await (opts.fetchFn ?? fetch)(hermesUrl(opts.baseUrl, opts.id, opts.target), {
    headers: { accept: "application/json", authorization: `Bearer ${opts.apiKey}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 404) return { status: "wait", reason: "Hermes has no update at or after T yet" };
  if (!res.ok) return { status: "wait", reason: `Hermes answered HTTP ${res.status}` };
  return checkHermesUpdate((await res.json()) as HermesBody, opts.id, opts.target);
}

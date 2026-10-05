import type { L2Level } from "@hunch-book/shared";
import { appNetwork } from "../config";
import { estimateBlockTime, PRICE_SCALE } from "../market/logic";
import type { ChainClock, MarketView } from "../market/types";
import { challengeSecondsFor, type Health, marketHealth } from "./score";

// The health score (score.ts) from what the app already reads about a market: the view, the chain clock
// and, on the market page, the full Kuru book for depth.

/** The band around the mid that counts as depth, in USDC per token. */
export const DEPTH_BAND = 0.05;

/**
 * USDC resting within `band` of the mid on both sides together, from L2 levels in book units (price
 * scaled by `pricePrecision`, size by `sizePrecision`). Null when either side is empty.
 */
export function depthWithinBand(
  bids: readonly L2Level[],
  asks: readonly L2Level[],
  pricePrecision: bigint,
  sizePrecision: bigint,
  band = DEPTH_BAND,
): number | null {
  const best = (levels: readonly L2Level[]) =>
    levels[0] ? Number(levels[0].price) / Number(pricePrecision) : null;
  const bid = best(bids);
  const ask = best(asks);
  if (bid === null || ask === null) return null;
  const mid = (bid + ask) / 2;
  let usdc = 0;
  for (const l of [...bids, ...asks]) {
    const price = Number(l.price) / Number(pricePrecision);
    if (Math.abs(price - mid) <= band + 1e-9) usdc += price * (Number(l.size) / Number(sizePrecision));
  }
  return usdc;
}

const price = (p: bigint | null | undefined): number | null =>
  p === null || p === undefined ? null : Number((p * 1_000_000n) / PRICE_SCALE) / 1e6;

/** The market's health now. `now` is unix seconds. */
export function viewHealth(
  m: MarketView,
  clock: ChainClock | null,
  now: number,
  depthUsdc: number | null = null,
): Health {
  const at = (point: bigint): number =>
    !m.window.blockClock ? Number(point) : clock ? estimateBlockTime(point, clock) : Number.NaN;
  const closeAt = at(m.window.close);
  return marketHealth({
    phase: m.phase,
    graduated: m.graduated,
    templateId: m.templateId,
    network: appNetwork,
    bid: price(m.quote?.bid),
    ask: price(m.quote?.ask),
    depthUsdc,
    pool: { yesUsdc: Number(m.pool.yes) / 1e6, noUsdc: Number(m.pool.no) / 1e6, stakers: m.pool.stakers },
    rule: { minPoolUsdc: Number(m.rule.minPool) / 1e6, minStakers: m.rule.minStakers },
    now,
    closeAt,
    lockAt: at(m.window.lock),
    settleFrom: closeAt + challengeSecondsFor(m.templateId),
  });
}

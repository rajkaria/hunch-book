import { type Address, getAddress, isAddressEqual } from "viem";
import type { RestingOrder } from "./orders.js";

// The maker-reward formula of docs/PERIPHERY.md (V-5), in exact integer arithmetic:
//
//   1. Samples: every resting order (price, size, owner) and the book's mid, every N blocks.
//   2. Order score: with a band B around the mid and d = |price − mid|, an order with d < B scores
//      size · ((B − d) / B)^2: full size at the mid, nothing at the band's edge.
//   3. Two-sided: per maker and sample, Qbid and Qask sum their bids' and asks' scores, and the
//      sample score is S = max(min(Qbid, Qask), max(Qbid, Qask) / 3).
//   4. Payout: reward(maker) = floor(R · ΣS(maker) / ΣS(every maker)) for a market's pool R.
//
// To stay exact, everything is scaled: prices are doubled so the mid (bid + ask) / 2 is a whole number,
// the (B − d)^2 / B^2 factor keeps its numerator (B^2 is the same for every order), and S is tripled.
// Those factors cancel in step 4. Hunch Book's own maker is excluded from payouts by default and its
// share is not redistributed: it stays in the denominator, and that part of R is never paid.

/** The band B: 0.03 USDC per YES, in E6 (docs/PERIPHERY.md). */
export const DEFAULT_BAND_E6 = 30_000n;

export interface Sample {
  market: Address;
  block: bigint;
  /** Unix seconds, when known. */
  time?: number;
  orders: RestingOrder[];
}

export interface SampleScore {
  /** 3 · S, in the scaled units described above. */
  s3: bigint;
  qBid: bigint;
  qAsk: bigint;
  /** The maker had an order at the best bid or the best ask. */
  atTouch: boolean;
}

/** One sample's scores per maker, or null when the book had no mid (one side empty). */
export function scoreSample(
  orders: readonly RestingOrder[],
  bandE6: bigint = DEFAULT_BAND_E6,
): Map<Address, SampleScore> | null {
  let bestBid: bigint | null = null;
  let bestAsk: bigint | null = null;
  for (const o of orders) {
    if (o.size <= 0n) continue;
    if (o.isBuy) bestBid = bestBid === null || o.price > bestBid ? o.price : bestBid;
    else bestAsk = bestAsk === null || o.price < bestAsk ? o.price : bestAsk;
  }
  if (bestBid === null || bestAsk === null) return null;
  const mid2 = bestBid + bestAsk;
  const band2 = 2n * bandE6;
  const out = new Map<Address, SampleScore>();
  for (const o of orders) {
    if (o.size <= 0n) continue;
    const owner = getAddress(o.owner);
    const entry = out.get(owner) ?? { s3: 0n, qBid: 0n, qAsk: 0n, atTouch: false };
    const diff = 2n * o.price - mid2;
    const d2 = diff < 0n ? -diff : diff;
    if (d2 < band2) {
      const weight = o.size * (band2 - d2) ** 2n;
      if (o.isBuy) entry.qBid += weight;
      else entry.qAsk += weight;
    }
    if ((o.isBuy && o.price === bestBid) || (!o.isBuy && o.price === bestAsk)) entry.atTouch = true;
    out.set(owner, entry);
  }
  for (const entry of out.values()) {
    const lo = entry.qBid < entry.qAsk ? entry.qBid : entry.qAsk;
    const hi = entry.qBid < entry.qAsk ? entry.qAsk : entry.qBid;
    entry.s3 = 3n * lo > hi ? 3n * lo : hi;
  }
  return out;
}

export interface MakerTotals {
  maker: Address;
  /** Σ 3 · S over the samples (scaled). */
  score: bigint;
  /** Samples in which the maker had an order inside the band. */
  samplesInBand: number;
  /** Samples in which the maker had an order at the best bid or ask: time at the touch. */
  samplesAtTouch: number;
}

export interface MarketScore {
  market: Address;
  /** Samples with a two-sided book. */
  samples: number;
  /** Samples skipped because one side of the book was empty. */
  skipped: number;
  makers: MakerTotals[];
  /** Σ score over every maker, ours included. */
  total: bigint;
}

/** Adds up one market's samples. */
export function scoreMarket(
  market: Address,
  samples: readonly Sample[],
  bandE6: bigint = DEFAULT_BAND_E6,
): MarketScore {
  const totals = new Map<Address, MakerTotals>();
  let used = 0;
  let skipped = 0;
  for (const s of samples) {
    const scores = scoreSample(s.orders, bandE6);
    if (!scores) {
      skipped++;
      continue;
    }
    used++;
    for (const [maker, sc] of scores) {
      const t = totals.get(maker) ?? { maker, score: 0n, samplesInBand: 0, samplesAtTouch: 0 };
      t.score += sc.s3;
      if (sc.qBid + sc.qAsk > 0n) t.samplesInBand++;
      if (sc.atTouch) t.samplesAtTouch++;
      totals.set(maker, t);
    }
  }
  const makers = [...totals.values()].sort((a, b) =>
    a.score === b.score ? a.maker.localeCompare(b.maker) : a.score > b.score ? -1 : 1,
  );
  return { market, samples: used, skipped, makers, total: makers.reduce((s, m) => s + m.score, 0n) };
}

export interface MakerReward {
  market: Address;
  maker: Address;
  /** USDC base units the score earns: floor(R · score / total). */
  earned: bigint;
  /** USDC base units paid: `earned`, or 0 for our own makers. */
  reward: bigint;
  /** Share of the market's score, in basis points (ours included in the denominator). */
  shareBps: number;
  /** Share of two-sided samples with an order at the touch, in basis points. */
  timeAtTouchBps: number;
  /** One of Hunch Book's own makers: shown, never paid. */
  ours: boolean;
}

/**
 * Splits a market's pool `pool` (USDC base units) by score. Our makers are labelled and get nothing,
 * and their share is not given to others. Leftover base units from flooring are never paid either.
 */
export function makerRewards(
  score: MarketScore,
  pool: bigint,
  options: { ourMakers: readonly Address[]; payOurMaker?: boolean },
): MakerReward[] {
  return score.makers.map((m) => {
    const ours = options.ourMakers.some((a) => isAddressEqual(a, m.maker));
    const share = score.total === 0n ? 0n : (m.score * 10_000n) / score.total;
    const earned = score.total === 0n ? 0n : (pool * m.score) / score.total;
    const reward = ours && !options.payOurMaker ? 0n : earned;
    return {
      market: score.market,
      maker: m.maker,
      earned,
      reward,
      shareBps: Number(share),
      timeAtTouchBps: score.samples === 0 ? 0 : Math.floor((m.samplesAtTouch * 10_000) / score.samples),
      ours,
    };
  });
}

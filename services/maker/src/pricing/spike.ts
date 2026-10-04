import type { FundingSample } from "./perplFunding.js";

// Fair value for template 4, single-interval funding spike (docs/TEMPLATES.md): "Will any single funding
// event on Perpl perp P after block A and at or before block B charge longs more than X?"
//
// Model: empirical, from the perp's own recent single-interval increments (one per funding event).
// - With enough history, the chance is the share of past stretches of the same number of events in
//   which at least one increment was above X. Funding is strongly persistent (it sits at Perpl's clamp
//   for hours), so whole stretches carry that persistence, which a per-event rate would not.
// - With too little history for the window, it falls back to 1 − (1 − q)^n, q the share of single
//   events above X and n the events left, which assumes events are independent; the detail says so.
// Half a count of smoothing keeps the chance off exactly 0 and 1. A spike already seen in the window
// makes the answer YES; with no event left and none seen, NO.

/** The fewest stretches the empirical method needs before it is used. */
export const MIN_SPIKE_STRETCHES = 30;

export interface SpikeFairInput {
  /** Single-interval increments, oldest first. */
  increments: number[];
  threshold: number;
  /** Funding events left in the window. */
  eventsLeft: number;
  /** An event of the window has already spiked. */
  spiked: boolean;
}

export interface SpikeFair {
  p: number;
  decided: boolean;
  method: "seen" | "window-over" | "stretches" | "independent-events";
  /** Stretches (or single events) behind `p`. */
  samples: number;
  /** Share of single events above the threshold. */
  perEvent: number;
}

export function spikeFairValue(input: SpikeFairInput): SpikeFair {
  const { increments, threshold, eventsLeft } = input;
  const above = increments.map((x) => x > threshold);
  const perEvent = (above.filter(Boolean).length + 0.5) / (increments.length + 1);
  if (input.spiked) return { p: 1, decided: true, method: "seen", samples: 0, perEvent };
  if (eventsLeft <= 0) return { p: 0, decided: true, method: "window-over", samples: 0, perEvent };
  const stretches = increments.length - eventsLeft + 1;
  if (stretches >= MIN_SPIKE_STRETCHES) {
    // Sliding window: does increments[t .. t + n − 1] hold a spike?
    let inWindow = 0;
    for (let i = 0; i < eventsLeft; i++) if (above[i]) inWindow++;
    let hits = inWindow > 0 ? 1 : 0;
    for (let t = 1; t < stretches; t++) {
      if (above[t - 1]) inWindow--;
      if (above[t + eventsLeft - 1]) inWindow++;
      if (inWindow > 0) hits++;
    }
    return {
      p: (hits + 0.5) / (stretches + 1),
      decided: false,
      method: "stretches",
      samples: stretches,
      perEvent,
    };
  }
  if (increments.length === 0) throw new Error("no funding history to price a spike");
  return {
    p: 1 - (1 - perEvent) ** eventsLeft,
    decided: false,
    method: "independent-events",
    samples: increments.length,
    perEvent,
  };
}

/**
 * Single-interval increments from consecutive grid samples, oldest first: only pairs where both samples
 * are funding events exactly one interval apart, which is what the resolver accepts as one event.
 */
export function singleIntervalIncrements(
  samples: FundingSample[],
  interval: number,
): { block: number; increment: number }[] {
  const sorted = [...samples].sort((a, b) => a.block - b.block);
  const out: { block: number; increment: number }[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1] as FundingSample;
    const cur = sorted[i] as FundingSample;
    const onGrid = cur.eventBlock === cur.block && prev.eventBlock === prev.block && prev.eventBlock !== 0;
    if (onGrid && cur.block - prev.block === interval)
      out.push({ block: cur.block, increment: cur.sum - prev.sum });
  }
  return out;
}

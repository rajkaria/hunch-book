// The agent's model, kept pure so it is easy to test and to replace with your own.
//
// Question (template 1): will Perpl's funding sum rise by more than X between block A and block B?
// Forecast: funding already paid in the window, plus the recent average per-event funding for every
// event left, with a normal error that grows with the square root of the events left. The error's size
// is the spread of recent per-event funding. It is a deliberately simple model for an example, not
// advice: replace `estimateYes` with your own.

/** Standard normal CDF (Abramowitz and Stegun 7.1.26, error below 1.5e-7). */
export function normalCdf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x / Math.SQRT2));
  const poly =
    t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - poly * Math.exp(-(x * x) / 2);
  return x >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

export interface FundingInput {
  /** Funding already paid inside the window, raw Perpl units. */
  accrued: number;
  /** Recent per-event funding, oldest first, raw units. */
  increments: number[];
  /** Funding events still to come inside the window. */
  eventsLeft: number;
  /** YES if the window's funding is above this (equal is NO), raw units. */
  threshold: number;
}

export interface Estimate {
  /** Probability of YES, 0 to 1. */
  pYes: number;
  /** Expected funding over the whole window. */
  expected: number;
  /** Standard deviation of the forecast. */
  sigma: number;
}

const mean = (xs: number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);

function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}

/** How many recent events the rate averages over. */
export const RATE_WINDOW = 6;

export function estimateYes(input: FundingInput): Estimate {
  const recent = input.increments.slice(-RATE_WINDOW);
  const rate = mean(recent);
  const expected = input.accrued + rate * input.eventsLeft;
  if (input.eventsLeft <= 0) {
    return { pYes: input.accrued > input.threshold ? 1 : 0, expected: input.accrued, sigma: 0 };
  }
  // At least one raw unit per event, so a flat history never claims certainty.
  const sigma = Math.max(stdev(input.increments), 1) * Math.sqrt(input.eventsLeft);
  // Funding sums are whole units and YES needs strictly more than X: the boundary is X + 0.5.
  const pYes = 1 - normalCdf((input.threshold + 0.5 - expected) / sigma);
  return { pYes, expected, sigma };
}

export interface DecideInput {
  pYes: number;
  /** The book's best YES ask, USDC per token (0 to 1), or null when there are no asks. */
  ask: number | null;
  /** USDC left in the agent's budget. */
  budgetLeft: number;
  /** Most USDC per trade. */
  maxTrade: number;
  /** Smallest edge (probability minus price) worth trading. */
  minEdge: number;
}

export type Decision = { action: "buy"; usdc: number; edge: number } | { action: "skip"; reason: string };

/** Buys YES when the model's chance beats the ask by at least `minEdge` and the budget allows. */
export function decide(input: DecideInput): Decision {
  if (input.ask === null) return { action: "skip", reason: "no asks on the book" };
  const edge = input.pYes - input.ask;
  if (edge < input.minEdge) {
    return { action: "skip", reason: `edge ${edge.toFixed(3)} is below ${input.minEdge}` };
  }
  const usdc = Math.min(input.maxTrade, input.budgetLeft);
  if (usdc < 1) return { action: "skip", reason: "budget spent" };
  return { action: "buy", usdc: Math.floor(usdc * 1e6) / 1e6, edge };
}

/** True once the fill's average price still leaves at least half the required edge. */
export function fillStillWorthIt(pYes: number, averagePrice: number | null, minEdge: number): boolean {
  return averagePrice !== null && pYes - averagePrice >= minEdge / 2;
}

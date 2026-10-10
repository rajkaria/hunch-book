import { ONE_USDC, Outcome, Phase, redemptionPayout } from "@hunch-book/shared";
import type { Address, Hex } from "viem";

// Profit and loss per market, by average cost. Every USDC flow a wallet has with a market is an event:
// stakes, token claims at graduation, pool payouts, trades through the router or straight on the book,
// complete-set mints and merges, and redemptions. Each side (YES, NO) is a lot with a quantity and a
// cost; selling, merging or redeeming takes cost out at the lot's average, and the difference to what
// came back is realised. What is still held is valued at the book's mid (or at what it redeems for once
// final), and the difference to its cost is unrealised. Amounts are USDC and token base units (6 decimals).

export type TokenSide = "yes" | "no";

export type PnlEventKind =
  /** USDC staked into the pool on one side. */
  | "stake"
  /** Tokens claimed at graduation: the side's pool stake becomes the cost of these tokens. */
  | "claim"
  /** USDC paid out of a pool that settled or voided without graduating. */
  | "poolPayout"
  | "buy"
  | "sell"
  /** USDC in, one YES and one NO per USDC out. */
  | "mint"
  /** One YES and one NO in, one USDC out. */
  | "merge"
  | "redeem";

export interface PnlEvent {
  market: Address;
  kind: PnlEventKind;
  side?: TokenSide;
  /** Tokens moved; sets for a mint or merge. */
  tokens: bigint;
  /** USDC paid (stake, buy, mint) or received (payout, sell, merge, redeem). */
  usdc: bigint;
  fee: bigint;
  /** How it happened: "router", "book", "book (maker)", "pool", "vault". */
  via: string;
  /** Unix seconds; null for rows rebuilt from chain state. */
  time: number | null;
  block: bigint | null;
  logIndex: number;
  tx: Hex | null;
  /** Rebuilt from what the contracts hold now, not read from an event. */
  derived?: boolean;
}

/** What a market looks like now, to value what is held. */
export interface MarketMark {
  phase: Phase;
  outcome: Outcome;
  graduated: boolean;
  pool: { yes: bigint; no: bigint; total: bigint };
  /** YES mid in USDC base units per token, or null without a two-sided book. */
  midE6: bigint | null;
  balances: { yes: bigint; no: bigint };
  claimableTokens: { yes: bigint; no: bigint };
  /** A pool payout not claimed yet. */
  claimablePool: bigint;
}

export interface MarketPnl {
  market: Address;
  spent: bigint;
  received: bigint;
  /** Cost of what is still held: tokens, and pool stakes not converted or paid out yet. */
  costBasis: bigint;
  realised: bigint;
  /** What is held is worth now, or null when there is no price (an open pool, a one-sided book). */
  value: bigint | null;
  unrealised: bigint | null;
  /** realised + unrealised, or null when unrealised is unknown. */
  total: bigint | null;
  held: { yes: bigint; no: bigint };
  /** False when the events cannot explain every token held or sold: some cost is unknown. */
  complete: boolean;
  notes: string[];
}

interface Lot {
  qty: bigint;
  cost: bigint;
}

interface State {
  pool: { yes: bigint; no: bigint };
  lots: { yes: Lot; no: Lot };
  spent: bigint;
  received: bigint;
  realised: bigint;
  complete: boolean;
  notes: Set<string>;
}

const NOTE = {
  noCostSold: "Sold or redeemed tokens with no recorded cost, so their whole proceeds count as profit.",
  extraHeld:
    "Holds tokens the history does not explain (received by transfer, or history not indexed); they count at zero cost.",
  movedOut:
    "Some tokens left the wallet by plain transfer (for example into an order book's margin account); their cost is left out.",
  openPool: "An open pool has no price until it graduates or settles.",
  noBook: "No two-sided book, so the tokens have no mid price right now.",
} as const;

function emptyState(): State {
  return {
    pool: { yes: 0n, no: 0n },
    lots: { yes: { qty: 0n, cost: 0n }, no: { qty: 0n, cost: 0n } },
    spent: 0n,
    received: 0n,
    realised: 0n,
    complete: true,
    notes: new Set(),
  };
}

/** Takes `amount` out of a lot at its average cost. Returns the cost taken out. */
function takeOut(state: State, side: TokenSide, amount: bigint): bigint {
  const lot = state.lots[side];
  if (amount <= 0n) return 0n;
  if (lot.qty <= 0n) {
    state.complete = false;
    state.notes.add(NOTE.noCostSold);
    return 0n;
  }
  if (amount >= lot.qty) {
    if (amount > lot.qty) {
      state.complete = false;
      state.notes.add(NOTE.noCostSold);
    }
    const cost = lot.cost;
    state.lots[side] = { qty: 0n, cost: 0n };
    return cost;
  }
  const cost = (lot.cost * amount) / lot.qty;
  state.lots[side] = { qty: lot.qty - amount, cost: lot.cost - cost };
  return cost;
}

function apply(state: State, e: PnlEvent): void {
  const side = e.side ?? "yes";
  switch (e.kind) {
    case "stake":
      state.pool[side] += e.usdc;
      state.spent += e.usdc;
      break;
    case "claim": {
      const lot = state.lots[side];
      state.lots[side] = { qty: lot.qty + e.tokens, cost: lot.cost + state.pool[side] };
      state.pool[side] = 0n;
      break;
    }
    case "poolPayout": {
      const cost = state.pool.yes + state.pool.no;
      state.pool = { yes: 0n, no: 0n };
      state.received += e.usdc;
      state.realised += e.usdc - cost;
      break;
    }
    case "buy": {
      const lot = state.lots[side];
      state.lots[side] = { qty: lot.qty + e.tokens, cost: lot.cost + e.usdc };
      state.spent += e.usdc;
      break;
    }
    case "sell":
    case "redeem": {
      const cost = takeOut(state, side, e.tokens);
      state.received += e.usdc;
      state.realised += e.usdc - cost;
      break;
    }
    case "mint": {
      const yesCost = e.usdc / 2n;
      const y = state.lots.yes;
      const n = state.lots.no;
      state.lots.yes = { qty: y.qty + e.tokens, cost: y.cost + yesCost };
      state.lots.no = { qty: n.qty + e.tokens, cost: n.cost + (e.usdc - yesCost) };
      state.spent += e.usdc;
      break;
    }
    case "merge": {
      const cost = takeOut(state, "yes", e.tokens) + takeOut(state, "no", e.tokens);
      state.received += e.usdc;
      state.realised += e.usdc - cost;
      break;
    }
  }
}

/** Events in the order they happened: by block, then log index; rows without a block first. */
export function byOccurrence(a: PnlEvent, b: PnlEvent): number {
  const ab = a.block ?? -1n;
  const bb = b.block ?? -1n;
  if (ab !== bb) return ab < bb ? -1 : 1;
  return a.logIndex - b.logIndex;
}

/** What `tokens` of one side are worth now, or null without a price. */
export function tokenValue(mark: MarketMark, side: TokenSide, tokens: bigint): bigint | null {
  if (tokens === 0n) return 0n;
  if (mark.phase === Phase.Settled) {
    const winning: TokenSide = mark.outcome === Outcome.Yes ? "yes" : "no";
    if (side !== winning) return 0n;
    const losing = winning === "yes" ? mark.pool.no : mark.pool.yes;
    return mark.graduated ? redemptionPayout(tokens, losing, mark.pool.total) : tokens;
  }
  if (mark.phase === Phase.Voided) return tokens / 2n;
  if (mark.midE6 === null) return null;
  const price = side === "yes" ? mark.midE6 : ONE_USDC - mark.midE6;
  return (tokens * price) / ONE_USDC;
}

/** One market's profit and loss from its events (any order) and how it stands now. */
export function marketPnl(market: Address, events: readonly PnlEvent[], mark: MarketMark): MarketPnl {
  const state = emptyState();
  for (const e of [...events].sort(byOccurrence)) apply(state, e);

  // Tokens claimable since graduation count as held, at the cost of the stake they come from.
  if (mark.graduated) {
    for (const side of ["yes", "no"] as const) {
      const claimable = mark.claimableTokens[side];
      if (claimable > 0n) apply(state, { ...syntheticClaim(market, side, claimable) });
    }
  }

  const held = {
    yes: mark.balances.yes + mark.claimableTokens.yes,
    no: mark.balances.no + mark.claimableTokens.no,
  };
  // Square the lots with what is actually held.
  for (const side of ["yes", "no"] as const) {
    const lot = state.lots[side];
    if (held[side] < lot.qty) {
      takeOut(state, side, lot.qty - held[side]);
      state.notes.add(NOTE.movedOut);
    } else if (held[side] > lot.qty) {
      state.lots[side] = { qty: held[side], cost: lot.cost };
      state.complete = false;
      state.notes.add(NOTE.extraHeld);
    }
  }

  // Once a market is decided, what can never pay is a realised loss: losing tokens, and a pool stake
  // that pays nothing. What still pays (winning tokens, a pool payout not claimed yet) stays unrealised.
  const final = mark.phase === Phase.Settled || mark.phase === Phase.Voided;
  if (mark.phase === Phase.Settled && mark.graduated) {
    const losing: TokenSide = mark.outcome === Outcome.Yes ? "no" : "yes";
    state.realised -= state.lots[losing].cost;
    state.lots[losing] = { qty: state.lots[losing].qty, cost: 0n };
  }
  if (final && !mark.graduated && mark.claimablePool === 0n) {
    state.realised -= state.pool.yes + state.pool.no;
    state.pool = { yes: 0n, no: 0n };
  }

  let value: bigint | null = 0n;
  for (const side of ["yes", "no"] as const) {
    const v = tokenValue(mark, side, held[side]);
    if (v === null) {
      value = null;
      state.notes.add(NOTE.noBook);
    } else if (value !== null) value += v;
  }
  const poolCost = state.pool.yes + state.pool.no;
  if (poolCost > 0n) {
    if (!mark.graduated && final) {
      if (value !== null) value += mark.claimablePool;
    } else {
      value = null;
      state.notes.add(NOTE.openPool);
    }
  }
  const costBasis = state.lots.yes.cost + state.lots.no.cost + poolCost;
  const unrealised = value === null ? null : value - costBasis;
  return {
    market,
    spent: state.spent,
    received: state.received,
    costBasis,
    realised: state.realised,
    value,
    unrealised,
    total: unrealised === null ? null : state.realised + unrealised,
    held,
    complete: state.complete,
    notes: [...state.notes],
  };
}

function syntheticClaim(market: Address, side: TokenSide, tokens: bigint): PnlEvent {
  return {
    market,
    kind: "claim",
    side,
    tokens,
    usdc: 0n,
    fee: 0n,
    via: "pool",
    time: null,
    block: null,
    logIndex: 0,
    tx: null,
    derived: true,
  };
}

export interface PnlTotals {
  spent: bigint;
  received: bigint;
  realised: bigint;
  /** Over markets with a price. */
  unrealised: bigint;
  markets: number;
  /** Markets with no price right now, left out of unrealised. */
  unpriced: number;
  /** Markets whose cost basis is not fully known. */
  incomplete: number;
}

export function pnlTotals(rows: readonly MarketPnl[]): PnlTotals {
  const t: PnlTotals = {
    spent: 0n,
    received: 0n,
    realised: 0n,
    unrealised: 0n,
    markets: rows.length,
    unpriced: 0,
    incomplete: 0,
  };
  for (const r of rows) {
    t.spent += r.spent;
    t.received += r.received;
    t.realised += r.realised;
    if (r.unrealised === null) t.unpriced++;
    else t.unrealised += r.unrealised;
    if (!r.complete) t.incomplete++;
  }
  return t;
}

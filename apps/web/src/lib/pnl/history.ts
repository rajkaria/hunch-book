import { ONE_USDC, Outcome, Phase, poolPayout, tokenClaim } from "@hunch-book/shared";
import type { Address } from "viem";
import type { IndexerClient } from "../indexer/client";
import { address, big, eventPosition, hash } from "../indexer/parse";
import {
  HISTORY_ENTITIES,
  HISTORY_PAGE,
  type HistoryEntity,
  type HistoryKey,
  type HistoryResult,
  historyQuery,
} from "../indexer/queries";
import { bookMid, PRICE_SCALE } from "../market/logic";
import type { MarketView, PortfolioEntry } from "../market/types";
import type { MarketMark, PnlEvent, TokenSide } from "./ledger";

// Where a wallet's P&L events come from: every event the indexer recorded for it, or, without the
// indexer, what the contracts hold now (stakes, claims and pool payouts can be rebuilt exactly from
// them; trades, mints and redemptions cannot, and the ledger then marks the market incomplete).

/** Pages read per entity before giving up on a very long history. */
const MAX_PAGES = 20;

const SIDE: Record<"Yes" | "No", TokenSide> = { Yes: "yes", No: "no" };

/** Every history row of one wallet from the indexer, all pages. */
export async function fetchHistory(client: IndexerClient, wallet: Address): Promise<HistoryResult> {
  const variables = { wallet: wallet.toLowerCase(), limit: HISTORY_PAGE, offset: 0 };
  const first = await client.query<HistoryResult>(historyQuery(), variables);
  const out = { ...first } as HistoryResult;
  for (const entity of HISTORY_ENTITIES) {
    let rows = out[entity.key] as unknown[];
    let page = rows.length;
    for (let n = 1; page === HISTORY_PAGE && n < MAX_PAGES; n++) {
      const more = await client.query<Record<HistoryKey, unknown[]>>(
        historyQuery([entity as HistoryEntity]),
        {
          ...variables,
          offset: n * HISTORY_PAGE,
        },
      );
      const next = more[entity.key] ?? [];
      rows = [...rows, ...next];
      page = next.length;
    }
    (out as unknown as Record<HistoryKey, unknown[]>)[entity.key] = rows;
  }
  return out;
}

const base = (r: { id: string; block: string; timestamp: string; tx: string; market: { id: string } }) => {
  const pos = eventPosition(r.id);
  return {
    market: address(r.market.id),
    time: Number(big(r.timestamp)),
    block: big(r.block),
    logIndex: pos.logIndex,
    tx: hash(r.tx),
    fee: 0n,
  };
};

/** The indexer's rows as P&L events. */
export function eventsFromHistory(h: HistoryResult): PnlEvent[] {
  const out: PnlEvent[] = [];
  for (const r of h.stakes) {
    out.push({ ...base(r), kind: "stake", side: SIDE[r.side], tokens: 0n, usdc: big(r.amount), via: "pool" });
  }
  for (const r of h.claims) {
    out.push({ ...base(r), kind: "claim", side: SIDE[r.side], tokens: big(r.amount), usdc: 0n, via: "pool" });
  }
  for (const r of h.payouts) {
    out.push({ ...base(r), kind: "poolPayout", tokens: 0n, usdc: big(r.paid), fee: big(r.fee), via: "pool" });
  }
  for (const r of h.routerTrades) {
    const buy = r.kind === "BuyYes" || r.kind === "BuyNo";
    const side: TokenSide = r.kind === "BuyYes" || r.kind === "SellYes" ? "yes" : "no";
    out.push({
      ...base(r),
      kind: buy ? "buy" : "sell",
      side,
      tokens: big(r.tokens),
      usdc: big(r.usdc),
      via: "router",
    });
  }
  for (const r of h.setFlows) {
    const amount = big(r.amount);
    out.push({
      ...base(r),
      kind: r.kind === "Mint" ? "mint" : "merge",
      tokens: amount,
      usdc: amount,
      via: "vault",
    });
  }
  for (const r of h.redemptions) {
    out.push({
      ...base(r),
      kind: "redeem",
      side: SIDE[r.side],
      tokens: big(r.amount),
      usdc: big(r.paid),
      fee: big(r.fee),
      via: "vault",
    });
  }
  // As the maker, a taker buying YES means this wallet sold it, and the other way round.
  for (const r of h.makerFills) {
    out.push({
      ...base(r),
      kind: r.takerBuysYes ? "sell" : "buy",
      side: "yes",
      tokens: big(r.size),
      usdc: big(r.notional),
      via: "book (maker)",
    });
  }
  for (const r of h.takerFills) {
    out.push({
      ...base(r),
      kind: r.takerBuysYes ? "buy" : "sell",
      side: "yes",
      tokens: big(r.size),
      usdc: big(r.notional),
      via: "book",
    });
  }
  return out;
}

const isFinal = (phase: number): boolean => phase === Phase.Settled || phase === Phase.Voided;

const derived = (market: Address) => ({
  market,
  fee: 0n,
  time: null,
  block: null,
  logIndex: 0,
  tx: null,
  derived: true as const,
});

/**
 * Events rebuilt from what the contracts hold now: each side's stake, the tokens it became at
 * graduation (if claimed), and the pool payout (if claimed). Exact for those; trades, mints and
 * redemptions are not in chain state.
 */
export function eventsFromChain(entries: readonly PortfolioEntry[]): PnlEvent[] {
  const out: PnlEvent[] = [];
  for (const e of entries) {
    const m = e.market;
    const sides: [TokenSide, bigint, bigint][] = [
      ["yes", e.stake.yes, m.pool.yes],
      ["no", e.stake.no, m.pool.no],
    ];
    for (const [side, stake] of sides) {
      if (stake > 0n)
        out.push({ ...derived(m.address), kind: "stake", side, tokens: 0n, usdc: stake, via: "pool" });
    }
    if (m.graduated) {
      for (const [side, stake, sideTotal] of sides) {
        // claimableTokens is zero once claimed; the claim was this many tokens.
        if (stake > 0n && e.claimableTokens[side] === 0n) {
          out.push({
            ...derived(m.address),
            kind: "claim",
            side,
            tokens: tokenClaim(stake, sideTotal, m.pool.total),
            usdc: 0n,
            via: "pool",
          });
        }
      }
    } else if (isFinal(m.phase) && e.claimablePool.paid === 0n && e.stake.yes + e.stake.no > 0n) {
      // The pool payout was claimed: rebuild it with the contract's own math.
      const refund = m.phase === Phase.Voided || m.pool.yes === 0n || m.pool.no === 0n;
      let paid = 0n;
      let fee = 0n;
      if (refund) paid = e.stake.yes + e.stake.no;
      else if (m.outcome === Outcome.Yes) ({ paid, fee } = poolPayout(e.stake.yes, m.pool.yes, m.pool.no));
      else ({ paid, fee } = poolPayout(e.stake.no, m.pool.no, m.pool.yes));
      if (paid > 0n) {
        out.push({ ...derived(m.address), kind: "poolPayout", tokens: 0n, usdc: paid, fee, via: "pool" });
      }
    }
  }
  return out;
}

/** How a market stands for the wallet now, from the portfolio's chain reads. */
export function markOf(e: PortfolioEntry): MarketMark {
  const m = e.market;
  const mid = bookMid(m.quote);
  return {
    phase: m.phase,
    outcome: m.outcome,
    graduated: m.graduated,
    pool: m.pool,
    midE6: mid === null ? null : (mid * ONE_USDC) / PRICE_SCALE,
    balances: e.balances,
    claimableTokens: e.claimableTokens,
    claimablePool: e.claimablePool.paid,
  };
}

/** A portfolio row for a market the wallet no longer holds anything in. */
export function emptyEntry(market: MarketView): PortfolioEntry {
  return {
    market,
    stake: { yes: 0n, no: 0n },
    claimableTokens: { yes: 0n, no: 0n },
    claimablePool: { paid: 0n, fee: 0n },
    balances: { yes: 0n, no: 0n },
  };
}

/** Markets in the history that the portfolio rows do not cover. */
export function missingMarkets(events: readonly PnlEvent[], entries: readonly PortfolioEntry[]): Address[] {
  const have = new Set(entries.map((e) => e.market.address.toLowerCase()));
  const out = new Map<string, Address>();
  for (const e of events) {
    const key = e.market.toLowerCase();
    if (!have.has(key)) out.set(key, e.market);
  }
  return [...out.values()];
}

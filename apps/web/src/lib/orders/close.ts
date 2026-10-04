import { Side, type TradeKind } from "@hunch-book/shared";
import { evaluateTicket, type TicketContext, type TicketState } from "../trade/ticket";

// One-click "Close position": sell the wallet's whole YES or NO balance through the router, with a
// minimum out from the slippage limit. No conditional order is involved: it is the trade ticket's own
// sellYes or sellNo path, with the amount fixed to what the wallet holds (or what the book can take).

export interface ClosePlan {
  side: Side;
  kind: TradeKind;
  /** Tokens the wallet holds on this side. */
  held: bigint;
  /** Tokens this close sells: all of them, or what the book can fill when it is thinner than that. */
  amount: bigint;
  /** True when the book cannot take the whole balance, so the close sells part of it. */
  partial: boolean;
  state: TicketState;
}

/** The close for one side, or null when the wallet holds none of it. */
export function closePlan(side: Side, ctx: Omit<TicketContext, "kind" | "amount">): ClosePlan | null {
  const kind: TradeKind = side === Side.Yes ? "sellYes" : "sellNo";
  const held = ctx.balances ? (side === Side.Yes ? ctx.balances.yes : ctx.balances.no) : 0n;
  if (held <= 0n) return null;
  const full = evaluateTicket({ ...ctx, kind, amount: held });
  if (full.max !== null && full.max > 0n && full.max < held) {
    const state = evaluateTicket({ ...ctx, kind, amount: full.max });
    return { side, kind, held, amount: full.max, partial: true, state };
  }
  return { side, kind, held, amount: held, partial: false, state: full };
}

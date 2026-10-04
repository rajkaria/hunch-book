import type { Address } from "viem";
import type { MarketEvent, Redeemable } from "./events.js";
import { type MarketState, Outcome } from "./markets.js";

// Every message the bot sends, in plain words, each with a link to the market in the app and to its
// contract on the explorer. Plain text only (no Markdown), so nothing in a market's text can break
// the formatting.

export interface Links {
  appUrl: string;
  explorer: string;
}

const usdc = (base: bigint): string => {
  const whole = base / 1_000_000n;
  const cents = (base % 1_000_000n) / 10_000n;
  return `${whole.toLocaleString("en-US")}.${cents.toString().padStart(2, "0")}`;
};

export const chance = (bps: number | null): string =>
  bps === null ? "n/a" : `${Math.trunc(bps / 100)}.${Math.trunc((bps % 100) / 10)}%`;

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

function title(m: MarketState): string {
  return m.question ?? `Hunch Book market #${m.marketId}`;
}

function links(m: MarketState, l: Links): string {
  return `Market: ${l.appUrl}/m/${m.address}\nContract: ${l.explorer}/address/${m.address}`;
}

export function eventMessage(e: MarketEvent, l: Links): string {
  const m = e.market;
  switch (e.kind) {
    case "graduated":
      return [
        `Graduated: ${title(m)}`,
        `The pool of ${usdc(m.poolTotal)} USDC became YES and NO tokens, now trading on Kuru's order book${
          m.chanceBps === null ? "" : ` at ${chance(m.chanceBps)} YES`
        }. Stakers can claim their tokens, and anyone can now sell before the answer.`,
        links(m, l),
      ].join("\n\n");
    case "settled": {
      const side = m.outcome === Outcome.Yes ? "YES" : "NO";
      return [
        `Settled ${side}: ${title(m)}`,
        `The resolver read the answer from the chain. Winning ${side} holders and stakers can collect their payout now.`,
        links(m, l),
      ].join("\n\n");
    }
    case "voided":
      return [
        `Voided: ${title(m)}`,
        m.graduated
          ? "No answer came before the settlement deadline. Every YES and NO token redeems for 0.50 USDC, with no fee."
          : "No answer came before the settlement deadline. Every stake is refunded in full, with no fee.",
        links(m, l),
      ].join("\n\n");
    case "move":
      return [
        `Big move: ${title(m)}`,
        `The chance of YES went from ${chance(e.fromBps)} to ${chance(e.toBps)} (${m.graduated ? "the book's mid price" : "the pool split"}).`,
        links(m, l),
      ].join("\n\n");
  }
}

export function redeemMessage(wallet: Address, m: MarketState, r: Redeemable, l: Links): string {
  const what =
    r.kind === "pool"
      ? `${usdc(r.amount)} USDC from the pool is waiting to be claimed.`
      : r.kind === "claim"
        ? `${usdc(r.amount)}${r.side ? ` ${r.side.toUpperCase()}` : ""} tokens are waiting to be claimed, then redeemed.`
        : r.side
          ? `${usdc(r.amount)} winning ${r.side.toUpperCase()} tokens can be redeemed for USDC.`
          : `${usdc(r.amount)} tokens can be redeemed for 0.50 USDC each.`;
  return [
    `Ready to collect for ${short(wallet)}: ${title(m)}`,
    `${what} Open your portfolio to collect it: ${l.appUrl}/portfolio`,
    links(m, l),
  ].join("\n\n");
}

export function welcomeMessage(appUrl: string): string {
  return [
    "Hunch Book alerts.",
    "I tell you when a market graduates to its order book, settles, voids or moves a lot, and when a wallet you watch has winnings to collect.",
    "Commands:\n/watch <market or wallet address, or a market link>\n/unwatch <address>, or /unwatch all\n/list",
    `Markets: ${appUrl}/markets`,
  ].join("\n\n");
}

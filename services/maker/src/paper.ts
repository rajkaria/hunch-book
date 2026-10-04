import { kuruOrderBookAbi } from "@hunch-book/shared";
import { type Address, getAbiItem, type PublicClient } from "viem";
import { type BookSpec, baseAmount, type Order, type Quotes, quoteCostToPlace } from "./quotes.js";

// Paper mode (MAKER_MODE=paper): the bot prices and quotes every market exactly as it would live, but
// its orders exist only here. Fills are simulated against the book's real trades: each cycle the bot
// reads the Kuru Trade events since the last one and asks, for each, whether a resting paper order
// would have been hit first. It never sends a transaction and needs no key.
//
// The fill rule never assumes queue priority. A taker who sold YES into a bid at price P would have hit
// a paper bid first only if the paper bid was strictly above P; a taker who bought from an ask at P
// would have lifted a paper ask strictly below P. The trade's size is shared out best price first.
// A quote at the same price as the real order that traded counts as not filled, so paper results lean
// against the bot, not for it.
//
// The account: one USDC balance across markets (Kuru's margin account is shared the same way), YES and
// NO per market. Asks are funded by minting complete sets (1 USDC → 1 YES + 1 NO) as the live bot does;
// pairs are merged back. Value = USDC + YES × fair + NO × (1 − fair); after settlement the winning side
// is worth what it redeems for.

export interface PaperOrder {
  isBuy: boolean;
  /** pricePrecision units. */
  price: number;
  /** sizePrecision units. */
  remaining: bigint;
}

/** One Kuru Trade event, as read from the book's logs. */
export interface BookTrade {
  /** The taker bought YES (lifted an ask); false: the taker sold YES (hit a bid). */
  takerBuysYes: boolean;
  /** The resting order's price, 1e18 scale. */
  priceE18: bigint;
  /** Filled size, sizePrecision units. */
  size: bigint;
  block: bigint;
  hash?: string;
}

export interface PaperFill {
  /** Our side: true when our bid filled. */
  isBuy: boolean;
  price: number;
  size: bigint;
  block: bigint;
  /** The real trade it was matched with. */
  tradePrice: number;
  hash?: string;
}

const E18 = 10n ** 18n;

/** A trade's price in the book's pricePrecision units (exact for Hunch Book books, 1e6). */
export const tradePrice = (t: BookTrade, pricePrecision: number) =>
  Number((t.priceE18 * BigInt(pricePrecision)) / E18);

/**
 * Matches real trades, in order, against resting paper orders. Returns the fills; `orders` is not
 * changed (the caller applies the fills to its own copy). Pure.
 */
export function matchTrades(
  orders: readonly PaperOrder[],
  trades: readonly BookTrade[],
  pricePrecision: number,
): PaperFill[] {
  const book = orders.map((o) => ({ ...o }));
  const fills: PaperFill[] = [];
  for (const t of trades) {
    const p = tradePrice(t, pricePrecision);
    // The taker bought: our asks strictly below the traded price, cheapest first.
    const candidates = book
      .filter((o) => o.remaining > 0n && (t.takerBuysYes ? !o.isBuy && o.price < p : o.isBuy && o.price > p))
      .sort((a, b) => (t.takerBuysYes ? a.price - b.price : b.price - a.price));
    let left = t.size;
    for (const o of candidates) {
      if (left <= 0n) break;
      const size = o.remaining < left ? o.remaining : left;
      o.remaining -= size;
      left -= size;
      fills.push({ isBuy: o.isBuy, price: o.price, size, block: t.block, tradePrice: p, hash: t.hash });
    }
  }
  return fills;
}

export interface PaperPosition {
  yes: bigint;
  no: bigint;
  /** USDC spent minting sets for this market, and returned by merges and redemptions (net). */
  minted: bigint;
  fills: number;
  /** USDC traded through fills (both sides). */
  volume: bigint;
}

export interface PaperValuation {
  usdc: bigint;
  /** The account's value in USDC base units, positions marked at their fair value. */
  value: bigint;
  pnl: bigint;
  positions: Record<string, { yes: string; no: string; mark: number; fills: number; volume: string }>;
}

export class PaperAccount {
  readonly positions = new Map<Address, PaperPosition>();

  constructor(
    public usdc: bigint,
    readonly start: bigint = usdc,
  ) {}

  position(market: Address): PaperPosition {
    let p = this.positions.get(market);
    if (!p) {
      p = { yes: 0n, no: 0n, minted: 0n, fills: 0, volume: 0n };
      this.positions.set(market, p);
    }
    return p;
  }

  /** 1 USDC → 1 YES + 1 NO (both in the same base units). */
  mint(market: Address, amount: bigint): void {
    if (amount <= 0n) return;
    if (amount > this.usdc) throw new Error(`paper account holds ${this.usdc} USDC, cannot mint ${amount}`);
    const p = this.position(market);
    this.usdc -= amount;
    p.yes += amount;
    p.no += amount;
    p.minted += amount;
  }

  /** Merges every YES + NO pair back into USDC. */
  merge(market: Address): bigint {
    const p = this.position(market);
    const pairs = p.yes < p.no ? p.yes : p.no;
    p.yes -= pairs;
    p.no -= pairs;
    p.minted -= pairs;
    this.usdc += pairs;
    return pairs;
  }

  applyFill(market: Address, fill: PaperFill, book: BookSpec): void {
    const p = this.position(market);
    const base = baseAmount(fill.size, book);
    if (fill.isBuy) {
      const cost = quoteCostToPlace(fill.price, fill.size, book);
      this.usdc -= cost;
      p.yes += base;
      p.volume += cost;
    } else {
      const proceeds =
        (BigInt(fill.price) * fill.size * 10n ** BigInt(book.quoteDecimals)) /
        (book.sizePrecision * BigInt(book.pricePrecision));
      this.usdc += proceeds;
      p.yes -= base;
      p.volume += proceeds;
    }
    p.fills++;
  }

  /** Redeems a finished market: `yesValue` and `noValue` per token, in 1e6 (1 USDC = 1e6). */
  redeem(market: Address, yesValueE6: bigint, noValueE6: bigint): bigint {
    const p = this.position(market);
    const paid = (p.yes * yesValueE6 + p.no * noValueE6) / 1_000_000n;
    this.usdc += paid;
    p.yes = 0n;
    p.no = 0n;
    return paid;
  }

  /** Marks every position at its fair value (chance of YES); a market with no mark is valued at 0.5. */
  valuation(marks: Map<Address, number>): PaperValuation {
    let value = this.usdc;
    const positions: PaperValuation["positions"] = {};
    for (const [market, p] of this.positions) {
      const mark = marks.get(market) ?? 0.5;
      const ppm = BigInt(Math.round(mark * 1_000_000));
      value += (p.yes * ppm + p.no * (1_000_000n - ppm)) / 1_000_000n;
      positions[market] = {
        yes: p.yes.toString(),
        no: p.no.toString(),
        mark,
        fills: p.fills,
        volume: p.volume.toString(),
      };
    }
    return { usdc: this.usdc, value, pnl: value - this.start, positions };
  }
}

/** Paper orders from the quotes the bot would place. */
export function toPaperOrders(q: Quotes): PaperOrder[] {
  const one = (o: Order, isBuy: boolean): PaperOrder => ({ isBuy, price: o.price, remaining: o.size });
  return [...q.bids.map((o) => one(o, true)), ...q.asks.map((o) => one(o, false))];
}

const TRADE_EVENT = getAbiItem({ abi: kuruOrderBookAbi, name: "Trade" });

/** The book's Trade events in [from, to], in windows of `range` blocks (Monad's public RPCs allow 100). */
export async function readTrades(
  client: PublicClient,
  book: Address,
  from: bigint,
  to: bigint,
  range = 100n,
): Promise<BookTrade[]> {
  const out: BookTrade[] = [];
  for (let start = from; start <= to; start += range) {
    const end = start + range - 1n < to ? start + range - 1n : to;
    const logs = await client.getLogs({ address: book, event: TRADE_EVENT, fromBlock: start, toBlock: end });
    for (const l of logs) {
      const a = l.args;
      if (a.isBuy === undefined || a.price === undefined || a.filledSize === undefined) continue;
      out.push({
        takerBuysYes: a.isBuy,
        priceE18: a.price,
        size: a.filledSize,
        block: l.blockNumber ?? 0n,
        hash: l.transactionHash ?? undefined,
      });
    }
  }
  return out;
}

import { marketAbi, Outcome, Phase, Side } from "@hunch-book/shared";
import type { Address, PublicClient } from "viem";
import type { MarketView } from "./discovery.js";
import { type BookInfo, readL2Book } from "./kuru.js";
import { log } from "./log.js";
import type { MakerDeps } from "./maker.js";
import {
  matchTrades,
  PaperAccount,
  type PaperOrder,
  type PaperValuation,
  readTrades,
  toPaperOrders,
} from "./paper.js";
import { externalTopOfBook, priceLadder, type Quotes, sameQuotes, sizeQuotes } from "./quotes.js";

// The paper-mode desk (MAKER_MODE=paper): per market, the paper orders the bot would rest on the book,
// fills simulated against the book's real Trade events (paper.ts), and one paper account across
// markets. It sends nothing. The bot calls `quote` where it would quote live, `stop` where it would
// cancel, and `settle` after a market settles or voids.

interface DeskBook {
  info: BookInfo;
  /** Trade events up to this block have been matched. */
  cursor: bigint;
  orders: PaperOrder[];
  quotes: Quotes;
  lastLogAt: number;
}

export interface PaperReport extends PaperValuation {
  start: bigint;
  markets: number;
  fills: number;
}

export class PaperDesk {
  readonly account: PaperAccount;
  private readonly books = new Map<Address, DeskBook>();
  private readonly marks = new Map<Address, number>();
  private readonly finished = new Set<Address>();
  private fills = 0;

  constructor(
    private readonly client: PublicClient,
    private readonly deps: Pick<MakerDeps, "quote" | "heartbeatSeconds">,
    startUsdc: bigint,
  ) {
    this.account = new PaperAccount(startUsdc);
  }

  /** Matches the trades since the last call, then rests the quotes the bot would place now. */
  async quote(
    market: MarketView,
    info: BookInfo,
    input: { fair: number; widen: number; block: bigint; now: number; detail?: Record<string, unknown> },
  ): Promise<void> {
    const desk = await this.book(market, info, input.block);
    this.marks.set(market.address, input.fair);
    const position = this.account.position(market.address);
    const tokens = (x: bigint) => Number(x) / 10 ** info.baseDecimals;
    const l2 = await readL2Book(this.client, market.book);
    const ladder = priceLadder({
      fair: input.fair,
      position: tokens(position.yes - position.no),
      widen: input.widen,
      params: this.deps.quote,
      book: info,
      // Paper orders are not on the book: every resting order is someone else's.
      external: externalTopOfBook(l2, { bids: new Map(), asks: new Map() }),
    });
    const sized = sizeQuotes({
      ladder,
      params: this.deps.quote,
      book: info,
      position: tokens(position.yes - position.no),
      yesAvailable: position.yes,
      usdcAvailable: this.account.usdc,
    });
    if (sized.mint > 0n) this.account.mint(market.address, sized.mint);
    const quotes: Quotes = { bids: sized.bids, asks: sized.asks };
    desk.orders = toPaperOrders(quotes);
    const changed = !sameQuotes(quotes, desk.quotes);
    desk.quotes = quotes;
    if (changed || input.now - desk.lastLogAt >= this.deps.heartbeatSeconds) {
      desk.lastLogAt = input.now;
      log("paper-quote", {
        market: market.address,
        book: market.book,
        fair: input.fair,
        bids: quotes.bids,
        asks: quotes.asks,
        yes: position.yes,
        no: position.no,
        ...input.detail,
      });
    }
  }

  /** No quotes from now on (close, the answer is known, the book paused); fills up to now still count. */
  async stop(market: MarketView, info: BookInfo, block: bigint, reason: string): Promise<void> {
    const desk = await this.book(market, info, block);
    if (desk.orders.length > 0) log("paper-stop", { market: market.address, reason });
    desk.orders = [];
    desk.quotes = { bids: [], asks: [] };
  }

  /** After settlement or a void: redeem the paper tokens at what the vault would pay. */
  async settle(market: MarketView): Promise<void> {
    if (this.finished.has(market.address) || !this.account.positions.has(market.address)) return;
    let yesE6 = 0n;
    let noE6 = 0n;
    if (market.phase === Phase.Voided) {
      yesE6 = 500_000n;
      noE6 = 500_000n;
    } else if (market.phase === Phase.Settled) {
      const side = market.outcome === Outcome.Yes ? Side.Yes : Side.No;
      const fee = await this.client.readContract({
        address: market.address,
        abi: marketAbi,
        functionName: "feePerToken",
        args: [side],
      });
      if (side === Side.Yes) yesE6 = 1_000_000n - fee;
      else noE6 = 1_000_000n - fee;
    } else {
      return;
    }
    const paid = this.account.redeem(market.address, yesE6, noE6);
    this.marks.delete(market.address);
    this.finished.add(market.address);
    log("paper-redeem", { market: market.address, phase: market.phase, paid });
  }

  report(): PaperReport {
    return {
      ...this.account.valuation(this.marks),
      start: this.account.start,
      markets: this.books.size,
      fills: this.fills,
    };
  }

  /** The desk's state for a book, after matching the trades up to `block` against its paper orders. */
  private async book(market: MarketView, info: BookInfo, block: bigint): Promise<DeskBook> {
    let desk = this.books.get(market.address);
    if (!desk) {
      // Start from now: earlier trades happened before any paper order existed.
      desk = { info, cursor: block, orders: [], quotes: { bids: [], asks: [] }, lastLogAt: 0 };
      this.books.set(market.address, desk);
      return desk;
    }
    if (block > desk.cursor) {
      const trades = await readTrades(this.client, market.book, desk.cursor + 1n, block);
      const fills = matchTrades(desk.orders, trades, info.pricePrecision);
      for (const fill of fills) {
        this.account.applyFill(market.address, fill, info);
        this.fills++;
        const order = desk.orders.find((o) => o.isBuy === fill.isBuy && o.price === fill.price);
        if (order) order.remaining -= fill.size;
        log("paper-fill", {
          market: market.address,
          side: fill.isBuy ? "bid" : "ask",
          price: fill.price,
          size: fill.size,
          tradePrice: fill.tradePrice,
          block: fill.block,
          tx: fill.hash,
        });
      }
      desk.orders = desk.orders.filter((o) => o.remaining > 0n);
      desk.cursor = block;
      const merged = this.account.merge(market.address);
      if (merged > 0n) log("paper-merge", { market: market.address, sets: merged });
    }
    return desk;
  }
}

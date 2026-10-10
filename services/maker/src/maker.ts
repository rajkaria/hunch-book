import { kuruMarginAccountAbi, kuruOrderBookAbi } from "@hunch-book/shared";
import { type Address, encodeFunctionData } from "viem";
import {
  type Balances,
  depositToMargin,
  readBalances,
  type SetOps,
  withdrawAllFromMargin,
  withdrawFromMargin,
} from "./inventory.js";
import {
  type BookInfo,
  bookStateStatus,
  findOwnOrders,
  MarketState,
  readL2Book,
  readMarketState,
  readOrderStatuses,
} from "./kuru.js";
import { log } from "./log.js";
import { type Fill, OrderTracker, parseOrderCreated } from "./orders.js";
import {
  baseAmount,
  decideRequote,
  externalTopOfBook,
  type Order,
  planFunding,
  priceLadder,
  type QuoteParams,
  type Quotes,
  quoteRefundOnCancel,
  sizeQuotes,
} from "./quotes.js";
import { accountAddress, sendTx, type TxContext } from "./tx.js";

// One market's quoting, cancelling and unwinding against its v1 book: Kuru's, or Hunch Book's own order
// book, which has the same interface (no fees, no AMM vault, every limit order post-only). Market
// discovery and pricing live elsewhere; this module is what the integration test drives directly.

export interface MakerDeps {
  tx: TxContext;
  marginAccount: Address;
  quote: QuoteParams;
  requoteThreshold: number;
  heartbeatSeconds: number;
  /** Tokens; margin float, and the smallest withdraw or merge worth a transaction. */
  dustTokens: number;
}

export interface MarketHealth {
  market: Address;
  book: Address;
  status: string;
  fair?: number;
  detail?: Record<string, unknown>;
  bids: Order[];
  asks: Order[];
  openOrders: number;
  position?: number;
  balances?: Balances;
  lastQuoteAt?: string;
  lastTx?: string;
  error?: string;
}

export interface MarketRuntime {
  /** The Hunch market (or, for a bare book, the book itself). */
  market: Address;
  book: Address;
  info: BookInfo;
  tokens: { yes: Address; no: Address; usdc: Address };
  sets: SetOps;
  tracker: OrderTracker;
  /** False until the bot has adopted any of its orders already on the book (startup, unknown tx). */
  synced: boolean;
  lastFair: number | null;
  lastQuoteAt: number | null;
  /** Dry runs keep what they would have placed here, so they print only when it changes. */
  dryRunQuotes: Quotes | null;
  lastIdleLogAt: number | null;
  unwound: boolean;
  health: MarketHealth;
}

export function createRuntime(input: {
  market: Address;
  book: Address;
  info: BookInfo;
  no: Address;
  sets: SetOps;
}): MarketRuntime {
  const { market, book, info, no, sets } = input;
  return {
    market,
    book,
    info,
    tokens: { yes: info.base, no, usdc: info.quote },
    sets,
    tracker: new OrderTracker(),
    synced: false,
    lastFair: null,
    lastQuoteAt: null,
    dryRunQuotes: null,
    lastIdleLogAt: null,
    unwound: false,
    health: { market, book, status: "starting", bids: [], asks: [], openOrders: 0 },
  };
}

const units = (tokens: number, decimals: number) => BigInt(Math.floor(tokens * 10 ** decimals));

/** Adopts orders of ours already on the book, then reads every tracked order's status. */
async function refreshOrders(deps: MakerDeps, rt: MarketRuntime): Promise<Fill[]> {
  const client = deps.tx.publicClient;
  const me = accountAddress(deps.tx);
  if (!rt.synced) {
    const found = await findOwnOrders(client, rt.book, me, await readL2Book(client, rt.book));
    rt.tracker.adopt(found);
    if (found.length > 0)
      log("orders-adopted", { market: rt.market, book: rt.book, ids: found.map((o) => o.id) });
    rt.synced = true;
  }
  const ids = rt.tracker.cancelIds();
  if (ids.length === 0) return [];
  const fills = rt.tracker.update(await readOrderStatuses(client, rt.book, ids, me));
  for (const fill of fills) {
    log("fill", {
      market: rt.market,
      book: rt.book,
      orderId: fill.id,
      side: fill.isBuy ? "bid" : "ask",
      price: fill.price,
      size: fill.size,
      complete: fill.complete,
    });
  }
  return fills;
}

/** One batchUpdate: cancels `cancelIds` first, then places `quotes` post-only. Tracks the outcome. */
async function sendBatch(
  deps: MakerDeps,
  rt: MarketRuntime,
  quotes: Quotes,
  cancelIds: bigint[],
  reason: string,
): Promise<boolean> {
  const result = await sendTx(deps.tx, {
    to: rt.book,
    data: encodeFunctionData({
      abi: kuruOrderBookAbi,
      functionName: "batchUpdate",
      args: [
        quotes.bids.map((o) => o.price),
        quotes.bids.map((o) => o.size),
        quotes.asks.map((o) => o.price),
        quotes.asks.map((o) => o.size),
        cancelIds.map((id) => Number(id)),
        true,
      ],
    }),
    abi: kuruOrderBookAbi,
    action: "batchUpdate",
    fields: {
      market: rt.market,
      book: rt.book,
      reason,
      cancel: cancelIds,
      bids: quotes.bids,
      asks: quotes.asks,
    },
  });
  if (result.status === "success") {
    rt.tracker.retire(cancelIds);
    rt.tracker.adopt(parseOrderCreated(result.receipt.logs, rt.book, accountAddress(deps.tx)));
    rt.health.lastTx = result.hash;
    return true;
  }
  // Unknown outcome: re-read the book next cycle instead of guessing which ids still rest.
  if (result.status === "unknown") rt.synced = false;
  if (result.status === "skipped" && result.reason === "PostOnlyError") {
    // A quote would have crossed the book, so the whole batch (its cancels too) did not go out: Kuru
    // refuses a crossing post-only order, and a Hunch order book refuses every crossing limit order.
    // The bot never prices a quote through the book it read, so the book moved after that read, or an
    // order of ours rests untracked. Re-adopt our orders from the book; the next cycle requotes from a
    // fresh read (lastQuoteAt is unchanged, so the requote is still due).
    rt.synced = false;
    log(
      "quote-crossed",
      {
        market: rt.market,
        book: rt.book,
        reason,
        note: "a quote would cross the book; nothing was sent, requoting from a fresh book next cycle",
      },
      "warn",
    );
  }
  return false;
}

/**
 * Brings the market's resting orders in line with `fair`: reads the book and inventory, builds quotes,
 * and when a requote is due funds the margin account (minting sets for asks if needed) and sends one
 * batchUpdate. Afterwards it withdraws idle fill proceeds and merges spare YES with NO.
 */
export async function quoteMarket(
  deps: MakerDeps,
  rt: MarketRuntime,
  input: { fair: number; widen: number; now: number; detail?: Record<string, unknown> },
): Promise<void> {
  const client = deps.tx.publicClient;
  const me = accountAddress(deps.tx);
  const book = rt.info;
  const fills = await refreshOrders(deps, rt);
  const [l2, state, balances] = await Promise.all([
    readL2Book(client, rt.book),
    readMarketState(client, rt.book),
    readBalances(client, me, rt.tokens, deps.marginAccount),
  ]);
  rt.health = { ...rt.health, fair: input.fair, detail: input.detail, balances, error: undefined };
  if (state !== MarketState.Active) {
    // Cancels work in every state; placing does not. 1 is cancels only (Kuru's soft pause, or a Hunch
    // order book whose market is not trading), 2 Kuru's hard pause.
    const { status, reason } = bookStateStatus(state);
    rt.health.status = status;
    await cancelMarket(deps, rt, reason);
    return;
  }

  const own = rt.tracker.orders();
  const lockedYes = own.filter((o) => !o.isBuy).reduce((s, o) => s + baseAmount(o.remaining, book), 0n);
  const lockedUsdc = own
    .filter((o) => o.isBuy)
    .reduce((s, o) => s + quoteRefundOnCancel(o.price, o.remaining, book), 0n);
  const yesHeld = balances.walletYes + balances.marginYes + lockedYes;
  const position = Number(yesHeld - balances.walletNo) / 10 ** book.baseDecimals;
  const dust = units(deps.dustTokens, book.quoteDecimals);
  const usdcTotal = balances.walletUsdc + balances.marginUsdc + lockedUsdc;

  const ladder = priceLadder({
    fair: input.fair,
    position,
    widen: input.widen,
    params: deps.quote,
    book,
    external: externalTopOfBook(l2, rt.tracker.sizeByPrice()),
  });
  const sized = sizeQuotes({
    ladder,
    params: deps.quote,
    book,
    position,
    yesAvailable: yesHeld,
    usdcAvailable: usdcTotal > dust ? usdcTotal - dust : 0n,
  });
  const desired: Quotes = { bids: sized.bids, asks: sized.asks };
  const live = deps.tx.enabled ? rt.tracker.quotes() : (rt.dryRunQuotes ?? { bids: [], asks: [] });
  rt.health = {
    ...rt.health,
    status: "quoting",
    position,
    bids: live.bids,
    asks: live.asks,
    openOrders: rt.tracker.orders().length,
  };

  const reason = decideRequote({
    live,
    desired,
    fair: input.fair,
    lastFair: rt.lastFair,
    filled: fills.length > 0,
    now: input.now,
    lastQuoteAt: rt.lastQuoteAt,
    heartbeatSeconds: deps.heartbeatSeconds,
    threshold: deps.requoteThreshold,
    pricePrecision: book.pricePrecision,
  });
  const nothing = desired.bids.length + desired.asks.length === 0;
  if (!reason && nothing && live.bids.length + live.asks.length === 0) {
    if (rt.lastIdleLogAt === null || input.now - rt.lastIdleLogAt >= deps.heartbeatSeconds) {
      rt.lastIdleLogAt = input.now;
      log("idle", {
        market: rt.market,
        book: rt.book,
        reason: "no inventory to quote with (fund the wallet with USDC)",
        fair: input.fair,
        bidPrices: ladder.bids,
        askPrices: ladder.asks,
        balances,
        ...input.detail,
      });
    }
    rt.health.status = "no-inventory";
  }
  if (!reason) return;

  log("quote", {
    market: rt.market,
    book: rt.book,
    reason,
    dryRun: !deps.tx.enabled,
    fair: input.fair,
    reservation: ladder.reservation,
    halfSpread: ladder.halfSpread,
    widen: input.widen,
    position,
    bids: desired.bids,
    asks: desired.asks,
    ...input.detail,
  });

  const plan = planFunding({
    quotes: desired,
    book,
    marginYes: balances.marginYes,
    marginUsdc: balances.marginUsdc,
    lockedYes,
    lockedUsdc,
    walletYes: balances.walletYes,
    walletUsdc: balances.walletUsdc,
  });
  const ceiling = units(deps.quote.inventoryCap * 2, book.quoteDecimals);
  const fields = { market: rt.market, book: rt.book };
  if (plan.mint > 0n && !(await rt.sets.mint(plan.mint))) return;
  if (plan.depositYes > 0n) {
    if (
      !(await depositToMargin(deps.tx, deps.marginAccount, rt.tokens.yes, plan.depositYes, ceiling, fields))
    )
      return;
  }
  if (plan.depositUsdc > 0n) {
    // A small float on top, so Kuru's round-up on placing never forces a deposit on the next requote.
    const room = balances.walletUsdc - plan.mint;
    const withFloat = plan.depositUsdc + dust;
    const amount = withFloat < room ? withFloat : room;
    if (!(await depositToMargin(deps.tx, deps.marginAccount, rt.tokens.usdc, amount, ceiling, fields)))
      return;
  }

  if (!deps.tx.enabled) {
    await sendBatch(deps, rt, desired, rt.tracker.cancelIds(), reason);
    rt.dryRunQuotes = desired;
    rt.lastFair = input.fair;
    rt.lastQuoteAt = input.now;
    return;
  }
  const placed = await sendBatch(deps, rt, desired, rt.tracker.cancelIds(), reason);
  if (!placed) return;
  rt.lastFair = input.fair;
  rt.lastQuoteAt = input.now;
  rt.health.lastQuoteAt = new Date(input.now * 1000).toISOString();
  rt.health.bids = rt.tracker.quotes().bids;
  rt.health.asks = rt.tracker.quotes().asks;
  rt.health.openOrders = rt.tracker.orders().length;
  await tidyMargin(deps, rt);
}

/** After a batch: withdraw idle USDC beyond a small float, and merge YES no order needs with NO. */
async function tidyMargin(deps: MakerDeps, rt: MarketRuntime): Promise<void> {
  const me = accountAddress(deps.tx);
  const after = await readBalances(deps.tx.publicClient, me, rt.tokens, deps.marginAccount);
  const dust = units(deps.dustTokens, rt.info.quoteDecimals);
  const fields = { market: rt.market, book: rt.book };
  if (after.marginUsdc > 2n * dust) {
    await withdrawFromMargin(deps.tx, deps.marginAccount, rt.tokens.usdc, after.marginUsdc - dust, fields);
  }
  const spare = after.marginYes < after.walletNo ? after.marginYes : after.walletNo;
  if (spare >= dust && spare > 0n) {
    if (await withdrawFromMargin(deps.tx, deps.marginAccount, rt.tokens.yes, spare, fields)) {
      await rt.sets.merge(spare);
    }
  }
  rt.health.balances = await readBalances(deps.tx.publicClient, me, rt.tokens, deps.marginAccount);
}

/** Cancels every order of ours on the book (tracked, plus any found on the book). */
export async function cancelMarket(deps: MakerDeps, rt: MarketRuntime, reason: string): Promise<boolean> {
  await refreshOrders(deps, rt);
  const ids = rt.tracker.cancelIds();
  rt.health.bids = [];
  rt.health.asks = [];
  if (ids.length === 0) return true;
  log("cancel", { market: rt.market, book: rt.book, reason, ids, dryRun: !deps.tx.enabled });
  const ok = await sendBatch(deps, rt, { bids: [], asks: [] }, ids, reason);
  rt.health.openOrders = rt.tracker.orders().length;
  return ok;
}

/**
 * Leaves a market: cancels everything, withdraws all margin balances of its tokens, then merges as many
 * YES + NO pairs as it holds (when the market still allows merges).
 */
export async function unwindMarket(
  deps: MakerDeps,
  rt: MarketRuntime,
  input: { reason: string; merge: boolean },
): Promise<void> {
  const cancelled = await cancelMarket(deps, rt, input.reason);
  if (!cancelled) return;
  const me = accountAddress(deps.tx);
  const before = await readBalances(deps.tx.publicClient, me, rt.tokens, deps.marginAccount);
  let ok = true;
  if (before.marginYes > 0n || before.marginUsdc > 0n) {
    ok = await withdrawAllFromMargin(deps.tx, deps.marginAccount, [rt.tokens.yes, rt.tokens.usdc], {
      market: rt.market,
      book: rt.book,
      reason: input.reason,
    });
  }
  const after = await readBalances(deps.tx.publicClient, me, rt.tokens, deps.marginAccount);
  const pairs = after.walletYes < after.walletNo ? after.walletYes : after.walletNo;
  if (ok && input.merge && pairs > 0n) ok = await rt.sets.merge(pairs);
  rt.health = {
    ...rt.health,
    status: input.reason,
    balances: await readBalances(deps.tx.publicClient, me, rt.tokens, deps.marginAccount),
    bids: [],
    asks: [],
    openOrders: rt.tracker.orders().length,
  };
  // Done once it all landed; a dry run marks it done too, so it prints once instead of every poll.
  rt.unwound = ok;
  log("unwound", {
    market: rt.market,
    book: rt.book,
    reason: input.reason,
    merged: input.merge ? pairs : 0n,
  });
}

/** Cancel-all for any Kuru book, Hunch market or not: cancel our orders, withdraw base and quote. */
export async function cancelBook(
  deps: MakerDeps,
  book: Address,
  info: BookInfo,
  reason: string,
): Promise<void> {
  const client = deps.tx.publicClient;
  const me = accountAddress(deps.tx);
  const found = await findOwnOrders(client, book, me, await readL2Book(client, book));
  const ids = found.map((o) => o.id);
  log("cancel", { book, reason, ids, dryRun: !deps.tx.enabled });
  if (ids.length > 0) {
    await sendTx(deps.tx, {
      to: book,
      data: encodeFunctionData({
        abi: kuruOrderBookAbi,
        functionName: "batchUpdate",
        args: [[], [], [], [], ids.map((id) => Number(id)), false],
      }),
      abi: kuruOrderBookAbi,
      action: "batchUpdate",
      fields: { book, reason, cancel: ids },
    });
  }
  const [marginBase, marginQuote] = await Promise.all(
    [info.base, info.quote].map((token) =>
      client.readContract({
        address: deps.marginAccount,
        abi: kuruMarginAccountAbi,
        functionName: "getBalance",
        args: [me, token],
      }),
    ),
  );
  if ((marginBase ?? 0n) > 0n || (marginQuote ?? 0n) > 0n) {
    await withdrawAllFromMargin(deps.tx, deps.marginAccount, [info.base, info.quote], { book, reason });
  }
}

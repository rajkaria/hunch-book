import {
  KURU_V2_MAX_SLOTS,
  KuruV2Exec,
  KuruV2MarketState,
  KuruV2Side,
  KuruV2Tif,
  kuruV2AccountCoreAbi,
  kuruV2OrderBookAbi,
  type L2Book,
  l2BookFromV2,
} from "@hunch-book/shared";
import { type Address, encodeFunctionData, erc20Abi, type PublicClient } from "viem";
import { type Balances, ensureAllowance, type SetOps } from "./inventory.js";
import type { BookInfo } from "./kuru.js";
import { log } from "./log.js";
import type { MarketHealth } from "./maker.js";
import {
  decideRequote,
  externalTopOfBook,
  type Order,
  planFunding,
  priceLadder,
  type QuoteParams,
  type Quotes,
  sizeQuotes,
} from "./quotes.js";
import { accountAddress, sendTx, type TxContext } from "./tx.js";

// The maker on a Kuru v2 book (docs/PROTOCOL.md §8.1, Kuru v2). Balances live in Kuru's AccountCore
// under the maker's account id (created by its first deposit); orders rest in up to 62 slots per book.
// Each requote is one `batch` call that cancels every occupied slot and places the new quotes
// post-only, so the bot never needs per-order ids: it reads which slots are occupied, and what is
// reserved behind them, from the chain each cycle.

/** How many L2 levels to read per side. */
const L2_LEVELS = 64n;

export interface V2Deps {
  tx: TxContext;
  accountCore: Address;
  quote: QuoteParams;
  requoteThreshold: number;
  heartbeatSeconds: number;
  dustTokens: number;
}

/** Per-market state the v2 maker keeps between cycles. */
export interface V2Runtime {
  market: Address;
  book: Address;
  info: BookInfo;
  tokens: { yes: Address; no: Address; usdc: Address };
  sets: SetOps;
  /** What the bot last placed; cleared when its slots are found empty. */
  placed: Quotes;
  /** YES and USDC reserved behind the bot's orders last cycle (a drop means a fill). */
  reserved: { yes: bigint; usdc: bigint };
  lastFair: number | null;
  lastQuoteAt: number | null;
  dryRunQuotes: Quotes | null;
  unwound: boolean;
  health: MarketHealth;
}

export interface V2Balances extends Balances {
  /** The bot's Kuru account id (0 before its first deposit). */
  accountId: number;
  reservedYes: bigint;
  reservedUsdc: bigint;
}

/** A v2 book's fixed parameters, in the shape the quoting code uses (sizes limited by notional). */
export async function readBookInfoV2(client: PublicClient, book: Address): Promise<BookInfo> {
  const [params, base, quote] = await client.multicall({
    allowFailure: false,
    contracts: [
      { address: book, abi: kuruV2OrderBookAbi, functionName: "getMarketParams" },
      { address: book, abi: kuruV2OrderBookAbi, functionName: "baseToken" },
      { address: book, abi: kuruV2OrderBookAbi, functionName: "quoteToken" },
    ],
  });
  const [baseDecimals, quoteDecimals] = await client.multicall({
    allowFailure: false,
    contracts: [
      { address: base, abi: erc20Abi, functionName: "decimals" },
      { address: quote, abi: erc20Abi, functionName: "decimals" },
    ],
  });
  const [
    pricePrecision,
    sizePrecision,
    tickSize,
    minQuoteNotional,
    maxQuoteNotional,
    takerFeePps,
    makerFeePps,
  ] = params;
  return {
    pricePrecision: Number(pricePrecision),
    sizePrecision,
    tickSize: Number(tickSize),
    minSize: 1n,
    maxSize: 2n ** 96n - 1n,
    minQuoteNotional,
    maxQuoteNotional,
    baseDecimals: Number(baseDecimals),
    quoteDecimals: Number(quoteDecimals),
    base,
    quote,
    // Display only (bps); matching and costs use pps.
    takerFeeBps: takerFeePps / 1000n,
    makerFeeBps: makerFeePps / 1000n,
    takerFeePps,
  };
}

export async function readL2BookV2(client: PublicClient, book: Address): Promise<L2Book> {
  const [block, result] = await Promise.all([
    client.getBlockNumber(),
    client.readContract({
      address: book,
      abi: kuruV2OrderBookAbi,
      functionName: "getL2Book",
      args: [L2_LEVELS],
    }),
  ]);
  return l2BookFromV2(result, block);
}

export async function readMarketStateV2(client: PublicClient, book: Address): Promise<number> {
  return client.readContract({ address: book, abi: kuruV2OrderBookAbi, functionName: "marketState" });
}

/** Wallet balances, free AccountCore balances (as "margin") and what the bot's orders reserve. */
export async function readBalancesV2(
  client: PublicClient,
  me: Address,
  tokens: { yes: Address; no: Address; usdc: Address },
  accountCore: Address,
): Promise<V2Balances> {
  const accountId = await client.readContract({
    address: accountCore,
    abi: kuruV2AccountCoreAbi,
    functionName: "rootAccountIdOf",
    args: [me],
  });
  const wallet = await client.multicall({
    allowFailure: false,
    contracts: [
      { address: tokens.yes, abi: erc20Abi, functionName: "balanceOf", args: [me] },
      { address: tokens.no, abi: erc20Abi, functionName: "balanceOf", args: [me] },
      { address: tokens.usdc, abi: erc20Abi, functionName: "balanceOf", args: [me] },
    ],
  });
  let account: readonly bigint[] = [0n, 0n, 0n, 0n];
  if (accountId !== 0) {
    account = await client.multicall({
      allowFailure: false,
      contracts: [
        {
          address: accountCore,
          abi: kuruV2AccountCoreAbi,
          functionName: "getBalance",
          args: [accountId, tokens.yes],
        },
        {
          address: accountCore,
          abi: kuruV2AccountCoreAbi,
          functionName: "getBalance",
          args: [accountId, tokens.usdc],
        },
        {
          address: accountCore,
          abi: kuruV2AccountCoreAbi,
          functionName: "getSpotReservedBalance",
          args: [accountId, tokens.yes],
        },
        {
          address: accountCore,
          abi: kuruV2AccountCoreAbi,
          functionName: "getSpotReservedBalance",
          args: [accountId, tokens.usdc],
        },
      ],
    });
  }
  return {
    accountId,
    walletYes: wallet[0],
    walletNo: wallet[1],
    walletUsdc: wallet[2],
    marginYes: account[0] ?? 0n,
    marginUsdc: account[1] ?? 0n,
    reservedYes: account[2] ?? 0n,
    reservedUsdc: account[3] ?? 0n,
  };
}

/** Slots (0 to 61) holding one of the account's orders on `book`. */
export async function occupiedSlots(
  client: PublicClient,
  book: Address,
  accountId: number,
): Promise<number[]> {
  if (accountId === 0) return [];
  const ids = await client.multicall({
    allowFailure: false,
    contracts: Array.from({ length: KURU_V2_MAX_SLOTS }, (_, slot) => ({
      address: book,
      abi: kuruV2OrderBookAbi,
      functionName: "getOrderId" as const,
      args: [accountId, slot] as const,
    })),
  });
  return ids.flatMap((id, slot) => (id !== 0n ? [slot] : []));
}

/** Deposits `amount` of `token` into the bot's Kuru account (by owner: the first deposit opens it). */
export async function depositV2(
  deps: V2Deps,
  token: Address,
  amount: bigint,
  ceiling: bigint,
  fields: Record<string, unknown>,
): Promise<boolean> {
  if (amount <= 0n) return true;
  if (!(await ensureAllowance(deps.tx, token, deps.accountCore, amount, ceiling, fields))) return false;
  const me = accountAddress(deps.tx);
  const result = await sendTx(deps.tx, {
    to: deps.accountCore,
    data: encodeFunctionData({
      abi: kuruV2AccountCoreAbi,
      functionName: "deposit",
      args: [me, token, amount],
    }),
    abi: kuruV2AccountCoreAbi,
    action: "deposit",
    fields: { ...fields, token, amount },
  });
  return result.status === "success";
}

export async function withdrawV2(
  deps: V2Deps,
  accountId: number,
  token: Address,
  amount: bigint,
  fields: Record<string, unknown>,
): Promise<boolean> {
  if (amount <= 0n || accountId === 0) return true;
  const result = await sendTx(deps.tx, {
    to: deps.accountCore,
    data: encodeFunctionData({
      abi: kuruV2AccountCoreAbi,
      functionName: "withdraw",
      args: [accountId, token, amount, accountAddress(deps.tx)],
    }),
    abi: kuruV2AccountCoreAbi,
    action: "withdraw",
    fields: { ...fields, token, amount },
  });
  return result.status === "success";
}

/** The `batch` order tuples for `quotes`: GTC, post-only. */
export function v2Orders(quotes: Quotes) {
  const order = (side: number, o: Order) => ({
    side,
    quantity: o.size,
    price: o.price,
    tif: KuruV2Tif.gtc,
    executionInstruction: KuruV2Exec.postOnly,
    minSizeAfterBlock: 0,
  });
  return [
    ...quotes.bids.map((o) => order(KuruV2Side.buy, o)),
    ...quotes.asks.map((o) => order(KuruV2Side.sell, o)),
  ];
}

/** One `batch`: cancels `slots`, places `quotes`. */
async function sendBatchV2(
  deps: V2Deps,
  rt: V2Runtime,
  accountId: number,
  quotes: Quotes,
  slots: number[],
  reason: string,
): Promise<boolean> {
  const result = await sendTx(deps.tx, {
    to: rt.book,
    data: encodeFunctionData({
      abi: kuruV2OrderBookAbi,
      functionName: "batch",
      args: [accountId, v2Orders(quotes), slots],
    }),
    abi: kuruV2OrderBookAbi,
    action: "batch",
    fields: {
      market: rt.market,
      book: rt.book,
      reason,
      cancelSlots: slots,
      bids: quotes.bids,
      asks: quotes.asks,
    },
  });
  if (result.status === "success") {
    rt.placed = quotes;
    rt.health.lastTx = result.hash;
    return true;
  }
  return false;
}

/** Sizes the bot rests at each price (what it last placed), for reading the rest of the book. */
function ownSizes(placed: Quotes): { bids: Map<number, bigint>; asks: Map<number, bigint> } {
  const add = (orders: Order[]) => {
    const m = new Map<number, bigint>();
    for (const o of orders) m.set(o.price, (m.get(o.price) ?? 0n) + o.size);
    return m;
  };
  return { bids: add(placed.bids), asks: add(placed.asks) };
}

const units = (tokens: number, decimals: number) => BigInt(Math.floor(tokens * 10 ** decimals));

/**
 * The v2 counterpart of quoteMarket: reads the book, the account and the occupied slots; builds quotes;
 * when a requote is due, funds the account (minting sets for asks if needed) and sends one batch that
 * cancels every occupied slot and places the new quotes. Then withdraws idle USDC and merges spare YES.
 */
export async function quoteMarketV2(
  deps: V2Deps,
  rt: V2Runtime,
  input: { fair: number; widen: number; now: number; detail?: Record<string, unknown> },
): Promise<void> {
  const client = deps.tx.publicClient;
  const me = accountAddress(deps.tx);
  const book = rt.info;
  const [l2, state, balances] = await Promise.all([
    readL2BookV2(client, rt.book),
    readMarketStateV2(client, rt.book),
    readBalancesV2(client, me, rt.tokens, deps.accountCore),
  ]);
  const slots = await occupiedSlots(client, rt.book, balances.accountId);
  rt.health = { ...rt.health, fair: input.fair, detail: input.detail, balances, error: undefined };
  if (state !== KuruV2MarketState.active) {
    rt.health.status = "book-paused";
    await cancelMarketV2(deps, rt, "book paused");
    return;
  }

  // A fill shows as less reserved behind the bot's orders (or slots emptied) since the last cycle.
  const filled =
    balances.reservedYes < rt.reserved.yes || balances.reservedUsdc < rt.reserved.usdc || slots.length === 0;
  if (slots.length === 0) rt.placed = { bids: [], asks: [] };
  rt.reserved = { yes: balances.reservedYes, usdc: balances.reservedUsdc };

  const yesHeld = balances.walletYes + balances.marginYes + balances.reservedYes;
  const position = Number(yesHeld - balances.walletNo) / 10 ** book.baseDecimals;
  const dust = units(deps.dustTokens, book.quoteDecimals);
  const usdcTotal = balances.walletUsdc + balances.marginUsdc + balances.reservedUsdc;

  const ladder = priceLadder({
    fair: input.fair,
    position,
    widen: input.widen,
    params: deps.quote,
    book,
    external: externalTopOfBook(l2, ownSizes(rt.placed)),
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
  const live = deps.tx.enabled ? rt.placed : (rt.dryRunQuotes ?? { bids: [], asks: [] });
  rt.health = {
    ...rt.health,
    status: "quoting",
    position,
    bids: live.bids,
    asks: live.asks,
    openOrders: slots.length,
  };

  const reason = decideRequote({
    live,
    desired,
    fair: input.fair,
    lastFair: rt.lastFair,
    filled: filled && live.bids.length + live.asks.length > 0,
    now: input.now,
    lastQuoteAt: rt.lastQuoteAt,
    heartbeatSeconds: deps.heartbeatSeconds,
    threshold: deps.requoteThreshold,
    pricePrecision: book.pricePrecision,
  });
  if (desired.bids.length + desired.asks.length === 0 && slots.length === 0) {
    rt.health.status = "no-inventory";
  }
  if (!reason) return;

  log("quote", {
    market: rt.market,
    book: rt.book,
    kuru: 2,
    reason,
    dryRun: !deps.tx.enabled,
    fair: input.fair,
    position,
    bids: desired.bids,
    asks: desired.asks,
    ...input.detail,
  });

  // The batch cancels first, so what the bot's orders reserve comes back before the new ones draw on it.
  const plan = planFunding({
    quotes: desired,
    book,
    marginYes: balances.marginYes,
    marginUsdc: balances.marginUsdc,
    lockedYes: balances.reservedYes,
    lockedUsdc: balances.reservedUsdc,
    walletYes: balances.walletYes,
    walletUsdc: balances.walletUsdc,
  });
  const ceiling = units(deps.quote.inventoryCap * 2, book.quoteDecimals);
  const fields = { market: rt.market, book: rt.book };
  if (plan.mint > 0n && !(await rt.sets.mint(plan.mint))) return;
  if (!(await depositV2(deps, rt.tokens.yes, plan.depositYes, ceiling, fields))) return;
  if (plan.depositUsdc > 0n) {
    const room = balances.walletUsdc - plan.mint;
    const withFloat = plan.depositUsdc + dust;
    if (!(await depositV2(deps, rt.tokens.usdc, withFloat < room ? withFloat : room, ceiling, fields)))
      return;
  }

  let accountId = balances.accountId;
  if (accountId === 0 && deps.tx.enabled) {
    accountId = await client.readContract({
      address: deps.accountCore,
      abi: kuruV2AccountCoreAbi,
      functionName: "rootAccountIdOf",
      args: [me],
    });
  }
  if (!deps.tx.enabled) {
    rt.dryRunQuotes = desired;
    rt.lastFair = input.fair;
    rt.lastQuoteAt = input.now;
    return;
  }
  if (accountId === 0) {
    log(
      "no-account",
      { market: rt.market, note: "nothing deposited yet, so no Kuru account to quote from" },
      "warn",
    );
    return;
  }
  if (!(await sendBatchV2(deps, rt, accountId, desired, slots, reason))) return;
  rt.lastFair = input.fair;
  rt.lastQuoteAt = input.now;
  rt.health.lastQuoteAt = new Date(input.now * 1000).toISOString();
  rt.health.bids = desired.bids;
  rt.health.asks = desired.asks;
  await tidyV2(deps, rt);
  const after = await readBalancesV2(client, me, rt.tokens, deps.accountCore);
  rt.reserved = { yes: after.reservedYes, usdc: after.reservedUsdc };
  rt.health.balances = after;
}

/** Withdraws free USDC beyond a small float, and free YES that can merge with NO the wallet holds. */
async function tidyV2(deps: V2Deps, rt: V2Runtime): Promise<void> {
  const me = accountAddress(deps.tx);
  const after = await readBalancesV2(deps.tx.publicClient, me, rt.tokens, deps.accountCore);
  const dust = units(deps.dustTokens, rt.info.quoteDecimals);
  const fields = { market: rt.market, book: rt.book };
  if (after.marginUsdc > 2n * dust) {
    await withdrawV2(deps, after.accountId, rt.tokens.usdc, after.marginUsdc - dust, fields);
  }
  const spare = after.marginYes < after.walletNo ? after.marginYes : after.walletNo;
  if (spare >= dust && spare > 0n) {
    if (await withdrawV2(deps, after.accountId, rt.tokens.yes, spare, fields)) await rt.sets.merge(spare);
  }
}

/** Cancels every order of the bot's on the book (`cancelAllOrders`). */
export async function cancelMarketV2(deps: V2Deps, rt: V2Runtime, reason: string): Promise<boolean> {
  const client = deps.tx.publicClient;
  const me = accountAddress(deps.tx);
  const accountId = await client.readContract({
    address: deps.accountCore,
    abi: kuruV2AccountCoreAbi,
    functionName: "rootAccountIdOf",
    args: [me],
  });
  const slots = await occupiedSlots(client, rt.book, accountId);
  rt.health.bids = [];
  rt.health.asks = [];
  rt.placed = { bids: [], asks: [] };
  if (slots.length === 0) return true;
  log("cancel", { market: rt.market, book: rt.book, kuru: 2, reason, slots, dryRun: !deps.tx.enabled });
  const result = await sendTx(deps.tx, {
    to: rt.book,
    data: encodeFunctionData({ abi: kuruV2OrderBookAbi, functionName: "cancelAllOrders", args: [accountId] }),
    abi: kuruV2OrderBookAbi,
    action: "cancelAllOrders",
    fields: { market: rt.market, book: rt.book, reason },
  });
  rt.health.openOrders = 0;
  return result.status === "success";
}

/**
 * Leaves a market: cancels everything, withdraws the account's YES and USDC, then merges as many YES + NO
 * pairs as it holds (when the market still allows merges). Works while Kuru soft-pauses the book.
 */
export async function unwindMarketV2(
  deps: V2Deps,
  rt: V2Runtime,
  input: { reason: string; merge: boolean },
): Promise<void> {
  if (!(await cancelMarketV2(deps, rt, input.reason))) return;
  const client = deps.tx.publicClient;
  const me = accountAddress(deps.tx);
  const before = await readBalancesV2(client, me, rt.tokens, deps.accountCore);
  let ok = true;
  const fields = { market: rt.market, book: rt.book, reason: input.reason };
  if (before.marginYes > 0n)
    ok = (await withdrawV2(deps, before.accountId, rt.tokens.yes, before.marginYes, fields)) && ok;
  if (before.marginUsdc > 0n)
    ok = (await withdrawV2(deps, before.accountId, rt.tokens.usdc, before.marginUsdc, fields)) && ok;
  const after = await readBalancesV2(client, me, rt.tokens, deps.accountCore);
  const pairs = after.walletYes < after.walletNo ? after.walletYes : after.walletNo;
  if (ok && input.merge && pairs > 0n) ok = await rt.sets.merge(pairs);
  rt.health = { ...rt.health, status: input.reason, balances: after, bids: [], asks: [], openOrders: 0 };
  rt.unwound = ok;
  rt.reserved = { yes: 0n, usdc: 0n };
  log("unwound", {
    market: rt.market,
    book: rt.book,
    kuru: 2,
    reason: input.reason,
    merged: input.merge ? pairs : 0n,
  });
}

export function createRuntimeV2(input: {
  market: Address;
  book: Address;
  info: BookInfo;
  no: Address;
  sets: SetOps;
}): V2Runtime {
  const { market, book, info, no, sets } = input;
  return {
    market,
    book,
    info,
    tokens: { yes: info.base, no, usdc: info.quote },
    sets,
    placed: { bids: [], asks: [] },
    reserved: { yes: 0n, usdc: 0n },
    lastFair: null,
    lastQuoteAt: null,
    dryRunQuotes: null,
    unwound: false,
    health: { market, book, status: "starting", bids: [], asks: [], openOrders: 0 },
  };
}

/** Cancel-all for any Kuru v2 book: cancel the bot's orders there and withdraw its base and quote. */
export async function cancelBookV2(
  deps: V2Deps,
  book: Address,
  info: BookInfo,
  reason: string,
): Promise<void> {
  const client = deps.tx.publicClient;
  const me = accountAddress(deps.tx);
  const accountId = await client.readContract({
    address: deps.accountCore,
    abi: kuruV2AccountCoreAbi,
    functionName: "rootAccountIdOf",
    args: [me],
  });
  if (accountId === 0) return;
  const slots = await occupiedSlots(client, book, accountId);
  log("cancel", { book, kuru: 2, reason, slots, dryRun: !deps.tx.enabled });
  if (slots.length > 0) {
    await sendTx(deps.tx, {
      to: book,
      data: encodeFunctionData({
        abi: kuruV2OrderBookAbi,
        functionName: "cancelAllOrders",
        args: [accountId],
      }),
      abi: kuruV2OrderBookAbi,
      action: "cancelAllOrders",
      fields: { book, reason },
    });
  }
  for (const token of [info.base, info.quote]) {
    const free = await client.readContract({
      address: deps.accountCore,
      abi: kuruV2AccountCoreAbi,
      functionName: "getBalance",
      args: [accountId, token],
    });
    if (free > 0n) await withdrawV2(deps, accountId, token, free, { book, reason });
  }
}

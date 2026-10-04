import { conditionalOrdersAbi, Side, touchPrice } from "@hunch-book/shared";
import { type Abi, type Address, type ContractFunctionParameters, erc20Abi, isAddressEqual } from "viem";
import { MULTICALL3, type ReadClient } from "../chain/client";
import type { BookSnapshot } from "../chain/kuru";
import { formatUsdc } from "../format";
import { formatPriceE6 } from "../trade/ticket";
import {
  Condition,
  conditionMet,
  isBuyKind,
  ORDER_TYPE_LABEL,
  OrderKind,
  OrderStatus,
  type OrderToken,
  orderTypeOf,
  sideOfKind,
  type TokenAmounts,
  TRIGGER_PRICE_LABEL,
  tradeKindOfOrder,
} from "./form";

// Reading a wallet's conditional orders. ConditionalOrders numbers orders from 1 and keeps every one,
// so the newest ORDER_SCAN_LIMIT ids are read by multicall and filtered by owner. No log scan needed.

/** How many of the newest orders are read. Older ones need the indexer. */
export const ORDER_SCAN_LIMIT = 1_000;
const MULTICALL_BATCH_BYTES = 16_384;

export interface StoredOrder {
  id: bigint;
  owner: Address;
  expiry: bigint;
  triggerPriceE6: bigint;
  market: Address;
  kind: OrderKind;
  condition: Condition;
  status: OrderStatus;
  executorTipBps: number;
  amountIn: bigint;
  limit: bigint;
}

interface RawOrder {
  owner: Address;
  expiry: bigint | number;
  triggerPriceE6: bigint | number;
  market: Address;
  kind: number;
  condition: number;
  status: number;
  executorTipBps: number;
  amountIn: bigint;
  limit: bigint;
}

export function parseOrder(id: bigint, raw: RawOrder): StoredOrder {
  return {
    id,
    owner: raw.owner,
    expiry: BigInt(raw.expiry),
    triggerPriceE6: BigInt(raw.triggerPriceE6),
    market: raw.market,
    kind: Number(raw.kind) as OrderKind,
    condition: Number(raw.condition) as Condition,
    status: Number(raw.status) as OrderStatus,
    executorTipBps: Number(raw.executorTipBps),
    amountIn: BigInt(raw.amountIn),
    limit: BigInt(raw.limit),
  };
}

/** Every order `owner` placed among the newest ORDER_SCAN_LIMIT, newest first. */
export async function readOwnerOrders(
  client: ReadClient,
  contract: Address,
  owner: Address,
  limit = ORDER_SCAN_LIMIT,
): Promise<{ orders: StoredOrder[]; total: bigint; complete: boolean }> {
  const total = await client.readContract({
    address: contract,
    abi: conditionalOrdersAbi,
    functionName: "orderCount",
  });
  const first = total > BigInt(limit) ? total - BigInt(limit) + 1n : 1n;
  const ids: bigint[] = [];
  for (let id = total; id >= first && id > 0n; id--) ids.push(id);
  if (ids.length === 0) return { orders: [], total, complete: true };
  const results = (await client.multicall({
    contracts: ids.map((id) => ({
      address: contract,
      abi: conditionalOrdersAbi as Abi,
      functionName: "getOrder",
      args: [id],
    })) as unknown as readonly ContractFunctionParameters[],
    allowFailure: true,
    batchSize: MULTICALL_BATCH_BYTES,
    multicallAddress: MULTICALL3,
  })) as ({ status: "success"; result: unknown } | { status: "failure"; error: Error })[];
  const orders: StoredOrder[] = [];
  results.forEach((r, i) => {
    const id = ids[i];
    if (r.status !== "success" || id === undefined) return;
    const order = parseOrder(id, r.result as RawOrder);
    if (isAddressEqual(order.owner, owner)) orders.push(order);
  });
  return { orders, total, complete: first === 1n };
}

/** The wallet's USDC, YES and NO, and what it approved ConditionalOrders to move of each. */
export async function readOrderFunds(
  client: ReadClient,
  contract: Address,
  tokens: { usdc: Address; yes: Address; no: Address },
  owner: Address,
): Promise<{ balances: TokenAmounts; allowances: TokenAmounts }> {
  const order: OrderToken[] = ["usdc", "yes", "no"];
  const results = (await client.multicall({
    contracts: [
      ...order.map((t) => ({ address: tokens[t], abi: erc20Abi, functionName: "balanceOf", args: [owner] })),
      ...order.map((t) => ({
        address: tokens[t],
        abi: erc20Abi,
        functionName: "allowance",
        args: [owner, contract],
      })),
    ] as unknown as readonly ContractFunctionParameters[],
    allowFailure: true,
    multicallAddress: MULTICALL3,
  })) as ({ status: "success"; result: unknown } | { status: "failure"; error: Error })[];
  const at = (i: number): bigint => {
    const r = results[i];
    if (r?.status !== "success") throw new Error("Could not read your balances for orders.");
    return r.result as bigint;
  };
  return {
    balances: { usdc: at(0), yes: at(1), no: at(2) },
    allowances: { usdc: at(3), yes: at(4), no: at(5) },
  };
}

// ---------------------------------------------------------------- state

export type OrderState = "open" | "expired" | "executed" | "cancelled";

export function orderState(order: StoredOrder, now: number): OrderState {
  if (order.status === OrderStatus.Executed) return "executed";
  if (order.status === OrderStatus.Cancelled) return "cancelled";
  return order.expiry < BigInt(Math.floor(now)) ? "expired" : "open";
}

export const ORDER_STATE_LABEL: Record<OrderState, string> = {
  open: "Open",
  expired: "Expired",
  executed: "Executed",
  cancelled: "Cancelled",
};

/** The token an order pulls at execution, and how much. */
export function orderInput(order: StoredOrder): { token: OrderToken; amount: bigint } {
  switch (order.kind) {
    case OrderKind.BuyYes:
      return { token: "usdc", amount: order.amountIn };
    case OrderKind.BuyNo:
      return { token: "usdc", amount: order.limit };
    case OrderKind.SellYes:
      return { token: "yes", amount: order.amountIn };
    default:
      return { token: "no", amount: order.amountIn };
  }
}

/**
 * What the wallet's open, unexpired orders can still pull: USDC across every market (one allowance
 * covers them all), YES and NO only for `market`'s own tokens.
 */
export function committedInputs(orders: StoredOrder[], market: Address, now: number): TokenAmounts {
  const sum: TokenAmounts = { usdc: 0n, yes: 0n, no: 0n };
  for (const o of orders) {
    if (orderState(o, now) !== "open") continue;
    const input = orderInput(o);
    if (input.token !== "usdc" && !isAddressEqual(o.market, market)) continue;
    sum[input.token] += input.amount;
  }
  return sum;
}

/** The price an order's trigger watches on this book now (E6), or null when that side is empty. */
export function triggerPriceNow(
  kind: OrderKind,
  book: Pick<BookSnapshot, "bids" | "asks" | "params">,
): bigint | null {
  return touchPrice(tradeKindOfOrder(kind), book, book.params);
}

/** True if an open order's trigger holds against this book now. */
export function triggeredNow(order: StoredOrder, book: BookSnapshot | null, now: number): boolean {
  if (!book || orderState(order, now) !== "open") return false;
  const price = triggerPriceNow(order.kind, book);
  return price !== null && conditionMet(order.condition, price, order.triggerPriceE6);
}

/** A stored order as a title and one line of detail. */
export function describeOrder(order: StoredOrder): { title: string; detail: string } {
  const type = orderTypeOf(order.kind, order.condition);
  const side = sideOfKind(order.kind) === Side.Yes ? "YES" : "NO";
  const typeLabel = type === "breakoutBuy" ? "Breakout buy" : ORDER_TYPE_LABEL[type];
  const at = `${order.condition === Condition.AtOrAbove ? "at or above" : "at or below"} ${formatPriceE6(order.triggerPriceE6)}`;
  const amount = formatUsdc(order.amountIn, { exact: true });
  const limit = formatUsdc(order.limit, { exact: true });
  let detail: string;
  if (order.kind === OrderKind.BuyYes) detail = `Spend ${amount} USDC, get at least ${limit} YES`;
  else if (order.kind === OrderKind.BuyNo) detail = `Buy ${amount} NO, pay at most ${limit} USDC`;
  else detail = `Sell ${amount} ${side}, get at least ${limit} USDC`;
  const tip = order.executorTipBps > 0 ? `, ${order.executorTipBps / 100}% tip` : "";
  return {
    title: `${typeLabel} ${side} ${at}`,
    detail: `${detail}, when ${TRIGGER_PRICE_LABEL[order.kind]} is ${at}${tip}.`,
  };
}

export const isBuyOrder = (order: StoredOrder): boolean => isBuyKind(order.kind);

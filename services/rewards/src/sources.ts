import type { HunchContext } from "@hunch-book/sdk";
import { collateralVaultAbi, kuruOrderBookAbi, marketAbi, stacksOf } from "@hunch-book/shared";
import { type Address, getAbiItem, type Hex } from "viem";
import type { BookEvent } from "./orders.js";
import type { FeeEvent } from "./referrals.js";

// Chain and indexer reads for the rewards CLI. Public Monad RPCs answer eth_getLogs for at most 100
// blocks, so every log read walks its range in 100-block windows, a few at a time.

export const LOG_WINDOW = 100n;

export function windows(
  from: bigint,
  to: bigint,
  size: bigint = LOG_WINDOW,
): { fromBlock: bigint; toBlock: bigint }[] {
  const out: { fromBlock: bigint; toBlock: bigint }[] = [];
  for (let start = from; start <= to; start += size) {
    const end = start + size - 1n;
    out.push({ fromBlock: start, toBlock: end > to ? to : end });
  }
  return out;
}

export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await run(items[i] as T);
    }
  });
  await Promise.all(workers);
  return out;
}

const KURU_EVENTS = [
  getAbiItem({ abi: kuruOrderBookAbi, name: "OrderCreated" }),
  getAbiItem({ abi: kuruOrderBookAbi, name: "Trade" }),
  getAbiItem({ abi: kuruOrderBookAbi, name: "OrderCanceled" }),
  getAbiItem({ abi: kuruOrderBookAbi, name: "OrdersCanceled" }),
] as const;

/**
 * One book's order events, as BookEvents: Kuru v1's events, which Hunch Book's own order books emit too.
 * `pricePrecision` converts prices to E6.
 */
export async function bookEvents(
  ctx: HunchContext,
  book: Address,
  from: bigint,
  to: bigint,
  options: { pricePrecision?: bigint; concurrency?: number } = {},
): Promise<BookEvent[]> {
  const precision = options.pricePrecision ?? 1_000_000n;
  const toE6 = (p: bigint): bigint => (p * 1_000_000n) / precision;
  const logs = (
    await mapLimit(windows(from, to), options.concurrency ?? 5, (w) =>
      ctx.publicClient.getLogs({
        address: book,
        events: KURU_EVENTS,
        fromBlock: w.fromBlock,
        toBlock: w.toBlock,
      }),
    )
  ).flat();
  const out: BookEvent[] = [];
  for (const l of logs) {
    const at = { block: l.blockNumber as bigint, logIndex: l.logIndex ?? 0 };
    const args = l.args as Record<string, unknown>;
    switch (l.eventName) {
      case "OrderCreated":
        out.push({
          kind: "created",
          ...at,
          orderId: BigInt(args.orderId as number | bigint),
          owner: args.owner as Address,
          price: toE6(BigInt(args.price as number | bigint)),
          size: BigInt(args.size as bigint),
          isBuy: args.isBuy as boolean,
        });
        break;
      case "Trade":
        out.push({
          kind: "filled",
          ...at,
          orderId: BigInt(args.orderId as number | bigint),
          remaining: BigInt(args.updatedSize as bigint),
        });
        break;
      case "OrderCanceled":
        out.push({ kind: "cancelled", ...at, orderIds: [BigInt(args.orderId as number | bigint)] });
        break;
      case "OrdersCanceled":
        out.push({
          kind: "cancelled",
          ...at,
          orderIds: (args.orderId as readonly (number | bigint)[]).map((x) => BigInt(x)),
        });
        break;
    }
  }
  return out;
}

/** The first block at which `market.graduated()` is true, by binary search on past state. */
export async function graduationBlock(
  ctx: HunchContext,
  market: Address,
  from: bigint,
  head: bigint,
): Promise<bigint | null> {
  const at = async (b: bigint): Promise<boolean> =>
    ctx.publicClient
      .readContract({ address: market, abi: marketAbi, functionName: "graduated", blockNumber: b })
      .catch(() => false);
  if (!(await at(head))) return null;
  let lo = from;
  let hi = head;
  if (await at(lo)) return lo;
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if (await at(mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}

/** Unix seconds of each block. */
export async function blockTimes(ctx: HunchContext, blocks: readonly bigint[]): Promise<Map<bigint, bigint>> {
  const unique = [...new Set(blocks)];
  const times = await mapLimit(
    unique,
    5,
    async (b) => (await ctx.publicClient.getBlock({ blockNumber: b })).timestamp,
  );
  return new Map(unique.map((b, i) => [b, times[i] as bigint]));
}

const REDEEMED = getAbiItem({ abi: collateralVaultAbi, name: "Redeemed" });
const POOL_CLAIMED = getAbiItem({ abi: marketAbi, name: "PoolClaimed" });

/**
 * Fee-paying events from the chain's logs: every stack's vault's Redeemed (each stack has its own vault,
 * the `hunch` one included) and every market's PoolClaimed.
 */
export async function feeEventsFromLogs(
  ctx: HunchContext,
  markets: readonly Address[],
  from: bigint,
  to: bigint,
): Promise<FeeEvent[]> {
  const vaults = stacksOf(ctx.deployment).flatMap((s) => (s.contracts.vault ? [s.contracts.vault] : []));
  if (vaults.length === 0) throw new Error(`The vault is not deployed on ${ctx.deployment.network}.`);
  const ranges = windows(from, to);
  const [redeemed, claimed] = await Promise.all([
    mapLimit(ranges, 5, (w) =>
      ctx.publicClient.getLogs({
        address: vaults,
        event: REDEEMED,
        fromBlock: w.fromBlock,
        toBlock: w.toBlock,
      }),
    ),
    markets.length === 0
      ? Promise.resolve([])
      : mapLimit(ranges, 5, (w) =>
          ctx.publicClient.getLogs({
            address: [...markets],
            event: POOL_CLAIMED,
            fromBlock: w.fromBlock,
            toBlock: w.toBlock,
          }),
        ),
  ]);
  const raw: Omit<FeeEvent, "time">[] = [];
  for (const l of redeemed.flat()) {
    if (!l.args.fee) continue;
    raw.push({
      kind: "redeem",
      market: l.args.market as Address,
      user: l.args.to as Address,
      fee: l.args.fee,
      block: l.blockNumber as bigint,
      tx: l.transactionHash as Hex,
    });
  }
  for (const l of claimed.flat()) {
    if (!l.args.fee) continue;
    raw.push({
      kind: "pool",
      market: l.address,
      user: l.args.user as Address,
      fee: l.args.fee,
      block: l.blockNumber as bigint,
      tx: l.transactionHash as Hex,
    });
  }
  const times = await blockTimes(
    ctx,
    raw.map((e) => e.block),
  );
  return raw
    .map((e) => ({ ...e, time: times.get(e.block) as bigint }))
    .sort((a, b) => (a.block === b.block ? 0 : a.block < b.block ? -1 : 1));
}

const FEES_QUERY = `query Fees($from: numeric!, $to: numeric!, $offset: Int!) {
  Redemption(where: { block: { _gte: $from, _lte: $to }, fee: { _gt: "0" } }, order_by: [{ block: asc }, { id: asc }], limit: 1000, offset: $offset) {
    to fee block timestamp tx market { id }
  }
  PoolPayout(where: { block: { _gte: $from, _lte: $to }, kind: { _eq: "Winnings" }, fee: { _gt: "0" } }, order_by: [{ block: asc }, { id: asc }], limit: 1000, offset: $offset) {
    fee block timestamp tx wallet { id } market { id }
  }
}`;

interface IndexedRedemption {
  to: Address;
  fee: string;
  block: string;
  timestamp: string;
  tx: Hex;
  market: { id: Address };
}

interface IndexedPayout {
  fee: string;
  block: string;
  timestamp: string;
  tx: Hex;
  wallet: { id: Address } | null;
  market: { id: Address };
}

/** Fee-paying events from the indexer (docs/INDEXER.md: Redemption and PoolPayout). */
export async function feeEventsFromIndexer(
  fetchFn: typeof fetch,
  url: string,
  from: bigint,
  to: bigint,
): Promise<FeeEvent[]> {
  const out: FeeEvent[] = [];
  for (let offset = 0; ; offset += 1000) {
    const res = await fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: FEES_QUERY,
        variables: { from: from.toString(), to: to.toString(), offset },
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`The indexer answered HTTP ${res.status}.`);
    const body = (await res.json()) as {
      data?: { Redemption?: IndexedRedemption[]; PoolPayout?: IndexedPayout[] };
      errors?: { message: string }[];
    };
    if (body.errors?.length || !body.data)
      throw new Error(body.errors?.[0]?.message ?? "The indexer returned nothing.");
    const redemptions = body.data.Redemption ?? [];
    const payouts = body.data.PoolPayout ?? [];
    for (const r of redemptions) {
      out.push({
        kind: "redeem",
        market: r.market.id,
        user: r.to,
        fee: BigInt(r.fee),
        block: BigInt(r.block),
        time: BigInt(r.timestamp),
        tx: r.tx,
      });
    }
    for (const p of payouts) {
      if (!p.wallet) continue;
      out.push({
        kind: "pool",
        market: p.market.id,
        user: p.wallet.id,
        fee: BigInt(p.fee),
        block: BigInt(p.block),
        time: BigInt(p.timestamp),
        tx: p.tx,
      });
    }
    if (redemptions.length < 1000 && payouts.length < 1000) break;
  }
  return out.sort((a, b) => (a.block === b.block ? 0 : a.block < b.block ? -1 : 1));
}

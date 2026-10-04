import { type Address, getAddress, type PublicClient } from "viem";
import { marketCreatedEvent, stakedEvent } from "./abis.js";
import type { StateStore } from "./state.js";

// Forward log scans with cursors saved in the state file. Monad's public RPCs answer eth_getLogs for
// at most 100 blocks at a time (about 40 seconds of chain), so history is read in windows, and each
// cycle spends at most a fixed number of requests (ScanBudget) so the other jobs never wait long.

export interface BlockWindow {
  from: bigint;
  to: bigint;
}

/** [from, to] cut into consecutive windows of at most `range` blocks, at most `max` of them. */
export function logWindows(
  from: bigint,
  to: bigint,
  range: number,
  max = Number.POSITIVE_INFINITY,
): BlockWindow[] {
  if (range < 1) throw new Error("range must be at least 1");
  const out: BlockWindow[] = [];
  const step = BigInt(range);
  for (let start = from; start <= to && out.length < max; start += step) {
    const end = start + step - 1n;
    out.push({ from: start, to: end < to ? end : to });
  }
  return out;
}

/** eth_getLogs requests the keeper may still spend in this cycle. */
export class ScanBudget {
  constructor(private left: number) {}

  get remaining(): number {
    return this.left;
  }

  take(): boolean {
    if (this.left <= 0) return false;
    this.left -= 1;
    return true;
  }
}

export interface ScanContext {
  client: PublicClient;
  store: StateStore;
  head: bigint;
  range: number;
  budget: ScanBudget;
}

/**
 * Scans the factory's MarketCreated events forward from the saved cursor (first run: the factory's
 * deploy block) and records each market's creation block. Stops at the head, when the budget runs out,
 * or as soon as `wanted` (if given) has a creation block.
 */
export async function scanMarketCreated(
  ctx: ScanContext,
  factory: Address,
  deployBlock: number,
  wanted?: Address,
): Promise<{ cursor: number; done: boolean }> {
  const found = () => wanted !== undefined && ctx.store.market(wanted).createdBlock !== undefined;
  let cursor = BigInt(ctx.store.factoryCursor ?? deployBlock);
  while (cursor <= ctx.head && !found() && ctx.budget.take()) {
    const [window] = logWindows(cursor, ctx.head, ctx.range, 1);
    if (!window) break;
    const logs = await ctx.client.getLogs({
      address: factory,
      event: marketCreatedEvent,
      fromBlock: window.from,
      toBlock: window.to,
    });
    for (const entry of logs) {
      const market = entry.args.market;
      if (market && entry.blockNumber !== null) {
        ctx.store.update(getAddress(market), (m) => {
          m.createdBlock = Number(entry.blockNumber);
        });
      }
    }
    cursor = window.to + 1n;
    ctx.store.factoryCursor = Number(cursor);
  }
  return { cursor: Number(cursor), done: found() || cursor > ctx.head };
}

export interface StakerScan {
  /** Next block to read; undefined until the market's creation block is known. */
  cursor: number | undefined;
  /** The scan has passed a block where staking was already closed: the list is final. */
  complete: boolean;
}

/** Whether a market's saved staker list is final. */
export function stakersComplete(m: { stakerCursor?: number; stakingClosedAt?: number }): boolean {
  return (
    m.stakingClosedAt !== undefined && m.stakerCursor !== undefined && m.stakerCursor > m.stakingClosedAt
  );
}

/**
 * Scans one market's Staked events forward from its cursor (first run: its creation block), up to the
 * block where staking was seen closed, or the head. Records every staker in the state file.
 */
export async function scanStakers(ctx: ScanContext, market: Address): Promise<StakerScan> {
  const m = ctx.store.market(market);
  if (m.createdBlock === undefined) return { cursor: undefined, complete: false };
  if (stakersComplete(m)) return { cursor: m.stakerCursor, complete: true };
  const end =
    m.stakingClosedAt !== undefined && BigInt(m.stakingClosedAt) < ctx.head
      ? BigInt(m.stakingClosedAt)
      : ctx.head;
  let cursor = BigInt(m.stakerCursor ?? m.createdBlock);
  while (cursor <= end && ctx.budget.take()) {
    const [window] = logWindows(cursor, end, ctx.range, 1);
    if (!window) break;
    const logs = await ctx.client.getLogs({
      address: market,
      event: stakedEvent,
      fromBlock: window.from,
      toBlock: window.to,
    });
    ctx.store.addStakers(
      market,
      logs.flatMap((entry) => (entry.args.user ? [getAddress(entry.args.user)] : [])),
    );
    cursor = window.to + 1n;
    ctx.store.update(market, (s) => {
      s.stakerCursor = Number(cursor);
    });
  }
  return { cursor: Number(cursor), complete: stakersComplete(ctx.store.market(market)) };
}

import { conditionalOrdersAbi, kuruOrderBookAbi, kuruV2OrderBookAbi } from "@hunch-book/shared";
import { type Address, encodeFunctionData, getAddress, zeroAddress } from "viem";
import { log } from "../log.js";
import type { MarketSnapshot } from "../markets.js";
import type { ChainNow } from "../settlers/index.js";
import { Backoff, type CycleJob, type JobContext, type JobRun, wentOut } from "./context.js";
import {
  evaluateOrder,
  KIND_LABEL,
  type OrderKind,
  OrderStatus,
  type YesQuote,
  yesQuote,
  yesQuoteV2,
} from "./triggers.js";

// Conditional orders (roadmap A-11, docs/PERIPHERY.md#conditionalorders). Owners place take-profit,
// stop-loss and limit orders on the ConditionalOrders contract; their funds stay in their wallets until
// execution. Each cycle the keeper reads every open order (ids 1 to orderCount()), reads the YES book of
// every market with an open order, decides with the pure rules in triggers.ts which orders the contract
// would call triggered, and calls `execute(orderId)` for each. The send simulates first, so an order that
// would revert (the owner moved their funds or cut the allowance, the limit cannot fill) costs nothing:
// it is logged and retried later with a growing wait. Executing earns the order's tip, paid to the
// keeper's published address.

export interface OrdersOptions {
  orders: Address;
  /** First wait before retrying an order whose execution would revert, doubling to the max. */
  retrySeconds: number;
  retryMaxSeconds: number;
}

interface Watched {
  id: bigint;
  owner: Address;
  market: Address;
  kind: number;
  condition: number;
  triggerPriceE6: number;
  expiry: bigint;
  status: number;
}

const BATCH_BYTES = 16_384;

export class ConditionalOrdersJob implements CycleJob {
  readonly name = "orders" as const;
  private readonly open = new Map<bigint, Watched>();
  private known = 0n;
  private readonly retry: Backoff;
  private readonly lastReason = new Map<bigint, string>();
  private executed = 0;

  constructor(
    private readonly opts: OrdersOptions,
    clock: () => number = Date.now,
  ) {
    this.retry = new Backoff(opts.retrySeconds, opts.retryMaxSeconds, clock);
  }

  async run(ctx: JobContext, markets: MarketSnapshot[], now: ChainNow): Promise<JobRun> {
    await this.refresh(ctx);
    const byMarket = new Map(markets.map((m) => [m.address, m]));
    const books = await this.readBooks(ctx, byMarket);
    let sent = 0;
    let due = 0;
    let triggered = 0;
    for (const order of [...this.open.values()]) {
      const market = byMarket.get(order.market);
      const decision = evaluateOrder(order, market, books.get(order.market), now.timestamp);
      if (!decision.execute) {
        if (decision.drop) {
          this.open.delete(order.id);
          log("order-dropped", { orderId: order.id, market: order.market, reason: decision.reason });
        } else {
          this.logOnce(ctx, order, "order-waiting", decision.reason);
        }
        continue;
      }
      triggered++;
      const key = order.id.toString();
      if (this.retry.waiting(key)) continue;
      due++;
      const result = await ctx.send(this.name, order.market, {
        to: this.opts.orders,
        data: encodeFunctionData({ abi: conditionalOrdersAbi, functionName: "execute", args: [order.id] }),
        abi: conditionalOrdersAbi,
        action: "executeOrder",
        fields: {
          orderId: order.id,
          owner: order.owner,
          market: order.market,
          kind: KIND_LABEL[order.kind as OrderKind],
          trigger: order.triggerPriceE6,
          price: decision.priceE6,
        },
      });
      if (result === undefined) continue;
      if (result.status === "success") {
        this.executed++;
        this.open.delete(order.id);
        this.retry.clear(key);
      } else if (result.status === "dry-run" && result.simulation.ok) {
        this.retry.pause(key, 600);
      } else {
        const sim = result.status === "dry-run" ? result.simulation : undefined;
        const reason =
          sim && !sim.ok
            ? sim.reason
            : result.status === "skipped"
              ? result.reason
              : `execute ${result.status}`;
        const wait = this.retry.fail(key);
        log("order-skip", { orderId: order.id, market: order.market, reason, retryInSeconds: wait });
      }
      if (wentOut(result)) sent++;
    }
    ctx.health.jobInfo(this.name, {
      contract: this.opts.orders,
      orderCount: this.known.toString(),
      open: this.open.size,
      triggered,
      executedByKeeper: this.executed,
    });
    return { sent, due };
  }

  /** New orders since the last cycle, then every watched order's current status. */
  private async refresh(ctx: JobContext): Promise<void> {
    const count = await ctx.client.readContract({
      address: this.opts.orders,
      abi: conditionalOrdersAbi,
      functionName: "orderCount",
    });
    const ids: bigint[] = [...this.open.keys()];
    for (let id = this.known + 1n; id <= count; id++) ids.push(id);
    this.known = count;
    if (ids.length === 0) return;
    const orders = await ctx.client.multicall({
      allowFailure: false,
      batchSize: BATCH_BYTES,
      contracts: ids.map((id) => ({
        address: this.opts.orders,
        abi: conditionalOrdersAbi,
        functionName: "getOrder" as const,
        args: [id] as const,
      })),
    });
    orders.forEach((o, i) => {
      const id = ids[i] as bigint;
      if (o.status !== OrderStatus.Open) {
        this.open.delete(id);
        return;
      }
      this.open.set(id, {
        id,
        owner: getAddress(o.owner),
        market: getAddress(o.market),
        kind: Number(o.kind),
        condition: Number(o.condition),
        triggerPriceE6: Number(o.triggerPriceE6),
        expiry: BigInt(o.expiry),
        status: Number(o.status),
      });
    });
  }

  /** bestBidAsk() of every book with an open order, in one multicall. */
  private async readBooks(
    ctx: JobContext,
    byMarket: Map<Address, MarketSnapshot>,
  ): Promise<Map<Address, YesQuote>> {
    const markets = [...new Set([...this.open.values()].map((o) => o.market))].filter((m) => {
      const book = byMarket.get(m)?.book;
      return book !== undefined && book !== zeroAddress;
    });
    const out = new Map<Address, YesQuote>();
    if (markets.length === 0) return out;
    // A book that cannot be read reads as empty, as BookPrice does.
    if (ctx.deployment.hunchBook.kuruVersion === 2) {
      const results = await ctx.client.multicall({
        allowFailure: true,
        batchSize: BATCH_BYTES,
        contracts: markets.map((m) => ({
          address: byMarket.get(m)?.book as Address,
          abi: kuruV2OrderBookAbi,
          functionName: "bestBidAsk" as const,
        })),
      });
      markets.forEach((m, i) => {
        const r = results[i];
        out.set(
          m,
          r?.status === "success" ? yesQuoteV2(BigInt(r.result[0]), BigInt(r.result[1])) : yesQuote(0n, 0n),
        );
      });
      return out;
    }
    const results = await ctx.client.multicall({
      allowFailure: true,
      batchSize: BATCH_BYTES,
      contracts: markets.map((m) => ({
        address: byMarket.get(m)?.book as Address,
        abi: kuruOrderBookAbi,
        functionName: "bestBidAsk" as const,
      })),
    });
    markets.forEach((m, i) => {
      const r = results[i];
      out.set(m, r?.status === "success" ? yesQuote(r.result[0], r.result[1]) : yesQuote(0n, 0n));
    });
    return out;
  }

  /** Logs a waiting order when the kind of reason changes, not on every price move. */
  private logOnce(ctx: JobContext, order: Watched, event: string, reason: string): void {
    const kind = reason.replace(/\d+/g, "#");
    if (!ctx.verbose && this.lastReason.get(order.id) === kind) return;
    this.lastReason.set(order.id, kind);
    log(event, {
      orderId: order.id,
      market: order.market,
      kind: KIND_LABEL[order.kind as OrderKind],
      reason,
    });
  }
}

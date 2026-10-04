import { autoRedeemerAbi, Phase } from "@hunch-book/shared";
import { type Address, encodeFunctionData, getAddress } from "viem";
import { chunks, halves } from "../batch.js";
import { log } from "../log.js";
import type { MarketSnapshot } from "../markets.js";
import { logWindows } from "../scan.js";
import { accountAddress, bufferedGas, simulate, type TxRequest } from "../tx.js";
import { type CycleJob, type JobContext, type JobRun, wentOut } from "./context.js";

// Auto-redeem (roadmap K-3, docs/PERIPHERY.md#autoredeemer). Holders opt in on the AutoRedeemer once and
// approve it for their outcome tokens. After a graduated market settles or voids, the keeper calls
// `redeemManyFor(market, holders)` and the vault pays each holder directly; the keeper never touches
// the USDC. Who opted in comes from the AutoRedeemer's OptInSet events, scanned forward with a cursor in
// the state file. What each holder can be paid comes from `redeemable(market, holder)`, which already
// accounts for per-market opt-outs, balances and allowances, so only holders with something to redeem
// go into a transaction.

export interface OptInEvent {
  holder: Address;
  optedIn: boolean;
}

/** The opted-in holders after `events`, in order. First-seen order is kept. Pure. */
export function applyOptIns(current: readonly Address[], events: readonly OptInEvent[]): Address[] {
  const out = [...current];
  for (const e of events) {
    const holder = getAddress(e.holder);
    const i = out.indexOf(holder);
    if (e.optedIn && i === -1) out.push(holder);
    if (!e.optedIn && i !== -1) out.splice(i, 1);
  }
  return out;
}

const optInSetEvent = (() => {
  const item = autoRedeemerAbi.find((x) => x.type === "event" && x.name === "OptInSet");
  if (item?.type !== "event") throw new Error("OptInSet is missing from autoRedeemerAbi");
  return item;
})();

/** Log requests the opt-in scan may spend per cycle (out of the cycle's shared scan budget). */
export const SCAN_REQUESTS_PER_CYCLE = 50;

export interface AutoRedeemOptions {
  redeemer: Address;
  /** First block the OptInSet scan reads (the AutoRedeemer's deploy block). */
  fromBlock: number;
  /** Holders per redeemManyFor transaction. */
  batch: number;
  /** A settled market is checked again this often, for holders who opted in or got tokens later. */
  recheckSeconds: number;
}

interface Watched {
  address: Address;
  phase: Phase;
  checkedAt?: number;
  /** The opt-in list version the market was last checked against. */
  version?: number;
}

export class AutoRedeemJob implements CycleJob {
  readonly name = "autoRedeem" as const;
  private readonly watched = new Map<Address, Watched>();
  private version = 0;
  private redeemedHolders = 0;

  constructor(
    private readonly opts: AutoRedeemOptions,
    private readonly clock: () => number = Date.now,
  ) {}

  async run(ctx: JobContext, markets: MarketSnapshot[]): Promise<JobRun> {
    for (const m of markets) {
      const final = m.phase === Phase.Settled || m.phase === Phase.Voided;
      if (final && m.graduated && !this.watched.has(m.address)) {
        this.watched.set(m.address, { address: m.address, phase: m.phase });
      }
    }
    if (await this.scanOptIns(ctx)) this.version++;
    const state = ctx.store.autoRedeem(this.opts.redeemer);
    const holders = state.optedIn;
    const due = [...this.watched.values()].filter(
      (w) =>
        w.checkedAt === undefined ||
        w.version !== this.version ||
        this.clock() - w.checkedAt >= this.opts.recheckSeconds * 1000,
    );
    let sent = 0;
    let dueCount = 0;
    if (holders.length > 0) {
      for (const w of due) {
        const ready = await this.redeemable(ctx, w.address, holders);
        w.checkedAt = this.clock();
        w.version = this.version;
        if (ready.length === 0) continue;
        dueCount++;
        log("auto-redeem-found", { market: w.address, holders: ready.length, optedIn: holders.length });
        for (const batch of chunks(ready, this.opts.batch))
          sent += await this.sendBatch(ctx, w.address, batch);
      }
    } else {
      for (const w of due) {
        w.checkedAt = this.clock();
        w.version = this.version;
      }
    }
    ctx.health.jobInfo(this.name, {
      redeemer: this.opts.redeemer,
      optedIn: holders.length,
      scanCursor: state.cursor,
      settledMarketsWatched: this.watched.size,
      holdersRedeemed: this.redeemedHolders,
    });
    return { sent, due: dueCount };
  }

  /**
   * Reads new OptInSet events into the state file, at most SCAN_REQUESTS_PER_CYCLE log requests a cycle
   * so catching up on a long history never holds up the other jobs. True if the opted-in list changed.
   */
  private async scanOptIns(ctx: JobContext): Promise<boolean> {
    const { redeemer } = this.opts;
    let changed = false;
    let cursor = BigInt(ctx.store.autoRedeem(redeemer).cursor ?? this.opts.fromBlock);
    for (let n = 0; n < SCAN_REQUESTS_PER_CYCLE && cursor <= ctx.scan.head && ctx.scan.budget.take(); n++) {
      const [window] = logWindows(cursor, ctx.scan.head, ctx.scan.range, 1);
      if (!window) break;
      const logs = await ctx.client.getLogs({
        address: redeemer,
        event: optInSetEvent,
        fromBlock: window.from,
        toBlock: window.to,
      });
      const events = logs.flatMap((l) =>
        l.args.holder !== undefined && l.args.optedIn !== undefined
          ? [{ holder: l.args.holder, optedIn: l.args.optedIn }]
          : [],
      );
      ctx.store.updateAutoRedeem(redeemer, (s) => {
        const next = applyOptIns(s.optedIn, events);
        if (next.length !== s.optedIn.length || next.some((h, i) => h !== s.optedIn[i])) changed = true;
        s.optedIn = next;
        s.cursor = Number(window.to + 1n);
      });
      if (events.length > 0) log("opt-ins", { redeemer, events: events.length, block: window.to });
      cursor = window.to + 1n;
    }
    return changed;
  }

  /** The holders with something `redeemFor` would redeem right now, in one multicall. */
  private async redeemable(ctx: JobContext, market: Address, holders: Address[]): Promise<Address[]> {
    const results = await ctx.client.multicall({
      allowFailure: true,
      batchSize: 16_384,
      contracts: holders.map((h) => ({
        address: this.opts.redeemer,
        abi: autoRedeemerAbi,
        functionName: "redeemable" as const,
        args: [market, h] as const,
      })),
    });
    return holders.filter((_, i) => {
      const r = results[i];
      return r?.status === "success" && r.result[0] + r.result[1] > 0n;
    });
  }

  /**
   * One redeemManyFor, with a gas limit at which every holder is really redeemed; halves the batch while
   * that is over the cap.
   */
  private async sendBatch(ctx: JobContext, market: Address, holders: Address[]): Promise<number> {
    const request: TxRequest = {
      to: this.opts.redeemer,
      data: encodeFunctionData({
        abi: autoRedeemerAbi,
        functionName: "redeemManyFor",
        args: [market, holders],
      }),
      abi: autoRedeemerAbi,
      action: "redeemManyFor",
      fields: { market, holders: holders.length },
    };
    const sim = await simulate(ctx.tx, request);
    const need = sim.ok ? await this.gasForAll(ctx, market, holders, sim.gas) : undefined;
    if (holders.length > 1 && need !== undefined && need > ctx.config.maxGasPerTx) {
      log("batch-split", { market, action: "redeemManyFor", holders: holders.length, gasNeeded: need });
      const [a, b] = halves(holders);
      return (await this.sendBatch(ctx, market, a)) + (await this.sendBatch(ctx, market, b));
    }
    if (need !== undefined) {
      request.minGas = need;
      request.fields = { ...request.fields, gasNeeded: need };
    }
    const result = await ctx.send(this.name, market, request);
    if (result?.status === "success") this.redeemedHolders += holders.length;
    return wentOut(result) ? 1 : 0;
  }

  /**
   * redeemManyFor catches each holder's failure, so it succeeds with too little gas: the estimate can be
   * a limit at which the inner redemptions run out of gas and are skipped. This finds a limit at which
   * the call redeems as many holders as it does with all the gas a transaction may have, by calling it
   * (eth_call) at growing limits from the estimate. Undefined when the call cannot be checked.
   */
  private async gasForAll(
    ctx: JobContext,
    market: Address,
    holders: Address[],
    estimate: bigint,
  ): Promise<bigint | undefined> {
    const redeemed = async (gas: bigint): Promise<bigint | undefined> => {
      try {
        const { result } = await ctx.client.simulateContract({
          address: this.opts.redeemer,
          abi: autoRedeemerAbi,
          functionName: "redeemManyFor",
          args: [market, holders],
          account: accountAddress(ctx.tx),
          gas,
        });
        return result[1];
      } catch {
        return undefined;
      }
    };
    const cap = ctx.config.maxGasPerTx;
    const want = await redeemed(cap);
    if (want === undefined) return undefined;
    for (let gas = bufferedGas(estimate); ; gas = (gas * 3n) / 2n) {
      const limit = gas < cap ? gas : cap;
      if ((await redeemed(limit)) === want) return bufferedGas(limit);
      if (limit === cap) return cap;
    }
  }
}

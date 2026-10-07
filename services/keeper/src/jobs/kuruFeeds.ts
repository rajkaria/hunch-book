import { outcomeTokenPriceAdapterFactoryAbi, Phase, Side } from "@hunch-book/shared";
import { type Address, encodeFunctionData, zeroAddress } from "viem";
import type { MarketSnapshot } from "../markets.js";
import type { ChainNow } from "../settlers/index.js";
import { type CycleJob, type JobContext, type JobRun, wentOut } from "./context.js";

// Kuru v2 feeds (docs/PROTOCOL.md §8.1, Kuru v2). Kuru's WithdrawalLimiter prices every token it holds
// through a price source, and Kuru's setup for a market's tokens reads that price at once. So on a Kuru
// v2 stack the keeper creates each open market's YES and NO feeds (OutcomeTokenPriceAdapters from the
// stack's kuruFeedFactory) as soon as the market exists. Creating one is permissionless and deterministic;
// anyone else creating it first is fine (the job only sends for feeds that are still missing). The oracle
// job pokes these markets from creation, so the feeds have history and stay fresh.

export interface KuruFeedOptions {
  /** The stack's kuruFeedFactory. */
  feeds: Address;
}

/** Markets that need feeds: not finished, and not pools that locked without graduating. */
export const needsFeeds = (m: Pick<MarketSnapshot, "phase">) =>
  m.phase === Phase.Pool || m.phase === Phase.Graduated || m.phase === Phase.Closed;

export class KuruFeedsJob implements CycleJob {
  readonly name = "kuruFeeds" as const;

  constructor(private readonly opts: KuruFeedOptions) {}

  async run(ctx: JobContext, markets: MarketSnapshot[], _now: ChainNow): Promise<JobRun> {
    const open = markets.filter(needsFeeds);
    const missing: { market: Address; side: number }[] = [];
    if (open.length > 0) {
      const sides = [Side.Yes, Side.No] as const;
      const existing = await ctx.client.multicall({
        allowFailure: false,
        batchSize: 16_384,
        contracts: open.flatMap((m) =>
          sides.map((side) => ({
            address: this.opts.feeds,
            abi: outcomeTokenPriceAdapterFactoryAbi,
            functionName: "adapterOf" as const,
            args: [m.address, side] as const,
          })),
        ),
      });
      open.forEach((m, i) => {
        sides.forEach((side, j) => {
          if (existing[i * 2 + j] === zeroAddress) missing.push({ market: m.address, side });
        });
      });
    }
    let sent = 0;
    for (const { market, side } of missing) {
      const result = await ctx.send(this.name, market, {
        to: this.opts.feeds,
        data: encodeFunctionData({
          abi: outcomeTokenPriceAdapterFactoryAbi,
          functionName: "createAdapter",
          args: [market, side],
        }),
        abi: outcomeTokenPriceAdapterFactoryAbi,
        action: "createAdapter",
        fields: { market, side: side === Side.Yes ? "yes" : "no" },
      });
      if (wentOut(result)) sent++;
    }
    ctx.health.jobInfo(this.name, {
      feeds: this.opts.feeds,
      openMarkets: open.length,
      missing: missing.length,
    });
    return { sent, due: missing.length };
  }
}

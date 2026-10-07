import { impliedProbabilityOracleAbi, Phase } from "@hunch-book/shared";
import { type Address, encodeFunctionData } from "viem";
import { chunks, halves } from "../batch.js";
import { log } from "../log.js";
import type { MarketSnapshot } from "../markets.js";
import type { ChainNow } from "../settlers/index.js";
import { bufferedGas, simulate } from "../tx.js";
import { type CycleJob, type JobContext, type JobRun, wentOut } from "./context.js";

// Oracle pokes (roadmap V-6, docs/PERIPHERY.md#impliedprobabilityoracle). The ImpliedProbabilityOracle
// records a market's chance only when someone pokes it, and each recorded value holds until the next
// poke. The keeper pokes every market with a live book at most once per KEEPER_ORACLE_POKE_SECONDS, all
// due markets in one `pokeMany` transaction, so the averages lending markets and other apps read stay
// fresh. On a Kuru v2 stack it pokes every open market, pools included, at most once per
// KEEPER_KURU_POKE_SECONDS: Kuru's WithdrawalLimiter reads the market's feeds and refuses a stale price. When a market was last poked comes from the oracle itself (`latest(market).timestamp`), so a
// restart, or a poke by anyone else, counts.

export interface OracleOptions {
  oracle: Address;
  /** Poke a market at most this often. */
  pokeSeconds: number;
  /** Markets per pokeMany transaction. */
  batch: number;
  /**
   * Kuru v2 stacks: poke every open market, pools too. Kuru's WithdrawalLimiter prices YES and NO through
   * feeds built on this oracle, and Kuru sets a market's tokens up (reading the price) before it graduates.
   */
  includePools?: boolean;
}

/** Markets whose last recorded poke is at least `pokeSeconds` old (never poked: due). Pure. */
export function marketsDue(
  markets: readonly { address: Address; lastPoke: bigint }[],
  now: bigint,
  pokeSeconds: number,
): Address[] {
  return markets
    .filter((m) => m.lastPoke === 0n || now - m.lastPoke >= BigInt(pokeSeconds))
    .map((m) => m.address);
}

/** Markets the oracle reads a book for: graduated and not yet settled or voided. */
export const hasLiveBook = (m: Pick<MarketSnapshot, "graduated" | "phase">) =>
  m.graduated && (m.phase === Phase.Graduated || m.phase === Phase.Closed);

/** Kuru v2: markets whose feeds Kuru may read, from creation (pool odds) until settlement. */
export const hasKuruFeed = (m: Pick<MarketSnapshot, "graduated" | "phase">) =>
  m.phase === Phase.Pool || hasLiveBook(m);

export class OraclePokeJob implements CycleJob {
  readonly name = "oracle" as const;
  private lastPokeAt: string | undefined;

  constructor(private readonly opts: OracleOptions) {}

  async run(ctx: JobContext, markets: MarketSnapshot[], now: ChainNow): Promise<JobRun> {
    const live = markets.filter(this.opts.includePools ? hasKuruFeed : hasLiveBook);
    let due: Address[] = [];
    if (live.length > 0) {
      const latest = await ctx.client.multicall({
        allowFailure: false,
        batchSize: 16_384,
        contracts: live.map((m) => ({
          address: this.opts.oracle,
          abi: impliedProbabilityOracleAbi,
          functionName: "latest" as const,
          args: [m.address] as const,
        })),
      });
      due = marketsDue(
        live.map((m, i) => ({ address: m.address, lastPoke: BigInt(latest[i]?.timestamp ?? 0) })),
        now.timestamp,
        this.opts.pokeSeconds,
      );
    }
    let sent = 0;
    for (const batch of chunks(due, this.opts.batch)) sent += await this.poke(ctx, batch);
    ctx.health.jobInfo(this.name, {
      oracle: this.opts.oracle,
      pokeSeconds: this.opts.pokeSeconds,
      liveBooks: live.length,
      due: due.length,
      lastPokeAt: this.lastPokeAt,
    });
    return { sent, due: due.length };
  }

  private async poke(ctx: JobContext, markets: Address[]): Promise<number> {
    const request = {
      to: this.opts.oracle,
      data: encodeFunctionData({
        abi: impliedProbabilityOracleAbi,
        functionName: "pokeMany",
        args: [markets],
      }),
      abi: impliedProbabilityOracleAbi,
      action: "pokeMany",
      fields: { markets },
    };
    if (markets.length > 1) {
      const sim = await simulate(ctx.tx, request);
      if (sim.ok && bufferedGas(sim.gas) > ctx.config.maxGasPerTx) {
        log("batch-split", { action: "pokeMany", markets: markets.length, gasEstimate: sim.gas });
        const [a, b] = halves(markets);
        return (await this.poke(ctx, a)) + (await this.poke(ctx, b));
      }
    }
    const result = await ctx.send(
      this.name,
      markets.length === 1 ? (markets[0] as Address) : "many",
      request,
    );
    if (result?.status === "success") this.lastPokeAt = new Date().toISOString();
    return wentOut(result) ? 1 : 0;
  }
}

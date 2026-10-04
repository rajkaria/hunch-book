import type { Deployment } from "@hunch-book/shared";
import type { PublicClient } from "viem";
import type { Alerter } from "../alerts.js";
import type { KeeperConfig } from "../config.js";
import type { Health, HealthJob } from "../health.js";
import type { MarketMeta, MarketSnapshot } from "../markets.js";
import type { ScanContext } from "../scan.js";
import type { ChainNow } from "../settlers/index.js";
import type { StateStore } from "../state.js";
import type { TxContext, TxRequest, TxResult } from "../tx.js";

// What a cycle-level job (one that looks at every market at once, not one market at a time) gets from
// the keeper: the clients, the health record, the alerter, the state file, and the keeper's own send,
// which simulates first, honours the kill switch and records the result in health.

export interface JobContext {
  config: KeeperConfig;
  deployment: Deployment;
  client: PublicClient;
  tx: TxContext;
  health: Health;
  alerter: Alerter;
  store: StateStore;
  /** Log scans share the cycle's request budget with the staker scans. */
  scan: ScanContext;
  /** The `once` mode: log everything, not only what changed. */
  verbose: boolean;
  /**
   * sendTx with the dry-run repeat filter and the health record. Undefined when filtered.
   * `dryRun` forces a dry run for this call even when sending is on (a job's own kill switch).
   */
  send(
    job: HealthJob,
    label: string,
    request: TxRequest,
    options?: { dryRun?: boolean },
  ): Promise<TxResult | undefined>;
  failed(job: HealthJob, label: string | undefined, error: unknown): void;
  /** Every market the keeper has read from the factory, finished ones included. */
  knownMarkets(): readonly MarketMeta[];
}

export interface JobRun {
  /** Transactions that went out (or, in a dry run, would have). */
  sent: number;
  /** Things the job had to do this cycle (markets to redeem, orders to execute, ...). */
  due: number;
}

export interface CycleJob {
  readonly name: HealthJob;
  run(ctx: JobContext, markets: MarketSnapshot[], now: ChainNow): Promise<JobRun>;
}

/** A transaction went out, or in a dry run would have gone out (its simulation passed). */
export const wentOut = (result: TxResult | undefined): boolean =>
  result !== undefined && (result.status === "dry-run" ? result.simulation.ok : result.status !== "skipped");

/** Per-key backoff: the first wait, doubling up to the longest. */
export class Backoff {
  private readonly next = new Map<string, { at: number; seconds: number }>();

  constructor(
    private readonly firstSeconds: number,
    private readonly maxSeconds: number,
    private readonly clock: () => number = Date.now,
  ) {}

  waiting(key: string): boolean {
    const n = this.next.get(key);
    return n !== undefined && this.clock() < n.at;
  }

  /** Records a failure; returns the wait in seconds. */
  fail(key: string): number {
    const prev = this.next.get(key);
    const seconds = Math.min(prev ? prev.seconds * 2 : this.firstSeconds, this.maxSeconds);
    this.next.set(key, { at: this.clock() + seconds * 1000, seconds });
    return seconds;
  }

  /** Waits `seconds` before the next try, without counting a failure. */
  pause(key: string, seconds: number): void {
    this.next.set(key, { at: this.clock() + seconds * 1000, seconds: this.next.get(key)?.seconds ?? 0 });
  }

  clear(key: string): void {
    this.next.delete(key);
  }
}

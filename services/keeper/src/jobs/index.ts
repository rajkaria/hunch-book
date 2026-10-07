import type { Deployment } from "@hunch-book/shared";
import type { KeeperConfig } from "../config.js";
import { AutoRedeemJob } from "./autoRedeem.js";
import type { CycleJob } from "./context.js";
import { KuruFeedsJob } from "./kuruFeeds.js";
import { OraclePokeJob } from "./oracle.js";
import { ConditionalOrdersJob } from "./orders.js";
import { SeriesJob } from "./series.js";

export type { CycleJob, JobContext, JobRun } from "./context.js";

/**
 * The cycle-level jobs this keeper runs: each periphery job only when its contract is in the
 * deployments file (`hunchBook.periphery`) and it is not switched off with KEEPER_JOBS_OFF; the series
 * job only when KEEPER_SERIES_FILE is set, on the primary stack. On a Kuru v2 stack, also the Kuru feeds
 * job, and oracle pokes for pools.
 */
export function buildCycleJobs(config: KeeperConfig, deployment: Deployment, primary = true): CycleJob[] {
  const periphery = deployment.hunchBook.periphery ?? {};
  const fromBlock = periphery.deployBlock ?? deployment.hunchBook.deployBlock ?? 0;
  const on = (job: Parameters<KeeperConfig["jobsOff"]["has"]>[0]) => !config.jobsOff.has(job);
  const jobs: CycleJob[] = [];
  if (periphery.autoRedeemer && on("autoRedeem")) {
    jobs.push(
      new AutoRedeemJob({
        redeemer: periphery.autoRedeemer,
        fromBlock,
        batch: config.redeemBatch,
        recheckSeconds: config.redeemRecheckSeconds,
      }),
    );
  }
  if (periphery.conditionalOrders && on("orders")) {
    jobs.push(
      new ConditionalOrdersJob({
        orders: periphery.conditionalOrders,
        retrySeconds: config.settleRetrySeconds,
        retryMaxSeconds: config.settleRetryMaxSeconds,
      }),
    );
  }
  const kuruV2 = deployment.hunchBook.kuruVersion === 2;
  if (kuruV2 && periphery.kuruFeedFactory && on("kuruFeeds")) {
    jobs.push(new KuruFeedsJob({ feeds: periphery.kuruFeedFactory }));
  }
  if (periphery.impliedProbabilityOracle && config.oraclePokeSeconds > 0 && on("oracle")) {
    jobs.push(
      new OraclePokeJob({
        oracle: periphery.impliedProbabilityOracle,
        pokeSeconds: kuruV2
          ? Math.min(config.oraclePokeSeconds, config.kuruPokeSeconds)
          : config.oraclePokeSeconds,
        batch: config.oracleBatch,
        includePools: kuruV2,
      }),
    );
  }
  // Series create markets on the primary stack only (one series file, one factory).
  if (config.seriesFile && on("series") && primary) {
    jobs.push(SeriesJob.fromFile(config.seriesFile, { enabled: config.seriesEnabled }));
  }
  return jobs;
}

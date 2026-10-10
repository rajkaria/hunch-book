import {
  chainsByNetwork,
  type Deployment,
  graduatorAbi,
  graduatorV2Abi,
  loadDeployment,
  marketAbi,
  outcomeTokenPriceAdapterFactoryAbi,
  PHASE_LABEL,
  Phase,
  Side,
  type Venue,
  venueOf,
} from "@hunch-book/shared";
import {
  type Account,
  type Address,
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  formatEther,
  http,
  isAddressEqual,
  keccak256,
  type PublicClient,
  parseEther,
  parseGwei,
  zeroAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { kuruRouterComputeAbi, marketWithResolverErrorsAbi, resolverErrorsAbi } from "./abis.js";
import { Alerter } from "./alerts.js";
import { chunks, claimableUsers, halves, uniqueAddresses } from "./batch.js";
import { type KeeperConfig, secretsOf } from "./config.js";
import { Health, type HealthJob, JOBS } from "./health.js";
import { buildCycleJobs, type CycleJob, type JobContext } from "./jobs/index.js";
import { errorMessage, log, setRedactions } from "./log.js";
import { type Globals, MarketDirectory, type MarketSnapshot, readGlobals } from "./markets.js";
import {
  type ActionKind,
  BOOK_PROBLEMS,
  type Decision,
  isFinal,
  needsBookLookup,
  type PredictedBook,
  planMarket,
} from "./plan.js";
import { rateLimitedFetch } from "./rpc.js";
import { ScanBudget, type ScanContext } from "./scan.js";
import { type ChainNow, defaultSettlers, type SettleDeps, type SettlerRegistry } from "./settlers/index.js";
import { IndexerStakerSource, RpcStakerSource, type StakerSource } from "./stakers.js";
import { StateStore } from "./state.js";
import {
  accountAddress,
  bufferedGas,
  sendTx,
  simulate,
  type TxContext,
  type TxRequest,
  type TxResult,
} from "./tx.js";

// The long-running keeper. Each cycle it reads every live market at one block, plans each job with the
// pure functions in plan.ts, and sends what is due through sendTx (which honours the kill switch).
// It only ever calls permissionless functions: graduate, registerBook (Kuru stacks), claimTokensFor,
// settle, voidIfExpired and claimPoolFor. It never holds user funds and never decides an outcome: `settle`
// passes evidence to the market's resolver, which reads the source and answers, or refuses.

/** In dry-run, the same intended transaction is logged again at most this often. */
const DRY_RUN_REPEAT_MS = 10 * 60 * 1000;

/**
 * Log scans stop this many blocks short of the head, so a block whose logs a node has not served yet
 * is never stepped over (about 4 seconds on Monad; it only delays a claim push, never skips one).
 */
const LOG_CONFIRMATIONS = 10n;

/** A transaction went out, or in a dry run would have gone out (its simulation passed). */
const sent = (result: TxResult) =>
  result.status === "dry-run" ? result.simulation.ok : result.status !== "skipped";

export interface KeeperDeps {
  settlers?: SettlerRegistry;
  stakerSource?: StakerSource;
  /** Replaces the cycle-level jobs built from the deployments file and config (jobs/index.ts). */
  cycleJobs?: CycleJob[];
  /** Used for Hermes, the indexer and the alert webhook (tests pass a fake). */
  fetchFn?: typeof fetch;
  /**
   * The stack this keeper works on, when the deployment has several (main.ts runs one keeper each).
   * `series`: this stack is the default one, so it runs the series job (absent: only the primary does).
   * `otherFactories`: the other stacks' factories, which the series job checks for a period's market.
   */
  stack?: { name: string; primary: boolean; series?: boolean; otherFactories?: readonly Address[] };
}

export interface CycleSummary {
  block: bigint;
  markets: number;
  decisions: number;
  sent: number;
  scanRequests: number;
}

interface Retry {
  at: number;
  delaySeconds: number;
}

type RetryKind = "settle" | "prove" | "snapshot";

type BookParams = {
  sizePrecision: bigint;
  pricePrecision: number;
  tickSize: number;
  minSize: bigint;
  takerFeeBps: bigint;
  makerFeeBps: bigint;
  kuruAmmSpread: bigint;
};

export class Keeper {
  readonly deployment: Deployment;
  readonly client: PublicClient;
  readonly tx: TxContext;
  readonly health: Health;
  readonly settlers: SettlerRegistry;
  readonly store: StateStore | undefined;
  private readonly directory: MarketDirectory | undefined;
  private readonly stakerSource: StakerSource | undefined;
  private readonly alerter: Alerter;
  private readonly fetchFn: typeof fetch;
  /** Backoffs per job and market, keyed `${kind}:${market}`. */
  private readonly retries = new Map<string, Retry>();
  /** The last "nothing proves YES yet" reason per market, so a hunt logs only when it changes. */
  private readonly lastProveScan = new Map<Address, string>();
  private readonly lastPlan = new Map<string, string>();
  private readonly dryRunSeen = new Map<string, number>();
  private readonly exhausted = new Set<Address>();
  private readonly unknownTemplates = new Set<number>();
  private bookParamsCache: BookParams | undefined;
  private cycles = 0;
  /** Jobs that look at every market at once (auto-redeem, conditional orders, oracle pokes, series). */
  readonly cycleJobs: CycleJob[];
  /** Log every plan line (the `once` mode), not just the ones that changed. */
  verbosePlan = false;
  /** "primary", or the name of the extra stack this keeper works on. */
  readonly stackName: string;

  /** `deployment` defaults to deployments/<network>.json; tests pass one with their own addresses. */
  constructor(
    readonly config: KeeperConfig,
    deployment: Deployment = loadDeployment(config.network),
    deps: KeeperDeps = {},
  ) {
    setRedactions(secretsOf(config));
    this.deployment = deployment;
    this.fetchFn = deps.fetchFn ?? fetch;
    const chain = chainsByNetwork[config.network];
    const transport = http(config.rpcUrl, {
      retryCount: 5,
      retryDelay: 500,
      timeout: 20_000,
      fetchFn: rateLimitedFetch(config.rpcRequestsPerSecond),
    });
    this.client = createPublicClient({ chain, transport }) as PublicClient;
    const account: Account | Address = config.privateKey
      ? privateKeyToAccount(config.privateKey)
      : this.deployment.wallets.keeper;
    const walletClient =
      typeof account === "string" ? undefined : createWalletClient({ account, chain, transport });
    this.tx = {
      publicClient: this.client,
      walletClient,
      account,
      chain,
      deployment: this.deployment,
      enabled: config.enabled,
      maxGasPriceWei: parseGwei(String(config.maxGasPriceGwei)),
      maxGasPerTx: config.maxGasPerTx,
    };
    this.settlers = deps.settlers ?? defaultSettlers();
    const factory = this.deployment.hunchBook.factory;
    if (factory) {
      this.directory = new MarketDirectory(this.client, factory, config.markets);
      this.store = new StateStore(config.stateFile, config.network, factory);
      const rpcSource = new RpcStakerSource(factory, this.deployment.hunchBook.deployBlock);
      this.stakerSource =
        deps.stakerSource ??
        (config.indexerUrl
          ? new IndexerStakerSource(config.indexerUrl, rpcSource, undefined, this.fetchFn)
          : rpcSource);
    }
    this.stackName = deps.stack?.name ?? "primary";
    this.health = new Health(config.healthFile, {
      network: config.network,
      keeper: accountAddress(this.tx),
      enabled: config.enabled,
      minMon: config.minMon,
      stack: this.stackName,
      kuruVersion: this.kuruVersion,
      venue: this.venue,
    });
    this.alerter = new Alerter(
      config.alertWebhook,
      {
        service: "hunch-book-keeper",
        network: config.network,
        keeper: accountAddress(this.tx),
        enabled: config.enabled,
      },
      config.alertRepeatSeconds,
      this.fetchFn,
    );
    this.cycleJobs =
      deps.cycleJobs ??
      (factory
        ? buildCycleJobs(config, this.deployment, {
            series: deps.stack?.series ?? deps.stack?.primary ?? true,
            otherFactories: deps.stack?.otherFactories,
          })
        : []);
  }

  get keeper(): Address {
    return accountAddress(this.tx);
  }

  /** Warns when the address the keeper runs as is not the one published in deployments/<network>.json. */
  checkPublishedAddress(): void {
    if (!isAddressEqual(this.keeper, this.deployment.wallets.keeper)) {
      log(
        "unpublished-address",
        {
          keeper: this.keeper,
          published: this.deployment.wallets.keeper,
          note: "transactions are only labelled as the keeper's when the address matches wallets.keeper",
        },
        "warn",
      );
    }
  }

  /** One pass over every live market. An error in one market or job never stops the others. */
  async cycle(): Promise<CycleSummary> {
    const started = Date.now();
    const factory = this.deployment.hunchBook.factory;
    if (!this.directory || !this.store || !factory) {
      log(
        "idle",
        { reason: `hunchBook.factory is not in deployments/${this.config.network}.json yet` },
        "warn",
      );
      this.health.update({ lastCycleAt: new Date().toISOString(), lastError: "factory not deployed" });
      return { block: 0n, markets: 0, decisions: 0, sent: 0, scanRequests: 0 };
    }
    const head = await this.client.getBlock();
    const now: ChainNow = { block: head.number, timestamp: head.timestamp };
    const globals = await readGlobals(this.client, factory, now.block, this.kuruVersion, this.venue);
    const markets = await this.directory.refresh(now.block, globals.graduator);
    const runAt = new Date().toISOString();
    // Every job looks at every live market each cycle, even when none has anything for it to do.
    for (const job of JOBS) this.health.jobRan(job, runAt);

    // No stake can land after a block where the market was already past staking.
    for (const m of markets) {
      if (m.phase !== Phase.Pool && this.store.market(m.address).stakingClosedAt === undefined) {
        this.store.update(m.address, (s) => {
          s.stakingClosedAt = Number(now.block);
        });
      }
    }

    const budget = new ScanBudget(this.config.scanRequestsPerCycle);
    const scan: ScanContext = {
      client: this.client,
      store: this.store,
      head: now.block > LOG_CONFIRMATIONS ? now.block - LOG_CONFIRMATIONS : 0n,
      range: this.config.logRange,
      budget,
    };
    const due: Partial<Record<HealthJob, number>> = {};
    let decisions = 0;
    let sent = 0;
    for (const m of markets) {
      const settler = this.settlers.get(m.templateId);
      if (!settler && !this.unknownTemplates.has(m.templateId)) {
        this.unknownTemplates.add(m.templateId);
        log(
          "unknown-template",
          { templateId: m.templateId, market: m.address, note: "no settler; settle skipped" },
          "warn",
        );
      }
      let predictedBook: PredictedBook | undefined;
      if (needsBookLookup(m, globals)) {
        try {
          predictedBook = await this.predictBook(m, globals);
        } catch (error) {
          this.jobFailed("graduate", m.address, error);
        }
      }
      const plan = planMarket({ market: m, now, globals, settler, predictedBook });
      decisions += plan.length;
      let proved = false;
      for (const d of plan) {
        const off = (d.job === "prove" || d.job === "snapshot") && this.config.jobsOff.has(d.job);
        this.logPlan(m, off ? { job: d.job, reason: `switched off by KEEPER_JOBS_OFF (${d.reason})` } : d);
        // A proof that went out settles the market: nothing else for it this cycle.
        if (!d.action || off || (proved && (d.job === "settle" || d.job === "snapshot"))) continue;
        due[d.job] = (due[d.job] ?? 0) + 1;
        try {
          const went = await this.execute(m, d.action, now, globals, scan, predictedBook);
          if (went) sent++;
          if (went && d.action === "prove") proved = true;
        } catch (error) {
          this.jobFailed(d.job, m.address, error);
        }
      }
      if (isFinal(m.phase) && (plan.every((d) => !d.action) || this.exhausted.has(m.address))) {
        this.directory.retire(m.address);
        log("market-done", { market: m.address, phase: PHASE_LABEL[m.phase] });
      }
    }

    // Jobs that look at every market at once: auto-redeem, conditional orders, oracle pokes, series.
    const ctx = this.jobContext(scan);
    for (const job of this.cycleJobs) {
      try {
        const run = await job.run(ctx, markets, now);
        sent += run.sent;
        if (run.due > 0) due[job.name] = (due[job.name] ?? 0) + run.due;
      } catch (error) {
        this.jobFailed(job.name, undefined, error);
      }
    }
    this.store.save();
    this.cycles++;

    const balance = await this.client.getBalance({ address: this.keeper });
    const lowBalance = balance < parseEther(String(this.config.minMon));
    if (lowBalance) {
      const fields = { keeper: this.keeper, balance: formatEther(balance), minimum: this.config.minMon };
      log("low-mon", fields, "warn");
      await this.alerter.send("low-mon", "low-mon", fields, "warn");
    }
    const byPhase: Record<string, number> = {};
    for (const m of markets) byPhase[PHASE_LABEL[m.phase]] = (byPhase[PHASE_LABEL[m.phase]] ?? 0) + 1;
    this.health.setDue(due);
    const summary: CycleSummary = {
      block: now.block,
      markets: markets.length,
      decisions,
      sent,
      scanRequests: this.config.scanRequestsPerCycle - budget.remaining,
    };
    this.health.update({
      cycles: this.cycles,
      lastCycleAt: new Date().toISOString(),
      lastCycleMs: Date.now() - started,
      block: now.block.toString(),
      monBalance: formatEther(balance),
      lowBalance,
      markets: { total: this.directory.known, done: this.directory.retiredCount, byPhase },
      scan: { factoryCursor: this.store.factoryCursor, requestsLastCycle: summary.scanRequests },
    });
    return summary;
  }

  /** What a cycle-level job gets from the keeper (jobs/context.ts). */
  private jobContext(scan: ScanContext): JobContext {
    return {
      config: this.config,
      deployment: this.deployment,
      client: this.client,
      tx: this.tx,
      health: this.health,
      alerter: this.alerter,
      store: scan.store,
      scan,
      verbose: this.verbosePlan,
      send: (job, label, request, options) => this.sendWithResult(job, label, request, options),
      failed: (job, label, error) => this.jobFailed(job, label, error),
      knownMarkets: () => this.directory?.all() ?? [],
    };
  }

  /** Records an error for a job, logs it, and alerts (rate-limited per job and market). */
  jobFailed(job: HealthJob, market: string | undefined, error: unknown): void {
    const message = errorMessage(error);
    log("job-error", { job, market, error: message }, "error");
    this.health.jobError(job, message);
    void this.alerter.send(`error:${job}:${market ?? "-"}`, "job-error", { job, market, error: message });
  }

  private logPlan(m: MarketSnapshot, d: Decision): void {
    const key = `${m.address}:${d.job}`;
    const text = `${d.action ?? "-"}|${d.reason}`;
    if (!this.verbosePlan && this.lastPlan.get(key) === text) return;
    this.lastPlan.set(key, text);
    log("plan", {
      market: m.address,
      template: m.templateId,
      phase: PHASE_LABEL[m.phase],
      job: d.job,
      action: d.action ?? "wait",
      reason: d.reason,
    });
  }

  /** Runs one action. Returns true if a transaction was sent (or, in dry-run, would have been). */
  private async execute(
    m: MarketSnapshot,
    action: ActionKind,
    now: ChainNow,
    globals: Globals,
    scan: ScanContext,
    predictedBook: PredictedBook | undefined,
  ): Promise<boolean> {
    switch (action) {
      case "graduate":
        return this.sendFor("graduate", m.address, {
          to: m.address,
          data: encodeFunctionData({ abi: marketAbi, functionName: "graduate" }),
          abi: marketAbi,
          action: "graduate",
          fields: { market: m.address },
        });
      case "register-book":
        if (!predictedBook) return false;
        return this.sendFor("graduate", m.address, {
          to: globals.graduator,
          data: encodeFunctionData({
            abi: graduatorAbi,
            functionName: "registerBook",
            args: [m.address, predictedBook.address],
          }),
          abi: graduatorAbi,
          action: "registerBook",
          fields: { market: m.address, book: predictedBook.address },
        });
      case "book-request":
        return this.requestBook(m, globals, predictedBook);
      case "claim-tokens":
        return this.pushClaims(m, "tokens", scan);
      case "claim-pool":
        return this.pushClaims(m, "pool", scan);
      case "prove":
        return this.prove(m, now);
      case "snapshot":
        return this.takeSnapshot(m, now);
      case "settle":
        return this.settle(m, now);
      case "void":
        return this.sendFor("void", m.address, {
          to: m.address,
          data: encodeFunctionData({ abi: marketAbi, functionName: "voidIfExpired" }),
          abi: marketAbi,
          action: "voidIfExpired",
          fields: { market: m.address, settleDeadline: m.window.settleDeadline },
        });
    }
  }

  /** sendTx, plus the health record. Returns true if the transaction went out (or would have, in dry-run). */
  private async sendFor(job: HealthJob, market: Address, request: TxRequest): Promise<boolean> {
    const result = await this.sendWithResult(job, market, request);
    return result !== undefined && sent(result);
  }

  /**
   * sendTx with the dry-run repeat filter: in a dry run that keeps running, the same intended
   * transaction is logged once per DRY_RUN_REPEAT_MS, not every cycle. Undefined when filtered.
   * `market` labels the health record: a market address, or what the call is about (a series id).
   */
  async sendWithResult(
    job: HealthJob,
    market: string,
    request: TxRequest,
    options: { dryRun?: boolean } = {},
  ): Promise<TxResult | undefined> {
    const tx = options.dryRun ? { ...this.tx, enabled: false } : this.tx;
    if (!tx.enabled && !this.verbosePlan) {
      const key = `${request.action}:${market}:${keccak256(request.data)}`;
      const last = this.dryRunSeen.get(key);
      if (last !== undefined && Date.now() - last < DRY_RUN_REPEAT_MS) return undefined;
      this.dryRunSeen.set(key, Date.now());
    }
    const result = await sendTx(tx, request);
    this.recordResult(job, market, request.action, result);
    return result;
  }

  private recordResult(job: HealthJob, market: string, action: string, result: TxResult): void {
    const base = { market, action, status: result.status };
    if (result.status === "success" || result.status === "reverted" || result.status === "unknown") {
      this.health.jobAction(job, {
        ...base,
        hash: result.hash,
        url: `${this.deployment.explorer}/tx/${result.hash}`,
      });
    } else {
      this.health.jobAction(job, base);
    }
    if (result.status === "reverted" || result.status === "unknown") {
      this.jobFailed(job, market, new Error(`${action} ${result.status}: ${result.hash}`));
    }
  }

  // ---- settlement ----------------------------------------------------------------------------

  private settleDeps(): SettleDeps {
    return {
      client: this.client,
      deployment: this.deployment,
      pythApiKey: this.config.pythApiKey,
      hermesUrl: this.config.hermesUrl,
      fetchFn: this.fetchFn,
    };
  }

  private waiting(kind: RetryKind, market: Address): boolean {
    const retry = this.retries.get(`${kind}:${market}`);
    return retry !== undefined && Date.now() < retry.at;
  }

  /**
   * Waits before the next attempt: KEEPER_SETTLE_RETRY_SECONDS, doubling up to the max, and never
   * longer than `cap` when the settler gives one (a snapshot window lasts minutes, not hours).
   */
  private backoff(
    market: Address,
    reason: string,
    longest = false,
    kind: RetryKind = "settle",
    cap?: number,
  ): void {
    const key = `${kind}:${market}`;
    const prev = this.retries.get(key);
    const wanted = longest
      ? this.config.settleRetryMaxSeconds
      : Math.min(
          prev ? prev.delaySeconds * 2 : this.config.settleRetrySeconds,
          this.config.settleRetryMaxSeconds,
        );
    const delaySeconds = cap !== undefined ? Math.min(wanted, cap) : wanted;
    this.retries.set(key, { at: Date.now() + delaySeconds * 1000, delaySeconds });
    log(`${kind}-later`, { market, reason, retryInSeconds: delaySeconds }, longest ? "warn" : "info");
    if (!longest && delaySeconds >= this.config.settleRetryMaxSeconds) {
      // Still not going through after the longest wait: worth a person's look (the market voids at its
      // deadline if nothing settles it).
      void this.alerter.send(`${kind}-stuck:${market}`, `${kind}-stuck`, { market, reason }, "warn");
    }
  }

  /** After a dry-run simulation passed: look again only when it would be logged again. */
  private quietDryRun(kind: RetryKind, market: Address): void {
    if (this.verbosePlan) return;
    this.retries.set(`${kind}:${market}`, {
      at: Date.now() + DRY_RUN_REPEAT_MS,
      delaySeconds: DRY_RUN_REPEAT_MS / 1000,
    });
  }

  /** Templates with an early YES: hunt for the proof, and send proveYes(proof) as soon as one exists. */
  private async prove(m: MarketSnapshot, now: ChainNow): Promise<boolean> {
    if (this.waiting("prove", m.address)) return false;
    const settler = this.settlers.get(m.templateId);
    if (!settler?.prover) return false;
    const found = await settler.prover.findProof(m, now, this.settleDeps());
    if (found.status !== "found") {
      const last = this.lastProveScan.get(m.address);
      if (this.verbosePlan || last !== found.reason) {
        this.lastProveScan.set(m.address, found.reason);
        log("prove-scan", { market: m.address, template: m.templateId, result: found.reason });
      }
      return false;
    }
    const request: TxRequest = {
      to: m.address,
      data: encodeFunctionData({ abi: marketAbi, functionName: "proveYes", args: [found.proof] }),
      abi: marketWithResolverErrorsAbi,
      action: "proveYes",
      fields: { market: m.address, template: m.templateId, settler: settler.name, ...found.detail },
    };
    const result = await this.sendWithResult("prove", m.address, request);
    if (result === undefined) return false;
    if (result.status === "success") {
      this.retries.delete(`prove:${m.address}`);
    } else if (result.status === "dry-run") {
      if (result.simulation.ok) this.quietDryRun("prove", m.address);
      else this.proofRejected(m, found.detail, result.simulation.reason);
    } else {
      this.proofRejected(
        m,
        found.detail,
        result.status === "skipped" ? result.reason : `proveYes ${result.status}`,
      );
    }
    return sent(result);
  }

  /** A proof the keeper believes in did not go through: retry later, and tell a person. */
  private proofRejected(m: MarketSnapshot, detail: Record<string, unknown>, reason: string): void {
    this.backoff(m.address, `proveYes would not go through: ${reason}`, false, "prove");
    void this.alerter.send(`proof-rejected:${m.address}`, "proof-rejected", {
      market: m.address,
      reason,
      proof: detail,
      note: "the keeper will not settle NO while it holds a proof of YES; it retries the proof",
    });
  }

  /** Snapshot-settled templates: send the call that records the snapshot the resolver settles from. */
  private async takeSnapshot(m: MarketSnapshot, now: ChainNow): Promise<boolean> {
    if (this.waiting("snapshot", m.address)) return false;
    const settler = this.settlers.get(m.templateId);
    if (!settler?.snapshot) return false;
    const snap = await settler.snapshot.request(m, now, this.settleDeps());
    if (snap.status !== "ready") {
      if (snap.status === "wait") this.backoff(m.address, snap.reason, false, "snapshot");
      else this.retries.set(`snapshot:${m.address}`, { at: Number.POSITIVE_INFINITY, delaySeconds: 0 });
      log("snapshot-skip", { market: m.address, status: snap.status, reason: snap.reason });
      return false;
    }
    const result = await this.sendWithResult("snapshot", m.address, {
      to: snap.to,
      data: snap.data,
      abi: [...(snap.abi as readonly unknown[]), ...resolverErrorsAbi],
      action: "snapshot",
      fields: { market: m.address, template: m.templateId, settler: settler.name, ...snap.detail },
    });
    if (result === undefined) return false;
    if (result.status === "dry-run") {
      if (result.simulation.ok) this.quietDryRun("snapshot", m.address);
      else this.backoff(m.address, `snapshot would revert: ${result.simulation.reason}`, false, "snapshot");
    } else if (result.status !== "success") {
      this.backoff(
        m.address,
        result.status === "skipped" ? result.reason : `snapshot ${result.status}`,
        false,
        "snapshot",
      );
    }
    return sent(result);
  }

  private async settle(m: MarketSnapshot, now: ChainNow): Promise<boolean> {
    if (this.waiting("settle", m.address)) return false;
    const settler = this.settlers.get(m.templateId);
    if (!settler) return false;
    const cap = settler.maxRetrySeconds?.(m, now);
    const evidence = await settler.evidence(m, now, this.settleDeps());
    if (evidence.status !== "ready") {
      const unsettleable = evidence.status === "unsettleable";
      if (unsettleable) {
        await this.alerter.send(
          `unsettleable:${m.address}`,
          "unsettleable",
          {
            market: m.address,
            reason: evidence.reason,
            note: "the resolver will not answer; the market voids after its settlement deadline",
          },
          "warn",
        );
      }
      this.backoff(m.address, evidence.reason, unsettleable, "settle", unsettleable ? undefined : cap);
      return false;
    }
    const request: TxRequest = {
      to: m.address,
      data: encodeFunctionData({ abi: marketAbi, functionName: "settle", args: [evidence.evidence] }),
      value: evidence.value,
      abi: marketWithResolverErrorsAbi,
      action: "settle",
      fields: { market: m.address, template: m.templateId, settler: settler.name, ...evidence.detail },
    };
    const result = await this.sendWithResult("settle", m.address, request);
    if (result === undefined) return false;
    if (result.status === "success") {
      this.retries.delete(`settle:${m.address}`);
    } else if (result.status === "dry-run") {
      if (!result.simulation.ok) {
        this.backoff(m.address, `settle would revert: ${result.simulation.reason}`, false, "settle", cap);
      } else {
        // A dry run that keeps running: fetch the evidence again only when it would be logged again.
        this.quietDryRun("settle", m.address);
      }
    } else {
      // Skipped (the simulation failed, for example NotResolved), reverted, or unknown.
      const reason = result.status === "skipped" ? result.reason : `settle ${result.status}`;
      this.backoff(m.address, reason, false, "settle", cap);
    }
    return sent(result);
  }

  // ---- token claims and pool payouts ------------------------------------------------------------

  private async pushClaims(m: MarketSnapshot, kind: "tokens" | "pool", scan: ScanContext): Promise<boolean> {
    const job: HealthJob = kind === "tokens" ? "claims" : "payouts";
    // Every staker was already checked with a final list: nothing anyone can claim is left.
    if (!this.stakerSource || this.exhausted.has(m.address)) return false;
    const list = await this.stakerSource.stakers(m.address, scan);
    const users = uniqueAddresses(list.users);
    const claimable = users.length ? await this.claimable(m.address, kind, users) : [];
    if (claimable.length === 0) {
      if (list.complete) {
        // Every staker was checked onchain and none has anything left: whatever the market still holds
        // (tokens sent to it by someone else) nobody can claim.
        this.exhausted.add(m.address);
        log(kind === "tokens" ? "claims-done" : "payouts-done", {
          market: m.address,
          stakers: users.length,
          note: "no staker has anything left to claim",
        });
      } else {
        log("claims-waiting", {
          market: m.address,
          kind,
          source: this.stakerSource.name,
          detail: list.detail,
        });
      }
      return false;
    }
    log("claims-found", {
      market: m.address,
      kind,
      claimable: claimable.length,
      stakers: users.length,
      source: this.stakerSource.name,
      detail: list.detail,
    });
    let sent = false;
    for (const batch of chunks(claimable, this.config.claimBatch)) {
      if (await this.sendClaimBatch(job, m.address, kind, batch)) sent = true;
    }
    return sent;
  }

  /** The users with something to claim, read onchain in one multicall. */
  private async claimable(market: Address, kind: "tokens" | "pool", users: Address[]): Promise<Address[]> {
    if (kind === "tokens") {
      const results = await this.client.multicall({
        allowFailure: false,
        batchSize: 16_384,
        contracts: users.map((u) => ({
          address: market,
          abi: marketAbi,
          functionName: "claimableTokens" as const,
          args: [u] as const,
        })),
      });
      return claimableUsers(
        users,
        results.map(([yes, no]) => yes + no),
      );
    }
    const results = await this.client.multicall({
      allowFailure: false,
      batchSize: 16_384,
      contracts: users.map((u) => ({
        address: market,
        abi: marketAbi,
        functionName: "claimablePool" as const,
        args: [u] as const,
      })),
    });
    return claimableUsers(
      users,
      results.map(([paid]) => paid),
    );
  }

  /** One claimTokensFor / claimPoolFor; halves the batch while its gas estimate is over the cap. */
  private async sendClaimBatch(
    job: HealthJob,
    market: Address,
    kind: "tokens" | "pool",
    users: Address[],
  ): Promise<boolean> {
    const functionName = kind === "tokens" ? "claimTokensFor" : "claimPoolFor";
    const request: TxRequest = {
      to: market,
      data: encodeFunctionData({ abi: marketAbi, functionName, args: [users] }),
      abi: marketAbi,
      action: functionName,
      fields: { market, users: users.length },
    };
    if (users.length > 1) {
      const sim = await simulate(this.tx, request);
      if (sim.ok && bufferedGas(sim.gas) > this.config.maxGasPerTx) {
        log("batch-split", { market, action: functionName, users: users.length, gasEstimate: sim.gas });
        const [a, b] = halves(users);
        const sentA = await this.sendClaimBatch(job, market, kind, a);
        const sentB = await this.sendClaimBatch(job, market, kind, b);
        return sentA || sentB;
      }
    }
    return this.sendFor(job, market, request);
  }

  // ---- books on networks where only Kuru can create them (mainnet) ------------------------------

  private async bookParams(graduator: Address): Promise<BookParams> {
    if (!this.bookParamsCache) {
      const p = await this.client.readContract({
        address: graduator,
        abi: graduatorAbi,
        functionName: "bookParams",
      });
      this.bookParamsCache = {
        sizePrecision: BigInt(p.sizePrecision),
        pricePrecision: Number(p.pricePrecision),
        tickSize: Number(p.tickSize),
        minSize: BigInt(p.minSize),
        takerFeeBps: BigInt(p.takerFeeBps),
        makerFeeBps: BigInt(p.makerFeeBps),
        kuruAmmSpread: BigInt(p.kuruAmmSpread),
      };
    }
    return this.bookParamsCache;
  }

  /** This stack's Kuru version (deployments file `kuruVersion`; absent = 1). */
  get kuruVersion(): 1 | 2 {
    return this.deployment.hunchBook.kuruVersion === 2 ? 2 : 1;
  }

  /**
   * Where this stack's books are: "kuru", or "hunch" for Hunch Book's own order book (deployments file
   * `venue`). A Hunch venue speaks Kuru v1's interface and its graduator always creates the book in
   * `graduate()`, so the keeper never asks Kuru for one there.
   */
  get venue(): Venue {
    return venueOf(this.deployment.hunchBook);
  }

  /**
   * Kuru v2: where Kuru's SpotRouter would deploy the book GraduatorV2 asks for, whether it is there, and
   * if so whether GraduatorV2 would accept it (bookProblem).
   */
  private async predictBookV2(m: MarketSnapshot, g: Globals): Promise<PredictedBook> {
    const address = await this.client.readContract({
      address: g.graduator,
      abi: graduatorV2Abi,
      functionName: "predictedBook",
      args: [m.address],
    });
    const code = await this.client.getCode({ address });
    const deployed = code !== undefined && code !== "0x";
    if (!deployed) return { address, deployed };
    const problem = await this.client.readContract({
      address: g.graduator,
      abi: graduatorV2Abi,
      functionName: "bookProblem",
      args: [m.address, address],
    });
    return {
      address,
      deployed,
      problem: { code: problem, text: BOOK_PROBLEMS[problem] ?? `problem ${problem}` },
    };
  }

  /**
   * The address Kuru's deployProxy gives this market's book, and whether a book is already there. Kuru
   * stacks only: needsBookLookup is false on a Hunch venue, whose graduator creates the book itself.
   */
  private async predictBook(m: MarketSnapshot, g: Globals): Promise<PredictedBook> {
    if (this.kuruVersion === 2) return this.predictBookV2(m, g);
    const p = await this.bookParams(g.graduator);
    const address = await this.client.readContract({
      address: this.deployment.external.kuru.router,
      abi: kuruRouterComputeAbi,
      functionName: "computeAddress",
      args: [
        m.yes,
        g.usdc,
        p.sizePrecision,
        p.pricePrecision,
        p.tickSize,
        p.minSize,
        m.caps.poolCap,
        p.takerFeeBps,
        p.makerFeeBps,
        p.kuruAmmSpread,
        zeroAddress,
        false,
      ],
    });
    const code = await this.client.getCode({ address });
    return { address, deployed: code !== undefined && code !== "0x" };
  }

  /**
   * Logs (and posts to the webhook) the exact Kuru deployProxy call that creates this market's book,
   * at most once per KEEPER_BOOK_REQUEST_SECONDS per market. Once Kuru deploys it, the graduate job
   * finds the book at the predicted address and registers it. Never on a Hunch venue: Kuru has no part
   * in those books (plan.ts never asks for one there; this is the second guard).
   */
  private async requestBook(
    m: MarketSnapshot,
    g: Globals,
    predictedBook: PredictedBook | undefined,
  ): Promise<boolean> {
    if (!this.store || this.venue === "hunch") return false;
    const nowSeconds = Math.floor(Date.now() / 1000);
    const last = this.store.market(m.address).bookRequestedAt;
    if (last !== undefined && nowSeconds - last < this.config.bookRequestSeconds) return false;
    const request =
      this.kuruVersion === 2
        ? await this.bookRequestV2(m, g, predictedBook)
        : await this.bookRequestV1(m, g, predictedBook);
    log("book-request", request, "warn");
    await this.alerter.send(`book-request:${m.address}`, "book-request", request, "warn");
    this.store.update(m.address, (s) => {
      s.bookRequestedAt = nowSeconds;
    });
    this.health.jobAction("graduate", { market: m.address, action: "book-request", status: "requested" });
    return true;
  }

  /**
   * Kuru v2: everything Kuru needs for this market (docs/PROTOCOL.md §8.1, Kuru v2): the token setup with
   * the feed for each token, the exact deploySpotMarket call, where the book will land, and what is done.
   */
  private async bookRequestV2(
    m: MarketSnapshot,
    g: Globals,
    predictedBook: PredictedBook | undefined,
  ): Promise<Record<string, unknown>> {
    const r = await this.client.readContract({
      address: g.graduator,
      abi: graduatorV2Abi,
      functionName: "bookRequest",
      args: [m.address],
    });
    // The YES feed's address is fixed before it exists (CREATE2), so the request can name it either way.
    const feeds = this.deployment.hunchBook.periphery?.kuruFeedFactory;
    const yesFeed = feeds
      ? await this.client.readContract({
          address: feeds,
          abi: outcomeTokenPriceAdapterFactoryAbi,
          functionName: "predictAdapter",
          args: [m.address, Side.Yes],
        })
      : undefined;
    const kuru = this.deployment.external.kuruV2;
    return {
      market: m.address,
      network: this.config.network,
      kuru: 2,
      spotRouter: kuru?.spotRouter,
      accountCore: kuru?.accountCore,
      tokenSetup: {
        token: m.yes,
        priceFeed: yesFeed,
        steps:
          "WithdrawalLimiter.setPriceSource (Kuru's price source over priceFeed), AccountCore.configureSpotToken, SpotRouter.whitelistSpotToken",
      },
      call: "deploySpotMarket",
      args: {
        baseToken: r.baseToken,
        quoteToken: r.quoteToken,
        sizePrecision: r.sizePrecision,
        pricePrecision: r.pricePrecision,
        tickSize: r.tickSize,
        passiveSpreadTicks: r.passiveSpreadTicks,
        minQuoteNotional: r.minQuoteNotional,
        maxQuoteNotional: r.maxQuoteNotional,
        takerFeePps: r.takerFeePps,
        makerFeePps: r.makerFeePps,
      },
      expectedBook: predictedBook?.address,
      bookState: predictedBook?.deployed ? (predictedBook.problem?.text ?? "deployed") : "not deployed",
      afterwards: `the keeper registers the book on GraduatorV2 ${g.graduator}, then graduates the market once its pool meets the rule`,
      pool: { yes: m.yesTotal, no: m.noTotal, stakers: m.stakers },
    };
  }

  private async bookRequestV1(
    m: MarketSnapshot,
    g: Globals,
    predictedBook: PredictedBook | undefined,
  ): Promise<Record<string, unknown>> {
    const p = await this.bookParams(g.graduator);
    const request = {
      market: m.address,
      network: this.config.network,
      kuruRouter: this.deployment.external.kuru.router,
      call: "deployProxy",
      args: {
        _type: 0,
        _baseAssetAddress: m.yes,
        _quoteAssetAddress: g.usdc,
        _sizePrecision: p.sizePrecision,
        _pricePrecision: p.pricePrecision,
        _tickSize: p.tickSize,
        _minSize: p.minSize,
        _maxSize: m.caps.poolCap,
        _takerFeeBps: p.takerFeeBps,
        _makerFeeBps: p.makerFeeBps,
        _kuruAmmSpread: p.kuruAmmSpread,
      },
      expectedBook: predictedBook?.address,
      afterwards: `anyone calls registerBook(${m.address}, <book>) on the graduator ${g.graduator}, then graduate() on the market`,
      pool: { yes: m.yesTotal, no: m.noTotal, stakers: m.stakers },
    };
    return request;
  }
}

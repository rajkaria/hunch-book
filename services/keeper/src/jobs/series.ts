import {
  type Deployment,
  hunchBookFactoryAbi,
  marketAbi,
  marketKey,
  Phase,
  perplExchangeAbi,
  priceToE8,
  Side,
  TemplateId,
  testUsdcAbi,
} from "@hunch-book/shared";
import {
  type Address,
  encodeFunctionData,
  erc20Abi,
  formatUnits,
  getAddress,
  type Hex,
  isAddressEqual,
  parseAbi,
  zeroAddress,
} from "viem";
import { log, toJson } from "../log.js";
import { loadSeriesFile, type SeedHolder, type SeriesSpec } from "../series/config.js";
import {
  buildParams,
  median,
  type Now,
  type ParamInputs,
  type Period,
  periodIdentity,
  priceStrike,
  quantile,
  seriesDecision,
  windowDeltas,
} from "../series/schedule.js";
import { chainlinkReader, findBracketingRound } from "../settlers/chainlink.js";
import { perplFundingReader, walkFundingEvents } from "../settlers/fundingEvents.js";
import { accountAddress } from "../tx.js";
import { type CycleJob, type JobContext, type JobRun, wentOut } from "./context.js";

// Recurring series (roadmap K-2, docs/SERIES.md). Each series in KEEPER_SERIES_FILE describes markets that
// repeat on a schedule. When the next period's creation point arrives, the keeper:
// 1. checks the period has no market yet: none of the keeper's own markets has the same template, asset
//    and window, and no stack's factory has a market under the exact params (its canonical key). Series
//    run on the default stack; asking the other stacks' factories too means a period created on another
//    stack before `defaultStack` changed is never created again;
// 2. measures the strike at the creation point (a Chainlink round at or before that time, or Perpl
//    funding at or before that block), so a rerun computes the same params;
// 3. approves the vault for the first stake (and the seed) if needed and calls factory.createMarket with
//    the first stake from its own USDC. The market's creator is the keeper's published address, so the
//    market and its stake are labelled as ours;
// 4. with a `seed` in the series, calls market.stakeFor(holder, side, amount) for each seed stake, paid
//    from the keeper's USDC, for other wallets of ours (the maker, the guardian), so the pool can meet its
//    graduation rule on its own. Each is logged as `series-seed` with `ours: true`. On Monad testnet only,
//    a short balance is first topped up from Hunch Book's open TestUSDC faucet; on mainnet a short
//    balance leaves the market a pool and the keeper says so. A holder that already has stake is never
//    staked again, so a restart between creating and seeding picks up where it stopped.
// Creating spends the keeper's USDC, so it has its own kill switch, KEEPER_SERIES_ENABLED, on top of
// KEEPER_ENABLED. With either off, the job simulates and logs what it would create and seed.

const decimalsAbi = parseAbi(["function decimals() view returns (uint8)"]);

/** In a dry run, a due period is worked out again only this often. */
const DRY_RUN_REPEAT_MS = 10 * 60 * 1000;

/** A seed stake that failed, or could not be paid on mainnet, is tried again no sooner than this. */
export const SEED_RETRY_MS = 30 * 60 * 1000;

/** Hunch Book's TestUSDC faucet gives at most this per call (TestUSDC.FAUCET_LIMIT, 10,000 USDC). */
export const TEST_USDC_FAUCET_LIMIT = 10_000_000_000n;

/** Monad testnet's chain id: the only chain where the keeper mints test USDC. */
const MONAD_TESTNET = 10_143;

/**
 * True only on Monad testnet, for Hunch Book's own TestUSDC from the deployments file: the one token the
 * keeper may mint for itself. Never on mainnet, whose collateral is Circle's USDC.
 */
export function canMintTestUsdc(
  ctx: { deployment: Deployment; tx: { chain: { id: number } } },
  usdc: Address,
): boolean {
  const d = ctx.deployment;
  const test = d.hunchBook.usdc;
  return (
    d.network === "monad-testnet" &&
    d.chainId === MONAD_TESTNET &&
    ctx.tx.chain.id === MONAD_TESTNET &&
    test !== undefined &&
    isAddressEqual(usdc, test) &&
    !(d.external.circleUsdc && isAddressEqual(usdc, d.external.circleUsdc))
  );
}

/** One seed stake with its holder's address. */
interface SeedPlan {
  for: SeedHolder;
  address: Address;
  side: Side;
  amount: bigint;
}

/** One seed stake as the health record shows it. */
export interface SeedStatus {
  for: string;
  address: Address;
  side: "yes" | "no";
  usdc: string;
  /** pending, staked, dry run, or what went wrong. */
  status: string;
  tx?: string;
}

const seedFields = (s: SeedPlan) => ({
  for: s.for,
  address: s.address,
  side: s.side === Side.Yes ? ("yes" as const) : ("no" as const),
  usdc: formatUnits(s.amount, 6),
});

export interface SeriesStatus {
  id: string;
  template: number;
  asset: string;
  enabled: boolean;
  next?: { period: string; lock: string; close: string; createAt: string };
  status: string;
  lastMarket?: string;
  lastTx?: string;
  /** The last market's seed stakes, ours, one per holder. */
  seed?: SeedStatus[];
}

export class SeriesJob implements CycleJob {
  readonly name = "series" as const;
  private readonly status = new Map<string, SeriesStatus>();
  /** Periods this process created or found with a market, so a period is never sent twice. */
  private readonly done = new Set<string>();
  /** Due periods worked out in a dry run: not again until this time. */
  private readonly quietUntil = new Map<string, number>();
  /** Markets whose seed is done (all staked, refused, or past the pool). */
  private readonly seeded = new Set<Address>();
  /** Markets whose seed waits after a failure, a short balance or a dry run: not again until this time. */
  private readonly seedQuietUntil = new Map<Address, number>();
  private readonly lastLogged = new Map<string, string>();

  constructor(
    private readonly specs: SeriesSpec[],
    private readonly opts: { enabled: boolean; file?: string; otherFactories?: readonly Address[] },
    private readonly clock: () => number = Date.now,
  ) {
    for (const s of specs) {
      this.status.set(s.id, {
        id: s.id,
        template: s.templateId,
        asset: s.asset,
        enabled: s.enabled,
        status: "starting",
      });
    }
  }

  static fromFile(path: string, opts: { enabled: boolean; otherFactories?: readonly Address[] }): SeriesJob {
    return new SeriesJob(loadSeriesFile(path), { ...opts, file: path });
  }

  async run(ctx: JobContext, _markets: unknown, now: Now): Promise<JobRun> {
    let sent = 0;
    let due = 0;
    for (const spec of this.specs) {
      try {
        const r = await this.runOne(ctx, spec, now);
        sent += r.sent;
        due += r.due;
      } catch (error) {
        this.set(spec, { status: `error: ${error instanceof Error ? error.message : String(error)}` });
        ctx.failed(this.name, spec.id, error);
      }
    }
    ctx.health.jobInfo(this.name, {
      file: this.opts.file,
      creating:
        this.opts.enabled && ctx.tx.enabled
          ? "on"
          : "dry run: KEEPER_SERIES_ENABLED and KEEPER_ENABLED must both be on to create markets",
      series: [...this.status.values()],
    });
    return { sent, due };
  }

  private set(spec: SeriesSpec, patch: Partial<SeriesStatus>): void {
    this.status.set(spec.id, { ...(this.status.get(spec.id) as SeriesStatus), ...patch });
  }

  /** Logs a series line when what it says changes (every line in the `once` mode). */
  private logChange(ctx: JobContext, spec: SeriesSpec, event: string, fields: Record<string, unknown>): void {
    const key = `${event}:${toJson(fields)}`;
    if (!ctx.verbose && this.lastLogged.get(spec.id) === key) return;
    this.lastLogged.set(spec.id, key);
    log(event, { series: spec.id, ...fields });
  }

  private async runOne(ctx: JobContext, spec: SeriesSpec, now: Now): Promise<JobRun> {
    const decision = seriesDecision(spec, now);
    const p = decision.period;
    this.set(spec, {
      next: {
        period: p.index.toString(),
        lock: p.lock.toString(),
        close: p.close.toString(),
        createAt: p.createAt.toString(),
      },
    });
    const periodKey = `${spec.id}:${p.index}`;
    if (!decision.due) {
      this.set(spec, { status: decision.reason });
      this.logChange(ctx, spec, "series-wait", { reason: decision.reason });
      return { sent: 0, due: 0 };
    }
    if (this.done.has(periodKey)) return { sent: 0, due: 0 };
    const dryRun = !this.opts.enabled;

    // 1. Does this period have a market of ours already? (The identity does not depend on the strike.)
    const keeper = accountAddress(ctx.tx);
    const identity = periodIdentity(spec.templateId, buildParams(spec, p, this.placeholder(ctx, spec)));
    const existing = ctx
      .knownMarkets()
      .find(
        (m) =>
          isAddressEqual(m.creator, keeper) &&
          m.templateId === spec.templateId &&
          periodIdentity(m.templateId, m.params) === identity,
      );
    if (existing) {
      this.set(spec, { status: `period ${p.index} has its market`, lastMarket: existing.address });
      this.logChange(ctx, spec, "series-exists", { period: p.index, market: existing.address });
      // A restart between creating the market and seeding it: seed what is missing (stakeOf says what).
      if (spec.seed) {
        const seeded = await this.seed(ctx, spec, existing.address, dryRun);
        if (!seeded.finished) return { sent: seeded.sent, due: seeded.due };
        this.done.add(periodKey);
        return { sent: seeded.sent, due: 0 };
      }
      this.done.add(periodKey);
      return { sent: 0, due: 0 };
    }
    if ((this.quietUntil.get(periodKey) ?? 0) > this.clock()) return { sent: 0, due: 1 };
    const factory = ctx.deployment.hunchBook.factory as Address;
    const inputs = await this.inputs(ctx, spec, p);
    const params = buildParams(spec, p, inputs);
    const key = marketKey(spec.templateId, params);
    const byKey = await ctx.client.readContract({
      address: factory,
      abi: hunchBookFactoryAbi,
      functionName: "marketOf",
      args: [key],
    });
    if (!isAddressEqual(byKey, zeroAddress)) {
      this.set(spec, {
        status: `period ${p.index}: a market with these exact params exists`,
        lastMarket: byKey,
      });
      this.logChange(ctx, spec, "series-exists", { period: p.index, market: byKey, note: "same params" });
      // Ours, but not in the directory yet (it was created moments ago): seed what is missing.
      if (spec.seed) {
        const creator = await ctx.client.readContract({
          address: byKey,
          abi: marketAbi,
          functionName: "creator",
        });
        if (isAddressEqual(creator, keeper)) {
          const seeded = await this.seed(ctx, spec, getAddress(byKey), dryRun);
          if (!seeded.finished) return { sent: seeded.sent, due: seeded.due };
          this.done.add(periodKey);
          return { sent: seeded.sent, due: 0 };
        }
      }
      this.done.add(periodKey);
      return { sent: 0, due: 0 };
    }
    const elsewhere = await this.onOtherStack(ctx, key);
    if (elsewhere) {
      this.done.add(periodKey);
      this.set(spec, {
        status: `period ${p.index}: a market with these exact params exists on another stack`,
        lastMarket: elsewhere.market,
      });
      this.logChange(ctx, spec, "series-exists", {
        period: p.index,
        market: elsewhere.market,
        factory: elsewhere.factory,
        note: "same params, on another stack",
      });
      return { sent: 0, due: 0 };
    }

    // 2. Funds: the first stake (and the seed, when the series has one) comes from the keeper's own USDC.
    const seeds = this.seedPlan(ctx, spec);
    const usdc = ctx.deployment.hunchBook.usdc as Address;
    const vault = ctx.deployment.hunchBook.vault as Address;
    const [heldUsdc, allowance, paused] = await ctx.client.multicall({
      allowFailure: false,
      contracts: [
        { address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [keeper] },
        { address: usdc, abi: erc20Abi, functionName: "allowance", args: [keeper, vault] },
        { address: factory, abi: hunchBookFactoryAbi, functionName: "creationPaused" },
      ],
    });
    let balance = heldUsdc;
    const stake = spec.firstStake.amount;
    const seedTotal = seeds.reduce((sum, s) => sum + s.amount, 0n);
    const need = stake + seedTotal;
    const fields = {
      period: p.index,
      template: spec.templateId,
      asset: spec.asset,
      lock: p.lock,
      close: p.close,
      firstStake: formatUnits(stake, 6),
      side: spec.firstStake.side === Side.Yes ? "yes" : "no",
      ...(seeds.length > 0 ? { seed: seeds.map(seedFields) } : {}),
      ...inputs,
    };
    if (paused) {
      this.set(spec, { status: "market creation is paused by the guardian" });
      this.logChange(ctx, spec, "series-paused", { period: p.index });
      return { sent: 0, due: 1 };
    }
    let sent = 0;
    if (balance < need && seeds.length > 0 && canMintTestUsdc(ctx, usdc)) {
      // Testnet only: the stakes are our own test USDC, from Hunch Book's open TestUSDC faucet.
      const minted = await this.mintTestUsdc(ctx, spec, usdc, keeper, need - balance, dryRun);
      sent += minted.sent;
      if (!minted.ok) {
        this.quiet(periodKey, undefined);
        this.set(spec, {
          status: `period ${p.index} is due: mint ${formatUnits(need - balance, 6)} test USDC, then create and seed`,
        });
        this.logChange(ctx, spec, "series-would-create", { ...fields, note: "after minting test USDC" });
        return { sent, due: 1 };
      }
      balance = need;
    }
    if (balance < stake) {
      const status = `needs ${formatUnits(stake, 6)} USDC for the first stake, holds ${formatUnits(balance, 6)}`;
      this.set(spec, { status });
      this.logChange(ctx, spec, "series-unfunded", { period: p.index, balance: formatUnits(balance, 6) });
      await ctx.alerter.send(
        `series-unfunded:${spec.id}`,
        "series-unfunded",
        { series: spec.id, ...fields, balance: formatUnits(balance, 6) },
        "warn",
      );
      return { sent, due: 1 };
    }
    // One approval covers the first stake and the seed (the vault pulls both from the keeper).
    if (allowance < need) {
      const approve = await this.approveVault(ctx, spec, usdc, vault, need, "approveFirstStake", dryRun);
      if (wentOut(approve)) sent++;
      if (approve?.status !== "success") {
        // createMarket needs the approval to have landed: say what would happen, and stop here.
        this.quiet(periodKey, approve);
        this.set(spec, {
          status: `period ${p.index} is due: approve ${formatUnits(need, 6)} USDC for the vault, then create`,
        });
        this.logChange(ctx, spec, "series-would-create", { ...fields, note: "after the approval" });
        return { sent, due: 1 };
      }
    }

    // 3. Create the market with the first stake.
    const result = await ctx.send(
      this.name,
      spec.id,
      {
        to: factory,
        data: encodeFunctionData({
          abi: hunchBookFactoryAbi,
          functionName: "createMarket",
          args: [spec.templateId, params, spec.firstStake.side, stake],
        }),
        abi: hunchBookFactoryAbi,
        action: "createMarket",
        fields: { series: spec.id, ...fields, key },
      },
      { dryRun },
    );
    if (wentOut(result)) sent++;
    if (result?.status === "success") {
      const created = getAddress(
        await ctx.client.readContract({
          address: factory,
          abi: hunchBookFactoryAbi,
          functionName: "marketOf",
          args: [key],
        }),
      );
      this.set(spec, { status: `created period ${p.index}`, lastMarket: created, lastTx: result.hash });
      log("series-created", {
        series: spec.id,
        ...fields,
        market: created,
        hash: result.hash,
        url: `${ctx.deployment.explorer}/tx/${result.hash}`,
      });
      // 4. Seed it, so the pool can meet its graduation rule on its own.
      if (spec.seed) {
        const seeded = await this.seed(ctx, spec, created, dryRun);
        sent += seeded.sent;
        if (!seeded.finished) return { sent, due: 1 };
      }
      this.done.add(periodKey);
    } else if (result?.status === "dry-run") {
      this.quiet(periodKey, result);
      this.set(spec, {
        status: result.simulation.ok
          ? `period ${p.index} is due: a dry run, so not created${seeds.length > 0 ? " or seeded" : ""}`
          : `period ${p.index} is due: createMarket would revert: ${result.simulation.reason}`,
      });
      if (seeds.length > 0) {
        this.logChange(ctx, spec, "series-would-seed", { period: p.index, seed: seeds.map(seedFields) });
      }
    } else if (result) {
      const reason = result.status === "skipped" || result.status === "unknown" ? `: ${result.reason}` : "";
      this.set(spec, { status: `period ${p.index}: createMarket ${result.status}${reason}` });
    }
    return { sent, due: 1 };
  }

  // ---------------------------------------------------------------- seeding

  /**
   * The series' seed stakes with each holder's address: "maker" from `wallets.maker`, "guardian" from the
   * stack's guardian. Throws (and the series reports the error) when a holder has no address, is the
   * keeper itself, or appears twice once resolved.
   */
  private seedPlan(ctx: JobContext, spec: SeriesSpec): SeedPlan[] {
    const keeper = accountAddress(ctx.tx);
    const out: SeedPlan[] = [];
    for (const s of spec.seed?.stakes ?? []) {
      const address =
        s.for === "maker"
          ? ctx.deployment.wallets.maker
          : s.for === "guardian"
            ? ctx.deployment.hunchBook.guardian
            : s.for;
      if (!address)
        throw new Error(`seed for "${s.for}": this stack has no guardian in the deployments file`);
      if (isAddressEqual(address, keeper)) {
        throw new Error(`seed for "${s.for}" is the keeper's own address, whose stake is firstStake`);
      }
      if (out.some((o) => isAddressEqual(o.address, address))) {
        throw new Error(
          `seed names ${getAddress(address)} twice: every seed stake is for a different wallet`,
        );
      }
      out.push({ for: s.for, address: getAddress(address), side: s.side, amount: s.amount });
    }
    return out;
  }

  /**
   * Stakes every seed stake the market does not have yet: `market.stakeFor(holder, side, amount)`, paid
   * from the keeper's USDC (on testnet, minted from the TestUSDC faucet when short). Restart-safe: a
   * holder that already has stake in the market is never staked again. A stake that fails, or a short
   * balance on mainnet, leaves the market a pool and waits SEED_RETRY_MS before trying again.
   * `finished`: nothing is left to do for this market's seed (all staked, refused, or past the pool).
   */
  private async seed(
    ctx: JobContext,
    spec: SeriesSpec,
    market: Address,
    dryRun: boolean,
  ): Promise<{ sent: number; due: number; finished: boolean }> {
    if (this.seeded.has(market)) return { sent: 0, due: 0, finished: true };
    if ((this.seedQuietUntil.get(market) ?? 0) > this.clock()) return { sent: 0, due: 1, finished: false };
    let sent = 0;
    const finish = (status: string, seed: SeedStatus[]) => {
      this.seeded.add(market);
      this.set(spec, { status, seed });
      return { sent, due: 0, finished: true };
    };
    const wait = (status: string, seed: SeedStatus[], retryMs = SEED_RETRY_MS) => {
      this.seedQuietUntil.set(market, this.clock() + retryMs);
      this.set(spec, { status, seed });
      return { sent, due: 1, finished: false };
    };
    const seeds = this.seedPlan(ctx, spec);
    const keeper = accountAddress(ctx.tx);
    const usdc = ctx.deployment.hunchBook.usdc as Address;
    const vault = ctx.deployment.hunchBook.vault as Address;
    const [phaseRead, caps, totals, heldUsdc, allowance] = await ctx.client.multicall({
      allowFailure: false,
      contracts: [
        { address: market, abi: marketAbi, functionName: "phase" },
        { address: market, abi: marketAbi, functionName: "caps" },
        { address: market, abi: marketAbi, functionName: "poolTotals" },
        { address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [keeper] },
        { address: usdc, abi: erc20Abi, functionName: "allowance", args: [keeper, vault] },
      ],
    });
    const stakes = await ctx.client.multicall({
      allowFailure: false,
      contracts: seeds.map((s) => ({
        address: market,
        abi: marketAbi,
        functionName: "stakeOf" as const,
        args: [s.address] as const,
      })),
    });
    const phase = Number(phaseRead);
    const held = stakes.map(([yes, no]) => yes + no);
    const statuses: SeedStatus[] = seeds.map((s, i) => ({
      ...seedFields(s),
      status: (held[i] as bigint) > 0n ? "staked" : "pending",
    }));
    const pending = seeds.filter((_, i) => held[i] === 0n);
    if (pending.length === 0) {
      this.logChange(ctx, spec, "series-seeded", { market, seed: statuses });
      return finish(`market ${market} is seeded`, statuses);
    }
    if (phase !== Phase.Pool) {
      log("series-seed-skipped", { series: spec.id, market, reason: "the market is no longer a pool" });
      return finish(`seed skipped: market ${market} is no longer a pool`, statuses);
    }

    // The market's own caps: every stake at least minStake and within walletCap, the pool within poolCap.
    const pendingTotal = pending.reduce((sum, s) => sum + s.amount, 0n);
    const problem =
      pending.find((s) => s.amount < caps.minStake) !== undefined
        ? `a seed stake is below the market's minimum stake of ${formatUnits(caps.minStake, 6)} USDC`
        : pending.find((s) => s.amount > caps.walletCap) !== undefined
          ? `a seed stake is above the market's wallet cap of ${formatUnits(caps.walletCap, 6)} USDC`
          : totals[0] + totals[1] + pendingTotal > caps.poolCap
            ? `the seed would take the pool past its cap of ${formatUnits(caps.poolCap, 6)} USDC`
            : undefined;
    if (problem) {
      log("series-seed-invalid", { series: spec.id, market, reason: problem }, "warn");
      await ctx.alerter.send(
        `series-seed-invalid:${spec.id}`,
        "series-seed-invalid",
        { series: spec.id, market, reason: problem, note: "the market stays a pool; fix the series file" },
        "warn",
      );
      return finish(`seed refused: ${problem}`, statuses);
    }

    if (heldUsdc < pendingTotal) {
      if (!canMintTestUsdc(ctx, usdc)) {
        const reason = `needs ${formatUnits(pendingTotal, 6)} USDC for the seed, holds ${formatUnits(heldUsdc, 6)}`;
        log("series-seed-unfunded", { series: spec.id, market, reason }, "warn");
        await ctx.alerter.send(
          `series-seed-unfunded:${spec.id}`,
          "series-seed-unfunded",
          {
            series: spec.id,
            market,
            reason,
            note: "the market stays a pool until the keeper holds the seed",
          },
          "warn",
        );
        return wait(`seed waiting: ${reason}`, statuses);
      }
      const short = pendingTotal - heldUsdc;
      const minted = await this.mintTestUsdc(ctx, spec, usdc, keeper, short, dryRun);
      sent += minted.sent;
      if (!minted.ok) {
        return wait(
          `seed waiting: mint ${formatUnits(short, 6)} test USDC first`,
          statuses,
          dryRun || !ctx.tx.enabled ? DRY_RUN_REPEAT_MS : SEED_RETRY_MS,
        );
      }
    }
    if (allowance < pendingTotal) {
      const approve = await this.approveVault(ctx, spec, usdc, vault, pendingTotal, "approveSeed", dryRun);
      if (wentOut(approve)) sent++;
      if (approve?.status !== "success") {
        const dry = approve === undefined || approve.status === "dry-run";
        return wait(
          `seed waiting: approve ${formatUnits(pendingTotal, 6)} USDC for the vault first`,
          statuses,
          dry ? DRY_RUN_REPEAT_MS : SEED_RETRY_MS,
        );
      }
    }

    for (const s of pending) {
      const status = statuses.find((x) => isAddressEqual(x.address, s.address)) as SeedStatus;
      const result = await ctx.send(
        this.name,
        spec.id,
        {
          to: market,
          data: encodeFunctionData({
            abi: marketAbi,
            functionName: "stakeFor",
            args: [s.address, s.side, s.amount],
          }),
          abi: marketAbi,
          action: "seedStake",
          fields: { series: spec.id, market, ...seedFields(s), ours: true },
        },
        { dryRun },
      );
      if (wentOut(result)) sent++;
      if (result?.status === "success") {
        status.status = "staked";
        status.tx = result.hash;
        log("series-seed", {
          series: spec.id,
          market,
          ...seedFields(s),
          ours: true,
          note: "our own stake, paid from the keeper's USDC",
          hash: result.hash,
          url: `${ctx.deployment.explorer}/tx/${result.hash}`,
        });
        continue;
      }
      if (result === undefined || result.status === "dry-run") {
        status.status = "dry run";
        continue;
      }
      const reason = result.status === "skipped" || result.status === "unknown" ? result.reason : result.hash;
      status.status = `${result.status}: ${reason}`;
      log(
        "series-seed-failed",
        { series: spec.id, market, ...seedFields(s), status: result.status, reason },
        "warn",
      );
      await ctx.alerter.send(
        `series-seed-failed:${spec.id}`,
        "series-seed-failed",
        { series: spec.id, market, ...seedFields(s), status: result.status, reason },
        "warn",
      );
      return wait(`seed stake for ${s.for} ${result.status}; the market stays a pool for now`, statuses);
    }
    if (statuses.some((s) => s.status === "dry run")) {
      return wait(`seed of market ${market}: a dry run, so not staked`, statuses, DRY_RUN_REPEAT_MS);
    }
    return finish(`market ${market} is seeded`, statuses);
  }

  /** TestUSDC.mint(keeper, amount), in faucet-sized calls. Testnet only (canMintTestUsdc). */
  private async mintTestUsdc(
    ctx: JobContext,
    spec: SeriesSpec,
    usdc: Address,
    keeper: Address,
    amount: bigint,
    dryRun: boolean,
  ): Promise<{ ok: boolean; sent: number }> {
    let left = amount;
    let sent = 0;
    while (left > 0n) {
      const chunk = left > TEST_USDC_FAUCET_LIMIT ? TEST_USDC_FAUCET_LIMIT : left;
      const result = await ctx.send(
        this.name,
        spec.id,
        {
          to: usdc,
          data: encodeFunctionData({ abi: testUsdcAbi, functionName: "mint", args: [keeper, chunk] }),
          abi: testUsdcAbi,
          action: "mintTestUsdc",
          fields: {
            series: spec.id,
            to: keeper,
            amount: formatUnits(chunk, 6),
            ours: true,
            note: "testnet only: test USDC from the open faucet, for our own series stakes",
          },
        },
        { dryRun },
      );
      if (wentOut(result)) sent++;
      if (result?.status !== "success") return { ok: false, sent };
      left -= chunk;
    }
    return { ok: true, sent };
  }

  /** approve(vault, amount) for the first stake and the seed: the vault pulls both from the keeper. */
  private approveVault(
    ctx: JobContext,
    spec: SeriesSpec,
    usdc: Address,
    vault: Address,
    amount: bigint,
    action: string,
    dryRun: boolean,
  ) {
    return ctx.send(
      this.name,
      spec.id,
      {
        to: usdc,
        data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [vault, amount] }),
        abi: erc20Abi,
        action,
        fields: { series: spec.id, spender: vault, amount },
      },
      { dryRun },
    );
  }

  /**
   * The market another stack's factory has under `key`, if any. A factory that does not answer stops the
   * creation for this cycle (it throws): a period is never created while a stack that may hold it is unread.
   */
  private async onOtherStack(
    ctx: JobContext,
    key: Hex,
  ): Promise<{ factory: Address; market: Address } | undefined> {
    const factories = this.opts.otherFactories ?? [];
    if (factories.length === 0) return undefined;
    const found = await ctx.client.multicall({
      allowFailure: false,
      contracts: factories.map((address) => ({
        address,
        abi: hunchBookFactoryAbi,
        functionName: "marketOf" as const,
        args: [key] as const,
      })),
    });
    const at = found.findIndex((m) => !isAddressEqual(m, zeroAddress));
    return at < 0
      ? undefined
      : { factory: factories[at] as Address, market: getAddress(found[at] as Address) };
  }

  /** After a dry run, work the same period out again only after a while. */
  private quiet(periodKey: string, result: unknown): void {
    if (result === undefined || (result as { status?: string }).status === "dry-run") {
      this.quietUntil.set(periodKey, this.clock() + DRY_RUN_REPEAT_MS);
    }
  }

  /** Inputs with placeholder strikes: enough for the period's identity, which ignores the strike. */
  private placeholder(ctx: JobContext, spec: SeriesSpec): ParamInputs {
    const ext = ctx.deployment.external;
    if (spec.templateId === TemplateId.PerplFunding || spec.templateId === TemplateId.PerplFundingSpike) {
      return { perpId: BigInt(this.perp(ctx, spec)), scalingExp: 0, threshold: 0n };
    }
    const feed = ext.chainlink[spec.asset] ?? zeroAddress;
    return {
      feed,
      strike: spec.templateId === TemplateId.PriceRange ? { lowerE8: 1n, upperE8: 2n } : { strikeE8: 1n },
    };
  }

  private perp(ctx: JobContext, spec: SeriesSpec): number {
    const perp = ctx.deployment.external.perpl.perps[spec.asset];
    if (perp === undefined) {
      throw new Error(`no Perpl perp "${spec.asset}" in deployments/${ctx.deployment.network}.json`);
    }
    return perp;
  }

  /** Reads what the params need, measured at the period's creation point. */
  private async inputs(ctx: JobContext, spec: SeriesSpec, p: Period): Promise<ParamInputs> {
    const ext = ctx.deployment.external;
    if (spec.templateId === TemplateId.PerplFunding || spec.templateId === TemplateId.PerplFundingSpike) {
      const perpId = BigInt(this.perp(ctx, spec));
      const exchange = ext.perpl.exchange;
      const info = await ctx.client.readContract({
        address: exchange,
        abi: perplExchangeAbi,
        functionName: "getPerpetualInfoV2",
        args: [perpId],
      });
      const threshold = await this.fundingThreshold(ctx, spec, p, exchange, perpId);
      return { perpId, scalingExp: Number(info.fundingSumScalingExp), threshold };
    }
    const feed = ext.chainlink[spec.asset];
    if (!feed)
      throw new Error(`no Chainlink feed "${spec.asset}" in deployments/${ctx.deployment.network}.json`);
    if (spec.strike.rule === "fixed") return { feed, strike: { strikeE8: spec.strike.value } };
    const spotE8 = await this.spotAt(ctx, feed, p.createAt);
    return { feed, strike: priceStrike(spec.strike, spotE8, spec.direction) };
  }

  /** The Chainlink price (8 decimals) of the last round updated at or before `time`. */
  private async spotAt(ctx: JobContext, feed: Address, time: bigint): Promise<bigint> {
    const reader = chainlinkReader(ctx.client, feed);
    const found = await findBracketingRound(reader, time, 2n ** 63n);
    // No round after `time` yet: the latest round is the last one at or before it.
    const round =
      found.status === "found" ? found.round : found.status === "wait" ? await reader.latest() : undefined;
    if (!round || round.updatedAt > time || round.answer <= 0n) {
      throw new Error(`no positive Chainlink round at or before ${time} on ${feed}`);
    }
    const decimals = await ctx.client.readContract({
      address: feed,
      abi: decimalsAbi,
      functionName: "decimals",
    });
    return priceToE8(round.answer, -Number(decimals));
  }

  private async fundingThreshold(
    ctx: JobContext,
    spec: SeriesSpec,
    p: Period,
    exchange: Address,
    perpId: bigint,
  ): Promise<bigint> {
    const rule = spec.strike;
    if (rule.rule === "fixed") return rule.value;
    if (spec.schedule.clock !== "block") throw new Error("funding series run on a block clock");
    const reader = perplFundingReader(ctx.client, exchange, perpId);
    if (rule.rule === "trailing-median-funding") {
      const w = spec.schedule.windowBlocks;
      const blocks = Array.from({ length: rule.windows + 1 }, (_, j) => p.createAt - BigInt(j) * w);
      if ((blocks.at(-1) as bigint) <= 0n) throw new Error("not enough history before the creation point");
      const sums = await reader.sums(blocks);
      return median(windowDeltas(sums.map((s) => s.sum)));
    }
    if (rule.rule === "funding-increment-quantile") {
      const interval = await ctx.client.readContract({
        address: exchange,
        abi: perplExchangeAbi,
        functionName: "getFundingInterval",
      });
      const walk = await walkFundingEvents(reader, {
        after: p.createAt - BigInt(rule.intervals) * interval,
        upTo: p.createAt,
        interval,
      });
      const increments = walk.events.filter((e) => e.singleInterval).map((e) => e.increment);
      if (increments.length < 10) {
        throw new Error(`only ${increments.length} funding events before the creation point`);
      }
      return quantile(increments, rule.q);
    }
    throw new Error(`strike rule ${rule.rule} does not fit a funding series`);
  }
}

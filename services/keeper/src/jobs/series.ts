import {
  hunchBookFactoryAbi,
  marketKey,
  perplExchangeAbi,
  priceToE8,
  Side,
  TemplateId,
} from "@hunch-book/shared";
import {
  type Address,
  encodeFunctionData,
  erc20Abi,
  formatUnits,
  getAddress,
  isAddressEqual,
  parseAbi,
  zeroAddress,
} from "viem";
import { log, toJson } from "../log.js";
import { loadSeriesFile, type SeriesSpec } from "../series/config.js";
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
//    and window, and the factory has no market under the exact params (its canonical key);
// 2. measures the strike at the creation point (a Chainlink round at or before that time, or Perpl
//    funding at or before that block), so a rerun computes the same params;
// 3. approves the vault for the first stake if needed and calls factory.createMarket with the first
//    stake from its own USDC. The market's creator is the keeper's published address, so the market and
//    its stake are labelled as ours.
// Creating spends the keeper's USDC, so it has its own kill switch, KEEPER_SERIES_ENABLED, on top of
// KEEPER_ENABLED. With either off, the job simulates and logs what it would create.

const decimalsAbi = parseAbi(["function decimals() view returns (uint8)"]);

/** In a dry run, a due period is worked out again only this often. */
const DRY_RUN_REPEAT_MS = 10 * 60 * 1000;

export interface SeriesStatus {
  id: string;
  template: number;
  asset: string;
  enabled: boolean;
  next?: { period: string; lock: string; close: string; createAt: string };
  status: string;
  lastMarket?: string;
  lastTx?: string;
}

export class SeriesJob implements CycleJob {
  readonly name = "series" as const;
  private readonly status = new Map<string, SeriesStatus>();
  /** Periods this process created or found with a market, so a period is never sent twice. */
  private readonly done = new Set<string>();
  /** Due periods worked out in a dry run: not again until this time. */
  private readonly quietUntil = new Map<string, number>();
  private readonly lastLogged = new Map<string, string>();

  constructor(
    private readonly specs: SeriesSpec[],
    private readonly opts: { enabled: boolean; file?: string },
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

  static fromFile(path: string, opts: { enabled: boolean }): SeriesJob {
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
    if ((this.quietUntil.get(periodKey) ?? 0) > this.clock()) return { sent: 0, due: 1 };

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
      this.done.add(periodKey);
      this.set(spec, { status: `period ${p.index} has its market`, lastMarket: existing.address });
      this.logChange(ctx, spec, "series-exists", { period: p.index, market: existing.address });
      return { sent: 0, due: 0 };
    }
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
      this.done.add(periodKey);
      this.set(spec, {
        status: `period ${p.index}: a market with these exact params exists`,
        lastMarket: byKey,
      });
      this.logChange(ctx, spec, "series-exists", { period: p.index, market: byKey, note: "same params" });
      return { sent: 0, due: 0 };
    }

    // 2. Funds: the first stake comes from the keeper's own USDC.
    const usdc = ctx.deployment.hunchBook.usdc as Address;
    const vault = ctx.deployment.hunchBook.vault as Address;
    const [balance, allowance, paused] = await ctx.client.multicall({
      allowFailure: false,
      contracts: [
        { address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [keeper] },
        { address: usdc, abi: erc20Abi, functionName: "allowance", args: [keeper, vault] },
        { address: factory, abi: hunchBookFactoryAbi, functionName: "creationPaused" },
      ],
    });
    const stake = spec.firstStake.amount;
    const fields = {
      period: p.index,
      template: spec.templateId,
      asset: spec.asset,
      lock: p.lock,
      close: p.close,
      firstStake: formatUnits(stake, 6),
      side: spec.firstStake.side === Side.Yes ? "yes" : "no",
      ...inputs,
    };
    if (paused) {
      this.set(spec, { status: "market creation is paused by the guardian" });
      this.logChange(ctx, spec, "series-paused", { period: p.index });
      return { sent: 0, due: 1 };
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
      return { sent: 0, due: 1 };
    }
    const dryRun = !this.opts.enabled;
    let sent = 0;
    if (allowance < stake) {
      const approve = await ctx.send(
        this.name,
        spec.id,
        {
          to: usdc,
          data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [vault, stake] }),
          abi: erc20Abi,
          action: "approveFirstStake",
          fields: { series: spec.id, spender: vault, amount: stake },
        },
        { dryRun },
      );
      if (wentOut(approve)) sent++;
      if (approve?.status !== "success") {
        // createMarket needs the approval to have landed: say what would happen, and stop here.
        this.quiet(periodKey, approve);
        this.set(spec, {
          status: `period ${p.index} is due: approve ${formatUnits(stake, 6)} USDC for the vault, then create`,
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
    if (result?.status === "success") {
      this.done.add(periodKey);
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
    } else if (result?.status === "dry-run") {
      this.quiet(periodKey, result);
      this.set(spec, {
        status: result.simulation.ok
          ? `period ${p.index} is due: a dry run, so not created`
          : `period ${p.index} is due: createMarket would revert: ${result.simulation.reason}`,
      });
    } else if (result) {
      const reason = result.status === "skipped" || result.status === "unknown" ? `: ${result.reason}` : "";
      this.set(spec, { status: `period ${p.index}: createMarket ${result.status}${reason}` });
    }
    if (wentOut(result)) sent++;
    return { sent, due: 1 };
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

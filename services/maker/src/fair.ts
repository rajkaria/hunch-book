import {
  type Deployment,
  decodeChainlinkTouchParams,
  decodeParlayParams,
  decodePerplFundingParams,
  decodePerplFundingSpikeParams,
  decodePriceAtTimeParams,
  decodePriceRangeParams,
  KURU_BEST_PRICE_SCALE,
  KURU_EMPTY_ASK,
  KURU_EMPTY_BID,
  kuruOrderBookAbi,
  marketAbi,
  Outcome,
  Phase,
  PriceSource,
  TemplateId,
  TouchDirection,
  touchesStrike,
} from "@hunch-book/shared";
import { type Address, type Hex, isAddressEqual, type PublicClient, zeroAddress } from "viem";
import { chainlinkAggregatorAbi, perplExchangeAbi } from "./abis.js";
import { type LegValue, parlayFairValue } from "./pricing/parlay.js";
import { fundingFairValue, fundingIncrements, historyNeeded, windowSteps } from "./pricing/perplFunding.js";
import { priceAtTimeFairValue, rangeFairValue, realisedVariancePerSecond } from "./pricing/priceAtTime.js";
import {
  type ChainlinkRound,
  type FundingHistory,
  type PerpInfo,
  readChainlinkHistory,
  readFundingHistory,
  readPerpInfo,
} from "./pricing/sources.js";
import { singleIntervalIncrements, spikeFairValue } from "./pricing/spike.js";
import { touchFairValue } from "./pricing/touch.js";

// Fair value per template, with the onchain inputs cached so a poll costs a handful of reads.

export interface ChainNow {
  block: number;
  timestamp: number;
}

export interface FairResult {
  p: number;
  /** The answer is already fixed; the bot stops quoting this market. */
  decided: boolean;
  detail: Record<string, unknown>;
}

/** A template the maker has no model for: it does not quote such markets (logged once, not an error). */
export class NoModelError extends Error {}

/** Templates with a pricing model: 1 to 6. Template 7 (snapshot) has none. */
export const PRICED_TEMPLATES: readonly number[] = [
  TemplateId.PerplFunding,
  TemplateId.PriceAtTime,
  TemplateId.ChainlinkTouch,
  TemplateId.PerplFundingSpike,
  TemplateId.PriceRange,
  TemplateId.Parlay,
];

const VOL_ROUNDS = 300;
const VOL_TTL_SECONDS = 300;
const PERP_INFO_TTL_SECONDS = 600;
/** A feed that has not updated for this long is treated as stopped: no quotes. */
const MAX_FEED_AGE_SECONDS = 3_600;
/** History kept for spike markets, in funding events, beyond the events left in the window. */
const SPIKE_HISTORY = 600;

interface FeedState {
  at: number;
  decimals: number;
  variance: number;
  /** Average seconds between the rounds measured. */
  roundSeconds: number;
  rounds: ChainlinkRound[];
}

export class FairValues {
  private readonly perpInfo = new Map<string, { at: number; info: PerpInfo }>();
  private readonly funding = new Map<string, FundingHistory>();
  private readonly startSums = new Map<string, number>();
  private readonly feeds = new Map<Address, FeedState>();
  private interval: number | undefined;

  constructor(
    private readonly client: PublicClient,
    private readonly deployment: Deployment,
  ) {}

  async forMarket(templateId: number, params: Hex, now: ChainNow, depth = 0): Promise<FairResult> {
    switch (templateId) {
      case TemplateId.PerplFunding:
        return this.perplFunding(params, now);
      case TemplateId.PriceAtTime:
        return this.priceAtTime(params, now);
      case TemplateId.ChainlinkTouch:
        return this.touch(params, now);
      case TemplateId.PerplFundingSpike:
        return this.spike(params, now);
      case TemplateId.PriceRange:
        return this.range(params, now);
      case TemplateId.Parlay:
        if (depth > 0) throw new NoModelError("a parlay of parlays is priced from its book only");
        return this.parlay(params, now);
      default:
        throw new NoModelError(`template ${templateId} has no pricing model: the maker does not quote it`);
    }
  }

  // ---------------------------------------------------------------- shared inputs

  private async perp(perpId: bigint, expectedScalingExp: number, now: ChainNow): Promise<PerpInfo> {
    const key = perpId.toString();
    let cached = this.perpInfo.get(key);
    if (!cached || now.timestamp - cached.at > PERP_INFO_TTL_SECONDS) {
      cached = {
        at: now.timestamp,
        info: await readPerpInfo(this.client, this.deployment.external.perpl.exchange, perpId),
      };
      this.perpInfo.set(key, cached);
    }
    if (cached.info.fundingSumScalingExp !== expectedScalingExp) {
      throw new Error(
        `Perpl rescaled perp ${key} (exp ${cached.info.fundingSumScalingExp}, market expects ${expectedScalingExp}): the resolver will refuse to answer`,
      );
    }
    return cached.info;
  }

  private async fundingInterval(): Promise<number> {
    this.interval ??= Number(
      await this.client.readContract({
        address: this.deployment.external.perpl.exchange,
        abi: perplExchangeAbi,
        functionName: "getFundingInterval",
      }),
    );
    return this.interval;
  }

  private async lastEvent(perpId: bigint, now: ChainNow): Promise<{ sum: number; event: number }> {
    const [sum, event] = await this.client.readContract({
      address: this.deployment.external.perpl.exchange,
      abi: perplExchangeAbi,
      functionName: "getFundingSumAtBlock",
      args: [perpId, BigInt(now.block)],
    });
    return { sum: Number(sum), event: Number(event) };
  }

  /** The perp's last `count` intervals of funding, reread only when a new event lands. */
  private async history(
    perpId: bigint,
    lastEvent: number,
    now: ChainNow,
    count: number,
  ): Promise<FundingHistory> {
    const key = perpId.toString();
    let history = this.funding.get(key);
    if (!history || history.lastEvent !== lastEvent || history.samples.length < count + 1) {
      history = await readFundingHistory(
        this.client,
        this.deployment.external.perpl.exchange,
        perpId,
        now.block,
        count,
      );
      this.funding.set(key, history);
    }
    return history;
  }

  /** Spot, realised variance and recent rounds of a Chainlink feed. Refuses a feed silent for an hour. */
  private async feed(feed: Address, now: ChainNow): Promise<FeedState & { spot: number; latestAt: number }> {
    const latest = await this.client.readContract({
      address: feed,
      abi: chainlinkAggregatorAbi,
      functionName: "latestRoundData",
    });
    const age = now.timestamp - Number(latest[3]);
    if (age > MAX_FEED_AGE_SECONDS) throw new Error(`feed ${feed} last updated ${age} s ago`);
    let state = this.feeds.get(feed);
    if (!state || now.timestamp - state.at > VOL_TTL_SECONDS) {
      const history = await readChainlinkHistory(this.client, feed, VOL_ROUNDS);
      const measured = realisedVariancePerSecond(
        history.rounds.map((r) => ({ roundId: r.roundId, answer: Number(r.answer), updatedAt: r.updatedAt })),
      );
      state = {
        at: now.timestamp,
        decimals: history.decimals,
        variance: measured.variance,
        roundSeconds: measured.seconds / measured.returns,
        rounds: history.rounds,
      };
      this.feeds.set(feed, state);
    }
    return { ...state, spot: Number(latest[1]) / 10 ** state.decimals, latestAt: Number(latest[3]) };
  }

  // ---------------------------------------------------------------- template 1

  private async perplFunding(raw: Hex, now: ChainNow): Promise<FairResult> {
    const params = decodePerplFundingParams(raw);
    const key = params.perpId.toString();
    const info = await this.perp(params.perpId, params.expectedScalingExp, now);
    const interval = await this.fundingInterval();
    const { sum: sumNow, event: lastEvent } = await this.lastEvent(params.perpId, now);
    const startBlock = Number(params.startBlock);
    const endBlock = Number(params.endBlock);
    const { stepsToStart, stepsToEnd } = windowSteps(lastEvent, interval, startBlock, endBlock);

    let accrued = 0;
    if (now.block > startBlock) {
      const startKey = `${key}:${startBlock}`;
      let startSum = this.startSums.get(startKey);
      if (startSum === undefined) {
        const [sum] = await this.client.readContract({
          address: this.deployment.external.perpl.exchange,
          abi: perplExchangeAbi,
          functionName: "getFundingSumAtBlock",
          args: [params.perpId, params.startBlock],
        });
        startSum = Number(sum);
        this.startSums.set(startKey, startSum);
      }
      accrued = sumNow - startSum;
    }

    const threshold = Number(params.threshold);
    const usdPerUnit = 10 ** -(info.priceDecimals + info.fundingSumScalingExp);
    const base = {
      perpId: key,
      symbol: info.symbol,
      accrued,
      threshold,
      stepsToStart,
      stepsToEnd,
      usdPerUnit,
    };
    if (stepsToEnd === 0) {
      const fair = fundingFairValue({
        accrued,
        currentRate: 0,
        stepsToStart,
        stepsToEnd,
        threshold,
        increments: [],
      });
      return { p: fair.p, decided: true, detail: base };
    }
    const history = await this.history(params.perpId, lastEvent, now, historyNeeded(stepsToEnd));
    const increments = fundingIncrements(history.samples);
    const currentRate = increments[increments.length - 1] ?? 0;
    const fair = fundingFairValue({ accrued, currentRate, stepsToStart, stepsToEnd, threshold, increments });
    return {
      p: fair.p,
      decided: false,
      detail: { ...base, currentRate, expected: fair.expected, samples: fair.samples },
    };
  }

  // ---------------------------------------------------------------- template 2

  private async priceAtTime(raw: Hex, now: ChainNow): Promise<FairResult> {
    const params = decodePriceAtTimeParams(raw);
    if (params.source !== PriceSource.Chainlink) {
      throw new NoModelError(
        "Pyth-sourced markets have no volatility source in the maker (Hermes history needs an API key)",
      );
    }
    const f = await this.feed(params.feed, now);
    const strike = Number(params.strikeE8) / 1e8;
    const secondsToClose = Number(params.closeTime) - now.timestamp;
    const fair = priceAtTimeFairValue({
      spot: f.spot,
      strike,
      variancePerSecond: f.variance,
      secondsToClose,
    });
    return {
      p: fair.p,
      decided: fair.decided,
      detail: { feed: params.feed, spot: f.spot, strike, secondsToClose, annualVol: fair.vol },
    };
  }

  // ---------------------------------------------------------------- template 3

  private async touch(raw: Hex, now: ChainNow): Promise<FairResult> {
    const params = decodeChainlinkTouchParams(raw);
    const f = await this.feed(params.feed, now);
    const t1 = Number(params.startTime);
    const t2 = Number(params.endTime);
    // A round of the window that already touched: the keeper proves it, so the answer is YES.
    const inWindow = f.rounds.filter((r) => r.updatedAt >= t1 && r.updatedAt <= t2);
    const touched = inWindow.some((r) =>
      touchesStrike(r.answer, f.decimals, params.strikeE8, params.direction),
    );
    const oldest = f.rounds[0]?.updatedAt ?? Number.POSITIVE_INFINITY;
    const strike = Number(params.strikeE8) / 1e8;
    const fair = touchFairValue({
      spot: f.spot,
      strike,
      direction: params.direction === TouchDirection.AtOrAbove ? "up" : "down",
      variancePerSecond: f.variance,
      secondsToStart: t1 - now.timestamp,
      secondsToEnd: t2 - now.timestamp,
      touched,
      roundSeconds: f.roundSeconds,
    });
    return {
      p: fair.p,
      decided: fair.decided,
      detail: {
        feed: params.feed,
        spot: f.spot,
        strike,
        direction: params.direction === TouchDirection.AtOrAbove ? "at or above" : "at or below",
        barrier: fair.barrier,
        annualVol: fair.vol,
        roundSeconds: Math.round(f.roundSeconds),
        touched,
        // The rounds read reach back to `oldest`; a window that opened earlier is only partly checked
        // here (the keeper reads all of it before NO).
        touchCheck: oldest <= t1 ? "every round of the window so far" : `rounds since ${oldest}`,
      },
    };
  }

  // ---------------------------------------------------------------- template 4

  private async spike(raw: Hex, now: ChainNow): Promise<FairResult> {
    const params = decodePerplFundingSpikeParams(raw);
    const info = await this.perp(params.perpId, params.expectedScalingExp, now);
    const interval = await this.fundingInterval();
    const { event: lastEvent } = await this.lastEvent(params.perpId, now);
    const startBlock = Number(params.startBlock);
    const endBlock = Number(params.endBlock);
    const { stepsToStart, stepsToEnd } = windowSteps(lastEvent, interval, startBlock, endBlock);
    const eventsLeft = Math.max(0, stepsToEnd - stepsToStart);
    const history = await this.history(
      params.perpId,
      lastEvent,
      now,
      Math.max(SPIKE_HISTORY, eventsLeft + 300),
    );
    const events = singleIntervalIncrements(history.samples, interval);
    const threshold = Number(params.threshold);
    const finalUpTo = Math.min(endBlock, now.block - 1);
    const spiked = events.some(
      (e) => e.block > startBlock && e.block <= finalUpTo && e.increment > threshold,
    );
    const fair = spikeFairValue({
      increments: events.map((e) => e.increment),
      threshold,
      eventsLeft,
      spiked,
    });
    return {
      p: fair.p,
      decided: fair.decided,
      detail: {
        perpId: params.perpId.toString(),
        symbol: info.symbol,
        threshold,
        eventsLeft,
        method: fair.method,
        samples: fair.samples,
        perEvent: fair.perEvent,
        spiked,
        usdPerUnit: 10 ** -(info.priceDecimals + info.fundingSumScalingExp),
      },
    };
  }

  // ---------------------------------------------------------------- template 5

  private async range(raw: Hex, now: ChainNow): Promise<FairResult> {
    const params = decodePriceRangeParams(raw);
    if (params.source !== PriceSource.Chainlink) {
      throw new NoModelError("Pyth-sourced markets have no volatility source in the maker");
    }
    const f = await this.feed(params.feed, now);
    const lower = Number(params.lowerE8) / 1e8;
    const upper = Number(params.upperE8) / 1e8;
    const secondsToClose = Number(params.closeTime) - now.timestamp;
    const fair = rangeFairValue({
      spot: f.spot,
      lower,
      upper,
      variancePerSecond: f.variance,
      secondsToClose,
    });
    return {
      p: fair.p,
      decided: fair.decided,
      detail: { feed: params.feed, spot: f.spot, lower, upper, secondsToClose, annualVol: fair.vol },
    };
  }

  // ---------------------------------------------------------------- template 6

  private async parlay(raw: Hex, now: ChainNow): Promise<FairResult> {
    const { legs } = decodeParlayParams(raw);
    const reads = await this.client.multicall({
      allowFailure: false,
      contracts: legs.flatMap((leg) => [
        { address: leg, abi: marketAbi, functionName: "phase" as const },
        { address: leg, abi: marketAbi, functionName: "outcome" as const },
        { address: leg, abi: marketAbi, functionName: "book" as const },
        { address: leg, abi: marketAbi, functionName: "templateId" as const },
        { address: leg, abi: marketAbi, functionName: "params" as const },
      ]),
    });
    const values: LegValue[] = [];
    for (const [i, leg] of legs.entries()) {
      const [phase, outcome, book, templateId, params] = reads.slice(i * 5, i * 5 + 5) as [
        number,
        number,
        Address,
        number,
        Hex,
      ];
      if (phase === Phase.Settled) {
        values.push({ market: leg, state: outcome === Outcome.Yes ? "settled-yes" : "settled-no" });
        continue;
      }
      if (phase === Phase.Voided) {
        values.push({ market: leg, state: "voided" });
        continue;
      }
      const mid = book && !isAddressEqual(book, zeroAddress) ? await this.bookMid(book) : undefined;
      if (mid !== undefined) {
        values.push({ market: leg, state: "open", p: mid, source: "book" });
        continue;
      }
      const fair = await this.forMarket(Number(templateId), params, now, 1);
      values.push({ market: leg, state: "open", p: fair.p, source: "model" });
    }
    const fair = parlayFairValue(values);
    return { p: fair.p, decided: fair.decided, detail: { assumption: fair.assumption, legs: fair.legs } };
  }

  /** A two-sided book's mid (YES per USDC), or undefined. */
  private async bookMid(book: Address): Promise<number | undefined> {
    try {
      const [bid, ask] = await this.client.readContract({
        address: book,
        abi: kuruOrderBookAbi,
        functionName: "bestBidAsk",
      });
      if (bid === KURU_EMPTY_BID || bid === 0n || ask === KURU_EMPTY_ASK || ask === KURU_EMPTY_BID)
        return undefined;
      return (Number(bid) + Number(ask)) / 2 / Number(KURU_BEST_PRICE_SCALE);
    } catch {
      return undefined;
    }
  }
}

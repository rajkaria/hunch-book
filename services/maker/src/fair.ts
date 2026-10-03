import {
  type Deployment,
  decodePerplFundingParams,
  decodePriceAtTimeParams,
  PriceSource,
  TemplateId,
} from "@hunch-book/shared";
import type { Address, Hex, PublicClient } from "viem";
import { chainlinkAggregatorAbi, perplExchangeAbi } from "./abis.js";
import { fundingFairValue, fundingIncrements, historyNeeded, windowSteps } from "./pricing/perplFunding.js";
import { priceAtTimeFairValue, realisedVariancePerSecond } from "./pricing/priceAtTime.js";
import {
  type FundingHistory,
  type PerpInfo,
  readChainlinkHistory,
  readFundingHistory,
  readPerpInfo,
} from "./pricing/sources.js";

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

const VOL_ROUNDS = 300;
const VOL_TTL_SECONDS = 300;
const PERP_INFO_TTL_SECONDS = 600;
/** A feed that has not updated for this long is treated as stopped: no quotes. */
const MAX_FEED_AGE_SECONDS = 3_600;

export class FairValues {
  private readonly perpInfo = new Map<string, { at: number; info: PerpInfo }>();
  private readonly funding = new Map<string, FundingHistory>();
  private readonly startSums = new Map<string, number>();
  private readonly vol = new Map<Address, { at: number; variance: number }>();
  private interval: number | undefined;

  constructor(
    private readonly client: PublicClient,
    private readonly deployment: Deployment,
  ) {}

  async forMarket(templateId: number, params: Hex, now: ChainNow): Promise<FairResult> {
    if (templateId === TemplateId.PerplFunding) return this.perplFunding(params, now);
    if (templateId === TemplateId.PriceAtTime) return this.priceAtTime(params, now);
    throw new Error(`template ${templateId} has no pricing model in maker v0`);
  }

  private async perplFunding(raw: Hex, now: ChainNow): Promise<FairResult> {
    const params = decodePerplFundingParams(raw);
    const exchange = this.deployment.external.perpl.exchange;
    const key = params.perpId.toString();

    let cached = this.perpInfo.get(key);
    if (!cached || now.timestamp - cached.at > PERP_INFO_TTL_SECONDS) {
      cached = { at: now.timestamp, info: await readPerpInfo(this.client, exchange, params.perpId) };
      this.perpInfo.set(key, cached);
    }
    const info = cached.info;
    if (info.fundingSumScalingExp !== params.expectedScalingExp) {
      throw new Error(
        `Perpl rescaled perp ${key} (exp ${info.fundingSumScalingExp}, market expects ${params.expectedScalingExp}): the resolver will refuse to answer`,
      );
    }
    this.interval ??= Number(
      await this.client.readContract({
        address: exchange,
        abi: perplExchangeAbi,
        functionName: "getFundingInterval",
      }),
    );
    const [sumNow, lastEventRaw] = await this.client.readContract({
      address: exchange,
      abi: perplExchangeAbi,
      functionName: "getFundingSumAtBlock",
      args: [params.perpId, BigInt(now.block)],
    });
    const lastEvent = Number(lastEventRaw);
    const startBlock = Number(params.startBlock);
    const endBlock = Number(params.endBlock);
    const { stepsToStart, stepsToEnd } = windowSteps(lastEvent, this.interval, startBlock, endBlock);

    let accrued = 0;
    if (now.block > startBlock) {
      const startKey = `${key}:${startBlock}`;
      let startSum = this.startSums.get(startKey);
      if (startSum === undefined) {
        const [sum] = await this.client.readContract({
          address: exchange,
          abi: perplExchangeAbi,
          functionName: "getFundingSumAtBlock",
          args: [params.perpId, params.startBlock],
        });
        startSum = Number(sum);
        this.startSums.set(startKey, startSum);
      }
      accrued = Number(sumNow) - startSum;
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

    const needed = historyNeeded(stepsToEnd);
    let history = this.funding.get(key);
    if (!history || history.lastEvent !== lastEvent || history.samples.length < needed + 1) {
      history = await readFundingHistory(this.client, exchange, params.perpId, now.block, needed);
      this.funding.set(key, history);
    }
    const increments = fundingIncrements(history.samples);
    const currentRate = increments[increments.length - 1] ?? 0;
    const fair = fundingFairValue({ accrued, currentRate, stepsToStart, stepsToEnd, threshold, increments });
    return {
      p: fair.p,
      decided: false,
      detail: { ...base, currentRate, expected: fair.expected, samples: fair.samples },
    };
  }

  private async priceAtTime(raw: Hex, now: ChainNow): Promise<FairResult> {
    const params = decodePriceAtTimeParams(raw);
    if (params.source !== PriceSource.Chainlink) {
      throw new Error(
        "Pyth-sourced markets have no volatility source in maker v0 (Hermes history needs an API key)",
      );
    }
    const feed = params.feed;
    const [decimals, latest] = await Promise.all([
      this.client.readContract({ address: feed, abi: chainlinkAggregatorAbi, functionName: "decimals" }),
      this.client.readContract({
        address: feed,
        abi: chainlinkAggregatorAbi,
        functionName: "latestRoundData",
      }),
    ]);
    const age = now.timestamp - Number(latest[3]);
    if (age > MAX_FEED_AGE_SECONDS) throw new Error(`feed ${feed} last updated ${age} s ago`);

    let vol = this.vol.get(feed);
    if (!vol || now.timestamp - vol.at > VOL_TTL_SECONDS) {
      const history = await readChainlinkHistory(this.client, feed, VOL_ROUNDS);
      const measured = realisedVariancePerSecond(
        history.rounds.map((r) => ({ roundId: r.roundId, answer: Number(r.answer), updatedAt: r.updatedAt })),
      );
      vol = { at: now.timestamp, variance: measured.variance };
      this.vol.set(feed, vol);
    }
    const spot = Number(latest[1]) / 10 ** decimals;
    const strike = Number(params.strikeE8) / 1e8;
    const secondsToClose = Number(params.closeTime) - now.timestamp;
    const fair = priceAtTimeFairValue({ spot, strike, variancePerSecond: vol.variance, secondsToClose });
    return {
      p: fair.p,
      decided: fair.decided,
      detail: { feed, spot, strike, secondsToClose, annualVol: fair.vol },
    };
  }
}

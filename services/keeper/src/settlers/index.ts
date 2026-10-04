import { type Deployment, TemplateId, type Window } from "@hunch-book/shared";
import type { Abi, Address, Hex, PublicClient } from "viem";
import { chainlinkTouchSettler } from "./chainlinkTouch.js";
import { fundingSpikeSettler } from "./fundingSpike.js";
import { parlaySettler } from "./parlay.js";
import { perplFundingSettler } from "./perplFunding.js";
import { priceAtTimeSettler } from "./priceAtTime.js";
import { priceRangeSettler } from "./priceRange.js";

// One settler per template: it knows when the template's resolver can answer, and what evidence to
// pass to `settle`. Templates with an early YES (touch, funding spike) also have a prover, which hunts
// for the observation that proves YES and hands it to `proveYes`. Templates settled from a snapshot
// taken after close (roadmap S-6) have a snapshot taker. A new template plugs in with
// `registry.register(id, settler)`; markets on a template with no settler are logged once and skipped.

export interface SettleMarket {
  address: Address;
  templateId: number;
  params: Hex;
  window: Window;
  /** The market's resolver contract. */
  resolver: Address;
}

/** What the pure `waitReason` checks look at: no reads, only the market's fixed fields. */
export type PlanSettleMarket = Pick<SettleMarket, "address" | "params" | "window" | "resolver">;

export interface ChainNow {
  block: bigint;
  timestamp: bigint;
}

export interface SettleDeps {
  client: PublicClient;
  deployment: Deployment;
  pythApiKey: string | undefined;
  hermesUrl: string;
  fetchFn?: typeof fetch;
}

export type EvidenceResult =
  /** Call `settle(evidence)` with `value` MON. */
  | { status: "ready"; evidence: Hex; value: bigint; detail: Record<string, unknown> }
  /** Not yet; try again later. */
  | { status: "wait"; reason: string }
  /** The resolver will never accept an answer for this market; it voids at its deadline. */
  | { status: "unsettleable"; reason: string };

export type ProofResult =
  /** Call `proveYes(proof)`. */
  | { status: "found"; proof: Hex; detail: Record<string, unknown> }
  /** Nothing proves YES yet. */
  | { status: "none"; reason: string };

/** Hunts for the observation that proves YES early (templates 3 and 4). */
export interface Prover {
  /**
   * Why there is nothing to hunt now (the window has not opened, or every observation that can count
   * has been checked and none proves YES), or null. No reads: it looks only at its own memory.
   */
  waitReason(market: PlanSettleMarket, now: ChainNow): string | null;
  /** Checks the observations since the last call; the first one that proves YES, if any. */
  findProof(market: SettleMarket, now: ChainNow, deps: SettleDeps): Promise<ProofResult>;
}

export type SnapshotResult =
  /** Send this call: it records the snapshot the resolver will settle from. */
  | {
      status: "ready";
      to: Address;
      data: Hex;
      abi: Abi | readonly unknown[];
      detail: Record<string, unknown>;
    }
  /** The snapshot is already taken, or cannot be taken any more. */
  | { status: "done"; reason: string }
  | { status: "wait"; reason: string };

/** Takes the snapshot a snapshot-settled template (roadmap S-6) reads after close. */
export interface SnapshotTaker {
  /** Pure: why no snapshot can be taken at `now` (before the window, after it), or null. */
  waitReason(market: PlanSettleMarket, now: ChainNow): string | null;
  /** Reads whether the snapshot exists, and builds the call that takes it if not. */
  request(market: SettleMarket, now: ChainNow, deps: SettleDeps): Promise<SnapshotResult>;
}

export interface Settler {
  readonly name: string;
  /** Pure: why this template cannot settle yet at `now`, or null when its time has come. */
  waitReason(market: PlanSettleMarket, now: ChainNow): string | null;
  /** Reads or fetches the evidence for `settle`. Only called once `waitReason` is null. */
  evidence(market: SettleMarket, now: ChainNow, deps: SettleDeps): Promise<EvidenceResult>;
  /** Templates whose resolver accepts an early YES: the proof hunter. */
  readonly prover?: Prover;
  /** Templates settled from a snapshot taken after close. */
  readonly snapshot?: SnapshotTaker;
}

export class SettlerRegistry {
  private readonly byTemplate = new Map<number, Settler>();

  register(templateId: number, settler: Settler): this {
    this.byTemplate.set(templateId, settler);
    return this;
  }

  get(templateId: number): Settler | undefined {
    return this.byTemplate.get(templateId);
  }

  templates(): number[] {
    return [...this.byTemplate.keys()].sort((a, b) => a - b);
  }
}

/**
 * Every template the keeper knows: 1 Perpl funding, 2 price at a time, 3 price touch, 4 funding spike,
 * 5 price range, 6 parlay. The touch and spike settlers keep their hunt's progress in memory, so each
 * registry gets its own.
 */
export function defaultSettlers(): SettlerRegistry {
  return new SettlerRegistry()
    .register(TemplateId.PerplFunding, perplFundingSettler)
    .register(TemplateId.PriceAtTime, priceAtTimeSettler)
    .register(TemplateId.ChainlinkTouch, chainlinkTouchSettler())
    .register(TemplateId.PerplFundingSpike, fundingSpikeSettler())
    .register(TemplateId.PriceRange, priceRangeSettler)
    .register(TemplateId.Parlay, parlaySettler);
}

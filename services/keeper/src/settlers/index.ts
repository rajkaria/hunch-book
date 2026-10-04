import { type Deployment, TemplateId, type Window } from "@hunch-book/shared";
import type { Address, Hex, PublicClient } from "viem";
import { perplFundingSettler } from "./perplFunding.js";
import { priceAtTimeSettler } from "./priceAtTime.js";

// One settler per template: it knows when the template's resolver can answer, and what evidence to
// pass to `settle`. A new template (touch markets, ranges) plugs in with `registry.register(id, settler)`;
// markets on a template with no settler are logged once and skipped.

export interface SettleMarket {
  address: Address;
  templateId: number;
  params: Hex;
  window: Window;
  /** The market's resolver contract. */
  resolver: Address;
}

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

export interface Settler {
  readonly name: string;
  /** Pure: why this template cannot settle yet at `now`, or null when its time has come. */
  waitReason(market: Pick<SettleMarket, "params" | "window">, now: ChainNow): string | null;
  /** Reads or fetches the evidence for `settle`. Only called once `waitReason` is null. */
  evidence(market: SettleMarket, now: ChainNow, deps: SettleDeps): Promise<EvidenceResult>;
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

/** The v0 templates: 1 Perpl funding, 2 price at a time. */
export function defaultSettlers(): SettlerRegistry {
  return new SettlerRegistry()
    .register(TemplateId.PerplFunding, perplFundingSettler)
    .register(TemplateId.PriceAtTime, priceAtTimeSettler);
}

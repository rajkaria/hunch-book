import { type Network, TemplateId } from "@hunch-book/shared";

// The templates the create flow can build, in the order the picker shows them. A template appears
// only if the factory has it registered on this network (`templateOf(id)` has a resolver) and this
// app has a form for it. Adding a template is one entry here plus its form and parameter builder.

/** Every template id the picker asks the factory about. */
export const TEMPLATE_IDS = [1, 2, 3, 4, 5, 6] as const;

export type TemplateKind =
  | "perpl-funding"
  | "perpl-spike"
  | "price-at-time"
  | "price-range"
  | "price-touch"
  | "parlay";

export interface CreateTemplate {
  id: number;
  kind: TemplateKind;
  title: string;
  /** One line: the question shape. */
  summary: string;
  /** A filled-in question, as the market page would show it. */
  example: string;
  /** Where the answer is read from. */
  source: string;
  /** How soon after close it can settle. */
  speed: string;
  /** "block": lock and close are block numbers; "time": unix seconds. */
  clock: "block" | "time";
}

export const CREATE_TEMPLATES: readonly CreateTemplate[] = [
  {
    id: TemplateId.PerplFunding,
    kind: "perpl-funding",
    title: "Perpl funding over a window",
    summary: "Will longs pay more than a set amount in funding on a Perpl perp over a window?",
    example: "Will MON longs pay more than $0.00001 per MON in funding on Perpl over the next day?",
    source: "Perpl's funding history, read onchain with getFundingSumAtBlock",
    speed: "Settles as soon as the window's last block has passed",
    clock: "block",
  },
  {
    id: TemplateId.PerplFundingSpike,
    kind: "perpl-spike",
    title: "Perpl funding spike",
    summary: "Will any single funding event on a Perpl perp charge longs more than a set amount in a window?",
    example: "Will any single BTC funding event on Perpl this week charge longs more than $2 per BTC?",
    source: "Perpl's funding history: anyone proves YES by pointing at the event",
    speed: "YES as soon as someone proves a spike; NO about 24 hours after the window",
    clock: "block",
  },
  {
    id: TemplateId.PriceAtTime,
    kind: "price-at-time",
    title: "Price at a time",
    summary: "Will an asset be at or above a price at a set time?",
    example: "Will BTC/USD be at or above $90,000 at 12:00 UTC tomorrow?",
    source: "Chainlink's onchain price feed, or Pyth where Chainlink has no feed",
    speed: "Settles once the feed publishes its next price after the close",
    clock: "time",
  },
  {
    id: TemplateId.PriceRange,
    kind: "price-range",
    title: "Price in a range",
    summary: "Will an asset be at or above one price and below another at a set time?",
    example: "Will ETH/USD be at or above $2,600 and below $2,800 at 12:00 UTC tomorrow?",
    source: "Chainlink's onchain price feed, or Pyth where Chainlink has no feed",
    speed: "Settles once the feed publishes its next price after the close",
    clock: "time",
  },
  {
    id: TemplateId.ChainlinkTouch,
    kind: "price-touch",
    title: "Price touch",
    summary: "Will an asset reach (or fall to) a price at any time in a window?",
    example: "Will Chainlink's BTC/USD feed report $90,000 or more at any time in the next week?",
    source: "Chainlink's onchain rounds: anyone proves YES by pointing at the round",
    speed: "YES as soon as someone proves a touch; NO 24 hours after the window",
    clock: "time",
  },
  {
    id: TemplateId.Parlay,
    kind: "parlay",
    title: "Parlay",
    summary: "Will every one of 2 to 5 open Hunch Book markets settle YES?",
    example: "Will MON funding this week and BTC at $90,000 on Friday both settle YES?",
    source: "The legs' own outcomes, read from their market contracts",
    speed: "NO as soon as any leg settles NO; YES once every leg settles YES",
    clock: "time",
  },
];

export function templateById(id: number): CreateTemplate | undefined {
  return CREATE_TEMPLATES.find((t) => t.id === id);
}

/** The templates to offer: registered with the factory, and with a form in this app. */
export function availableTemplates(registered: readonly number[]): CreateTemplate[] {
  const set = new Set(registered);
  return CREATE_TEMPLATES.filter((t) => set.has(t.id));
}

/** A caveat a creator should read before picking a template on this network, or null. */
export function networkCaveat(kind: TemplateKind, network: Network): string | null {
  if (network !== "monad-testnet") return null;
  if (kind === "price-at-time" || kind === "price-range") {
    return "On testnet, Chainlink's feeds update about once a day, so a price market here can miss the one-hour freshness rule and void. Perpl funding markets settle reliably on testnet.";
  }
  if (kind === "price-touch") {
    return "On testnet, Chainlink's feeds update about once a day, so few rounds land in a window. A touch market here settles, but rarely YES.";
  }
  return null;
}

/** Parses `?template=1` into a known template id, or null. */
export function parseTemplateParam(value: string | string[] | undefined): number | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw || !/^\d+$/.test(raw)) return null;
  const id = Number(raw);
  return templateById(id) ? id : null;
}

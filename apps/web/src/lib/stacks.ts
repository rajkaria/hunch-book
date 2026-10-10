import {
  type Deployment,
  defaultStackOf,
  type HunchBookContracts,
  type Stack,
  stackNamed,
  stacksOf,
  type Venue,
  venueLabel,
} from "@hunch-book/shared";
import type { Address } from "viem";
import { appDeployment } from "./config";
import type { MarketView } from "./market/types";

// A market's stack: its factory, vault, router and periphery (docs/PROTOCOL.md §8.1). Markets read from
// any stack carry the stack's name; this turns it back into addresses. A stack's venue is where its
// books are: Hunch Book's own onchain order book, or Kuru (v1 or v2). Copy names a market's venue from
// here, so every sentence about where a book lives follows deployments/<network>.json.

/** The stack `m` belongs to: its own (`m.stack`), or the primary one. */
export function stackOf(
  m: Pick<MarketView, "stack">,
  deployment: Deployment = appDeployment,
): Stack | undefined {
  return stackNamed(deployment, m.stack ?? "primary") ?? stacksOf(deployment)[0];
}

/** One contract of the market's stack (undefined where that stack has none). */
export function stackContract<K extends keyof HunchBookContracts>(
  m: Pick<MarketView, "stack">,
  key: K,
  deployment: Deployment = appDeployment,
): HunchBookContracts[K] | undefined {
  return stackOf(m, deployment)?.contracts[key];
}

/** The router that trades this market's book. */
export const routerOf = (
  m: Pick<MarketView, "stack">,
  deployment: Deployment = appDeployment,
): Address | undefined => stackContract(m, "router", deployment);

/** The vault that holds this market's USDC (the spender for stakes and set mints). */
export const vaultOf = (
  m: Pick<MarketView, "stack">,
  deployment: Deployment = appDeployment,
): Address | undefined => stackContract(m, "vault", deployment);

/** The block a market's stack was deployed at: where a log scan for its events can start. */
export const deployBlockOf = (m: Pick<MarketView, "stack">, deployment: Deployment = appDeployment): bigint =>
  BigInt(stackContract(m, "deployBlock", deployment) ?? deployment.hunchBook.deployBlock ?? 0);

/** The stack new markets go to (deployments `defaultStack`, else the primary one). */
export const defaultStack = (deployment: Deployment = appDeployment): Stack | undefined =>
  defaultStackOf(deployment);

/** True when `m` is on the stack new markets go to. */
export const onDefaultStack = (
  m: Pick<MarketView, "stack">,
  deployment: Deployment = appDeployment,
): boolean => (m.stack ?? "primary") === (defaultStackOf(deployment)?.name ?? "primary");

/** True for a market whose book is (or will be) on Kuru v2. */
export const onKuruV2 = (m: Pick<MarketView, "kuruVersion">): boolean => m.kuruVersion === 2;

// ---------------------------------------------------------------- venues

/** A market or a stack: what the venue words read (a market leaves both out on the primary Kuru v1 stack). */
export interface VenueSource {
  venue?: Venue;
  kuruVersion?: 1 | 2;
}

/** "hunch" for Hunch Book's own order book, else "kuru" (absent = Kuru). */
export const venueOfMarket = (m: VenueSource): Venue => (m.venue === "hunch" ? "hunch" : "kuru");

/** True for a market (or stack) whose book is Hunch Book's own onchain order book. */
export const onHunchVenue = (m: VenueSource): boolean => venueOfMarket(m) === "hunch";

/** The shared label: "Hunch order book", "Kuru v2" or "Kuru". */
export const marketVenueLabel = (m: VenueSource): string =>
  venueLabel({ venue: venueOfMarket(m), kuruVersion: m.kuruVersion === 2 ? 2 : 1 });

/** The book by name, as in "<name> on the explorer": "Hunch order book", "Kuru v2 book" or "Kuru book". */
export const bookName = (m: VenueSource): string =>
  onHunchVenue(m) ? "Hunch order book" : m.kuruVersion === 2 ? "Kuru v2 book" : "Kuru book";

/** The venue after "on" in a sentence: "Hunch Book's own order book", "Kuru v2" or "Kuru". */
export const venueWords = (m: VenueSource): string =>
  onHunchVenue(m) ? "Hunch Book's own order book" : marketVenueLabel(m);

/** The venue in a short label, after "on" or "to": "the order book", "Kuru v2" or "Kuru". */
export const venueShort = (m: VenueSource): string =>
  onHunchVenue(m) ? "the order book" : marketVenueLabel(m);

/**
 * Where a network's markets trade, one sentence per venue, read from its stacks: the venue new markets
 * go to first, then the others the app still reads.
 */
export function venueSentences(deployment: Deployment): string[] {
  const first = defaultStackOf(deployment);
  if (!first) return [];
  const out = [
    onHunchVenue(first)
      ? "New markets graduate to Hunch Book's own onchain order book, so graduation waits on no third party."
      : first.kuruVersion === 2
        ? "New markets graduate to Kuru v2 books, each once Kuru has created it."
        : "New markets graduate to Kuru's onchain order book.",
  ];
  const others = stacksOf(deployment).filter((s) => s.name !== first.name);
  if (others.some((s) => !onHunchVenue(s) && s.kuruVersion === 1)) {
    out.push("Kuru is supported too: markets created on a Kuru stack graduate to Kuru's books.");
  }
  if (others.some((s) => !onHunchVenue(s) && s.kuruVersion === 2)) {
    out.push("Kuru v2 is supported: pools on a Kuru v2 stack graduate once Kuru creates their books.");
  }
  return out;
}

/**
 * "#3" for a market on Hunch Book's own order book, "#3 · Kuru" on a Kuru v1 stack and "#3 · Kuru v2"
 * on a Kuru v2 stack. Each stack's factory numbers its markets from 1, so the venue keeps two markets
 * with the same number apart.
 */
export const marketTag = (m: Pick<MarketView, "marketId"> & VenueSource): string =>
  `#${m.marketId.toString()}${onHunchVenue(m) ? "" : ` · ${marketVenueLabel(m)}`}`;

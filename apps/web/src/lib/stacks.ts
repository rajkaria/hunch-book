import {
  type Deployment,
  type HunchBookContracts,
  type Stack,
  stackNamed,
  stacksOf,
} from "@hunch-book/shared";
import type { Address } from "viem";
import { appDeployment } from "./config";
import type { MarketView } from "./market/types";

// A market's stack: its factory, vault, router and periphery (docs/PROTOCOL.md §8.1). Markets read from
// any stack carry the stack's name; this turns it back into addresses.

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

/** True for a market whose book is (or will be) on Kuru v2. */
export const onKuruV2 = (m: Pick<MarketView, "kuruVersion">): boolean => m.kuruVersion === 2;

/**
 * "#3", or "#3 · Kuru v2" for a market of a Kuru v2 stack: each stack's factory numbers its markets
 * from 1, so the label keeps two markets with the same number apart.
 */
export const marketTag = (m: Pick<MarketView, "marketId" | "kuruVersion">): string =>
  `#${m.marketId.toString()}${onKuruV2(m) ? " · Kuru v2" : ""}`;

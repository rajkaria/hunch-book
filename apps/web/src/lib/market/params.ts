import {
  addressUrl,
  type Deployment,
  decodePerplFundingParams,
  decodePriceAtTimeParams,
  PriceSource,
  TemplateId,
} from "@hunch-book/shared";
import type { Address, Hex } from "viem";
import { formatE8Usd, formatInt, formatUtc, shortHash } from "../format";
import type { DecodedParams } from "./types";

export const TEMPLATE_LABEL: Record<number, string> = {
  [TemplateId.PerplFunding]: "Perpl funding",
  [TemplateId.PriceAtTime]: "Price at a time",
};

export function templateLabel(templateId: number): string {
  return TEMPLATE_LABEL[templateId] ?? `Template ${templateId}`;
}

/** Decodes a market's params with the shared decoders. Never throws: bad bytes come back as "unknown". */
export function decodeMarketParams(templateId: number, params: Hex): DecodedParams {
  try {
    if (templateId === TemplateId.PerplFunding) {
      return { kind: "perpl-funding", params: decodePerplFundingParams(params) };
    }
    if (templateId === TemplateId.PriceAtTime) {
      return { kind: "price-at-time", params: decodePriceAtTimeParams(params) };
    }
  } catch {
    // fall through
  }
  return { kind: "unknown", raw: params };
}

const sameAddress = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** "BTC" for Perpl perp 16 on testnet, from deployments/<network>.json. */
export function perpName(deployment: Deployment, perpId: bigint): string | undefined {
  const entry = Object.entries(deployment.external.perpl.perps).find(([, id]) => BigInt(id) === perpId);
  return entry?.[0];
}

/** "BTC/USD" for a known Chainlink proxy address. */
export function chainlinkFeedName(deployment: Deployment, feed: Address): string | undefined {
  return Object.entries(deployment.external.chainlink).find(([, addr]) => sameAddress(addr, feed))?.[0];
}

/** "SOL/USD" for a known Pyth price id. */
export function pythFeedName(deployment: Deployment, id: Hex): string | undefined {
  return Object.entries(deployment.external.pyth.ids).find(([, known]) => sameAddress(known, id))?.[0];
}

/** The asset pair a price market observes, for headlines. */
export function priceAssetName(deployment: Deployment, decoded: DecodedParams): string | undefined {
  if (decoded.kind !== "price-at-time") return undefined;
  const p = decoded.params;
  return p.source === PriceSource.Chainlink
    ? chainlinkFeedName(deployment, p.feed)
    : pythFeedName(deployment, p.pythId);
}

/**
 * A plain sentence built from the decoded params. Used only when the resolver's own `describe()`
 * is unavailable; the resolver's text is the rule of record.
 */
export function fallbackHeadline(deployment: Deployment, decoded: DecodedParams): string {
  if (decoded.kind === "perpl-funding") {
    const p = decoded.params;
    const perp = perpName(deployment, p.perpId) ?? `perp ${p.perpId.toString()}`;
    const what =
      p.threshold === 0n
        ? `${perp} longs pay shorts on net`
        : `${perp} longs pay more than ${p.threshold.toString()} (raw Perpl units) in funding`;
    return `Will ${what} on Perpl between block ${formatInt(p.startBlock)} and block ${formatInt(p.endBlock)}?`;
  }
  if (decoded.kind === "price-at-time") {
    const p = decoded.params;
    const asset = priceAssetName(deployment, decoded) ?? "the asset";
    return `Will ${asset} be at or above ${formatE8Usd(p.strikeE8)} at ${formatUtc(p.closeTime)}?`;
  }
  return "Market with an unknown template";
}

export interface SourceItem {
  label: string;
  value: string;
  href?: string;
  mono?: boolean;
}

export interface SourceDescription {
  title: string;
  items: SourceItem[];
  /** Who the market trusts beyond the chain, in plain words. */
  trust: string;
}

/** What the market reads at settlement, with explorer links. */
export function describeSource(
  deployment: Deployment,
  decoded: DecodedParams,
  resolver: Address,
): SourceDescription {
  const resolverItem: SourceItem = {
    label: "Resolver",
    value: resolver,
    href: addressUrl(deployment, resolver),
    mono: true,
  };

  if (decoded.kind === "perpl-funding") {
    const p = decoded.params;
    const exchange = deployment.external.perpl.exchange;
    const perp = perpName(deployment, p.perpId);
    return {
      title: "Perpl funding history",
      items: [
        resolverItem,
        { label: "Perpl Exchange", value: exchange, href: addressUrl(deployment, exchange), mono: true },
        {
          label: "Perp",
          value: perp ? `${perp} (id ${p.perpId.toString()})` : `id ${p.perpId.toString()}`,
        },
        {
          label: "Window",
          value: `block ${formatInt(p.startBlock)} to block ${formatInt(p.endBlock)}`,
          mono: true,
        },
        {
          label: "Threshold",
          value:
            p.threshold === 0n
              ? "0 (longs pay shorts on net)"
              : `${p.threshold.toString()} raw Perpl funding units`,
          mono: true,
        },
        { label: "Funding scale exponent", value: p.expectedScalingExp.toString(), mono: true },
      ],
      trust:
        "Perpl's funding rates are set by Perpl's own price administrator, and a 3-of-7 multisig can upgrade its Exchange. This market pays on what Perpl records.",
    };
  }

  if (decoded.kind === "price-at-time") {
    const p = decoded.params;
    const strike = { label: "Strike", value: formatE8Usd(p.strikeE8), mono: true };
    const observation = { label: "Observed at", value: formatUtc(p.closeTime) };
    if (p.source === PriceSource.Chainlink) {
      const name = chainlinkFeedName(deployment, p.feed);
      return {
        title: name ? `Chainlink ${name}` : "Chainlink price feed",
        items: [
          resolverItem,
          { label: "Chainlink feed", value: p.feed, href: addressUrl(deployment, p.feed), mono: true },
          strike,
          observation,
        ],
        trust:
          "Chainlink's node operators publish the price. Settlement accepts only the round that brackets the observation time.",
      };
    }
    const name = pythFeedName(deployment, p.pythId);
    const pyth = deployment.external.pyth.contract;
    return {
      title: name ? `Pyth ${name}` : "Pyth price feed",
      items: [
        resolverItem,
        { label: "Pyth contract", value: pyth, href: addressUrl(deployment, pyth), mono: true },
        { label: "Pyth price id", value: shortHash(p.pythId), mono: true },
        strike,
        observation,
      ],
      trust:
        "Pyth's publishers sign the price. Settlement accepts only the first update published at or after the observation time.",
    };
  }

  return {
    title: "Unknown template",
    items: [resolverItem],
    trust: "This app does not recognise the template, so it cannot describe the source.",
  };
}

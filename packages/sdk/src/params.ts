import {
  type ChainlinkTouchParams,
  type Deployment,
  decodeChainlinkTouchParams,
  decodeParlayParams,
  decodePerplFundingParams,
  decodePerplFundingSpikeParams,
  decodePriceAtTimeParams,
  decodePriceRangeParams,
  decodeSnapshotParams,
  encodeChainlinkTouchParams,
  encodeParlayParams,
  encodePerplFundingParams,
  encodePerplFundingSpikeParams,
  encodePriceAtTimeParams,
  encodePriceRangeParams,
  encodeSnapshotParams,
  type ParlayParams,
  type PerplFundingParams,
  type PerplFundingSpikeParams,
  type PriceAtTimeParams,
  type PriceRangeParams,
  PriceSource,
  type SnapshotParams,
  TemplateId,
} from "@hunch-book/shared";
import type { Address, Hex } from "viem";

// A market's parameters for templates 1 to 7, decoded with the shared codecs (whose ABI shapes come
// from contracts/src/interfaces/ITemplates*.sol), and the names the deployments file gives their
// perps and feeds. docs/TEMPLATES.md describes every template.

export type DecodedParams =
  | { kind: "perpl-funding"; templateId: 1; params: PerplFundingParams }
  | { kind: "price-at-time"; templateId: 2; params: PriceAtTimeParams }
  | { kind: "chainlink-touch"; templateId: 3; params: ChainlinkTouchParams }
  | { kind: "perpl-funding-spike"; templateId: 4; params: PerplFundingSpikeParams }
  | { kind: "price-range"; templateId: 5; params: PriceRangeParams }
  | { kind: "parlay"; templateId: 6; params: ParlayParams }
  | { kind: "snapshot"; templateId: 7; params: SnapshotParams }
  | { kind: "unknown"; templateId: number; raw: Hex };

export type TemplateKind = DecodedParams["kind"];

/** The parameters for a new market, typed per template. `encodeMarketParams` turns them into bytes. */
export type MarketParamsInput =
  | { templateId: 1; params: PerplFundingParams }
  | { templateId: 2; params: PriceAtTimeParams }
  | { templateId: 3; params: ChainlinkTouchParams }
  | { templateId: 4; params: PerplFundingSpikeParams }
  | { templateId: 5; params: PriceRangeParams }
  | { templateId: 6; params: ParlayParams }
  | { templateId: 7; params: SnapshotParams };

/** Decodes a market's params. Never throws: bytes that do not decode come back as "unknown". */
export function decodeMarketParams(templateId: number, params: Hex): DecodedParams {
  try {
    switch (templateId) {
      case TemplateId.PerplFunding:
        return { kind: "perpl-funding", templateId, params: decodePerplFundingParams(params) };
      case TemplateId.PriceAtTime:
        return { kind: "price-at-time", templateId, params: decodePriceAtTimeParams(params) };
      case TemplateId.ChainlinkTouch:
        return { kind: "chainlink-touch", templateId, params: decodeChainlinkTouchParams(params) };
      case TemplateId.PerplFundingSpike:
        return { kind: "perpl-funding-spike", templateId, params: decodePerplFundingSpikeParams(params) };
      case TemplateId.PriceRange:
        return { kind: "price-range", templateId, params: decodePriceRangeParams(params) };
      case TemplateId.Parlay:
        return { kind: "parlay", templateId, params: decodeParlayParams(params) };
      case TemplateId.Snapshot:
        return { kind: "snapshot", templateId, params: decodeSnapshotParams(params) };
    }
  } catch {
    // fall through: malformed bytes for a known template
  }
  return { kind: "unknown", templateId, raw: params };
}

/** Encodes typed params in the one canonical encoding each resolver accepts (parlay legs sorted). */
export function encodeMarketParams(input: MarketParamsInput): Hex {
  switch (input.templateId) {
    case TemplateId.PerplFunding:
      return encodePerplFundingParams(input.params);
    case TemplateId.PriceAtTime:
      return encodePriceAtTimeParams(input.params);
    case TemplateId.ChainlinkTouch:
      return encodeChainlinkTouchParams(input.params);
    case TemplateId.PerplFundingSpike:
      return encodePerplFundingSpikeParams(input.params);
    case TemplateId.PriceRange:
      return encodePriceRangeParams(input.params);
    case TemplateId.Parlay:
      return encodeParlayParams(input.params);
    case TemplateId.Snapshot:
      return encodeSnapshotParams(input.params);
  }
}

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** "BTC" for Perpl perp 16 on testnet, from the deployments file. */
export function perpName(deployment: Deployment, perpId: bigint): string | null {
  const entry = Object.entries(deployment.external.perpl.perps).find(([, id]) => BigInt(id) === perpId);
  return entry?.[0] ?? null;
}

/** "BTC/USD" for a Chainlink proxy the deployments file lists. */
export function chainlinkFeedName(deployment: Deployment, feed: Address): string | null {
  return Object.entries(deployment.external.chainlink).find(([, a]) => same(a, feed))?.[0] ?? null;
}

/** "SOL/USD" for a Pyth price id the deployments file lists. */
export function pythFeedName(deployment: Deployment, id: Hex): string | null {
  return Object.entries(deployment.external.pyth.ids).find(([, known]) => same(known, id))?.[0] ?? null;
}

/**
 * What a market is about, for lists and filters: the perp's symbol for Perpl templates ("BTC"), the
 * feed's pair for price templates ("BTC/USD"), null for parlays and unknown templates. A snapshot
 * market's asset depends on its resolver's source, so `getMarket` fills it in from `source(sourceId)`.
 */
export function marketAsset(deployment: Deployment, decoded: DecodedParams): string | null {
  switch (decoded.kind) {
    case "perpl-funding":
    case "perpl-funding-spike":
      return perpName(deployment, decoded.params.perpId);
    case "price-at-time":
    case "price-range":
      return decoded.params.source === PriceSource.Chainlink
        ? chainlinkFeedName(deployment, decoded.params.feed)
        : pythFeedName(deployment, decoded.params.pythId);
    case "chainlink-touch":
      return chainlinkFeedName(deployment, decoded.params.feed);
    default:
      return null;
  }
}

/** True if `asset` names this market's asset: "BTC" matches both perp BTC and feed BTC/USD. */
export function assetMatches(marketAssetName: string | null, asset: string): boolean {
  if (!marketAssetName) return false;
  const want = asset.trim().toUpperCase();
  const have = marketAssetName.toUpperCase();
  return have === want || have.split("/")[0] === want.split("/")[0];
}

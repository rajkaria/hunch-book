import {
  type Deployment,
  decodeChainlinkTouchParams,
  decodeParlayParams,
  decodePerplFundingParams,
  decodePerplFundingSpikeParams,
  decodePriceAtTimeParams,
  decodePriceRangeParams,
  decodeSnapshotParams,
  PriceSource,
  type SnapshotComparator,
  TemplateId,
  TouchDirection,
} from "@hunch-book/shared";
import type { Address, Hex } from "viem";
import { perpName } from "../market/params";
import { DAY, HOUR } from "./price";

// A link into /create can carry a market's exact parameters: `?template=<id>&params=<ABI-encoded>`
// (lib/ladder/prefill.ts builds them for the ladder and parlay pages). This decodes them with the shared
// template decoders and maps them to what each template's form holds, so the form opens filled in. The
// form still checks every field, and the person still reviews it before the first stake.

/** Templates 1 and 4: the exact blocks and the threshold in Perpl's raw units. */
export interface PerplLinked {
  kind: "perpl";
  /** The asset key in deployments (BTC, MON...), or null when this network does not list the perp. */
  asset: string | null;
  perpId: bigint;
  startBlock: bigint;
  endBlock: bigint;
  threshold: bigint;
}

/** Templates 2 and 5: the feed, the level or range in 8 decimals, and the times. */
export interface PriceLinked {
  kind: "price";
  /** PriceFeedOption.key: "chainlink:<address>" or "pyth:<id>", lower case. */
  feedKey: string;
  strikeE8: bigint | null;
  lowerE8: bigint | null;
  upperE8: bigint | null;
  lockTime: number;
  closeTime: number;
}

/** Template 3. */
export interface TouchLinked {
  kind: "touch";
  feedKey: string;
  direction: "above" | "below";
  strikeE8: bigint;
  lockTime: number;
  startTime: number;
  endTime: number;
}

/** Template 6. */
export interface ParlayLinked {
  kind: "parlay";
  legs: Address[];
  lockTime: number;
  closeTime: number;
}

/** Template 7: the threshold stays in the source's raw units until the form knows its decimals. */
export interface SnapshotLinked {
  kind: "snapshot";
  sourceId: number;
  threshold: bigint;
  comparator: SnapshotComparator;
  lockTime: number;
  closeTime: number;
  window: number;
}

export type LinkedParams = PerplLinked | PriceLinked | TouchLinked | ParlayLinked | SnapshotLinked;

/** Where a prefilled link came from, for the note above the form. */
export type LinkSource = "ladder" | "parlay" | "link";

export interface LinkedPrefill {
  templateId: number;
  params: LinkedParams;
  from: LinkSource;
}

const chainlinkKey = (feed: Address): string => `chainlink:${feed.toLowerCase()}`;
const priceKey = (source: number, feed: Address, pythId: Hex): string =>
  source === PriceSource.Pyth ? `pyth:${pythId.toLowerCase()}` : chainlinkKey(feed);

/**
 * The params for `templateId`, decoded for its form, or null when they do not decode as that
 * template's params (a malformed or mismatched link). Never throws.
 */
export function decodeLinkedParams(
  templateId: number,
  params: Hex,
  deployment: Deployment,
): LinkedParams | null {
  try {
    switch (templateId) {
      case TemplateId.PerplFunding:
      case TemplateId.PerplFundingSpike: {
        const p =
          templateId === TemplateId.PerplFunding
            ? decodePerplFundingParams(params)
            : decodePerplFundingSpikeParams(params);
        return {
          kind: "perpl",
          asset: perpName(deployment, p.perpId) ?? null,
          perpId: p.perpId,
          startBlock: p.startBlock,
          endBlock: p.endBlock,
          threshold: p.threshold,
        };
      }
      case TemplateId.PriceAtTime: {
        const p = decodePriceAtTimeParams(params);
        return {
          kind: "price",
          feedKey: priceKey(p.source, p.feed, p.pythId),
          strikeE8: p.strikeE8,
          lowerE8: null,
          upperE8: null,
          lockTime: Number(p.lockTime),
          closeTime: Number(p.closeTime),
        };
      }
      case TemplateId.PriceRange: {
        const p = decodePriceRangeParams(params);
        return {
          kind: "price",
          feedKey: priceKey(p.source, p.feed, p.pythId),
          strikeE8: null,
          lowerE8: p.lowerE8,
          upperE8: p.upperE8,
          lockTime: Number(p.lockTime),
          closeTime: Number(p.closeTime),
        };
      }
      case TemplateId.ChainlinkTouch: {
        const p = decodeChainlinkTouchParams(params);
        return {
          kind: "touch",
          feedKey: chainlinkKey(p.feed),
          direction: p.direction === TouchDirection.AtOrBelow ? "below" : "above",
          strikeE8: p.strikeE8,
          lockTime: Number(p.lockTime),
          startTime: Number(p.startTime),
          endTime: Number(p.endTime),
        };
      }
      case TemplateId.Parlay: {
        const p = decodeParlayParams(params);
        return {
          kind: "parlay",
          legs: [...p.legs],
          lockTime: Number(p.lockTime),
          closeTime: Number(p.closeTime),
        };
      }
      case TemplateId.Snapshot: {
        const p = decodeSnapshotParams(params);
        return {
          kind: "snapshot",
          sourceId: p.sourceId,
          threshold: p.threshold,
          comparator: p.comparator,
          lockTime: Number(p.lockTime),
          closeTime: Number(p.closeTime),
          window: p.snapshotWindow,
        };
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/**
 * The lock lead a price or snapshot form shows for a lock and close: one of the presets when the gap
 * matches it exactly, else "custom" with the lock as its own time.
 */
export function lockLeadOf(lockTime: number, closeTime: number): "day" | "hour" | "custom" {
  const gap = closeTime - lockTime;
  if (gap === DAY) return "day";
  if (gap === HOUR) return "hour";
  return "custom";
}

/** `?from=` as a known source, else "link". */
export function parseLinkSource(value: string | null | undefined): LinkSource {
  return value === "ladder" || value === "parlay" ? value : "link";
}

const pad2 = (n: number): string => n.toString().padStart(2, "0");

/**
 * Unix seconds to a `datetime-local` value in the browser's time zone, with seconds when they are not
 * zero, so a linked time goes back into the params to the second (lib/create/clock.ts `fromLocalInput`
 * reads both forms).
 */
export function toExactLocalInput(unix: number): string {
  const d = new Date(unix * 1000);
  const minute = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return d.getSeconds() === 0 ? minute : `${minute}:${pad2(d.getSeconds())}`;
}

import {
  type Address,
  decodeAbiParameters,
  encodeAbiParameters,
  getAbiItem,
  type Hex,
  keccak256,
} from "viem";
import {
  templateParamsCodecAbi,
  templateParamsCodecV2Abi,
  templateParamsCodecV3Abi,
} from "./abis/generated.js";
import { TemplateId } from "./types.js";

// Encoders for market params. The ABI shapes come from contracts/src/interfaces/ITemplates.sol
// (templates 1 and 2), ITemplatesV2.sol (templates 3 to 6) and ITemplatesV3.sol (template 7), so
// TypeScript and Solidity cannot drift apart. docs/TEMPLATES.md describes every template.

// ---------------------------------------------------------------- template ids

export interface TemplateInfo {
  id: TemplateId;
  /** Short plain-text name for lists and filters. */
  label: string;
  /** The question shape, in plain words. */
  question: string;
  /** "block": lock and close are block numbers (Perpl); "time": unix seconds. */
  clock: "block" | "time";
  /** True if YES can be proved before close (touch templates). */
  earlyYes: boolean;
}

/** What each template id means. The ids themselves are `TemplateId` (types.ts). */
export const TEMPLATES: Readonly<Record<TemplateId, TemplateInfo>> = {
  [TemplateId.PerplFunding]: {
    id: TemplateId.PerplFunding,
    label: "Perpl net funding",
    question: "Will longs pay more than X in funding on a Perpl perp between two blocks?",
    clock: "block",
    earlyYes: false,
  },
  [TemplateId.PriceAtTime]: {
    id: TemplateId.PriceAtTime,
    label: "Price at a time",
    question: "Will an asset be at or above a price at a set time?",
    clock: "time",
    earlyYes: false,
  },
  [TemplateId.ChainlinkTouch]: {
    id: TemplateId.ChainlinkTouch,
    label: "Price touch",
    question:
      "Will an asset's Chainlink feed report a price at or above (or at or below) a level in any round in a window?",
    clock: "time",
    earlyYes: true,
  },
  [TemplateId.PerplFundingSpike]: {
    id: TemplateId.PerplFundingSpike,
    label: "Perpl funding spike",
    question: "Will any single funding event on a Perpl perp charge longs more than X in a window?",
    clock: "block",
    earlyYes: true,
  },
  [TemplateId.PriceRange]: {
    id: TemplateId.PriceRange,
    label: "Price range",
    question: "Will an asset be at or above one price and below another at a set time?",
    clock: "time",
    earlyYes: false,
  },
  [TemplateId.Parlay]: {
    id: TemplateId.Parlay,
    label: "Parlay",
    question: "Will every one of these Hunch Book markets settle YES?",
    clock: "time",
    earlyYes: false,
  },
  [TemplateId.Snapshot]: {
    id: TemplateId.Snapshot,
    label: "Snapshot",
    question:
      "Will a value read onchain right after close, such as Perpl open interest or mark price, be above or below a level?",
    clock: "time",
    earlyYes: false,
  },
};

export function isTemplateId(id: number): id is TemplateId {
  return Object.hasOwn(TEMPLATES, id);
}

/** "Price touch" for 3; "Template 9" for an id this package does not know. */
export function templateLabel(id: number): string {
  return isTemplateId(id) ? TEMPLATES[id].label : `Template ${id}`;
}

// ---------------------------------------------------------------- templates 1 and 2

export interface PerplFundingParams {
  perpId: bigint;
  startBlock: bigint;
  endBlock: bigint;
  threshold: bigint;
  expectedScalingExp: number;
}

export const PriceSource = { Chainlink: 0, Pyth: 1 } as const;
export type PriceSource = (typeof PriceSource)[keyof typeof PriceSource];

export interface PriceAtTimeParams {
  source: PriceSource;
  feed: Address;
  pythId: Hex;
  strikeE8: bigint;
  lockTime: bigint;
  closeTime: bigint;
}

const perplInputs = getAbiItem({ abi: templateParamsCodecAbi, name: "perplFunding" }).inputs;
const priceInputs = getAbiItem({ abi: templateParamsCodecAbi, name: "priceAtTime" }).inputs;

export function encodePerplFundingParams(params: PerplFundingParams): Hex {
  return encodeAbiParameters(perplInputs, [params]);
}

export function decodePerplFundingParams(data: Hex): PerplFundingParams {
  const [decoded] = decodeAbiParameters(perplInputs, data);
  return decoded;
}

export function encodePriceAtTimeParams(params: PriceAtTimeParams): Hex {
  return encodeAbiParameters(priceInputs, [params]);
}

export function decodePriceAtTimeParams(data: Hex): PriceAtTimeParams {
  const [decoded] = decodeAbiParameters(priceInputs, data);
  return { ...decoded, source: decoded.source as PriceSource };
}

// ---------------------------------------------------------------- templates 3 to 6

/** Template 3: which side of the strike counts as a touch. Equal counts in both directions. */
export const TouchDirection = { AtOrAbove: 0, AtOrBelow: 1 } as const;
export type TouchDirection = (typeof TouchDirection)[keyof typeof TouchDirection];

/** Template 3, touch: proved YES by pointing at a Chainlink round in [startTime, endTime]. */
export interface ChainlinkTouchParams {
  feed: Address;
  strikeE8: bigint;
  direction: TouchDirection;
  lockTime: bigint;
  startTime: bigint;
  endTime: bigint;
}

/** Template 4, funding spike: proved YES by pointing at a single funding event in (startBlock, endBlock]. */
export interface PerplFundingSpikeParams {
  perpId: bigint;
  startBlock: bigint;
  endBlock: bigint;
  threshold: bigint;
  expectedScalingExp: number;
}

/** Template 5, price range: YES if lowerE8 <= price at closeTime < upperE8. */
export interface PriceRangeParams {
  source: PriceSource;
  feed: Address;
  pythId: Hex;
  lowerE8: bigint;
  upperE8: bigint;
  lockTime: bigint;
  closeTime: bigint;
}

/** Template 6, parlay: YES if every leg settles YES, NO if any leg settles NO. */
export interface ParlayParams {
  legs: readonly Address[];
  lockTime: bigint;
  closeTime: bigint;
}

/**
 * Template 3's challenge period after the window, in seconds. Template 4's is in blocks and fixed per
 * resolver deployment: read `challengeBlocks()` from it.
 */
export const TOUCH_CHALLENGE_SECONDS = 86_400n;
/** Template 6 leg count limits. */
export const PARLAY_MIN_LEGS = 2;
export const PARLAY_MAX_LEGS = 5;

const touchInputs = getAbiItem({ abi: templateParamsCodecV2Abi, name: "chainlinkTouch" }).inputs;
const spikeInputs = getAbiItem({ abi: templateParamsCodecV2Abi, name: "perplFundingSpike" }).inputs;
const rangeInputs = getAbiItem({ abi: templateParamsCodecV2Abi, name: "priceRange" }).inputs;
const parlayInputs = getAbiItem({ abi: templateParamsCodecV2Abi, name: "parlay" }).inputs;

export function encodeChainlinkTouchParams(params: ChainlinkTouchParams): Hex {
  return encodeAbiParameters(touchInputs, [params]);
}

export function decodeChainlinkTouchParams(data: Hex): ChainlinkTouchParams {
  const [decoded] = decodeAbiParameters(touchInputs, data);
  return { ...decoded, direction: decoded.direction as TouchDirection };
}

export function encodePerplFundingSpikeParams(params: PerplFundingSpikeParams): Hex {
  return encodeAbiParameters(spikeInputs, [params]);
}

export function decodePerplFundingSpikeParams(data: Hex): PerplFundingSpikeParams {
  const [decoded] = decodeAbiParameters(spikeInputs, data);
  return decoded;
}

export function encodePriceRangeParams(params: PriceRangeParams): Hex {
  return encodeAbiParameters(rangeInputs, [params]);
}

export function decodePriceRangeParams(data: Hex): PriceRangeParams {
  const [decoded] = decodeAbiParameters(rangeInputs, data);
  return { ...decoded, source: decoded.source as PriceSource };
}

/**
 * The legs in the only order the resolver accepts: strictly increasing as numbers. A parlay is a set,
 * so the order carries no meaning; one order per set keeps one market per question.
 * Throws on a repeated leg or a count outside 2 to 5.
 */
export function canonicalParlayLegs(legs: readonly Address[]): Address[] {
  const sorted = [...legs].sort((a, b) => {
    const x = BigInt(a);
    const y = BigInt(b);
    return x < y ? -1 : x > y ? 1 : 0;
  });
  for (let i = 1; i < sorted.length; i++) {
    if (BigInt(sorted[i] as Address) === BigInt(sorted[i - 1] as Address)) {
      throw new Error(`parlay leg ${sorted[i]} appears twice`);
    }
  }
  if (sorted.length < PARLAY_MIN_LEGS || sorted.length > PARLAY_MAX_LEGS) {
    throw new Error(`a parlay has ${PARLAY_MIN_LEGS} to ${PARLAY_MAX_LEGS} legs, not ${sorted.length}`);
  }
  return sorted;
}

/** Encodes with the legs in canonical order (see `canonicalParlayLegs`). */
export function encodeParlayParams(params: ParlayParams): Hex {
  return encodeAbiParameters(parlayInputs, [{ ...params, legs: canonicalParlayLegs(params.legs) }]);
}

export function decodeParlayParams(data: Hex): ParlayParams {
  const [decoded] = decodeAbiParameters(parlayInputs, data);
  return decoded;
}

// ---------------------------------------------------------------- template 7

/** Template 7: how the snapshot value is compared with the threshold. */
export const SnapshotComparator = { Above: 0, AtOrAbove: 1, Below: 2, AtOrBelow: 3 } as const;
export type SnapshotComparator = (typeof SnapshotComparator)[keyof typeof SnapshotComparator];

/**
 * Template 7, snapshot: YES if the source's value, read once in the first snapshot taken in
 * [closeTime, closeTime + snapshotWindow], meets `threshold` under `comparator`. `sourceId` indexes the
 * resolver's source list (read it with `sourceCount()` and `source(id)`); `threshold` is in the
 * source's raw units.
 */
export interface SnapshotParams {
  sourceId: number;
  threshold: bigint;
  comparator: SnapshotComparator;
  lockTime: bigint;
  closeTime: bigint;
  snapshotWindow: number;
}

/** SnapshotResolver.MIN_SNAPSHOT_WINDOW and MAX_SNAPSHOT_WINDOW, in seconds. */
export const SNAPSHOT_MIN_WINDOW = 60;
export const SNAPSHOT_MAX_WINDOW = 1_800;
/** The window the app offers by default: ten minutes. */
export const SNAPSHOT_DEFAULT_WINDOW = 600;

const snapshotInputs = getAbiItem({ abi: templateParamsCodecV3Abi, name: "snapshot" }).inputs;

export function encodeSnapshotParams(params: SnapshotParams): Hex {
  return encodeAbiParameters(snapshotInputs, [params]);
}

export function decodeSnapshotParams(data: Hex): SnapshotParams {
  const [decoded] = decodeAbiParameters(snapshotInputs, data);
  return { ...decoded, comparator: decoded.comparator as SnapshotComparator };
}

/**
 * Same as SnapshotStore.snapshotKey: keccak256(abi.encode(uint16 sourceId, uint64 closeTime,
 * uint32 snapshotWindow)). Every market on one source, close time and window shares this snapshot.
 */
export function snapshotKey(sourceId: number, closeTime: bigint, snapshotWindow: number): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "uint16" }, { type: "uint64" }, { type: "uint32" }],
      [sourceId, closeTime, snapshotWindow],
    ),
  );
}

// ---------------------------------------------------------------- evidence

/**
 * A Chainlink round id as evidence: the bracketing round for templates 2 and 5, or the touching
 * round for a template 3 proof. Round ids are (phaseId << 64) | aggregatorRoundId.
 */
export function encodeRoundEvidence(roundId: bigint): Hex {
  return encodeAbiParameters([{ type: "uint80" }], [roundId]);
}

/** A template 4 proof: the block of the funding event that spiked. */
export function encodeFundingEventEvidence(eventBlock: bigint): Hex {
  return encodeAbiParameters([{ type: "uint64" }], [eventBlock]);
}

/** Empty evidence: templates 1, 6 and 7 always, and the NO path of templates 3 and 4. */
export const EMPTY_EVIDENCE: Hex = "0x";

/** Same as HunchBookFactory.marketKey: keccak256(abi.encode(templateId, params)). */
export function marketKey(templateId: number, params: Hex): Hex {
  return keccak256(encodeAbiParameters([{ type: "uint32" }, { type: "bytes" }], [templateId, params]));
}

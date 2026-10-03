import {
  type Address,
  decodeAbiParameters,
  encodeAbiParameters,
  getAbiItem,
  type Hex,
  keccak256,
} from "viem";
import { templateParamsCodecAbi } from "./abis/generated.js";

// Encoders for market params. The ABI shapes come from contracts/src/interfaces/ITemplates.sol,
// so TypeScript and Solidity cannot drift apart.

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

/** Same as HunchBookFactory.marketKey: keccak256(abi.encode(templateId, params)). */
export function marketKey(templateId: number, params: Hex): Hex {
  return keccak256(encodeAbiParameters([{ type: "uint32" }, { type: "bytes" }], [templateId, params]));
}

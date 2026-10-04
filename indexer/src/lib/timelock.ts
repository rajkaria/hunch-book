import type { Enum } from "envio";
import { decodeFunctionData, type Hex } from "viem";
import { formatDecimal } from "./params.js";

// TemplateTimelock operations carry the full factory calldata. The timelock can queue exactly four
// calls (contracts/src/periphery/TemplateTimelock.sol); these are their signatures on IHunchBookFactory.
// test/periphery.test.ts checks them against the ABI generated from the contracts.

/** TemplateTimelock.GRACE_PERIOD: an operation runs from readyAt until readyAt plus this. */
export const TIMELOCK_GRACE_PERIOD_SECONDS = 14n * 24n * 60n * 60n;

export const timelockCallsAbi = [
  {
    type: "function",
    name: "addTemplate",
    stateMutability: "nonpayable",
    inputs: [
      { name: "templateId", type: "uint32" },
      { name: "resolver", type: "address" },
      {
        name: "rule",
        type: "tuple",
        components: [
          { name: "minPool", type: "uint128" },
          { name: "minStakers", type: "uint32" },
          { name: "minChanceBps", type: "uint16" },
          { name: "maxChanceBps", type: "uint16" },
        ],
      },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "setCaps",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "caps",
        type: "tuple",
        components: [
          { name: "poolCap", type: "uint128" },
          { name: "walletCap", type: "uint128" },
          { name: "minStake", type: "uint128" },
          { name: "creatorMinStake", type: "uint128" },
        ],
      },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "setCollateralCap",
    stateMutability: "nonpayable",
    inputs: [{ name: "cap", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "transferGuardian",
    stateMutability: "nonpayable",
    inputs: [{ name: "pending", type: "address" }],
    outputs: [],
  },
] as const;

/** What the indexer stores about a queued call: its kind, a sentence, and its arguments. */
export interface TimelockCall {
  kind: Enum<"TimelockOperationKind">;
  summary: string;
  templateId?: bigint;
  resolver?: string;
  minPool?: bigint;
  minStakers?: bigint;
  minChanceBps?: bigint;
  maxChanceBps?: bigint;
  poolCap?: bigint;
  walletCap?: bigint;
  minStake?: bigint;
  creatorMinStake?: bigint;
  collateralCap?: bigint;
  pendingGuardian?: string;
}

const usdc = (amount: bigint): string => `${formatDecimal(amount, 6)} USDC`;
const percent = (bps: bigint): string => `${formatDecimal(bps, 2)}%`;

/** Decodes a timelock operation's calldata. Never throws: anything else is Unknown, by its selector. */
export function decodeTimelockCall(data: string): TimelockCall {
  const selector = data.slice(0, 10).toLowerCase();
  try {
    const call = decodeFunctionData({ abi: timelockCallsAbi, data: data as Hex });
    switch (call.functionName) {
      case "addTemplate": {
        const [templateId, resolver, rule] = call.args;
        const id = BigInt(templateId);
        return {
          kind: "AddTemplate",
          summary: `Add template ${id} with resolver ${resolver.toLowerCase()}. A market graduates with at least ${usdc(rule.minPool)} staked by at least ${rule.minStakers} wallets, at a chance from ${percent(BigInt(rule.minChanceBps))} to ${percent(BigInt(rule.maxChanceBps))}.`,
          templateId: id,
          resolver: resolver.toLowerCase(),
          minPool: rule.minPool,
          minStakers: BigInt(rule.minStakers),
          minChanceBps: BigInt(rule.minChanceBps),
          maxChanceBps: BigInt(rule.maxChanceBps),
        };
      }
      case "setCaps": {
        const [caps] = call.args;
        return {
          kind: "SetCaps",
          summary: `Set the caps for new markets: a pool of at most ${usdc(caps.poolCap)}, at most ${usdc(caps.walletCap)} per wallet, stakes of at least ${usdc(caps.minStake)}, and a creator's first stake of at least ${usdc(caps.creatorMinStake)}.`,
          poolCap: caps.poolCap,
          walletCap: caps.walletCap,
          minStake: caps.minStake,
          creatorMinStake: caps.creatorMinStake,
        };
      }
      case "setCollateralCap": {
        const [cap] = call.args;
        return {
          kind: "SetCollateralCap",
          summary: `Set the vault's collateral cap to ${usdc(cap)}.`,
          collateralCap: cap,
        };
      }
      case "transferGuardian": {
        const [pending] = call.args;
        return {
          kind: "TransferGuardian",
          summary: `Start handing the guardian role to ${pending.toLowerCase()}, which must then accept it.`,
          pendingGuardian: pending.toLowerCase(),
        };
      }
    }
  } catch {
    // Only the four typed queue functions create operations, so this only guards the indexer.
  }
  return { kind: "Unknown", summary: `A call with selector ${selector} that the indexer does not decode.` };
}

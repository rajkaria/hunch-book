// Mirrors contracts/src/interfaces/IHunchBookTypes.sol. Enum values match the Solidity ordinals.

export const Phase = {
  Pool: 0,
  PoolLocked: 1,
  Graduated: 2,
  Closed: 3,
  Settled: 4,
  Voided: 5,
} as const;
export type Phase = (typeof Phase)[keyof typeof Phase];

export const Side = { Yes: 0, No: 1 } as const;
export type Side = (typeof Side)[keyof typeof Side];

export const Outcome = { Unresolved: 0, Yes: 1, No: 2 } as const;
export type Outcome = (typeof Outcome)[keyof typeof Outcome];

export const PHASE_LABEL: Record<Phase, string> = {
  [Phase.Pool]: "Pool",
  [Phase.PoolLocked]: "Pool locked",
  [Phase.Graduated]: "Trading",
  [Phase.Closed]: "Closed",
  [Phase.Settled]: "Settled",
  [Phase.Voided]: "Voided",
};

export interface Window {
  blockClock: boolean;
  lock: bigint;
  close: bigint;
  settleDeadline: bigint;
}

export interface GraduationRule {
  minPool: bigint;
  minStakers: number;
  minChanceBps: number;
  maxChanceBps: number;
}

export interface MarketCaps {
  poolCap: bigint;
  walletCap: bigint;
  minStake: bigint;
  creatorMinStake: bigint;
}

/** Template ids registered with the factory. docs/TEMPLATES.md describes each one. */
export const TemplateId = {
  PerplFunding: 1,
  PriceAtTime: 2,
  ChainlinkTouch: 3,
  PerplFundingSpike: 4,
  PriceRange: 5,
  Parlay: 6,
  Snapshot: 7,
} as const;
export type TemplateId = (typeof TemplateId)[keyof typeof TemplateId];

/** USDC and outcome tokens both use 6 decimals. */
export const USDC_DECIMALS = 6;
export const ONE_USDC = 1_000_000n;

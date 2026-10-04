import { type GraduationRule, type MarketCaps, PriceSource, type Window } from "@hunch-book/shared";
import { formatBpsPercent, formatUsdc } from "../format";
import { voidTerms } from "../market/logic";
import { type Head, type Pace, timeAt, uncertaintySeconds } from "./clock";
import type { TemplateKind } from "./templates";

// What the preview says about a market before it exists: its window, how it graduates, what it
// costs and what happens if the source never answers (docs/PROTOCOL.md §2, §5).

/** Pool fee on winnings (φ), in basis points. */
export const POOL_FEE_BPS = 200;
/** The creator's share of every fee the market pays, in basis points. */
export const CREATOR_SHARE_BPS = 2_500;

export interface WindowPoint {
  key: "lock" | "close" | "challenge" | "deadline";
  title: string;
  note: string;
  /** The block, for block-clock points. */
  block: bigint | null;
  /** Unix seconds; an estimate for block-clock points. */
  unix: number | null;
  estimated: boolean;
  /** Seconds either side of an estimate. */
  plusMinus: number | null;
}

/**
 * Lock, close, the end of a touch market's challenge period (when given) and the settlement
 * deadline, with estimated clock times for block-clock markets.
 */
export function windowPoints(
  window: Window,
  clock: { head: Head; pace: Pace } | null,
  challengeEnd: { block: bigint | null; unix: number | null } | null = null,
): WindowPoint[] {
  const at = (key: "lock" | "close", value: bigint): Omit<WindowPoint, "title" | "note"> => {
    if (!window.blockClock) {
      return { key, block: null, unix: Number(value), estimated: false, plusMinus: null };
    }
    return {
      key,
      block: value,
      unix: clock ? timeAt(value, clock.head, clock.pace.msPerBlock) : null,
      estimated: true,
      plusMinus: clock ? uncertaintySeconds(value, clock.head, clock.pace) : null,
    };
  };
  const challenge: WindowPoint[] = challengeEnd
    ? [
        {
          key: "challenge",
          title: "Challenge period ends",
          note: "YES can be proved any time before this. If nobody has, NO can settle from here.",
          block: challengeEnd.block,
          unix: challengeEnd.unix,
          estimated: challengeEnd.block !== null,
          plusMinus:
            challengeEnd.block !== null && clock
              ? uncertaintySeconds(challengeEnd.block, clock.head, clock.pace)
              : null,
        },
      ]
    : [];
  return [
    { ...at("lock", window.lock), title: "Lock", note: "Staking and graduation stop." },
    { ...at("close", window.close), title: "Close", note: "The observation ends and settlement opens." },
    ...challenge,
    {
      key: "deadline",
      title: "Settlement deadline",
      note: "Anyone can settle up to here. After it, the only action left is void.",
      block: null,
      unix: Number(window.settleDeadline),
      estimated: false,
      plusMinus: null,
    },
  ];
}

/** The graduation rule in plain words (§5.3). */
export function ruleLines(rule: GraduationRule): string[] {
  return [
    `A pool of at least ${formatUsdc(rule.minPool)} USDC`,
    `At least ${rule.minStakers} different wallets staking`,
    "Stakes on both YES and NO",
    `A pool chance of YES between ${formatBpsPercent(rule.minChanceBps)} and ${formatBpsPercent(rule.maxChanceBps)}`,
  ];
}

/** The limits every market created now copies (§10.3). */
export function capLines(caps: MarketCaps): { label: string; value: string }[] {
  return [
    { label: "Pool cap", value: `${formatUsdc(caps.poolCap)} USDC` },
    { label: "Most one wallet can stake", value: `${formatUsdc(caps.walletCap)} USDC` },
    { label: "Smallest stake", value: `${formatUsdc(caps.minStake)} USDC` },
    { label: "Smallest first stake (yours)", value: `${formatUsdc(caps.creatorMinStake)} USDC` },
  ];
}

/** Fees, from the creator's side (§5.7). */
export const FEE_LINES: readonly string[] = [
  `Winners pay ${formatBpsPercent(POOL_FEE_BPS)} of their winnings as a fee. Nobody pays a fee to stake.`,
  `As the creator you earn ${formatBpsPercent(CREATOR_SHARE_BPS)} of every fee this market pays, withdrawable onchain.`,
  "If only one side has stakes at settlement, or the market voids as a pool, every stake is refunded in full.",
];

const PERPL_VOID =
  "It voids if Perpl upgrades its Exchange to a new version, pauses or removes the perp, or changes its funding units before settlement, or if nobody settles it by the deadline.";
const PROVER =
  "YES needs one honest prover: Hunch Book's keeper watches every touch market and submits proofs, and anyone else can too, from the same public data.";

/** What a market from this template trusts and why it could void, then what a void pays. */
export function voidLines(kind: TemplateKind, window: Window, source?: PriceSource): string[] {
  let why: string[];
  switch (kind) {
    case "perpl-funding":
      why = [PERPL_VOID];
      break;
    case "perpl-spike":
      why = [PROVER, PERPL_VOID];
      break;
    case "price-touch":
      why = [
        PROVER,
        "NO needs the feed to report a round after the window. If the feed goes dark, or nobody settles by the deadline, the market voids.",
      ];
      break;
    case "parlay":
      why = ["It voids if a leg voids while no leg has settled NO, or if nobody settles it by the deadline."];
      break;
    default:
      why = [
        source === PriceSource.Pyth
          ? "It voids if no Pyth update is published within 60 seconds after the close, or if nobody settles it by the deadline."
          : "It voids unless Chainlink publishes a round in the hour up to the close and another after it, or if nobody settles it by the deadline.",
      ];
  }
  return [...why, ...voidTerms({ graduated: false, window })];
}

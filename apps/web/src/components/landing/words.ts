import type { GraduationRule } from "@hunch-book/shared";
import { REPO_URL } from "@/lib/config";
import { formatBpsPercent, formatFixed, formatInt } from "@/lib/format";

// Small helpers that turn chain values into words for the landing page, and links into the docs.

export const PROTOCOL_URL = `${REPO_URL}/blob/main/docs/PROTOCOL.md`;

/** Sections of PROTOCOL.md on GitHub, by the anchors GitHub generates from the headings. */
export const PROTOCOL = {
  lifecycle: `${PROTOCOL_URL}#4-market-lifecycle`,
  collateral: `${PROTOCOL_URL}#51-collateral`,
  graduation: `${PROTOCOL_URL}#53-graduation`,
  book: `${PROTOCOL_URL}#54-book-phase`,
  void: `${PROTOCOL_URL}#56-void`,
  fees: `${PROTOCOL_URL}#57-fee-summary`,
  settlement: `${PROTOCOL_URL}#6-settlement-and-templates`,
  access: `${PROTOCOL_URL}#73-access-control`,
  maker: `${PROTOCOL_URL}#92-maker-bot-open-source-labelled`,
  invariants: `${PROTOCOL_URL}#101-invariants-enforced-by-foundry-invariant-tests`,
  threats: `${PROTOCOL_URL}#102-threats-and-answers`,
  limitations: `${PROTOCOL_URL}#11-known-limitations`,
} as const;

/** "500 USDC", without trailing zeros, for prose. */
export const usdcWords = (base: bigint): string => `${formatFixed(base, 6, { maxDecimals: 2 })} USDC`;

/** The graduation rule in words, from the chain. */
export function ruleWords(rule: GraduationRule): string {
  return `at least ${usdcWords(rule.minPool)} from at least ${formatInt(rule.minStakers)} wallets, with a chance between ${formatBpsPercent(rule.minChanceBps)} and ${formatBpsPercent(rule.maxChanceBps)}`;
}

/** "0.40 seconds" from a measured block time. */
export function blockTimeWords(msPerBlock: number): string {
  return `${(msPerBlock / 1000).toFixed(2)} seconds`;
}

/** A book's 1e18 price (Kuru v1's scale) as USDC per YES token with three decimals: "0.380". */
export function priceWords(priceE18: bigint): string {
  return formatFixed(priceE18, 18, { minDecimals: 3, maxDecimals: 3 });
}

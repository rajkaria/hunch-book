import type { Deployment, PeripheryContracts } from "@hunch-book/shared";
import type { Address } from "viem";
import { describeTxError } from "../wallet/errors";

// Shared bits for the periphery features (docs/PERIPHERY.md): which contracts this network has, and
// plain words for their custom errors. Addresses come only from deployments/<network>.json.

export type PeripheryName = Exclude<
  keyof PeripheryContracts,
  | "timelockProposer"
  | "timelockDelay"
  | "distributorFunder"
  | "referralDuration"
  | "deployBlock"
  | "deployTxs"
>;

/** A periphery contract's address on this deployment, or undefined while it is not deployed there. */
export function peripheryAddress(deployment: Deployment, name: PeripheryName): Address | undefined {
  const value = deployment.hunchBook.periphery?.[name];
  return typeof value === "string" ? (value as Address) : undefined;
}

/** The first block any periphery contract exists at, for log scans. */
export function peripheryDeployBlock(deployment: Deployment): bigint {
  const block = deployment.hunchBook.periphery?.deployBlock ?? deployment.hunchBook.deployBlock ?? 0;
  return BigInt(block);
}

/** Plain words for the periphery contracts' custom errors, by name. */
const PERIPHERY_ERRORS: Record<string, string> = {
  // ConditionalOrders
  TipTooHigh: "The executor tip can be at most 0.5%.",
  BadTrigger: "The trigger price must be between 0 and 1 USDC.",
  BadExpiry: "The expiry must be in the future.",
  UnknownOrder: "That order does not exist.",
  OrderNotOpen: "That order is no longer open: it was executed or cancelled.",
  OrderExpired: "That order has expired. It can only be cancelled.",
  NotTriggered: "The book price has not reached that order's trigger.",
  NotOwner: "Only the wallet that placed an order can cancel it.",
  // AutoRedeemer
  NotOptedIn: "That wallet has not turned on auto-redeem.",
  NothingToRedeem: "There is nothing to redeem for that wallet.",
  UnknownToken: "That token is not a YES or NO token of a Hunch Book market.",
  PermitFailed: "The token refused the signed approval. Approve it with a transaction instead.",
  // ReferralRegistry
  SelfReferral: "You cannot use your own referral link.",
  AlreadyBound: "This wallet is already bound to a referrer. A binding lasts 180 days and cannot be changed.",
  SignatureExpired: "The signature expired. Sign again.",
  InvalidSignature: "The signature does not match this wallet.",
  // MerkleDistributor
  InvalidProof: "The proof does not match this epoch's published root.",
  AlreadyClaimed: "This reward was already claimed.",
  ClaimWindowClosed: "The claim window for this epoch has closed.",
  UnknownEpoch: "That reward epoch does not exist onchain yet.",
  ExceedsTotal: "That claim would take the epoch past its total. Nothing was paid.",
  ZeroAddress: "An address in this request is empty.",
};

const REFUSED = /^The contract refused with (\w+)\.$/;

/** One sentence for any error from a periphery call: the periphery names first, then the app's own words. */
export function describePeripheryError(error: unknown): string {
  return peripheryMessage(describeTxError(error));
}

/** Rewrites the tx runner's "refused with X." fallback into plain words when X is a periphery error. */
export function peripheryMessage(text: string): string;
export function peripheryMessage(text: string | null): string | null;
export function peripheryMessage(text: string | null): string | null {
  if (text === null) return null;
  const match = REFUSED.exec(text);
  const name = match?.[1];
  return (name && PERIPHERY_ERRORS[name]) ?? text;
}

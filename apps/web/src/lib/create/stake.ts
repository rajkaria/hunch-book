import type { MarketCaps } from "@hunch-book/shared";
import { formatUsdc } from "../format";

// The creator's first stake (docs/PROTOCOL.md §5.2): at least the factory's creatorMinStake, at most
// one wallet's cap (and never more than the pool cap), and no more than the wallet holds.

/** The most a first stake can be under these caps. */
export function maxFirstStake(caps: MarketCaps): bigint {
  return caps.walletCap < caps.poolCap ? caps.walletCap : caps.poolCap;
}

/** A reason the first stake cannot go ahead, or null. `amount` is null when the input is not a number. */
export function validateFirstStake(args: {
  input: string;
  amount: bigint | null;
  caps: MarketCaps;
  balance: bigint | null;
}): string | null {
  const { amount, caps, balance } = args;
  if (args.input.trim() === "") return null;
  if (amount === null) return "Enter an amount in USDC, like 25 or 25.50.";
  if (amount < caps.creatorMinStake) {
    return `The first stake must be at least ${formatUsdc(caps.creatorMinStake)} USDC.`;
  }
  const max = maxFirstStake(caps);
  if (amount > max) return `One wallet can stake at most ${formatUsdc(max)} USDC in a market.`;
  if (balance !== null && amount > balance) {
    return `Your wallet holds ${formatUsdc(balance)} USDC. Enter less, or get more first.`;
  }
  return null;
}

/** Where the creator is in the create sequence, so the panel shows one clear next action. */
export type CreateStep =
  | "connect"
  | "switch"
  | "loading"
  | "paused"
  | "fix-params"
  | "exists"
  | "enter-amount"
  | "approve"
  | "create";

export function nextCreateStep(s: {
  connected: boolean;
  wrongNetwork: boolean;
  ready: boolean;
  paused: boolean;
  paramsOk: boolean;
  exists: boolean;
  amountOk: boolean;
  allowance: bigint | null;
  amount: bigint | null;
}): CreateStep {
  if (s.paused) return "paused";
  if (s.exists) return "exists";
  if (!s.connected) return "connect";
  if (s.wrongNetwork) return "switch";
  if (!s.ready) return "loading";
  if (!s.paramsOk) return "fix-params";
  if (!s.amountOk || s.amount === null) return "enter-amount";
  if (s.allowance === null || s.allowance < s.amount) return "approve";
  return "create";
}

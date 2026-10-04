import { BPS, CREATOR_SHARE_BPS } from "@hunch-book/shared";
import type { Address } from "viem";
import type { Bind } from "./binds";

// The referral formula from docs/PERIPHERY.md ("The referral formula"), as pure functions. The registry
// decides who; the fee events decide how much. Paid per epoch through the MerkleDistributor, so what this
// computes is an estimate until an epoch file publishes the real amount.

/** The share of the protocol's part of each fee a referrer earns, as planned (published with each epoch). */
export const PLANNED_REFERRAL_SHARE_BPS = 2_000n;

/** The 75% of a fee the protocol keeps: fee − ⌊fee · 2500 / 10000⌋. The creator's 25% is never shared. */
export function protocolShare(fee: bigint): bigint {
  return fee - (fee * CREATOR_SHARE_BPS) / BPS;
}

/** ⌊protocolShare(fee) · shareBps / 10000⌋: one fee event's credit to the referrer. */
export function referralCredit(fee: bigint, shareBps: bigint = PLANNED_REFERRAL_SHARE_BPS): bigint {
  return (protocolShare(fee) * shareBps) / BPS;
}

/** One fee-paying event: a vault redemption (to the user) or a pool payout (to the user). */
export interface FeeEvent {
  /** Lowercase address of the user who paid the fee. */
  user: string;
  fee: bigint;
  /** Unix seconds of the block. */
  timestamp: bigint;
}

export interface CreditEstimate {
  total: bigint;
  /** Fee events that fell inside an active binding. */
  counted: number;
  /** Credit per referred user, lowercase address to amount. */
  perUser: Map<string, bigint>;
}

/**
 * Sums the credit for every event paid by a user while bound to this referrer
 * (boundAt <= timestamp < expiresAt). A user who bound twice (after an expiry) counts in both windows.
 */
export function estimateCredit(
  binds: readonly Pick<Bind, "user" | "boundAt" | "expiresAt">[],
  events: readonly FeeEvent[],
  shareBps: bigint = PLANNED_REFERRAL_SHARE_BPS,
): CreditEstimate {
  const windows = new Map<string, { from: bigint; to: bigint }[]>();
  for (const b of binds) {
    const key = b.user.toLowerCase();
    const list = windows.get(key) ?? [];
    list.push({ from: b.boundAt, to: b.expiresAt });
    windows.set(key, list);
  }
  let total = 0n;
  let counted = 0;
  const perUser = new Map<string, bigint>();
  for (const e of events) {
    const user = e.user.toLowerCase();
    const inWindow = windows.get(user)?.some((w) => e.timestamp >= w.from && e.timestamp < w.to);
    if (!inWindow) continue;
    const credit = referralCredit(e.fee, shareBps);
    total += credit;
    counted += 1;
    perUser.set(user, (perUser.get(user) ?? 0n) + credit);
  }
  return { total, counted, perUser };
}

/** The indexer's GraphQL endpoint, when the app is configured with one. */
export function indexerUrl(): string | null {
  const url = process.env.NEXT_PUBLIC_INDEXER_URL?.trim();
  return url ? url : null;
}

const FEE_EVENTS_QUERY = `query ReferralFees($users: [String!]!) {
  Redemption(where: { to: { _in: $users } }) { to fee timestamp }
  PoolPayout(where: { wallet_id: { _in: $users } }) { wallet_id fee timestamp }
}`;

interface FeeEventsResponse {
  data?: {
    Redemption?: { to: string; fee: string | number; timestamp: string | number }[];
    PoolPayout?: { wallet_id: string | null; fee: string | number; timestamp: string | number }[];
  };
  errors?: { message: string }[];
}

/**
 * Every fee event paid by `users`, from the indexer (Envio GraphQL: Redemption by recipient, PoolPayout by
 * wallet). Throws when the indexer answers with an error or does not answer in time.
 */
export async function fetchFeeEvents(
  url: string,
  users: readonly Address[],
  { fetchImpl = fetch, timeoutMs = 8_000 }: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<FeeEvent[]> {
  if (users.length === 0) return [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: FEE_EVENTS_QUERY,
        variables: { users: users.map((u) => u.toLowerCase()) },
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`The indexer answered ${res.status}.`);
    const body = (await res.json()) as FeeEventsResponse;
    if (body.errors?.length) throw new Error(body.errors[0]?.message ?? "The indexer returned an error.");
    const redemptions = (body.data?.Redemption ?? []).map((r) => ({
      user: r.to.toLowerCase(),
      fee: BigInt(r.fee),
      timestamp: BigInt(r.timestamp),
    }));
    const payouts = (body.data?.PoolPayout ?? [])
      .filter((p) => p.wallet_id)
      .map((p) => ({
        user: (p.wallet_id as string).toLowerCase(),
        fee: BigInt(p.fee),
        timestamp: BigInt(p.timestamp),
      }));
    return [...redemptions, ...payouts];
  } finally {
    clearTimeout(timer);
  }
}

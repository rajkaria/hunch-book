import { type Address, getAddress } from "viem";

// Batching for claimTokensFor / claimPoolFor: the claimable stakers, in order, cut into chunks of
// KEEPER_CLAIM_BATCH. A chunk whose gas estimate is over KEEPER_MAX_GAS_PER_TX is halved until it fits.

/** `items` cut into consecutive chunks of at most `size`. */
export function chunks<T>(items: readonly T[], size: number): T[][] {
  if (!Number.isInteger(size) || size < 1) throw new Error("chunk size must be a positive integer");
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** The two halves of a batch, for when the whole batch needs more gas than one transaction may use. */
export function halves<T>(items: readonly T[]): [T[], T[]] {
  const mid = Math.ceil(items.length / 2);
  return [items.slice(0, mid), items.slice(mid)];
}

/** Unique checksummed addresses, first occurrence first. */
export function uniqueAddresses(users: readonly string[]): Address[] {
  const seen = new Set<Address>();
  const out: Address[] = [];
  for (const user of users) {
    const a = getAddress(user);
    if (!seen.has(a)) {
      seen.add(a);
      out.push(a);
    }
  }
  return out;
}

/** The users whose claim is above zero, given the claims read for each (same order). */
export function claimableUsers(users: readonly Address[], amounts: readonly bigint[]): Address[] {
  return users.filter((_, i) => (amounts[i] ?? 0n) > 0n);
}

import { type Address, getAddress, type Hex, isAddress } from "viem";

// Hasura returns BigInt columns as strings (sometimes as numbers for small values), and ids as
// lowercase addresses or "<block>-<logIndex>". These turn rows into the app's types, never throwing on
// an odd value: a field that cannot be read becomes 0n, null or the zero address, never a crash.

/** A BigInt column, or 0n when it is missing or malformed. */
export function big(value: string | number | bigint | null | undefined): bigint {
  if (value === null || value === undefined) return 0n;
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

/** A nullable BigInt column. */
export function bigOrNull(value: string | number | bigint | null | undefined): bigint | null {
  if (value === null || value === undefined) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

/** A checksummed address from an indexer column. */
export function address(value: string | null | undefined): Address {
  return value && isAddress(value, { strict: false })
    ? getAddress(value)
    : "0x0000000000000000000000000000000000000000";
}

export function hash(value: string | null | undefined): Hex {
  return (value && /^0x[0-9a-fA-F]*$/.test(value) ? value : "0x") as Hex;
}

/** Block and log index from an event record's id ("<block>-<logIndex>"), for ordering. */
export function eventPosition(id: string): { block: bigint; logIndex: number } {
  const [b, l] = id.split("-");
  return { block: big(b), logIndex: Number(l ?? 0) || 0 };
}

import { type Address, getAddress, isAddress } from "viem";

/** A checksummed address from a route segment, or null for anything that is not one. */
export function parseAddressParam(raw: string): Address | null {
  let value: string;
  try {
    value = decodeURIComponent(raw).trim();
  } catch {
    return null;
  }
  return isAddress(value, { strict: false }) ? getAddress(value) : null;
}

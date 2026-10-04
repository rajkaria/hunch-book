import type { Network } from "@hunch-book/shared";
import { type Address, getAddress, type Hex, isAddress, isHex, zeroAddress } from "viem";

// Parsing for the two relayer routes' JSON bodies. Pure: the routes and the tests share it. Every
// error is a sentence the app can show as it is.

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const NETWORKS: readonly Network[] = ["monad-testnet", "monad-mainnet"];

function parseNetwork(value: unknown, fallback: Network): Parsed<Network> {
  if (value === undefined || value === null || value === "") return { ok: true, value: fallback };
  if (typeof value === "string" && (NETWORKS as readonly string[]).includes(value)) {
    return { ok: true, value: value as Network };
  }
  return { ok: false, error: `Unknown network. Use one of: ${NETWORKS.join(", ")}.` };
}

function parseAddress(value: unknown, name: string): Parsed<Address> {
  if (typeof value !== "string" || !isAddress(value, { strict: false })) {
    return { ok: false, error: `${name} is not an address.` };
  }
  const address = getAddress(value);
  if (address === zeroAddress) return { ok: false, error: `${name} cannot be the zero address.` };
  return { ok: true, value: address };
}

/** A non-negative integer given as a decimal string or a safe JS integer. */
export function parseUint(value: unknown, name: string): Parsed<bigint> {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return { ok: true, value: BigInt(value) };
  }
  if (typeof value === "string" && /^\d{1,78}$/.test(value.trim())) {
    const n = BigInt(value.trim());
    if (n < 2n ** 256n) return { ok: true, value: n };
  }
  return { ok: false, error: `${name} must be a whole number of base units, as a string.` };
}

function parseSide(value: unknown): Parsed<0 | 1> {
  if (value === 0 || value === "0" || value === "yes" || value === "YES") return { ok: true, value: 0 };
  if (value === 1 || value === "1" || value === "no" || value === "NO") return { ok: true, value: 1 };
  return { ok: false, error: 'side must be 0 or "yes" (YES), or 1 or "no" (NO).' };
}

function parseBytes32(value: unknown, name: string): Parsed<Hex> {
  if (typeof value === "string" && isHex(value, { strict: true }) && value.length === 66) {
    return { ok: true, value: value.toLowerCase() as Hex };
  }
  return { ok: false, error: `${name} must be 32 bytes of hex.` };
}

function parseSignature(value: unknown): Parsed<Hex> {
  // r (32) + s (32) + v (1): Market.stakeWithAuthorization reads exactly this layout.
  if (typeof value === "string" && isHex(value, { strict: true }) && value.length === 132) {
    return { ok: true, value: value as Hex };
  }
  return { ok: false, error: "signature must be 65 bytes of hex (r, s, v)." };
}

function asObject(body: unknown): Record<string, unknown> | null {
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
}

export interface DripRequest {
  address: Address;
  network: Network;
}

export function parseDripRequest(body: unknown, fallback: Network): Parsed<DripRequest> {
  const o = asObject(body);
  if (!o) return { ok: false, error: "Send a JSON object: { address, network }." };
  const address = parseAddress(o.address, "address");
  if (!address.ok) return address;
  const network = parseNetwork(o.network, fallback);
  if (!network.ok) return network;
  return { ok: true, value: { address: address.value, network: network.value } };
}

export interface RelayStakeRequest {
  network: Network;
  market: Address;
  user: Address;
  side: 0 | 1;
  amount: bigint;
  validAfter: bigint;
  validBefore: bigint;
  salt: Hex;
  signature: Hex;
}

export function parseRelayStakeRequest(body: unknown, fallback: Network): Parsed<RelayStakeRequest> {
  const o = asObject(body);
  if (!o) {
    return {
      ok: false,
      error: "Send a JSON object: { market, user, side, amount, validAfter, validBefore, salt, signature }.",
    };
  }
  const network = parseNetwork(o.network, fallback);
  if (!network.ok) return network;
  const market = parseAddress(o.market, "market");
  if (!market.ok) return market;
  const user = parseAddress(o.user, "user");
  if (!user.ok) return user;
  const side = parseSide(o.side);
  if (!side.ok) return side;
  const amount = parseUint(o.amount, "amount");
  if (!amount.ok) return amount;
  if (amount.value === 0n) return { ok: false, error: "amount must be above zero." };
  const validAfter = parseUint(o.validAfter, "validAfter");
  if (!validAfter.ok) return validAfter;
  const validBefore = parseUint(o.validBefore, "validBefore");
  if (!validBefore.ok) return validBefore;
  const salt = parseBytes32(o.salt, "salt");
  if (!salt.ok) return salt;
  const signature = parseSignature(o.signature);
  if (!signature.ok) return signature;
  return {
    ok: true,
    value: {
      network: network.value,
      market: market.value,
      user: user.value,
      side: side.value,
      amount: amount.value,
      validAfter: validAfter.value,
      validBefore: validBefore.value,
      salt: salt.value,
      signature: signature.value,
    },
  };
}

/**
 * The time window rules the relayer applies before it spends gas: the authorisation is valid now
 * (validAfter < now < validBefore, as the token checks), leaves at least `minSeconds` to land, and
 * does not reach further than `maxSeconds` into the future (a long-lived signature is a standing
 * order someone could replay into the same market later).
 */
export function checkValidity(
  r: Pick<RelayStakeRequest, "validAfter" | "validBefore">,
  nowSeconds: number,
  { minSeconds = 30, maxSeconds = 3_600 }: { minSeconds?: number; maxSeconds?: number } = {},
): string | null {
  const now = BigInt(Math.floor(nowSeconds));
  if (r.validAfter >= now)
    return "The authorisation is not valid yet. Check your device clock and sign again.";
  if (r.validBefore <= now + BigInt(minSeconds)) return "The authorisation expires too soon. Sign again.";
  if (r.validBefore > now + BigInt(maxSeconds)) {
    return `The authorisation must expire within ${maxSeconds / 60} minutes. Sign again.`;
  }
  return null;
}

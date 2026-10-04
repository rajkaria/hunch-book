import { type Address, type Hex, hashDomain, parseAbi, parseSignature } from "viem";

// EIP-2612 permits on outcome tokens, so the first auto-redeem approval and the opt-in go in one
// transaction (AutoRedeemer.optInWithPermit). Outcome tokens are Solady ERC20s: domain
// (name(), version "1", chainId, token). The domain is checked against the token's own DOMAIN_SEPARATOR
// before anyone is asked to sign, and the app falls back to approve + setOptIn if it does not match.

export const permitTokenAbi = parseAbi([
  "function name() view returns (string)",
  "function nonces(address owner) view returns (uint256)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
  "function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)",
]);

export const PERMIT_TYPES = {
  Permit: [
    { name: "owner", type: "address" },
    { name: "spender", type: "address" },
    { name: "value", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export interface PermitDomain {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: Address;
}

export function permitDomain(name: string, chainId: number, token: Address): PermitDomain {
  return { name, version: "1", chainId, verifyingContract: token };
}

/** True when the token's DOMAIN_SEPARATOR is the one this domain hashes to. */
export function domainMatches(domain: PermitDomain, separator: Hex): boolean {
  return (
    hashDomain({
      domain: { ...domain, chainId: BigInt(domain.chainId) },
      types: {
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "version", type: "string" },
          { name: "chainId", type: "uint256" },
          { name: "verifyingContract", type: "address" },
        ],
      },
    }).toLowerCase() === separator.toLowerCase()
  );
}

export interface PermitMessage {
  owner: Address;
  spender: Address;
  value: bigint;
  nonce: bigint;
  deadline: bigint;
}

/** The typed data the wallet signs. */
export function permitTypedData(domain: PermitDomain, message: PermitMessage) {
  return { domain, types: PERMIT_TYPES, primaryType: "Permit" as const, message };
}

/** A 65-byte signature as the v, r, s that permit takes. */
export function splitSignature(signature: Hex): { v: number; r: Hex; s: Hex } {
  const sig = parseSignature(signature);
  const v = sig.v !== undefined ? Number(sig.v) : 27 + (sig.yParity ?? 0);
  return { v, r: sig.r, s: sig.s };
}

/** How long a permit signature stays valid. */
export const PERMIT_TTL_SECONDS = 1_800;

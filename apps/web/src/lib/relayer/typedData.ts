import {
  type Address,
  encodeAbiParameters,
  type Hex,
  hashDomain,
  isAddressEqual,
  keccak256,
  type PublicClient,
  parseAbi,
  type TypedDataDomain,
} from "viem";

// The signed USDC authorisation behind a relayed stake (PROTOCOL.md §9.5). The user signs EIP-3009's
// ReceiveWithAuthorization for USDC with the market as `to`. Market.stakeWithAuthorization then pulls
// the USDC and stakes it in one call that anyone, here our relayer, can send. The EIP-3009 nonce must
// equal keccak256(abi.encode(chainId, market, user, side, salt)), so the signature is bound to one
// market, one user and one side: a relayer cannot move it anywhere else.

export const RECEIVE_WITH_AUTHORIZATION_TYPES = {
  ReceiveWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

/** The EIP-712 domain reads both Circle USDC and Hunch Book's test USDC answer. */
export const usdcDomainAbi = parseAbi([
  "function name() view returns (string)",
  "function version() view returns (string)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
  "function eip712Domain() view returns (bytes1 fields, string name, string version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] extensions)",
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
]);

/** Same as Market.authorizationNonce: keccak256(abi.encode(block.chainid, market, user, side, salt)). */
export function stakeAuthorizationNonce(args: {
  chainId: number;
  market: Address;
  user: Address;
  side: 0 | 1;
  salt: Hex;
}): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "uint256" }, { type: "address" }, { type: "address" }, { type: "uint8" }, { type: "bytes32" }],
      [BigInt(args.chainId), args.market, args.user, args.side, args.salt],
    ),
  );
}

export interface StakeAuthorization {
  market: Address;
  user: Address;
  side: 0 | 1;
  amount: bigint;
  validAfter: bigint;
  validBefore: bigint;
  salt: Hex;
}

/** The typed data the user signs for a relayed stake. `domain` comes from the token (readUsdcDomain). */
export function stakeTypedData(domain: TypedDataDomain, auth: StakeAuthorization) {
  const chainId = Number(domain.chainId);
  return {
    domain,
    types: RECEIVE_WITH_AUTHORIZATION_TYPES,
    primaryType: "ReceiveWithAuthorization" as const,
    message: {
      from: auth.user,
      to: auth.market,
      value: auth.amount,
      validAfter: auth.validAfter,
      validBefore: auth.validBefore,
      nonce: stakeAuthorizationNonce({
        chainId,
        market: auth.market,
        user: auth.user,
        side: auth.side,
        salt: auth.salt,
      }),
    },
  };
}

/** A random 32-byte salt from the platform's secure random source. */
export function randomSalt(): Hex {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

type DomainClient = Pick<PublicClient, "readContract">;

/** The four-field EIP-712 domain USDC uses. */
export interface UsdcDomain {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: Address;
}

/**
 * The token's EIP-712 domain, read from the token itself: EIP-5267 `eip712Domain()` when it has it,
 * otherwise `name()` and `version()`. Either way the result must hash to the token's own
 * DOMAIN_SEPARATOR(), or this throws rather than have someone sign for the wrong domain.
 */
export async function readUsdcDomain(
  client: DomainClient,
  token: Address,
  chainId: number,
): Promise<UsdcDomain> {
  const separator = await client.readContract({
    address: token,
    abi: usdcDomainAbi,
    functionName: "DOMAIN_SEPARATOR",
  });
  let domain: UsdcDomain;
  try {
    const d = await client.readContract({ address: token, abi: usdcDomainAbi, functionName: "eip712Domain" });
    domain = { name: d[1], version: d[2], chainId: Number(d[3]), verifyingContract: d[4] };
  } catch {
    const [name, version] = await Promise.all([
      client.readContract({ address: token, abi: usdcDomainAbi, functionName: "name" }),
      client.readContract({ address: token, abi: usdcDomainAbi, functionName: "version" }),
    ]);
    domain = { name, version, chainId, verifyingContract: token };
  }
  if (domain.chainId !== chainId || !isAddressEqual(domain.verifyingContract, token)) {
    throw new Error("The token's signing domain names another chain or contract. Refusing to sign.");
  }
  const computed = hashDomain({
    domain: { ...domain, chainId: BigInt(domain.chainId) },
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
    },
  });
  if (computed.toLowerCase() !== separator.toLowerCase()) {
    throw new Error("The token's signing domain does not match its DOMAIN_SEPARATOR. Refusing to sign.");
  }
  return domain;
}

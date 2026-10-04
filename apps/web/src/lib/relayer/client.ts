import type { Network } from "@hunch-book/shared";
import type { Address, Hex, PublicClient, TypedDataDomain } from "viem";
import { randomSalt, readUsdcDomain, type StakeAuthorization, stakeTypedData } from "./typedData";

// Browser side of the relayer routes. Every function resolves to a result object; network and
// server failures come back as { ok: false, error } with a sentence the UI can show.

export interface ServiceStatus {
  enabled: boolean;
  reason?: string;
  message?: string;
  amountMon?: string;
  belowMon?: string;
  maxStake?: string;
  maxValiditySeconds?: number;
}

export type RelayerResult =
  | { ok: true; hash: Hex; url: string; amountMon?: string }
  | { ok: false; error: string; reason?: string; faucet?: string };

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

const UNREACHABLE = "Could not reach the server. Check your connection and try again.";

async function getStatus(path: string, fetchImpl: Fetch): Promise<ServiceStatus> {
  try {
    const res = await fetchImpl(path, { cache: "no-store" });
    if (!res.ok) return { enabled: false, reason: "unavailable" };
    return (await res.json()) as ServiceStatus;
  } catch {
    return { enabled: false, reason: "unavailable" };
  }
}

async function post(path: string, body: unknown, fetchImpl: Fetch): Promise<RelayerResult> {
  try {
    const res = await fetchImpl(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
    });
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (res.ok && data?.ok === true && typeof data.hash === "string") {
      return {
        ok: true,
        hash: data.hash as Hex,
        url: String(data.url ?? ""),
        ...(typeof data.amountMon === "string" ? { amountMon: data.amountMon } : {}),
      };
    }
    return {
      ok: false,
      error: typeof data?.error === "string" ? data.error : `The server answered ${res.status}.`,
      ...(typeof data?.reason === "string" ? { reason: data.reason } : {}),
      ...(typeof data?.faucet === "string" ? { faucet: data.faucet } : {}),
    };
  } catch {
    return { ok: false, error: UNREACHABLE };
  }
}

export const fetchDripStatus = (fetchImpl: Fetch = fetch) => getStatus("/api/drip", fetchImpl);
export const fetchRelayStatus = (fetchImpl: Fetch = fetch) => getStatus("/api/relay/stake", fetchImpl);

export function requestDrip(
  address: Address,
  network: Network,
  fetchImpl: Fetch = fetch,
): Promise<RelayerResult> {
  return post("/api/drip", { address, network }, fetchImpl);
}

/** What the user signs and what the relay route receives, built from the token's own domain. */
export async function prepareRelayedStake(args: {
  client: Pick<PublicClient, "readContract">;
  chainId: number;
  usdc: Address;
  market: Address;
  user: Address;
  side: 0 | 1;
  amount: bigint;
  nowSeconds: number;
  /** How long the signature stays valid. Ten minutes by default; the relayer refuses more than an hour. */
  validForSeconds?: number;
  domain?: TypedDataDomain;
}) {
  const domain = args.domain ?? (await readUsdcDomain(args.client, args.usdc, args.chainId));
  const now = BigInt(Math.floor(args.nowSeconds));
  const auth: StakeAuthorization = {
    market: args.market,
    user: args.user,
    side: args.side,
    amount: args.amount,
    // A minute back, so a device clock slightly ahead of the chain still passes `validAfter < now`.
    validAfter: now > 60n ? now - 60n : 0n,
    validBefore: now + BigInt(args.validForSeconds ?? 600),
    salt: randomSalt(),
  };
  return { auth, typedData: stakeTypedData(domain, auth) };
}

export function submitRelayedStake(
  auth: StakeAuthorization,
  signature: Hex,
  network: Network,
  fetchImpl: Fetch = fetch,
): Promise<RelayerResult> {
  return post(
    "/api/relay/stake",
    {
      network,
      market: auth.market,
      user: auth.user,
      side: auth.side,
      amount: auth.amount.toString(),
      validAfter: auth.validAfter.toString(),
      validBefore: auth.validBefore.toString(),
      salt: auth.salt,
      signature,
    },
    fetchImpl,
  );
}

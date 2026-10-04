import { deployments, type Network } from "@hunch-book/shared";
import { type Hex, parseEther } from "viem";

// Server-side settings for the gas drip (POST /api/drip) and relayed stakes (POST /api/relay/stake).
// Read from the host's environment. Code and logs use variable names only: the key is never printed,
// returned or written anywhere. docs/ACCOUNTS.md lists every variable.

type Env = Record<string, string | undefined>;

export interface RelayerConfig {
  /** RELAYER_PRIVATE_KEY. Undefined: both routes answer 503 and the app falls back to "get a little MON". */
  privateKey: Hex | undefined;
  /** RPC per network: RELAYER_RPC_URL (the app's own network), else MONAD_<NETWORK>_RPC, else deployments. */
  rpc: Record<Network, string>;
  drip: {
    amountWei: bigint;
    /** Only addresses holding less than this get a drip. */
    belowWei: bigint;
    perIpPerDay: number;
    perDay: number;
    /** Mainnet drips are off unless DRIP_MAINNET=1. */
    mainnet: boolean;
  };
  relay: {
    /** Largest stake the relayer submits, USDC base units. */
    maxStake: bigint;
    perIpPerDay: number;
    perUserPerDay: number;
    perDay: number;
    /** Longest an authorisation may stay valid, seconds. */
    maxValiditySeconds: number;
    /** Mainnet relaying is off unless RELAY_MAINNET=1. */
    mainnet: boolean;
  };
  /** Upstash / Vercel KV REST endpoint for "already dripped" and rate counters. Memory when unset. */
  kv: { url: string; token: string } | undefined;
}

const on = (raw: string | undefined) =>
  raw !== undefined && ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());

function count(env: Env, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a whole number of zero or more`);
  return n;
}

function mon(env: Env, name: string, fallback: string): bigint {
  const raw = env[name]?.trim() || fallback;
  if (!/^\d+(\.\d{1,18})?$/.test(raw)) throw new Error(`${name} must be an amount of MON, like 0.05`);
  return parseEther(raw);
}

function usdc(env: Env, name: string, fallback: string): bigint {
  const raw = env[name]?.trim() || fallback;
  if (!/^\d+(\.\d{1,6})?$/.test(raw)) throw new Error(`${name} must be an amount of USDC, like 100`);
  const [whole = "0", frac = ""] = raw.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(frac.padEnd(6, "0"));
}

export function parseRelayerConfig(env: Env, appNetwork: Network = "monad-testnet"): RelayerConfig {
  const rawKey = env.RELAYER_PRIVATE_KEY?.trim();
  let privateKey: Hex | undefined;
  if (rawKey) {
    const key = rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`;
    if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("RELAYER_PRIVATE_KEY is not a 32-byte hex key");
    privateKey = key as Hex;
  }
  const override = env.RELAYER_RPC_URL?.trim();
  const rpc: Record<Network, string> = {
    "monad-testnet": env.MONAD_TESTNET_RPC?.trim() || deployments["monad-testnet"].rpc,
    "monad-mainnet": env.MONAD_MAINNET_RPC?.trim() || deployments["monad-mainnet"].rpc,
  };
  const kvUrl = (env.KV_REST_API_URL ?? env.UPSTASH_REDIS_REST_URL)?.trim();
  const kvToken = (env.KV_REST_API_TOKEN ?? env.UPSTASH_REDIS_REST_TOKEN)?.trim();
  return {
    privateKey,
    rpc: override ? { ...rpc, [appNetwork]: override } : rpc,
    drip: {
      amountWei: mon(env, "DRIP_AMOUNT_MON", "0.05"),
      belowWei: mon(env, "DRIP_BELOW_MON", "0.01"),
      perIpPerDay: count(env, "DRIP_IP_DAILY_CAP", 3),
      perDay: count(env, "DRIP_DAILY_CAP", 200),
      mainnet: on(env.DRIP_MAINNET),
    },
    relay: {
      maxStake: usdc(env, "RELAY_MAX_STAKE_USDC", "1000"),
      perIpPerDay: count(env, "RELAY_IP_DAILY_CAP", 20),
      perUserPerDay: count(env, "RELAY_USER_DAILY_CAP", 10),
      perDay: count(env, "RELAY_DAILY_CAP", 500),
      maxValiditySeconds: Math.max(60, count(env, "RELAY_MAX_VALIDITY_SECONDS", 3_600)),
      mainnet: on(env.RELAY_MAINNET),
    },
    kv: kvUrl && kvToken ? { url: kvUrl.replace(/\/+$/, ""), token: kvToken } : undefined,
  };
}

/** Whether a network is served, and the sentence to show when it is not. */
export function networkAllowed(
  config: RelayerConfig,
  network: Network,
  route: "drip" | "relay",
): string | null {
  if (network !== "monad-mainnet") return null;
  const allowed = route === "drip" ? config.drip.mainnet : config.relay.mainnet;
  if (allowed) return null;
  return route === "drip"
    ? "The gas drip runs on Monad testnet only. On mainnet you need a little MON in your account."
    : "Relayed stakes run on Monad testnet only for now. On mainnet you need a little MON to stake.";
}

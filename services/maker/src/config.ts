import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { deployments, type Network } from "@hunch-book/shared";
import { type Address, getAddress, type Hex, isAddress } from "viem";
import type { QuoteParams } from "./quotes.js";

// Everything the bot reads from the environment. Only variable names appear in code and logs;
// the key itself is never printed.

/** The protocol's floor on the quoted spread (docs/PROTOCOL.md §9.2). */
export const MIN_TOTAL_SPREAD = 0.02;

export interface MakerConfig {
  network: Network;
  /** Kill switch. Off: compute and print intended quotes, send nothing. */
  enabled: boolean;
  privateKey: Hex | undefined;
  rpcUrl: string;
  quote: QuoteParams;
  requoteThreshold: number;
  heartbeatSeconds: number;
  pollSeconds: number;
  closeBufferSeconds: number;
  widenSeconds: number;
  widenMax: number;
  maxGasPriceGwei: number;
  maxGasPerTx: bigint;
  /** Margin balances and set counts below this many tokens are left alone. */
  dustTokens: number;
  healthFile: string;
  healthPort: number | undefined;
  /** Quote only these markets when set. */
  markets: Address[] | undefined;
}

type Env = Record<string, string | undefined>;

const NETWORKS: Network[] = ["monad-testnet", "monad-mainnet"];

function num(env: Env, name: string, fallback: number, check: (x: number) => boolean, rule: string): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || !check(value)) throw new Error(`${name} must be ${rule} (got "${raw}")`);
  return value;
}

const positive = (x: number) => x > 0;
const nonNegative = (x: number) => x >= 0;

export function parseBool(raw: string | undefined): boolean {
  return raw !== undefined && ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

export function parseConfig(env: Env): MakerConfig {
  const network = (env.MAKER_NETWORK?.trim() || "monad-testnet") as Network;
  if (!NETWORKS.includes(network)) throw new Error(`MAKER_NETWORK must be one of ${NETWORKS.join(", ")}`);

  const enabled = parseBool(env.MAKER_ENABLED);
  const rawKey = env.MAKER_PRIVATE_KEY?.trim();
  let privateKey: Hex | undefined;
  if (rawKey) {
    const key = rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`;
    if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("MAKER_PRIVATE_KEY is not a 32-byte hex key");
    privateKey = key as Hex;
  }
  if (enabled && !privateKey) throw new Error("MAKER_ENABLED is on but MAKER_PRIVATE_KEY is not set");

  const networkRpc = network === "monad-testnet" ? env.MONAD_TESTNET_RPC : env.MONAD_MAINNET_RPC;
  const rpcUrl = env.MAKER_RPC_URL?.trim() || networkRpc?.trim() || deployments[network].rpc;

  const halfSpread = num(env, "MAKER_HALF_SPREAD", 0.015, nonNegative, "zero or more");
  const levels = num(
    env,
    "MAKER_LEVELS",
    1,
    (x) => Number.isInteger(x) && x >= 1 && x <= 5,
    "an integer 1-5",
  );
  const markets = env.MAKER_MARKETS?.split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      if (!isAddress(s)) throw new Error(`MAKER_MARKETS has a bad address: ${s}`);
      return getAddress(s);
    });

  const healthPortRaw = env.MAKER_HEALTH_PORT?.trim();
  return {
    network,
    enabled,
    privateKey,
    rpcUrl,
    quote: {
      halfSpread,
      minSpread: MIN_TOTAL_SPREAD,
      skew: num(env, "MAKER_SKEW", 0.02, nonNegative, "zero or more"),
      levels,
      levelStep: num(env, "MAKER_LEVEL_STEP", 0.01, positive, "above zero"),
      orderSize: num(env, "MAKER_ORDER_SIZE", 20, positive, "above zero"),
      inventoryCap: num(env, "MAKER_INVENTORY_CAP", 100, positive, "above zero"),
      minPrice: 0.01,
      maxPrice: 0.99,
    },
    requoteThreshold: num(env, "MAKER_REQUOTE_THRESHOLD", 0.005, positive, "above zero"),
    heartbeatSeconds: num(env, "MAKER_HEARTBEAT_SECONDS", 300, positive, "above zero"),
    pollSeconds: num(env, "MAKER_POLL_SECONDS", 10, positive, "above zero"),
    closeBufferSeconds: num(env, "MAKER_CLOSE_BUFFER_SECONDS", 120, nonNegative, "zero or more"),
    widenSeconds: num(env, "MAKER_WIDEN_SECONDS", 3600, nonNegative, "zero or more"),
    widenMax: num(env, "MAKER_WIDEN_MAX", 3, (x) => x >= 1, "1 or more"),
    maxGasPriceGwei: num(env, "MAKER_MAX_GAS_PRICE_GWEI", 200, positive, "above zero"),
    maxGasPerTx: BigInt(
      num(
        env,
        "MAKER_MAX_GAS_PER_TX",
        3_000_000,
        (x) => Number.isInteger(x) && x >= 100_000,
        "an integer of at least 100000",
      ),
    ),
    dustTokens: num(env, "MAKER_DUST", 1, nonNegative, "zero or more"),
    healthFile: env.MAKER_HEALTH_FILE?.trim() || fileURLToPath(new URL("../health.json", import.meta.url)),
    healthPort: healthPortRaw
      ? num(env, "MAKER_HEALTH_PORT", 0, (x) => Number.isInteger(x) && x > 0 && x < 65536, "a port number")
      : undefined,
    markets: markets && markets.length > 0 ? markets : undefined,
  };
}

/** The config as it is safe to log: the key is reduced to whether it is set. */
export function describeConfig(config: MakerConfig): Record<string, unknown> {
  const { privateKey, ...rest } = config;
  return { ...rest, privateKey: privateKey ? "set" : "missing" };
}

/** Parses a .env file: KEY=value lines, optional `export`, optional quotes, # comments. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = (match[2] as string).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      const hash = value.indexOf(" #");
      if (hash !== -1) value = value.slice(0, hash).trim();
    }
    out[match[1] as string] = value;
  }
  return out;
}

/** The bot reads only its own variables and the RPC URLs; other services' keys stay out of its process. */
export const isMakerVariable = (name: string) => name.startsWith("MAKER_") || name.startsWith("MONAD_");

/**
 * Loads the maker's variables from a .env file into `env`, without overriding variables already set.
 * Returns the names it set (never the values).
 */
export function loadEnvFile(path: string, env: Env = process.env): string[] {
  if (!existsSync(path)) return [];
  const loaded: string[] = [];
  for (const [name, value] of Object.entries(parseEnvFile(readFileSync(path, "utf8")))) {
    if (isMakerVariable(name) && env[name] === undefined) {
      env[name] = value;
      loaded.push(name);
    }
  }
  return loaded;
}

/** The repository root's .env (the checkout this package lives in). */
export const REPO_ENV_FILE = fileURLToPath(new URL("../../../.env", import.meta.url));

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { deployments, type Network } from "@hunch-book/shared";
import { type Address, getAddress, type Hex, isAddress } from "viem";

// Everything the keeper reads from the environment. Only variable names appear in code and logs;
// the key, the Pyth API key and the webhook URL are never printed.

export interface KeeperConfig {
  network: Network;
  /** Kill switch. Off: work out every action, simulate it, log it, send nothing. */
  enabled: boolean;
  privateKey: Hex | undefined;
  rpcUrl: string;
  /** Requests per second the keeper allows itself on the RPC. */
  rpcRequestsPerSecond: number;
  pollSeconds: number;
  maxGasPriceGwei: number;
  maxGasPerTx: bigint;
  /** Below this MON balance the keeper warns (and alerts, when a webhook is set). */
  minMon: number;
  /** Stakers per claimTokensFor / claimPoolFor transaction. */
  claimBatch: number;
  /** Blocks per eth_getLogs request. Monad's public RPCs refuse more than 100. */
  logRange: number;
  /** eth_getLogs requests the keeper may spend per cycle on scans, so one cycle never stalls on history. */
  scanRequestsPerCycle: number;
  /** First wait after a settlement attempt that could not go through; doubles up to the max. */
  settleRetrySeconds: number;
  settleRetryMaxSeconds: number;
  /** How often the keeper repeats a request to Kuru for one market's book (mainnet). */
  bookRequestSeconds: number;
  stateFile: string;
  healthFile: string;
  healthPort: number | undefined;
  alertWebhook: string | undefined;
  /** The same alert (same event, same market) is posted at most this often. */
  alertRepeatSeconds: number;
  /** Envio GraphQL endpoint. When set, stakers come from the indexer, with log scans as the fallback. */
  indexerUrl: string | undefined;
  pythApiKey: string | undefined;
  hermesUrl: string;
  /** Handle only these markets when set. */
  markets: Address[] | undefined;
  /** Cycle-level and proof jobs switched off by name (KEEPER_JOBS_OFF). */
  jobsOff: Set<OptionalJob>;
  /** Poke each market with a live book at most this often; 0 turns oracle pokes off. */
  oraclePokeSeconds: number;
  /** Markets per pokeMany transaction. */
  oracleBatch: number;
  /** Holders per redeemManyFor transaction. */
  redeemBatch: number;
  /** A settled market's opted-in holders are checked again this often. */
  redeemRecheckSeconds: number;
  /** The recurring series file; the series job is off when unset. */
  seriesFile: string | undefined;
  /** Second kill switch for creating series markets, which spends the keeper's own USDC. */
  seriesEnabled: boolean;
}

/** Jobs that can be switched off one by one with KEEPER_JOBS_OFF (the core jobs cannot). */
export const OPTIONAL_JOBS = ["prove", "snapshot", "autoRedeem", "orders", "oracle", "series"] as const;
export type OptionalJob = (typeof OPTIONAL_JOBS)[number];

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
const positiveInt = (x: number) => Number.isInteger(x) && x > 0;

export function parseBool(raw: string | undefined): boolean {
  return raw !== undefined && ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

function url(env: Env, name: string): string | undefined {
  const raw = env[name]?.trim();
  if (!raw) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${name} is not a URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error(`${name} must be http(s)`);
  return raw;
}

export function parseConfig(env: Env): KeeperConfig {
  const network = (env.KEEPER_NETWORK?.trim() || "monad-testnet") as Network;
  if (!NETWORKS.includes(network)) throw new Error(`KEEPER_NETWORK must be one of ${NETWORKS.join(", ")}`);

  const enabled = parseBool(env.KEEPER_ENABLED);
  const rawKey = env.KEEPER_PRIVATE_KEY?.trim();
  let privateKey: Hex | undefined;
  if (rawKey) {
    const key = rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`;
    if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("KEEPER_PRIVATE_KEY is not a 32-byte hex key");
    privateKey = key as Hex;
  }
  if (enabled && !privateKey) throw new Error("KEEPER_ENABLED is on but KEEPER_PRIVATE_KEY is not set");

  const networkRpc = network === "monad-testnet" ? env.MONAD_TESTNET_RPC : env.MONAD_MAINNET_RPC;
  const rpcUrl = env.KEEPER_RPC_URL?.trim() || networkRpc?.trim() || deployments[network].rpc;

  const markets = env.KEEPER_MARKETS?.split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      if (!isAddress(s)) throw new Error(`KEEPER_MARKETS has a bad address: ${s}`);
      return getAddress(s);
    });

  const settleRetrySeconds = num(env, "KEEPER_SETTLE_RETRY_SECONDS", 60, positive, "above zero");
  const settleRetryMaxSeconds = num(env, "KEEPER_SETTLE_RETRY_MAX_SECONDS", 1_800, positive, "above zero");
  if (settleRetryMaxSeconds < settleRetrySeconds) {
    throw new Error("KEEPER_SETTLE_RETRY_MAX_SECONDS must be at least KEEPER_SETTLE_RETRY_SECONDS");
  }

  const jobsOff = new Set<OptionalJob>();
  for (const name of env.KEEPER_JOBS_OFF?.split(",") ?? []) {
    const job = name.trim();
    if (!job) continue;
    if (!(OPTIONAL_JOBS as readonly string[]).includes(job)) {
      throw new Error(`KEEPER_JOBS_OFF has an unknown job "${job}" (known: ${OPTIONAL_JOBS.join(", ")})`);
    }
    jobsOff.add(job as OptionalJob);
  }

  const healthPortRaw = env.KEEPER_HEALTH_PORT?.trim();
  return {
    network,
    enabled,
    privateKey,
    rpcUrl,
    rpcRequestsPerSecond: num(env, "KEEPER_RPC_RPS", 10, positive, "above zero"),
    pollSeconds: num(env, "KEEPER_POLL_SECONDS", 15, positive, "above zero"),
    maxGasPriceGwei: num(env, "KEEPER_MAX_GAS_PRICE_GWEI", 200, positive, "above zero"),
    maxGasPerTx: BigInt(
      num(
        env,
        "KEEPER_MAX_GAS_PER_TX",
        6_000_000,
        (x) => Number.isInteger(x) && x >= 100_000,
        "an integer of at least 100000",
      ),
    ),
    minMon: num(env, "KEEPER_MIN_MON", 0.5, nonNegative, "zero or more"),
    claimBatch: num(
      env,
      "KEEPER_CLAIM_BATCH",
      50,
      (x) => positiveInt(x) && x <= 500,
      "an integer from 1 to 500",
    ),
    logRange: num(env, "KEEPER_LOG_RANGE", 100, (x) => positiveInt(x) && x <= 10_000, "an integer 1-10000"),
    scanRequestsPerCycle: num(env, "KEEPER_SCAN_REQUESTS_PER_CYCLE", 300, positiveInt, "a positive integer"),
    settleRetrySeconds,
    settleRetryMaxSeconds,
    bookRequestSeconds: num(env, "KEEPER_BOOK_REQUEST_SECONDS", 6 * 3_600, positive, "above zero"),
    stateFile:
      env.KEEPER_STATE_FILE?.trim() || fileURLToPath(new URL("../.keeper-state.json", import.meta.url)),
    healthFile: env.KEEPER_HEALTH_FILE?.trim() || fileURLToPath(new URL("../health.json", import.meta.url)),
    healthPort: healthPortRaw
      ? num(env, "KEEPER_HEALTH_PORT", 0, (x) => Number.isInteger(x) && x > 0 && x < 65536, "a port number")
      : undefined,
    alertWebhook: url(env, "KEEPER_ALERT_WEBHOOK"),
    alertRepeatSeconds: num(env, "KEEPER_ALERT_REPEAT_SECONDS", 1_800, nonNegative, "zero or more"),
    indexerUrl: url(env, "INDEXER_URL"),
    pythApiKey: env.PYTH_API_KEY?.trim() || undefined,
    hermesUrl: (url(env, "KEEPER_HERMES_URL") ?? "https://hermes.pyth.network").replace(/\/+$/, ""),
    markets: markets && markets.length > 0 ? markets : undefined,
    jobsOff,
    oraclePokeSeconds: num(env, "KEEPER_ORACLE_POKE_SECONDS", 1_800, nonNegative, "zero or more"),
    oracleBatch: num(
      env,
      "KEEPER_ORACLE_BATCH",
      25,
      (x) => positiveInt(x) && x <= 200,
      "an integer from 1 to 200",
    ),
    redeemBatch: num(
      env,
      "KEEPER_REDEEM_BATCH",
      50,
      (x) => positiveInt(x) && x <= 500,
      "an integer from 1 to 500",
    ),
    redeemRecheckSeconds: num(env, "KEEPER_REDEEM_RECHECK_SECONDS", 600, positive, "above zero"),
    seriesFile: env.KEEPER_SERIES_FILE?.trim() || undefined,
    seriesEnabled: parseBool(env.KEEPER_SERIES_ENABLED),
  };
}

/** Only the origin of a URL, which is safe to log (paths and queries can carry tokens). */
function origin(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value).origin;
  } catch {
    return "set";
  }
}

/** The config as it is safe to log: secrets are reduced to whether they are set. */
export function describeConfig(config: KeeperConfig): Record<string, unknown> {
  const { privateKey, pythApiKey, alertWebhook, indexerUrl, rpcUrl, jobsOff, ...rest } = config;
  return {
    ...rest,
    jobsOff: [...jobsOff],
    rpcUrl: rpcUrl === deployments[config.network].rpc ? rpcUrl : origin(rpcUrl),
    privateKey: privateKey ? "set" : "missing",
    pythApiKey: pythApiKey ? "set" : "missing",
    alertWebhook: alertWebhook ? `set (${origin(alertWebhook)})` : "off",
    indexerUrl: indexerUrl ? origin(indexerUrl) : "off",
  };
}

/** Strings that must never reach a log line or an alert: keys, and URLs that can embed tokens. */
export function secretsOf(config: KeeperConfig): string[] {
  const out = [config.privateKey, config.pythApiKey, config.alertWebhook, config.indexerUrl];
  if (config.rpcUrl !== deployments[config.network].rpc) out.push(config.rpcUrl);
  return out.filter((s): s is string => typeof s === "string" && s.length >= 8);
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

const SHARED_VARIABLES = new Set(["INDEXER_URL", "PYTH_API_KEY"]);

/** The keeper reads only its own variables, the RPC URLs, the indexer URL and the Pyth key. */
export const isKeeperVariable = (name: string) =>
  name.startsWith("KEEPER_") || name.startsWith("MONAD_") || SHARED_VARIABLES.has(name);

/**
 * Loads the keeper's variables from a .env file into `env`, without overriding variables already set.
 * Returns the names it set (never the values).
 */
export function loadEnvFile(path: string, env: Env = process.env): string[] {
  if (!existsSync(path)) return [];
  const loaded: string[] = [];
  for (const [name, value] of Object.entries(parseEnvFile(readFileSync(path, "utf8")))) {
    if (isKeeperVariable(name) && env[name] === undefined) {
      env[name] = value;
      loaded.push(name);
    }
  }
  return loaded;
}

/** The repository root's .env (the checkout this package lives in). */
export const REPO_ENV_FILE = fileURLToPath(new URL("../../../.env", import.meta.url));

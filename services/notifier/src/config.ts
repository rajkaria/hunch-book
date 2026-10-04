import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { deployments, type Network } from "@hunch-book/shared";

// Everything the notifier reads from the environment. Only variable names appear in code and logs;
// the bot token is never printed (it is also cut from every log line by log.ts).

export interface NotifierConfig {
  network: Network;
  /** Kill switch. Off: read the chain, work out every message, print it, talk to Telegram not at all. */
  enabled: boolean;
  telegramToken: string | undefined;
  /** True only when enabled and a token is set. */
  live: boolean;
  rpcUrl: string;
  pollSeconds: number;
  /** A move of the YES chance by at least this many basis points is a "big move". */
  priceMoveBps: number;
  appUrl: string;
  indexerUrl: string | undefined;
  subscriptionsFile: string;
  stateFile: string;
  healthFile: string;
  healthPort: number | undefined;
  /** Watches one chat may hold (markets and wallets together). */
  maxWatchesPerChat: number;
  /** Wallets watched across all chats, the bound on per-cycle position reads. */
  maxWallets: number;
}

type Env = Record<string, string | undefined>;

const NETWORKS: Network[] = ["monad-testnet", "monad-mainnet"];

export function parseBool(raw: string | undefined): boolean {
  return raw !== undefined && ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

function num(env: Env, name: string, fallback: number, check: (x: number) => boolean, rule: string): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || !check(value)) throw new Error(`${name} must be ${rule} (got "${raw}")`);
  return value;
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
  return raw.replace(/\/+$/, "");
}

const positiveInt = (x: number) => Number.isInteger(x) && x > 0;

export function parseConfig(env: Env): NotifierConfig {
  const network = (env.NOTIFIER_NETWORK?.trim() || "monad-testnet") as Network;
  if (!NETWORKS.includes(network)) throw new Error(`NOTIFIER_NETWORK must be one of ${NETWORKS.join(", ")}`);
  const token = env.TELEGRAM_BOT_TOKEN?.trim() || undefined;
  if (token && !/^\d+:[A-Za-z0-9_-]{30,}$/.test(token)) {
    throw new Error("TELEGRAM_BOT_TOKEN does not look like a bot token (digits:letters from @BotFather)");
  }
  const enabled = parseBool(env.NOTIFIER_ENABLED);
  const networkRpc = network === "monad-testnet" ? env.MONAD_TESTNET_RPC : env.MONAD_MAINNET_RPC;
  const healthPortRaw = env.NOTIFIER_HEALTH_PORT?.trim();
  return {
    network,
    enabled,
    telegramToken: token,
    live: enabled && token !== undefined,
    rpcUrl: env.NOTIFIER_RPC_URL?.trim() || networkRpc?.trim() || deployments[network].rpc,
    pollSeconds: num(env, "NOTIFIER_POLL_SECONDS", 30, (x) => x >= 5, "at least 5"),
    priceMoveBps: num(
      env,
      "NOTIFIER_PRICE_MOVE_BPS",
      1_000,
      (x) => positiveInt(x) && x <= 10_000,
      "1 to 10000",
    ),
    appUrl: url(env, "NOTIFIER_APP_URL") ?? "https://book.playhunch.xyz",
    indexerUrl: url(env, "INDEXER_URL"),
    subscriptionsFile:
      env.NOTIFIER_SUBSCRIPTIONS_FILE?.trim() ||
      fileURLToPath(new URL("../.subscriptions.json", import.meta.url)),
    stateFile:
      env.NOTIFIER_STATE_FILE?.trim() || fileURLToPath(new URL("../.notifier-state.json", import.meta.url)),
    healthFile: env.NOTIFIER_HEALTH_FILE?.trim() || fileURLToPath(new URL("../health.json", import.meta.url)),
    healthPort: healthPortRaw
      ? num(env, "NOTIFIER_HEALTH_PORT", 0, (x) => Number.isInteger(x) && x > 0 && x < 65536, "a port number")
      : undefined,
    maxWatchesPerChat: num(env, "NOTIFIER_MAX_WATCHES_PER_CHAT", 20, positiveInt, "a positive integer"),
    maxWallets: num(env, "NOTIFIER_MAX_WALLETS", 200, positiveInt, "a positive integer"),
  };
}

function origin(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value).origin;
  } catch {
    return "set";
  }
}

/** The config as it is safe to log. */
export function describeConfig(config: NotifierConfig): Record<string, unknown> {
  const { telegramToken, rpcUrl, indexerUrl, ...rest } = config;
  return {
    ...rest,
    telegramToken: telegramToken ? "set" : "missing",
    rpcUrl: rpcUrl === deployments[config.network].rpc ? rpcUrl : origin(rpcUrl),
    indexerUrl: indexerUrl ? origin(indexerUrl) : "off",
  };
}

/** Strings that must never reach a log line. */
export function secretsOf(config: NotifierConfig): string[] {
  const out = [config.telegramToken, config.indexerUrl];
  if (config.rpcUrl !== deployments[config.network].rpc) out.push(config.rpcUrl);
  return out.filter((s): s is string => typeof s === "string" && s.length >= 8);
}

/** KEY=value lines, optional `export`, optional quotes, # comments. */
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

/** The notifier reads only its own variables, the bot token, the RPC URLs and the indexer URL. */
export const isNotifierVariable = (name: string) =>
  name.startsWith("NOTIFIER_") ||
  name.startsWith("MONAD_") ||
  name === "TELEGRAM_BOT_TOKEN" ||
  name === "INDEXER_URL";

/** Loads the notifier's variables from a .env file, never overriding what is already set. Returns names. */
export function loadEnvFile(path: string, env: Env = process.env): string[] {
  if (!existsSync(path)) return [];
  const loaded: string[] = [];
  for (const [name, value] of Object.entries(parseEnvFile(readFileSync(path, "utf8")))) {
    if (isNotifierVariable(name) && env[name] === undefined) {
      env[name] = value;
      loaded.push(name);
    }
  }
  return loaded;
}

export const REPO_ENV_FILE = fileURLToPath(new URL("../../../.env", import.meta.url));

import type { Network } from "@hunch-book/shared";
import type { Hex } from "viem";

// The server's settings, all from environment variables (names only; values are never logged or
// returned). Without HUNCH_MCP_PRIVATE_KEY the server is read-only: write tools are not offered.

export interface McpConfig {
  network: Network;
  rpcUrl: string | undefined;
  /** The wallet's key. Kept out of every log line and tool result. */
  privateKey: Hex | undefined;
  /** Most USDC (base units) one write may spend or stake. */
  maxUsdcPerCall: bigint;
  /** Most outcome tokens (base units) one sell may sell. */
  maxTokensPerCall: bigint;
  /** Highest slippage allowance a trade may ask for, in basis points. */
  maxSlippageBps: bigint;
  /** Slippage when the caller names none. */
  defaultSlippageBps: bigint;
  /** Mainnet writes need an explicit yes. */
  allowMainnetWrites: boolean;
  pythApiKey: string | undefined;
}

const USDC = 1_000_000n;

function decimalToUnits(value: string, name: string): bigint {
  if (!/^\d+(\.\d{1,6})?$/.test(value.trim())) throw new Error(`${name} must be an amount like 100 or 12.5`);
  const [whole = "0", frac = ""] = value.trim().split(".");
  return BigInt(whole) * USDC + BigInt(frac.padEnd(6, "0"));
}

function bps(value: string | undefined, fallback: bigint, name: string): bigint {
  if (value === undefined || value.trim() === "") return fallback;
  if (!/^\d+$/.test(value.trim())) throw new Error(`${name} must be a whole number of basis points`);
  const n = BigInt(value.trim());
  if (n > 5_000n) throw new Error(`${name} must be at most 5000 (50%)`);
  return n;
}

export function parseConfig(env: Record<string, string | undefined>): McpConfig {
  const networkName = (env.HUNCH_MCP_NETWORK ?? "monad-testnet").trim().toLowerCase();
  if (networkName !== "monad-testnet" && networkName !== "monad-mainnet") {
    throw new Error('HUNCH_MCP_NETWORK must be "monad-testnet" or "monad-mainnet"');
  }
  const key = env.HUNCH_MCP_PRIVATE_KEY?.trim();
  let privateKey: Hex | undefined;
  if (key) {
    const hex = key.startsWith("0x") ? key : `0x${key}`;
    // The message never includes the value.
    if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) throw new Error("HUNCH_MCP_PRIVATE_KEY is not a 32-byte hex key");
    privateKey = hex as Hex;
  }
  const maxSlippageBps = bps(env.HUNCH_MCP_MAX_SLIPPAGE_BPS, 300n, "HUNCH_MCP_MAX_SLIPPAGE_BPS");
  const defaultSlippageBps = bps(env.HUNCH_MCP_DEFAULT_SLIPPAGE_BPS, 100n, "HUNCH_MCP_DEFAULT_SLIPPAGE_BPS");
  return {
    network: networkName,
    rpcUrl: env.HUNCH_MCP_RPC_URL?.trim() || undefined,
    privateKey,
    maxUsdcPerCall: decimalToUnits(env.HUNCH_MCP_MAX_USDC_PER_CALL ?? "100", "HUNCH_MCP_MAX_USDC_PER_CALL"),
    maxTokensPerCall: decimalToUnits(
      env.HUNCH_MCP_MAX_TOKENS_PER_CALL ?? "200",
      "HUNCH_MCP_MAX_TOKENS_PER_CALL",
    ),
    maxSlippageBps,
    defaultSlippageBps: defaultSlippageBps > maxSlippageBps ? maxSlippageBps : defaultSlippageBps,
    allowMainnetWrites: env.HUNCH_MCP_ALLOW_MAINNET_WRITES === "1",
    pythApiKey: env.HUNCH_MCP_PYTH_API_KEY?.trim() || undefined,
  };
}

/** True when write tools are offered: a key is set, and mainnet writes were allowed explicitly. */
export function writesEnabled(config: McpConfig): boolean {
  if (!config.privateKey) return false;
  return config.network !== "monad-mainnet" || config.allowMainnetWrites;
}

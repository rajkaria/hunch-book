// Runs the Envio CLI (`dev`, `start`) for one network and picks where logs come from:
// HyperSync when ENVIO_API_TOKEN is set (RPC as a fallback), otherwise the RPC alone
// (ENVIO_RPC_MODE=sync), 100 blocks per request because public Monad RPCs cap eth_getLogs there.
//
//   pnpm --filter @hunch-book/indexer dev                     testnet, config.yaml
//   pnpm --filter @hunch-book/indexer dev --network mainnet   mainnet, config.mainnet.yaml
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { INDEXER_DIR } from "./gen-config.js";

const CONFIGS: Record<string, string> = { testnet: "config.yaml", mainnet: "config.mainnet.yaml" };

/** Environment for the Envio process. Pure, so the choice is testable. */
export function envioEnv(
  env: NodeJS.ProcessEnv,
  network: string,
): { env: NodeJS.ProcessEnv; notes: string[] } {
  const out: NodeJS.ProcessEnv = { ...env };
  const notes: string[] = [];
  const config = CONFIGS[network];
  if (!config) throw new Error(`unknown network ${network}: use testnet or mainnet`);
  out.ENVIO_CONFIG = config;
  if (!out.ENVIO_RPC_MODE) {
    out.ENVIO_RPC_MODE = out.ENVIO_API_TOKEN ? "fallback" : "sync";
    if (!out.ENVIO_API_TOKEN) {
      notes.push(
        "No ENVIO_API_TOKEN: reading logs over RPC, 100 blocks per request. Set it to use HyperSync.",
      );
    }
  }
  // The repo's .env names its RPCs MONAD_*_RPC; Envio only reads ENVIO_* variables.
  for (const [envio, plain] of [
    ["ENVIO_MONAD_TESTNET_RPC", "MONAD_TESTNET_RPC"],
    ["ENVIO_MONAD_MAINNET_RPC", "MONAD_MAINNET_RPC"],
  ] as const) {
    if (!out[envio] && out[plain]) out[envio] = out[plain];
  }
  return { env: out, notes };
}

function main(): void {
  const args = process.argv.slice(2);
  const at = args.indexOf("--network");
  const network = at >= 0 ? (args[at + 1] ?? "") : "testnet";
  if (at >= 0) args.splice(at, 2);
  try {
    process.loadEnvFile(join(INDEXER_DIR, ".env"));
  } catch {
    // No indexer/.env: use the shell's environment.
  }
  const { env, notes } = envioEnv(process.env, network);
  const config = join(INDEXER_DIR, env.ENVIO_CONFIG as string);
  if (!existsSync(config)) {
    console.error(
      `${env.ENVIO_CONFIG} does not exist: ${network} has no Hunch Book addresses in deployments/ yet.`,
    );
    process.exit(1);
  }
  for (const note of notes) console.log(note);
  const child = spawn("envio", args, { stdio: "inherit", env, cwd: INDEXER_DIR });
  child.on("exit", (code) => process.exit(code ?? 1));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();

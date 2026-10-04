import { writeFileSync } from "node:fs";
import { deployments, type Network } from "@hunch-book/shared";
import { evaluate, toMarkdown, worst } from "./checks.js";
import { makeClient, readSnapshot } from "./read.js";

// Usage: tsx src/main.ts [--markdown <file>]
// Env (names only; nothing secret is printed):
//   WATCHDOG_NETWORK      monad-testnet (default) or monad-mainnet
//   WATCHDOG_RPC_URL      RPC endpoint (default: MONAD_TESTNET_RPC / MONAD_MAINNET_RPC, then the public RPC)
//   KEEPER_HEALTH_URL     optional: the keeper's /health URL
//   MAKER_HEALTH_URL      optional: the maker's /health URL
//   WATCHDOG_WEBHOOK      optional: receives a JSON POST {level, text} when the result is not ok
// Exit code: 0 ok, 1 warn, 2 fail, 3 the check itself could not run.

const NETWORKS: Network[] = ["monad-testnet", "monad-mainnet"];

async function main(): Promise<number> {
  const network = (process.env.WATCHDOG_NETWORK?.trim() || "monad-testnet") as Network;
  if (!NETWORKS.includes(network)) throw new Error(`WATCHDOG_NETWORK must be one of ${NETWORKS.join(", ")}`);
  const deployment = deployments[network];
  const networkRpc =
    network === "monad-testnet" ? process.env.MONAD_TESTNET_RPC : process.env.MONAD_MAINNET_RPC;
  const rpcUrl = process.env.WATCHDOG_RPC_URL?.trim() || networkRpc?.trim() || deployment.rpc;

  const snapshot = await readSnapshot(makeClient(network, rpcUrl), {
    network,
    deployment,
    rpcUrl,
    keeperHealthUrl: process.env.KEEPER_HEALTH_URL?.trim() || undefined,
    makerHealthUrl: process.env.MAKER_HEALTH_URL?.trim() || undefined,
  });
  const findings = evaluate(snapshot);
  const level = worst(findings);
  const markdown = toMarkdown(snapshot, findings, deployment.explorer);

  for (const f of findings) console.log(JSON.stringify(f));
  const mdIndex = process.argv.indexOf("--markdown");
  if (mdIndex > 0 && process.argv[mdIndex + 1])
    writeFileSync(process.argv[mdIndex + 1] as string, `${markdown}\n`);

  const webhook = process.env.WATCHDOG_WEBHOOK?.trim();
  if (webhook && level !== "ok") {
    await fetch(webhook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ level, text: markdown }),
      signal: AbortSignal.timeout(10_000),
    }).catch((error: unknown) =>
      console.error(JSON.stringify({ event: "webhook-failed", error: String(error) })),
    );
  }
  console.log(JSON.stringify({ event: "result", network, block: snapshot.block.toString(), level }));
  return level === "ok" ? 0 : level === "warn" ? 1 : 2;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(
      JSON.stringify({ event: "error", error: error instanceof Error ? error.message : String(error) }),
    );
    process.exitCode = 3;
  },
);

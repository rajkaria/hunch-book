import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Abi, Hex } from "viem";

// A fresh local anvil chain (Foundry), with Monad testnet's chain id so the keeper's chain config
// applies unchanged, and the contract artifacts from contracts/out (run `forge build` in contracts/).
// Both helpers return null when anvil or the artifacts are missing, so the suite skips cleanly.

export interface Anvil {
  url: string;
  stop(): void;
}

export function anvilInstalled(): boolean {
  const probe = spawnSync("anvil", ["--version"], { stdio: "ignore" });
  return probe.error === undefined && probe.status === 0;
}

async function ready(url: string, deadline: number, exited: () => boolean): Promise<boolean> {
  while (Date.now() < deadline && !exited()) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      });
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

/** `genesisBlock` starts the chain at that block number (viem uses Multicall3 only after its creation block). */
export async function startAnvil(
  chainId: number,
  genesisBlock = 0,
  timeoutMs = 20_000,
): Promise<Anvil | null> {
  if (!anvilInstalled()) {
    console.warn("anvil is not installed: skipping the keeper integration tests");
    return null;
  }
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const child: ChildProcess = spawn(
    "anvil",
    ["--chain-id", String(chainId), "--number", String(genesisBlock), "--port", String(port), "--silent"],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-500);
  });
  const url = `http://127.0.0.1:${port}`;
  const stop = () => {
    if (child.exitCode === null) child.kill("SIGTERM");
  };
  if (await ready(url, Date.now() + timeoutMs, () => child.exitCode !== null)) return { url, stop };
  stop();
  console.warn(
    `anvil did not start (${stderr.trim() || "no answer"}): skipping the keeper integration tests`,
  );
  return null;
}

export interface Artifact {
  abi: Abi;
  bytecode: Hex;
}

const OUT = fileURLToPath(new URL("../../../../contracts/out/", import.meta.url));

/** contracts/out/<file>/<contract>.json, or null when contracts/ has not been built. */
export function artifact(file: string, contract: string): Artifact | null {
  const path = `${OUT}${file}/${contract}.json`;
  if (!existsSync(path)) return null;
  const json = JSON.parse(readFileSync(path, "utf8")) as { abi: Abi; bytecode: { object: Hex } };
  return { abi: json.abi, bytecode: json.bytecode.object };
}

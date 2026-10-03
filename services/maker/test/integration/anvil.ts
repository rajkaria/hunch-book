import { type ChildProcess, spawn, spawnSync } from "node:child_process";

// Starts a local anvil fork of Monad testnet (Foundry 1.8+, `--network monad` for Monad's EVM rules).
// Returns null when anvil is missing or the fork does not come up, so the suite can skip cleanly.

export interface Anvil {
  url: string;
  stop(): void;
}

export function anvilInstalled(): boolean {
  const probe = spawnSync("anvil", ["--version"], { stdio: "ignore" });
  return probe.error === undefined && probe.status === 0;
}

async function ready(url: string, deadline: number): Promise<boolean> {
  while (Date.now() < deadline) {
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
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

export async function startAnvilFork(forkUrl: string, timeoutMs = 60_000): Promise<Anvil | null> {
  if (!anvilInstalled()) return null;
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const child: ChildProcess = spawn(
    "anvil",
    ["--fork-url", forkUrl, "--network", "monad", "--port", String(port), "--silent"],
    { stdio: "ignore" },
  );
  const url = `http://127.0.0.1:${port}`;
  const stop = () => {
    if (child.exitCode === null) child.kill("SIGTERM");
  };
  if (!(await ready(url, Date.now() + timeoutMs))) {
    stop();
    return null;
  }
  return { url, stop };
}

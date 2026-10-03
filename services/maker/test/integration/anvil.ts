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
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function attempt(forkUrl: string, timeoutMs: number): Promise<Anvil | { error: string }> {
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const child: ChildProcess = spawn(
    "anvil",
    ["--fork-url", forkUrl, "--network", "monad", "--port", String(port), "--silent"],
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
  return { error: stderr.trim() || `no answer within ${timeoutMs / 1000} s` };
}

/** Tries a few times: the public testnet RPC sometimes refuses a fork's first requests. */
export async function startAnvilFork(
  forkUrl: string,
  attempts = 3,
  timeoutMs = 60_000,
): Promise<Anvil | null> {
  if (!anvilInstalled()) {
    console.warn("anvil is not installed: skipping the fork tests");
    return null;
  }
  let error = "";
  for (let i = 0; i < attempts; i++) {
    const result = await attempt(forkUrl, timeoutMs);
    if ("url" in result) return result;
    error = result.error;
    await new Promise((r) => setTimeout(r, 2_000 * (i + 1)));
  }
  console.warn(`anvil could not fork ${forkUrl} (${error}): skipping the fork tests`);
  return null;
}

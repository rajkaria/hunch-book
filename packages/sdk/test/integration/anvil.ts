import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { monadTestnet } from "@hunch-book/shared";
import {
  type Abi,
  type Address,
  type Chain,
  createPublicClient,
  createTestClient,
  createWalletClient,
  getAddress,
  type Hex,
  type HttpTransport,
  http,
  type PrivateKeyAccount,
  type PublicClient,
  parseEther,
  type TestClient,
  type WalletClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { MULTICALL3_ADDRESS, MULTICALL3_RUNTIME } from "./multicall3.js";

// A fresh local anvil chain (Foundry) with Monad testnet's chain id, Multicall3 in place, and helpers to
// deploy contracts from contracts/out and drive the clock. Returns null when anvil or the artifacts are
// missing, so the suite skips cleanly (CI's TypeScript job has no Foundry).

export interface Artifact {
  abi: Abi;
  bytecode: Hex;
}

const OUT = fileURLToPath(new URL("../../../../contracts/out/", import.meta.url));

export function artifact(file: string, contract: string): Artifact | null {
  const path = `${OUT}${file}/${contract}.json`;
  if (!existsSync(path)) return null;
  const json = JSON.parse(readFileSync(path, "utf8")) as { abi: Abi; bytecode: { object: Hex } };
  return { abi: json.abi, bytecode: json.bytecode.object };
}

function anvilInstalled(): boolean {
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

export class Anvil {
  readonly client: PublicClient;
  readonly test: TestClient;

  private constructor(
    readonly url: string,
    private readonly child: ChildProcess,
  ) {
    const transport = http(url);
    this.client = createPublicClient({ chain: monadTestnet, transport, pollingInterval: 50 }) as PublicClient;
    this.test = createTestClient({ mode: "anvil", chain: monadTestnet, transport });
  }

  static async start(): Promise<Anvil | null> {
    if (!anvilInstalled()) {
      console.warn("anvil is not installed: skipping the SDK integration tests");
      return null;
    }
    const port = 20_000 + Math.floor(Math.random() * 20_000);
    // viem reads through Multicall3 only at blocks after the one where Monad testnet's copy was created.
    const genesis = (monadTestnet.contracts?.multicall3?.blockCreated ?? 0) + 1;
    const child = spawn(
      "anvil",
      [
        "--chain-id",
        String(monadTestnet.id),
        "--number",
        String(genesis),
        "--port",
        String(port),
        "--silent",
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    const url = `http://127.0.0.1:${port}`;
    if (!(await ready(url, Date.now() + 20_000, () => child.exitCode !== null))) {
      if (child.exitCode === null) child.kill("SIGTERM");
      console.warn("anvil did not start: skipping the SDK integration tests");
      return null;
    }
    const anvil = new Anvil(url, child);
    await anvil.test.setCode({ address: MULTICALL3_ADDRESS, bytecode: MULTICALL3_RUNTIME });
    return anvil;
  }

  stop(): void {
    if (this.child.exitCode === null) this.child.kill("SIGTERM");
  }

  async account(): Promise<PrivateKeyAccount> {
    const account = privateKeyToAccount(generatePrivateKey());
    await this.test.setBalance({ address: account.address, value: parseEther("100") });
    return account;
  }

  wallet(from: PrivateKeyAccount): WalletClient<HttpTransport, Chain, PrivateKeyAccount> {
    return createWalletClient({
      account: from,
      chain: monadTestnet,
      transport: http(this.url),
      pollingInterval: 50,
    });
  }

  async deploy(from: PrivateKeyAccount, a: Artifact, args: unknown[] = []): Promise<Address> {
    const hash = await this.wallet(from).deployContract({
      abi: a.abi,
      bytecode: a.bytecode,
      args,
      chain: monadTestnet,
      account: from,
    });
    const receipt = await this.client.waitForTransactionReceipt({ hash });
    return getAddress(receipt.contractAddress as Address);
  }

  async send(
    from: PrivateKeyAccount,
    address: Address,
    abi: Abi,
    functionName: string,
    args: unknown[] = [],
  ): Promise<void> {
    const hash = await this.wallet(from).writeContract({
      address,
      abi,
      functionName,
      args,
      chain: monadTestnet,
      account: from,
    });
    const receipt = await this.client.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${functionName} reverted`);
  }

  read<T>(address: Address, abi: Abi, functionName: string, args: unknown[] = []): Promise<T> {
    return this.client.readContract({ address, abi, functionName, args }) as Promise<T>;
  }

  async head(): Promise<{ number: bigint; timestamp: bigint }> {
    const b = await this.client.getBlock({ blockTag: "latest" });
    return { number: b.number, timestamp: b.timestamp };
  }

  /** Mines one block at exactly `timestamp`. */
  async warp(timestamp: bigint): Promise<void> {
    await this.test.setNextBlockTimestamp({ timestamp });
    await this.test.mine({ blocks: 1 });
  }

  async mine(blocks: number): Promise<void> {
    await this.test.mine({ blocks });
  }
}

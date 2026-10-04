import { type Deployment, deployments, monadTestnet } from "@hunch-book/shared";
import {
  type Abi,
  type Address,
  createPublicClient,
  createWalletClient,
  custom,
  decodeFunctionData,
  encodeErrorResult,
  encodeFunctionResult,
  getAddress,
  type Hex,
  keccak256,
  multicall3Abi,
  numberToHex,
  type PublicClient,
  parseTransaction,
  recoverTransactionAddress,
  toHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createContext, type HunchContext, MULTICALL3 } from "../src/context.js";

// A fake chain behind viem's custom transport: contracts are ABIs with JavaScript handlers, eth_call
// and Multicall3's aggregate3 dispatch to them, and signed transactions are decoded, run through the
// same handlers and recorded, so tests can check exactly what the SDK read and sent.

export type Handler = (
  args: readonly unknown[],
  call: { from: Address | undefined; value: bigint; to: Address },
) => unknown;

/** Thrown by a handler to revert with a custom error from `abi`. */
export class Revert extends Error {
  constructor(
    readonly abi: Abi | readonly unknown[],
    readonly errorName: string,
    readonly errorArgs: readonly unknown[] = [],
  ) {
    super(errorName);
  }
  data(): Hex {
    return encodeErrorResult({
      abi: this.abi as Abi,
      errorName: this.errorName,
      args: this.errorArgs,
    } as never);
  }
}

interface FakeContract {
  abi: Abi;
  handlers: Record<string, Handler>;
}

export interface SentTx {
  hash: Hex;
  to: Address;
  functionName: string;
  args: readonly unknown[];
  value: bigint;
}

const revertError = (data: Hex) => Object.assign(new Error("execution reverted"), { code: 3, data });

export class FakeChain {
  block = { number: 1_000n, timestamp: 1_800_000_000n };
  readonly sent: SentTx[] = [];
  readonly calls: { to: Address; functionName: string; args: readonly unknown[] }[] = [];
  private readonly contracts = new Map<string, FakeContract>();
  private readonly receipts = new Map<Hex, { to: Address; block: bigint }>();
  logs: Record<string, unknown>[] = [];

  register(address: Address, abi: Abi | readonly unknown[], handlers: Record<string, Handler>): this {
    const key = address.toLowerCase();
    const existing = this.contracts.get(key);
    if (existing) {
      existing.abi = [...existing.abi, ...(abi as Abi)];
      Object.assign(existing.handlers, handlers);
    } else {
      this.contracts.set(key, { abi: [...(abi as Abi)], handlers: { ...handlers } });
    }
    return this;
  }

  /** Runs one call. Returns the encoded result or throws a Revert/Error. */
  private dispatch(to: Address, data: Hex, from: Address | undefined, value: bigint): Hex {
    const contract = this.contracts.get(to.toLowerCase());
    if (!contract) throw new Error(`no fake contract at ${to}`);
    const { functionName, args } = decodeFunctionData({ abi: contract.abi, data });
    const handler = contract.handlers[functionName];
    if (!handler) throw new Error(`no handler for ${functionName} at ${to}`);
    this.calls.push({ to, functionName, args: (args ?? []) as readonly unknown[] });
    const result = handler((args ?? []) as readonly unknown[], { from, value, to });
    const items = contract.abi.filter(
      (i) => i.type === "function" && i.name === functionName && i.inputs.length === (args ?? []).length,
    );
    return encodeFunctionResult({ abi: items as Abi, functionName, result } as never);
  }

  private call(to: Address, data: Hex, from: Address | undefined, value: bigint): Hex {
    if (to.toLowerCase() === MULTICALL3.toLowerCase()) {
      const { args } = decodeFunctionData({ abi: multicall3Abi, data });
      const calls = (args?.[0] ?? []) as readonly { target: Address; allowFailure: boolean; callData: Hex }[];
      const results = calls.map((c) => {
        try {
          return { success: true, returnData: this.dispatch(c.target, c.callData, MULTICALL3, 0n) };
        } catch (e) {
          if (!c.allowFailure) throw e;
          return { success: false, returnData: e instanceof Revert ? e.data() : ("0x" as Hex) };
        }
      });
      return encodeFunctionResult({ abi: multicall3Abi, functionName: "aggregate3", result: results });
    }
    try {
      return this.dispatch(to, data, from, value);
    } catch (e) {
      if (e instanceof Revert) throw revertError(e.data());
      throw e;
    }
  }

  async request({ method, params }: { method: string; params?: unknown }): Promise<unknown> {
    const p = (params ?? []) as unknown[];
    switch (method) {
      case "eth_chainId":
        return numberToHex(monadTestnet.id);
      case "eth_blockNumber":
        return numberToHex(this.block.number);
      case "eth_getBlockByNumber":
      case "eth_getBlockByHash": {
        const tag = p[0];
        const number =
          typeof tag === "string" && tag.startsWith("0x") && method === "eth_getBlockByNumber"
            ? BigInt(tag)
            : this.block.number;
        const timestamp = this.block.timestamp - (this.block.number - number);
        return {
          number: numberToHex(number),
          hash: keccak256(toHex(number)),
          parentHash: keccak256(toHex(number - 1n)),
          timestamp: numberToHex(timestamp),
          gasLimit: "0x1c9c380",
          gasUsed: "0x0",
          baseFeePerGas: "0x1",
          transactions: [],
          logsBloom: `0x${"00".repeat(256)}`,
          miner: "0x0000000000000000000000000000000000000000",
          extraData: "0x",
          difficulty: "0x0",
          nonce: "0x0000000000000000",
          size: "0x0",
          stateRoot: `0x${"00".repeat(32)}`,
          receiptsRoot: `0x${"00".repeat(32)}`,
          transactionsRoot: `0x${"00".repeat(32)}`,
          sha3Uncles: `0x${"00".repeat(32)}`,
          uncles: [],
          mixHash: `0x${"00".repeat(32)}`,
        };
      }
      case "eth_call": {
        const tx = p[0] as { to: Address; data: Hex; from?: Address; value?: Hex };
        return this.call(tx.to, tx.data, tx.from, tx.value ? BigInt(tx.value) : 0n);
      }
      case "eth_estimateGas":
        return "0x30000";
      case "eth_gasPrice":
      case "eth_maxPriorityFeePerGas":
        return "0x1";
      case "eth_getTransactionCount":
        return numberToHex(this.sent.length);
      case "eth_sendRawTransaction": {
        const raw = p[0] as Hex;
        const tx = parseTransaction(raw as `0x02${string}`);
        const to = getAddress(tx.to as Address);
        const contract = this.contracts.get(to.toLowerCase());
        if (!contract) throw new Error(`no fake contract at ${to}`);
        const { functionName, args } = decodeFunctionData({ abi: contract.abi, data: tx.data as Hex });
        const from = await recoverTransactionAddress({ serializedTransaction: raw as never });
        this.call(to, tx.data as Hex, from, tx.value ?? 0n);
        const hash = keccak256(raw);
        this.block = { number: this.block.number + 1n, timestamp: this.block.timestamp + 1n };
        this.sent.push({
          hash,
          to,
          functionName,
          args: (args ?? []) as readonly unknown[],
          value: tx.value ?? 0n,
        });
        this.receipts.set(hash, { to, block: this.block.number });
        return hash;
      }
      case "eth_getTransactionReceipt": {
        const r = this.receipts.get(p[0] as Hex);
        if (!r) return null;
        return {
          transactionHash: p[0],
          transactionIndex: "0x0",
          blockHash: keccak256(toHex(r.block)),
          blockNumber: numberToHex(r.block),
          from: "0x0000000000000000000000000000000000000001",
          to: r.to,
          cumulativeGasUsed: "0x1",
          gasUsed: "0x1",
          effectiveGasPrice: "0x1",
          contractAddress: null,
          logs: [],
          logsBloom: `0x${"00".repeat(256)}`,
          status: "0x1",
          type: "0x2",
        };
      }
      case "eth_getLogs":
        return this.logs;
      default:
        throw new Error(`fake chain: unsupported method ${method}`);
    }
  }

  publicClient(): PublicClient {
    return createPublicClient({
      chain: monadTestnet,
      transport: custom({ request: (args) => this.request(args) }, { retryCount: 0 }),
      pollingInterval: 1,
    }) as PublicClient;
  }

  context(options: { key?: Hex; deployment?: Deployment } = {}): HunchContext {
    const transport = custom({ request: (args) => this.request(args) }, { retryCount: 0 });
    const walletClient = options.key
      ? createWalletClient({
          account: privateKeyToAccount(options.key),
          chain: monadTestnet,
          transport,
          pollingInterval: 1,
        })
      : undefined;
    return createContext({
      network: "monad-testnet",
      deployment: options.deployment ?? deployments["monad-testnet"],
      publicClient: this.publicClient(),
      walletClient,
    });
  }
}

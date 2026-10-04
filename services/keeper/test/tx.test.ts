import { deployments, marketAbi, monadTestnet } from "@hunch-book/shared";
import {
  type Address,
  BaseError,
  encodeErrorResult,
  encodeFunctionData,
  type Hex,
  type PublicClient,
  parseGwei,
  type WalletClient,
} from "viem";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { marketWithResolverErrorsAbi } from "../src/abis.js";
import { setLogSink } from "../src/log.js";
import { revertReason, sendTx, type TxContext } from "../src/tx.js";

const KEEPER = "0x1f5AC9bB0DF7d0E0DD133cBd71388e1078475569" as Address;
const MARKET = "0x2A44B99014cF73065BFb89197a08DE09D18d3982" as Address;
const HASH = `0x${"12".repeat(32)}` as Hex;

const lines: Record<string, unknown>[] = [];
beforeEach(() => {
  lines.length = 0;
  setLogSink((line) => lines.push(JSON.parse(line)));
});
afterEach(() => setLogSink((line) => console.log(line)));

function reverted(data: Hex): BaseError {
  return Object.assign(new BaseError("execution reverted"), { data });
}

function context(opts: { enabled: boolean; estimate?: bigint | BaseError; baseFee?: bigint }) {
  const sent: Record<string, unknown>[] = [];
  const publicClient = {
    async estimateGas() {
      if (opts.estimate instanceof BaseError) throw opts.estimate;
      return opts.estimate ?? 100_000n;
    },
    async getBlock() {
      return { baseFeePerGas: opts.baseFee ?? parseGwei("100") };
    },
    async estimateMaxPriorityFeePerGas() {
      return parseGwei("2");
    },
    async waitForTransactionReceipt() {
      return { status: "success", blockNumber: 5n, gasUsed: 90_000n };
    },
  } as unknown as PublicClient;
  const walletClient = {
    async sendTransaction(tx: Record<string, unknown>) {
      sent.push(tx);
      return HASH;
    },
  } as unknown as WalletClient;
  const ctx: TxContext = {
    publicClient,
    walletClient: opts.enabled ? walletClient : undefined,
    account: KEEPER,
    chain: monadTestnet,
    deployment: deployments["monad-testnet"],
    enabled: opts.enabled,
    maxGasPriceWei: parseGwei("200"),
    maxGasPerTx: 6_000_000n,
  };
  return { ctx, sent };
}

const settle = {
  to: MARKET,
  data: encodeFunctionData({ abi: marketAbi, functionName: "settle", args: ["0x"] }),
  abi: marketWithResolverErrorsAbi,
  action: "settle",
  fields: { market: MARKET },
};

describe("sendTx", () => {
  it("dry run: simulates, logs what it would send, sends nothing", async () => {
    const { ctx, sent } = context({ enabled: false, estimate: 210_000n });
    const result = await sendTx(ctx, settle);
    expect(result).toEqual({ status: "dry-run", simulation: { ok: true, gas: 210_000n } });
    expect(sent).toEqual([]);
    expect(lines[0]).toMatchObject({
      event: "dry-run",
      action: "settle",
      simulation: "ok",
      gasEstimate: "210000",
    });
  });

  it("dry run: names the custom error a call would revert with", async () => {
    const data = encodeErrorResult({ abi: marketAbi, errorName: "NotResolved" });
    const { ctx } = context({ enabled: false, estimate: reverted(data) });
    await sendTx(ctx, settle);
    expect(lines[0]).toMatchObject({ event: "dry-run", simulation: "would revert: NotResolved" });
  });

  it("decodes resolver errors that bubble up through settle, with their arguments", () => {
    const data = encodeErrorResult({
      abi: marketWithResolverErrorsAbi,
      errorName: "RoundTooStale",
      args: [5n, 100n, 4_000n],
    });
    expect(revertReason(reverted(data), marketWithResolverErrorsAbi)).toBe("RoundTooStale(5, 100, 4000)");
  });

  it("live: sends with the estimate plus 10% as the gas limit, capped gas price, and the value", async () => {
    const { ctx, sent } = context({ enabled: true, estimate: 200_000n });
    const result = await sendTx(ctx, { ...settle, value: 7n });
    expect(result.status).toBe("success");
    expect(sent[0]).toMatchObject({
      to: MARKET,
      gas: 220_000n,
      value: 7n,
      maxFeePerGas: parseGwei("200"),
      maxPriorityFeePerGas: parseGwei("2"),
    });
    expect(lines.at(-1)).toMatchObject({
      event: "tx",
      status: "success",
      hash: HASH,
      url: `https://testnet.monadscan.com/tx/${HASH}`,
      gasLimit: "220000",
      value: "7",
    });
  });

  it("live: skips a call that would revert, one above the gas cap, and sends nothing over the max gas price", async () => {
    const data = encodeErrorResult({ abi: marketAbi, errorName: "NotResolved" });
    for (const opts of [
      { estimate: reverted(data) },
      { estimate: 7_000_000n },
      { baseFee: parseGwei("250") },
    ]) {
      const { ctx, sent } = context({ enabled: true, ...opts });
      const result = await sendTx(ctx, settle);
      expect(result.status).toBe("skipped");
      expect(sent).toEqual([]);
    }
    expect(lines.map((l) => l.reason)).toEqual([
      "simulation failed: NotResolved",
      "needs 7000000 gas, above KEEPER_MAX_GAS_PER_TX 6000000",
      "base fee 250000000000 wei is above KEEPER_MAX_GAS_PRICE_GWEI",
    ]);
  });
});

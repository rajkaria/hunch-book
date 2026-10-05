import { collateralVaultAbi, marketAbi } from "@hunch-book/shared";
import type { Abi } from "viem";
import { decodeFunctionData, getAddress } from "viem";
import { describe, expect, it } from "vitest";
import { atomicBatchReady, encodeCalls } from "../src/lib/wallet/batch";
import type { TxStep } from "../src/lib/wallet/useTxRunner";

const MARKET = "0x00000000000000000000000000000000000000a1" as const;
const VAULT = "0x00000000000000000000000000000000000000b2" as const;
const USER = "0x00000000000000000000000000000000000000c3" as const;

describe("atomic batches (EIP-5792)", () => {
  it("are ready when the wallet reports atomic support for the app's chain", () => {
    expect(atomicBatchReady({ atomic: { status: "supported" } }, 10143)).toBe(true);
    expect(atomicBatchReady({ 10143: { atomic: { status: "ready" } } }, 10143)).toBe(true);
    expect(atomicBatchReady({ "0x279f": { atomic: { status: "supported" } } }, 10143)).toBe(true);
  });

  it("are not ready without support on that chain, or without an answer", () => {
    expect(atomicBatchReady({ atomic: { status: "unsupported" } }, 10143)).toBe(false);
    expect(atomicBatchReady({ 1: { atomic: { status: "supported" } } }, 10143)).toBe(false);
    expect(atomicBatchReady({}, 10143)).toBe(false);
    expect(atomicBatchReady(undefined, 10143)).toBe(false);
    expect(atomicBatchReady("supported", 10143)).toBe(false);
  });

  it("encodes each step as a raw call, in order", () => {
    const steps: TxStep[] = [
      { label: "claim", request: { address: MARKET, abi: marketAbi as Abi, functionName: "claimTokens" } },
      {
        label: "redeem",
        request: {
          address: VAULT,
          abi: collateralVaultAbi as Abi,
          functionName: "redeem",
          args: [MARKET, 1, 5_000_000n, USER],
        },
      },
    ];
    const calls = encodeCalls(steps);
    expect(calls.map((c) => c.to)).toEqual([MARKET, VAULT]);
    expect(decodeFunctionData({ abi: marketAbi as Abi, data: calls[0]?.data ?? "0x" }).functionName).toBe(
      "claimTokens",
    );
    const redeem = decodeFunctionData({ abi: collateralVaultAbi as Abi, data: calls[1]?.data ?? "0x" });
    expect(redeem.functionName).toBe("redeem");
    expect(redeem.args).toEqual([getAddress(MARKET), 1, 5_000_000n, getAddress(USER)]);
    expect(calls[0]).not.toHaveProperty("value");
  });
});

import {
  deployments,
  encodeSnapshotParams,
  SnapshotComparator,
  snapshotKey,
  snapshotResolverAbi,
  TemplateId,
  type Window,
} from "@hunch-book/shared";
import { type Address, BaseError, encodeErrorResult, type PublicClient } from "viem";
import { describe, expect, it } from "vitest";
import type { SettleDeps, SettleMarket } from "../src/settlers/index.js";
import { snapshotSettler } from "../src/settlers/snapshot.js";

// Template 7: settle() with empty evidence takes the snapshot inside [T, T + W], so the keeper settles
// at the first cycle after T; after the window with no snapshot, nothing can settle the market.

const T = 1_791_600_000n;
const W = 600;
const RESOLVER = "0x00000000000000000000000000000000000000d7" as Address;
const params = encodeSnapshotParams({
  sourceId: 1,
  threshold: 85_000n * 10n,
  comparator: SnapshotComparator.AtOrAbove,
  lockTime: T - 3_600n,
  closeTime: T,
  snapshotWindow: W,
});
const window: Window = { blockClock: false, lock: T - 3_600n, close: T, settleDeadline: T + 600n + 604_800n };
const market: SettleMarket = {
  address: "0x00000000000000000000000000000000000000a7",
  templateId: TemplateId.Snapshot,
  params,
  window,
  resolver: RESOLVER,
};
const now = (timestamp: bigint) => ({ block: 1n, timestamp });
const key = snapshotKey(1, T, W);

function deps(opts: {
  snapshot?: { value: bigint; blockNumber: bigint; timestamp: bigint };
  source?: Error;
}) {
  const calls: string[] = [];
  const client = {
    async readContract(req: { functionName: string; args?: unknown[] }) {
      calls.push(req.functionName);
      if (req.functionName === "snapshotFor") {
        return [key, opts.snapshot ?? { value: 0n, blockNumber: 0n, timestamp: 0n }];
      }
      if (req.functionName === "currentValue") {
        if (opts.source) throw opts.source;
        return 852_000n;
      }
      throw new Error(`unexpected ${req.functionName}`);
    },
  } as unknown as PublicClient;
  return {
    calls,
    deps: {
      client,
      deployment: deployments["monad-testnet"],
      pythApiKey: undefined,
      hermesUrl: "",
    } as SettleDeps,
  };
}

describe("the snapshot settler", () => {
  it("waits for close, then settles at once: settle takes the snapshot", async () => {
    expect(snapshotSettler.waitReason(market, now(T - 1n))).toMatch(/^waiting for close at 1791600000/);
    expect(snapshotSettler.waitReason(market, now(T))).toBeNull();
    const { deps: d, calls } = deps({});
    const result = await snapshotSettler.evidence(market, now(T + 3n), d);
    expect(result).toMatchObject({
      status: "ready",
      evidence: "0x",
      detail: { snapshot: "taken by this settle", valueNow: 852_000n, key },
    });
    expect(calls).toEqual(["snapshotFor", "currentValue"]);
  });

  it("settles from a snapshot someone already took, even after the window", async () => {
    const snapshot = { value: 849_000n, blockNumber: 70_000_000n, timestamp: T + 1n };
    const { deps: d } = deps({ snapshot });
    const result = await snapshotSettler.evidence(market, now(T + 86_400n), d);
    expect(result).toMatchObject({
      status: "ready",
      evidence: "0x",
      detail: { snapshot: "taken", value: 849_000n, snapshotBlock: 70_000_000n },
    });
  });

  it("says why the source cannot be snapshotted, and retries within seconds while the window is open", async () => {
    const data = encodeErrorResult({ abi: snapshotResolverAbi, errorName: "SourceChanged", args: [1] });
    const { deps: d } = deps({ source: Object.assign(new BaseError("execution reverted"), { data }) });
    const result = await snapshotSettler.evidence(market, now(T + 10n), d);
    expect(result.status).toBe("wait");
    expect(result.status === "wait" && result.reason).toMatch(/SourceChanged\(1\)/);
    expect(snapshotSettler.maxRetrySeconds?.(market, now(T + 10n))).toBe(5);
    expect(snapshotSettler.maxRetrySeconds?.(market, now(T + BigInt(W) + 1n))).toBeUndefined();
  });

  it("cannot settle once the window has passed with no snapshot: the market voids at its deadline", async () => {
    const { deps: d, calls } = deps({});
    const result = await snapshotSettler.evidence(market, now(T + BigInt(W) + 1n), d);
    expect(result).toMatchObject({ status: "unsettleable" });
    expect(result.status === "unsettleable" && result.reason).toMatch(
      /^nobody took the snapshot in its window/,
    );
    expect(calls).toEqual(["snapshotFor"]);
    // The last second of the window still counts.
    expect((await snapshotSettler.evidence(market, now(T + BigInt(W)), deps({}).deps)).status).toBe("ready");
  });
});

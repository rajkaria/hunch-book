import { type SnapshotParams, snapshotResolverAbi, snapshotValueFromReturnData } from "@hunch-book/shared";
import type { Address, Hex } from "viem";
import type { HunchContext } from "../context.js";

// Template 7 reads: the resolver's source list (what a snapshot market is about) and the snapshot a
// market answers from. A snapshot is taken once per observation (source, close time, window) by
// whoever calls `snapshot` or a market's `settle` inside the window, and never changes after
// (docs/TEMPLATES.md, template 7).

/** One source as the resolver was deployed with it (ITemplatesV3.sol, SnapshotSource). */
export interface SnapshotSourceInfo {
  label: string;
  unit: string;
  decimals: number;
  target: Address;
  callData: Hex;
  tuple: boolean;
  valueWord: number;
  signed: boolean;
  timestampWord: number;
  maxAge: number;
  pinnedWords: readonly number[];
  guardTarget: Address;
  guardCallData: Hex;
}

export interface StoredSnapshot {
  key: Hex;
  /** The raw value read, in the source's units (shown as value / 10^decimals). */
  value: bigint;
  /** The block of the snapshot transaction. */
  blockNumber: bigint;
  /** That block's unix time. */
  timestamp: bigint;
}

export async function snapshotSource(
  ctx: HunchContext,
  resolver: Address,
  sourceId: number,
): Promise<SnapshotSourceInfo> {
  const s = await ctx.publicClient.readContract({
    address: resolver,
    abi: snapshotResolverAbi,
    functionName: "source",
    args: [sourceId],
  });
  return {
    label: s.label,
    unit: s.unit,
    decimals: Number(s.decimals),
    target: s.target,
    callData: s.callData,
    tuple: s.tuple,
    valueWord: Number(s.valueWord),
    signed: s.signed,
    timestampWord: Number(s.timestampWord),
    maxAge: Number(s.maxAge),
    pinnedWords: s.pinnedWords.map(Number),
    guardTarget: s.guardTarget,
    guardCallData: s.guardCallData,
  };
}

/** The snapshot a market with these params answers from, or null while none has been taken. */
export async function storedSnapshot(
  ctx: HunchContext,
  resolver: Address,
  params: Hex,
): Promise<StoredSnapshot | null> {
  const [key, s] = await ctx.publicClient.readContract({
    address: resolver,
    abi: snapshotResolverAbi,
    functionName: "snapshotFor",
    args: [params],
  });
  if (s.blockNumber === 0n) return null;
  return { key, value: s.value, blockNumber: s.blockNumber, timestamp: s.timestamp };
}

/**
 * Makes the source's call again at a block and reads the value the resolver's way. The state at the
 * end of that block: if a later transaction in the same block moved the value, it differs from the
 * snapshot's (the snapshot transaction's trace shows the exact read). Null if the call fails.
 */
export async function rereadSource(
  ctx: HunchContext,
  source: SnapshotSourceInfo,
  blockNumber: bigint,
): Promise<bigint | null> {
  try {
    const { data } = await ctx.publicClient.call({ to: source.target, data: source.callData, blockNumber });
    return data ? snapshotValueFromReturnData(data, source) : null;
  } catch {
    return null;
  }
}

/** "BTC" from "Perpl's BTC open interest (perp 1)", or the unit when it is not a currency. */
export function snapshotAsset(source: Pick<SnapshotSourceInfo, "label" | "unit">): string | null {
  const fromLabel = /'s ([A-Z0-9]{2,10}) /.exec(source.label)?.[1];
  if (fromLabel) return fromLabel;
  return source.unit && source.unit !== "USD" ? source.unit : null;
}

/** The observation a market belongs to: every market with the same three shares one snapshot. */
export function observationOf(p: SnapshotParams): {
  sourceId: number;
  closeTime: bigint;
  snapshotWindow: number;
} {
  return { sourceId: p.sourceId, closeTime: p.closeTime, snapshotWindow: p.snapshotWindow };
}

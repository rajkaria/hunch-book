import {
  type Outcome,
  type SnapshotComparator,
  type SnapshotParams,
  snapshotEvidenceHash,
  snapshotKey,
  snapshotOutcome,
  snapshotResolverAbi,
  snapshotValueFromReturnData,
  snapshotWindowState,
} from "@hunch-book/shared";
import type { Abi, Address, ContractFunctionParameters, Hex, PublicClient } from "viem";
import { MULTICALL3 } from "../chain/client";
import { formatFixed } from "../format";

// Template 7, snapshot (docs/TEMPLATES.md, "Template 7"): the resolver's sources, the stored snapshot a
// market answers from, and the checks a verifier runs on it. Shared by the create flow, the market page
// and the verifier. The math (evidence hash, outcome, window, reading the value out of return data) is
// the shared package's; this module only reads the chain and formats.

export const SNAPSHOT_COMPARATORS: readonly SnapshotComparator[] = [0, 1, 2, 3];

/** The resolver's own words for each comparator, as its rule sentence says them. */
export const COMPARATOR_TEXT: Record<SnapshotComparator, string> = {
  0: "above",
  1: "at or above",
  2: "below",
  3: "at or below",
};

/** One source as the resolver's `source(id)` returns it, with its id. */
export interface SnapshotSourceView {
  id: number;
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
}

/** A stored snapshot: the raw value read, and the block and time of the snapshot transaction. */
export interface StoredSnapshot {
  value: bigint;
  blockNumber: bigint;
  timestamp: bigint;
}

interface RawSource {
  label: string;
  unit: string;
  decimals: number | bigint;
  target: Address;
  callData: Hex;
  tuple: boolean;
  valueWord: number | bigint;
  signed: boolean;
  timestampWord: number | bigint;
  maxAge: number | bigint;
}

export function parseSource(id: number, raw: RawSource): SnapshotSourceView {
  return {
    id,
    label: raw.label,
    unit: raw.unit,
    decimals: Number(raw.decimals),
    target: raw.target,
    callData: raw.callData,
    tuple: raw.tuple,
    valueWord: Number(raw.valueWord),
    signed: raw.signed,
    timestampWord: Number(raw.timestampWord),
    maxAge: Number(raw.maxAge),
  };
}

/**
 * A raw source value in its unit, written out exactly as the resolver's rule sentence does: "$85,000.5"
 * for USD, "12.3456 BTC" otherwise.
 */
export function formatSnapshotValue(
  value: bigint,
  source: Pick<SnapshotSourceView, "decimals" | "unit">,
): string {
  const body = formatFixed(value < 0n ? -value : value, source.decimals);
  const sign = value < 0n ? "-" : "";
  return source.unit === "USD" ? `${sign}$${body}` : `${sign}${body} ${source.unit}`;
}

type Result = { status: "success"; result: unknown } | { status: "failure"; error: Error };
export type SnapshotClient = Pick<PublicClient, "readContract" | "multicall">;

/** Every source the resolver lists, in id order. */
export async function readSnapshotSources(
  client: SnapshotClient,
  resolver: Address,
): Promise<SnapshotSourceView[]> {
  const count = Number(
    await client.readContract({ address: resolver, abi: snapshotResolverAbi, functionName: "sourceCount" }),
  );
  if (count === 0) return [];
  const results = (await client.multicall({
    contracts: Array.from({ length: count }, (_, id) => ({
      address: resolver,
      abi: snapshotResolverAbi as Abi,
      functionName: "source",
      args: [id],
    })) as unknown as readonly ContractFunctionParameters[],
    allowFailure: true,
    multicallAddress: MULTICALL3,
  })) as Result[];
  return results.flatMap((r, id) => (r.status === "success" ? [parseSource(id, r.result as RawSource)] : []));
}

/** What a snapshot of `sourceId` would store now. Throws with the resolver's reason when it cannot read it. */
export async function readCurrentValue(
  client: SnapshotClient,
  resolver: Address,
  sourceId: number,
): Promise<bigint> {
  return client.readContract({
    address: resolver,
    abi: snapshotResolverAbi,
    functionName: "currentValue",
    args: [sourceId],
  });
}

/** The snapshot a market with these params answers from, or null when none has been taken. */
export async function readSnapshotFor(
  client: SnapshotClient,
  resolver: Address,
  params: Hex,
): Promise<{ key: Hex; snapshot: StoredSnapshot | null }> {
  const [key, s] = await client.readContract({
    address: resolver,
    abi: snapshotResolverAbi,
    functionName: "snapshotFor",
    args: [params],
  });
  const blockNumber = BigInt(s.blockNumber);
  return {
    key,
    snapshot: blockNumber === 0n ? null : { value: s.value, blockNumber, timestamp: BigInt(s.timestamp) },
  };
}

// ---------------------------------------------------------------- verification

export type SnapshotWindow = "before" | "open" | "after";

export interface SnapshotCheck {
  template: "snapshot";
  params: SnapshotParams;
  /** Same as SnapshotStore.snapshotKey: every market on this source, close and window shares it. */
  key: Hex;
  source: SnapshotSourceView | null;
  snapshot: StoredSnapshot | null;
  window: SnapshotWindow;
  /** The rule applied to the stored value, or null without a snapshot. */
  outcome: Outcome | null;
  /** The evidence hash rebuilt from the source's call and the stored snapshot. */
  expectedHash: Hex | null;
  /** The source's call re-run at the snapshot's block, read the way the resolver reads it. */
  reread: { value: bigint | null; matches: boolean | null; error: string | null } | null;
  /** The value a snapshot would store now, before one exists. */
  current: bigint | null;
}

export type SnapshotVerifyClient = Pick<PublicClient, "readContract" | "multicall" | "call">;

/**
 * Everything a verifier checks for a snapshot market: the source, the stored snapshot, where the window
 * stands, the evidence hash rebuilt from them, and the source call re-run at the snapshot's block. A call
 * re-run at a block reads the state at the end of that block, so a later transaction in the same block
 * that moved the value makes the two differ (the snapshot transaction's trace shows the exact read).
 */
export async function checkSnapshot(
  client: SnapshotVerifyClient,
  resolver: Address,
  marketParams: Hex,
  params: SnapshotParams,
  now: bigint,
): Promise<SnapshotCheck> {
  const [stored, source] = await Promise.all([
    readSnapshotFor(client, resolver, marketParams),
    client
      .readContract({
        address: resolver,
        abi: snapshotResolverAbi,
        functionName: "source",
        args: [params.sourceId],
      })
      .then((raw) => parseSource(params.sourceId, raw as RawSource))
      .catch(() => null),
  ]);
  const window = snapshotWindowState(params.closeTime, params.snapshotWindow, now);
  const snapshot = stored.snapshot;
  const check: SnapshotCheck = {
    template: "snapshot",
    params,
    key: stored.key,
    source,
    snapshot,
    window,
    outcome: snapshot ? snapshotOutcome(snapshot.value, params.threshold, params.comparator) : null,
    expectedHash:
      snapshot && source
        ? snapshotEvidenceHash({
            target: source.target,
            callData: source.callData,
            valueWord: source.valueWord,
            value: snapshot.value,
            blockNumber: snapshot.blockNumber,
            timestamp: snapshot.timestamp,
          })
        : null,
    reread: null,
    current: null,
  };
  if (snapshot && source) {
    try {
      const { data } = await client.call({
        to: source.target,
        data: source.callData,
        blockNumber: snapshot.blockNumber,
      });
      const value = data ? snapshotValueFromReturnData(data, source) : null;
      check.reread = { value, matches: value === null ? null : value === snapshot.value, error: null };
    } catch (e) {
      check.reread = {
        value: null,
        matches: null,
        error: e instanceof Error ? (e.message.split("\n")[0] ?? null) : null,
      };
    }
  } else if (!snapshot && window !== "after") {
    check.current = await readCurrentValue(client, resolver, params.sourceId).catch(() => null);
  }
  return check;
}

/** The key a market's snapshot is stored under, from its params. */
export const keyOf = (p: Pick<SnapshotParams, "sourceId" | "closeTime" | "snapshotWindow">): Hex =>
  snapshotKey(p.sourceId, p.closeTime, p.snapshotWindow);

/** One sentence on where the snapshot window stands, for the market page and the settle button. */
export function windowSentence(window: SnapshotWindow, hasSnapshot: boolean): string {
  if (hasSnapshot) return "The snapshot is taken and final: this market answers from it.";
  if (window === "before")
    return "The snapshot window opens at close. Settling then takes the snapshot and settles in one transaction.";
  if (window === "open") {
    return "The snapshot window is open. Settling now takes the snapshot and settles in one transaction.";
  }
  return "Nobody took a snapshot in the window, so this market has no answer. It voids at its deadline.";
}

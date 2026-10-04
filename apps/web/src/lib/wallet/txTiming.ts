"use client";

import type { Network } from "@hunch-book/shared";
import { useSyncExternalStore } from "react";
import type { Hex } from "viem";

// How long each transaction this browser sent took to land, measured in this browser: from the moment
// the wallet handed back the signed transaction's hash to the moment the receipt was first seen. Both
// times come from the same clock, so no clock skew. The block's own timestamp is kept too, but Monad
// block timestamps are whole seconds, too coarse for milliseconds.

export interface TxTiming {
  hash: Hex;
  network: Network;
  /** Browser clock, unix milliseconds: the wallet returned the signed transaction's hash. */
  signedAt: number;
  /** Browser clock, unix milliseconds: this browser first saw the receipt. */
  seenAt: number;
  /** seenAt minus signedAt. */
  includedMs: number;
  block: bigint;
  /** The block's timestamp, unix seconds, once read. */
  blockTime: number | null;
}

/** How often the tx runner polls for a receipt, in milliseconds: the resolution of `includedMs`. */
export const RECEIPT_POLL_MS = 150;

const STORAGE_KEY = "hunch-book:tx-timings";
/** The newest timings kept across page loads. */
const KEEP = 50;

type Stored = Omit<TxTiming, "block"> & { block: string };

let timings = new Map<string, TxTiming>();
let loaded = false;
const listeners = new Set<() => void>();

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function load(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = storage()?.getItem(STORAGE_KEY);
    if (!raw) return;
    const rows = JSON.parse(raw) as Stored[];
    const next = new Map<string, TxTiming>();
    for (const r of rows) {
      if (typeof r?.hash !== "string" || typeof r.includedMs !== "number") continue;
      next.set(r.hash.toLowerCase(), { ...r, block: BigInt(r.block) });
    }
    timings = next;
  } catch {
    // A corrupt or blocked store just starts empty.
  }
}

function save(): void {
  try {
    const rows: Stored[] = [...timings.values()]
      .sort((a, b) => b.signedAt - a.signedAt)
      .slice(0, KEEP)
      .map((t) => ({ ...t, block: t.block.toString() }));
    storage()?.setItem(STORAGE_KEY, JSON.stringify(rows));
  } catch {
    // Nothing to do: the timing still shows for this page view.
  }
}

function emit(): void {
  timings = new Map(timings);
  for (const l of listeners) l();
}

/** Stores one transaction's timing (or merges into the one already stored). */
export function recordTxTiming(t: TxTiming): void {
  load();
  const key = t.hash.toLowerCase();
  timings.set(key, { ...timings.get(key), ...t });
  emit();
  save();
}

/** Adds the block timestamp once it has been read. */
export function setTxBlockTime(hash: Hex, blockTime: number): void {
  load();
  const key = hash.toLowerCase();
  const t = timings.get(key);
  if (!t) return;
  timings.set(key, { ...t, blockTime });
  emit();
  save();
}

export function txTiming(hash: string): TxTiming | undefined {
  load();
  return timings.get(hash.toLowerCase());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function snapshot(): ReadonlyMap<string, TxTiming> {
  load();
  return timings;
}

const EMPTY: ReadonlyMap<string, TxTiming> = new Map();

/** Every timing this browser has, keyed by lowercase hash. Re-renders when one is added. */
export function useTxTimings(): ReadonlyMap<string, TxTiming> {
  return useSyncExternalStore(subscribe, snapshot, () => EMPTY);
}

/** Forgets every timing. For tests. */
export function clearTxTimings(): void {
  timings = new Map();
  loaded = true;
  emit();
  try {
    storage()?.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

import type { Network } from "@hunch-book/shared";
import { type Address, getAddress, isAddress } from "viem";
import type { PositionSide } from "./math";

// Hedges a person chose to track, kept in this browser only (localStorage). Nothing here is sent
// anywhere: the page reads the chain to show funding paid since the hedge started against what the
// hedge is worth, until the market settles. Storage can be missing or full, so every access is guarded.

export const HEDGE_STORAGE_KEY = "hunch-book:hedges:v1";

export interface TrackedHedge {
  id: string;
  network: Network;
  createdAt: number;
  /** The Perpl position being hedged. */
  perpId: string;
  symbol: string;
  side: PositionSide;
  units: number;
  /** Funding sum and block when tracking started: funding paid is measured from here. */
  startBlock: string;
  startSum: string;
  /** The hedge. */
  market: Address;
  buy: "yes" | "no";
  mode: "pool" | "book";
  /** USDC staked (pool) or spent (book). */
  cost: number;
  /** Tokens bought (book), or null for a pool stake. */
  tokens: number | null;
  /** USDC the hedge was projected to pay if it wins, when it was chosen. */
  payoutIfWin: number;
}

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function storage(): StorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const intString = (v: unknown): v is string => typeof v === "string" && /^-?\d+$/.test(v);

function valid(raw: unknown): TrackedHedge | null {
  const h = raw as Partial<TrackedHedge> | null;
  if (!h || typeof h !== "object") return null;
  if (
    typeof h.id !== "string" ||
    (h.network !== "monad-testnet" && h.network !== "monad-mainnet") ||
    !finite(h.createdAt) ||
    !intString(h.perpId) ||
    typeof h.symbol !== "string" ||
    (h.side !== "long" && h.side !== "short") ||
    !finite(h.units) ||
    !intString(h.startBlock) ||
    !intString(h.startSum) ||
    typeof h.market !== "string" ||
    !isAddress(h.market) ||
    (h.buy !== "yes" && h.buy !== "no") ||
    (h.mode !== "pool" && h.mode !== "book") ||
    !finite(h.cost) ||
    !(h.tokens === null || finite(h.tokens)) ||
    !finite(h.payoutIfWin)
  ) {
    return null;
  }
  return { ...(h as TrackedHedge), market: getAddress(h.market) };
}

export function loadHedges(network: Network, store: StorageLike | null = storage()): TrackedHedge[] {
  if (!store) return [];
  try {
    const parsed: unknown = JSON.parse(store.getItem(HEDGE_STORAGE_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(valid)
      .filter((h): h is TrackedHedge => h !== null && h.network === network)
      .sort((a, b) => b.createdAt - a.createdAt);
  } catch {
    return [];
  }
}

function saveAll(hedges: TrackedHedge[], store: StorageLike | null): boolean {
  if (!store) return false;
  try {
    store.setItem(HEDGE_STORAGE_KEY, JSON.stringify(hedges));
    return true;
  } catch {
    return false;
  }
}

function loadAll(store: StorageLike | null): TrackedHedge[] {
  if (!store) return [];
  try {
    const parsed: unknown = JSON.parse(store.getItem(HEDGE_STORAGE_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.map(valid).filter((h): h is TrackedHedge => h !== null) : [];
  } catch {
    return [];
  }
}

/** Adds a hedge. Returns false when this browser cannot store it (private mode, full storage). */
export function trackHedge(hedge: TrackedHedge, store: StorageLike | null = storage()): boolean {
  const rest = loadAll(store).filter((h) => h.id !== hedge.id);
  return saveAll([hedge, ...rest].slice(0, 50), store);
}

export function untrackHedge(id: string, store: StorageLike | null = storage()): boolean {
  return saveAll(
    loadAll(store).filter((h) => h.id !== id),
    store,
  );
}

/** A short unique id for a tracked hedge. */
export function hedgeId(now: number = Date.now()): string {
  return `${now.toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

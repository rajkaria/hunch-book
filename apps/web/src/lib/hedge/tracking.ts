import type { Network } from "@hunch-book/shared";
import { type Address, getAddress, isAddress } from "viem";
import type { PositionSide } from "./math";

// Hedges a person chose to track, kept in this browser only (localStorage). Nothing here is sent
// anywhere: the page reads the chain to show funding paid since the hedge started against what the
// hedge is worth, until every market in it settles. Storage can be missing or full, so every access is
// guarded.
//
// Schema v1 (this file): { version: 1, baskets: TrackedBasket[] } under BASKET_STORAGE_KEY. A basket is
// one or more legs, each a market, a side and a size.
// Schema v0 (before baskets): an array of single-market hedges under LEGACY_HEDGE_STORAGE_KEY. The first
// read moves each one into a one-leg basket with the same id, then retires the old key; if that write
// fails, the old records stay where they were and the next read tries again.

export const BASKET_STORAGE_KEY = "hunch-book:hedge-baskets";
/** Where v0 kept single-market hedges. Its name says v1; the records under it are schema v0. */
export const LEGACY_HEDGE_STORAGE_KEY = "hunch-book:hedges:v1";
export const BASKET_SCHEMA_VERSION = 1;
/** Baskets kept per browser; the oldest go first. */
export const MAX_BASKETS = 50;

/** One market in a tracked basket. */
export interface TrackedLeg {
  market: Address;
  buy: "yes" | "no";
  mode: "pool" | "book";
  /** USDC staked (pool) or spent (book). */
  cost: number;
  /** Tokens bought (book), or null for a pool stake. */
  tokens: number | null;
  /** USDC the leg was projected to pay if it wins, when it was chosen. */
  payoutIfWin: number;
}

export interface TrackedBasket {
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
  /** The share of the projected funding the basket was sized to cover (1 for a migrated v0 hedge). */
  cover: number;
  legs: TrackedLeg[];
}

/** A v0 record: one hedge on one market. */
export interface TrackedHedgeV0 {
  id: string;
  network: Network;
  createdAt: number;
  perpId: string;
  symbol: string;
  side: PositionSide;
  units: number;
  startBlock: string;
  startSum: string;
  market: Address;
  buy: "yes" | "no";
  mode: "pool" | "book";
  cost: number;
  tokens: number | null;
  payoutIfWin: number;
}

export type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function storage(): StorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const intString = (v: unknown): v is string => typeof v === "string" && /^-?\d+$/.test(v);
const isNetwork = (v: unknown): v is Network => v === "monad-testnet" || v === "monad-mainnet";
const isSide = (v: unknown): v is PositionSide => v === "long" || v === "short";

/** The fields a position shares across both schemas. */
function validPosition(h: Record<string, unknown>): boolean {
  return (
    typeof h.id === "string" &&
    isNetwork(h.network) &&
    finite(h.createdAt) &&
    intString(h.perpId) &&
    typeof h.symbol === "string" &&
    isSide(h.side) &&
    finite(h.units) &&
    intString(h.startBlock) &&
    intString(h.startSum)
  );
}

function validLeg(raw: unknown): TrackedLeg | null {
  const l = raw as Partial<TrackedLeg> | null;
  if (!l || typeof l !== "object") return null;
  if (
    typeof l.market !== "string" ||
    !isAddress(l.market) ||
    (l.buy !== "yes" && l.buy !== "no") ||
    (l.mode !== "pool" && l.mode !== "book") ||
    !finite(l.cost) ||
    !(l.tokens === null || finite(l.tokens)) ||
    !finite(l.payoutIfWin)
  ) {
    return null;
  }
  return {
    market: getAddress(l.market),
    buy: l.buy,
    mode: l.mode,
    cost: l.cost,
    tokens: l.tokens,
    payoutIfWin: l.payoutIfWin,
  };
}

/** A stored v1 basket, or null when any field is off. A basket with a bad leg is dropped whole. */
export function validBasket(raw: unknown): TrackedBasket | null {
  const b = raw as Record<string, unknown> | null;
  if (!b || typeof b !== "object" || !validPosition(b)) return null;
  if (!finite(b.cover) || b.cover <= 0 || !Array.isArray(b.legs) || b.legs.length === 0) return null;
  const legs = b.legs.map(validLeg);
  if (legs.some((l) => l === null)) return null;
  const p = b as unknown as TrackedBasket;
  return {
    id: p.id,
    network: p.network,
    createdAt: p.createdAt,
    perpId: p.perpId,
    symbol: p.symbol,
    side: p.side,
    units: p.units,
    startBlock: p.startBlock,
    startSum: p.startSum,
    cover: p.cover,
    legs: legs as TrackedLeg[],
  };
}

/** A v0 single-market hedge as a one-leg basket, keeping its id, its start and its numbers. */
export function migrateV0(raw: unknown): TrackedBasket | null {
  const h = raw as Record<string, unknown> | null;
  if (!h || typeof h !== "object" || !validPosition(h)) return null;
  const leg = validLeg(h);
  if (!leg) return null;
  const v0 = h as unknown as TrackedHedgeV0;
  return {
    id: v0.id,
    network: v0.network,
    createdAt: v0.createdAt,
    perpId: v0.perpId,
    symbol: v0.symbol,
    side: v0.side,
    units: v0.units,
    startBlock: v0.startBlock,
    startSum: v0.startSum,
    cover: 1,
    legs: [leg],
  };
}

function parse(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

interface Snapshot {
  baskets: TrackedBasket[];
  /** False when the store is missing, throws, or holds a newer schema this page must not overwrite. */
  writable: boolean;
}

function write(store: StorageLike, baskets: TrackedBasket[]): boolean {
  try {
    store.setItem(
      BASKET_STORAGE_KEY,
      JSON.stringify({ version: BASKET_SCHEMA_VERSION, baskets: baskets.slice(0, MAX_BASKETS) }),
    );
    return true;
  } catch {
    return false;
  }
}

/** Every stored basket, after moving any v0 hedges into one-leg baskets. */
function readAll(store: StorageLike | null): Snapshot {
  if (!store) return { baskets: [], writable: false };
  let current: unknown;
  let legacy: string | null;
  try {
    current = parse(store.getItem(BASKET_STORAGE_KEY));
    legacy = store.getItem(LEGACY_HEDGE_STORAGE_KEY);
  } catch {
    return { baskets: [], writable: false };
  }
  let baskets: TrackedBasket[] = [];
  if (current && typeof current === "object" && !Array.isArray(current)) {
    const { version, baskets: stored } = current as { version?: unknown; baskets?: unknown };
    // Written by a newer page (after a rollback, say): show nothing and never overwrite it.
    if (typeof version === "number" && version > BASKET_SCHEMA_VERSION)
      return { baskets: [], writable: false };
    if (version === BASKET_SCHEMA_VERSION && Array.isArray(stored)) {
      baskets = stored.map(validBasket).filter((b): b is TrackedBasket => b !== null);
    }
  }
  if (legacy === null) return { baskets, writable: true };
  const v0 = parse(legacy);
  const known = new Set(baskets.map((b) => b.id));
  const moved = (Array.isArray(v0) ? v0 : [])
    .map(migrateV0)
    .filter((b): b is TrackedBasket => b !== null && !known.has(b.id));
  const merged = [...baskets, ...moved].sort((a, b) => b.createdAt - a.createdAt);
  if (write(store, merged)) {
    try {
      store.removeItem(LEGACY_HEDGE_STORAGE_KEY);
    } catch {
      // The next read merges by id, so a key that would not go away adds nothing twice.
    }
  }
  return { baskets: merged, writable: true };
}

/** This network's tracked baskets, newest first. */
export function loadBaskets(network: Network, store: StorageLike | null = storage()): TrackedBasket[] {
  return readAll(store)
    .baskets.filter((b) => b.network === network)
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** Adds a basket. Returns false when this browser cannot store it (private mode, full storage). */
export function trackBasket(basket: TrackedBasket, store: StorageLike | null = storage()): boolean {
  const valid = validBasket(basket);
  const snapshot = readAll(store);
  if (!valid || !store || !snapshot.writable) return false;
  return write(store, [valid, ...snapshot.baskets.filter((b) => b.id !== valid.id)]);
}

export function untrackBasket(id: string, store: StorageLike | null = storage()): boolean {
  const snapshot = readAll(store);
  if (!store || !snapshot.writable) return false;
  return write(
    store,
    snapshot.baskets.filter((b) => b.id !== id),
  );
}

/** A short unique id for a tracked basket. */
export function basketId(now: number = Date.now()): string {
  return `${now.toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

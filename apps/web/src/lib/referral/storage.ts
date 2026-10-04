import { type Address, getAddress, isAddress, isAddressEqual } from "viem";

// The referrer a visitor arrived with, kept in this browser until they bind it onchain, dismiss it, or it
// goes stale. Nothing here is sent anywhere: binding is a transaction the visitor chooses to send
// (ReferralRegistry.bind). Every storage call is wrapped, so a private window or blocked storage just
// means no remembered referrer.

export const REFERRER_KEY = "hunch-book:referrer:v1";
/** A remembered referrer is forgotten after this long without a bind. */
export const REFERRER_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface StoredReferrer {
  referrer: Address;
  /** Unix milliseconds when the link was opened. */
  savedAt: number;
  /** The visitor said no to binding this referrer. */
  dismissed: boolean;
}

/** This browser's localStorage, or null on the server or when storage is blocked. */
export function browserStore(): KeyValueStore | null {
  try {
    if (typeof window === "undefined" || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

/** The remembered referrer, or null when there is none, it is malformed or it is older than the TTL. */
export function readReferrer(store: KeyValueStore | null, nowMs: number): StoredReferrer | null {
  if (!store) return null;
  let raw: string | null;
  try {
    raw = store.getItem(REFERRER_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredReferrer>;
    if (typeof parsed.referrer !== "string" || !isAddress(parsed.referrer, { strict: false })) return null;
    if (typeof parsed.savedAt !== "number" || !Number.isFinite(parsed.savedAt)) return null;
    if (nowMs - parsed.savedAt > REFERRER_TTL_MS || parsed.savedAt > nowMs + 60_000) {
      clearReferrer(store);
      return null;
    }
    return {
      referrer: getAddress(parsed.referrer),
      savedAt: parsed.savedAt,
      dismissed: parsed.dismissed === true,
    };
  } catch {
    return null;
  }
}

function write(store: KeyValueStore, value: StoredReferrer): boolean {
  try {
    store.setItem(REFERRER_KEY, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export type SaveResult = "saved" | "self" | "invalid" | "unavailable";

/**
 * Remembers `referrer` from a referral link. The latest link wins, except a link to the visitor's own
 * connected wallet, which is never stored (the registry refuses self-referral anyway).
 */
export function saveReferrer(
  store: KeyValueStore | null,
  referrer: string,
  nowMs: number,
  self?: Address,
): SaveResult {
  if (!isAddress(referrer, { strict: false })) return "invalid";
  const address = getAddress(referrer);
  if (self && isAddressEqual(self, address)) return "self";
  if (!store) return "unavailable";
  const current = readReferrer(store, nowMs);
  if (current && isAddressEqual(current.referrer, address)) {
    // Opening the same link again keeps a "no thanks" and refreshes the clock.
    return write(store, { ...current, savedAt: nowMs }) ? "saved" : "unavailable";
  }
  return write(store, { referrer: address, savedAt: nowMs, dismissed: false }) ? "saved" : "unavailable";
}

/** The visitor declined to bind: keep the record so the prompt stays away, but mark it. */
export function dismissReferrer(store: KeyValueStore | null, nowMs: number): void {
  if (!store) return;
  const current = readReferrer(store, nowMs);
  if (current) write(store, { ...current, dismissed: true });
}

export function clearReferrer(store: KeyValueStore | null): void {
  if (!store) return;
  try {
    store.removeItem(REFERRER_KEY);
  } catch {
    // Storage blocked: nothing to clear.
  }
}

/** A Map-backed store for tests and for environments without storage. */
export function memoryStore(initial: Record<string, string> = {}): KeyValueStore {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

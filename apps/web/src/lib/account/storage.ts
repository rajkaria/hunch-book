import type { PasskeyCredentialMetadata } from "@category-labs/mera";
import { type Address, getAddress, isAddress } from "viem";

// What this browser remembers about passkey accounts: public data only (credential id, transports,
// the account address and the domain). The secret never leaves the authenticator; the private key
// is derived again at every sign-in. Storage can be missing or full, so every access is guarded.

export const PASSKEY_STORAGE_KEY = "hunch-book:passkey-accounts";

export interface RememberedPasskey {
  address: Address;
  credential: PasskeyCredentialMetadata;
  rpId: string;
  /** Unix milliseconds of the last sign-in from this browser. */
  lastUsed: number;
}

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function storage(): StorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function parse(raw: string | null): RememberedPasskey[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.flatMap((item): RememberedPasskey[] => {
      const r = item as Partial<RememberedPasskey>;
      if (
        typeof r.address !== "string" ||
        !isAddress(r.address) ||
        typeof r.rpId !== "string" ||
        typeof r.credential?.credentialId !== "string" ||
        typeof r.lastUsed !== "number"
      ) {
        return [];
      }
      const transports = Array.isArray(r.credential.transports)
        ? r.credential.transports.filter((t): t is string => typeof t === "string")
        : undefined;
      return [
        {
          address: getAddress(r.address),
          rpId: r.rpId,
          lastUsed: r.lastUsed,
          credential: {
            credentialId: r.credential.credentialId,
            ...(transports ? { transports } : {}),
          },
        },
      ];
    });
  } catch {
    return [];
  }
}

/** Passkey accounts used from this browser on this domain, most recent first. */
export function rememberedPasskeys(rpId: string, store: StorageLike | null = storage()): RememberedPasskey[] {
  if (!store) return [];
  try {
    return parse(store.getItem(PASSKEY_STORAGE_KEY))
      .filter((r) => r.rpId === rpId)
      .sort((a, b) => b.lastUsed - a.lastUsed);
  } catch {
    return [];
  }
}

/** Records a sign-in. Keeps one entry per address and domain, and at most ten in all. */
export function rememberPasskey(entry: RememberedPasskey, store: StorageLike | null = storage()): void {
  if (!store) return;
  try {
    const all = parse(store.getItem(PASSKEY_STORAGE_KEY)).filter(
      (r) => !(r.rpId === entry.rpId && r.address.toLowerCase() === entry.address.toLowerCase()),
    );
    const next = [entry, ...all].sort((a, b) => b.lastUsed - a.lastUsed).slice(0, 10);
    store.setItem(PASSKEY_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Private mode or a full store: the account still works, it is just not remembered.
  }
}

/** Forgets one account in this browser. The passkey itself stays in the person's password manager. */
export function forgetPasskey(address: Address, rpId: string, store: StorageLike | null = storage()): void {
  if (!store) return;
  try {
    const rest = parse(store.getItem(PASSKEY_STORAGE_KEY)).filter(
      (r) => !(r.rpId === rpId && r.address.toLowerCase() === address.toLowerCase()),
    );
    if (rest.length === 0) store.removeItem(PASSKEY_STORAGE_KEY);
    else store.setItem(PASSKEY_STORAGE_KEY, JSON.stringify(rest));
  } catch {
    // ignore
  }
}

import type { PasskeySession } from "./passkey";

// The one live passkey session in this tab. It lives in memory only: a reload ends it, and the next
// sign-in derives the same account again from the passkey. The wagmi connector and the account UI
// both read it from here.

let active: PasskeySession | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function activePasskey(): PasskeySession | null {
  return active;
}

/** Makes `session` the live one. A previous, different session is ended first (its key is zeroed). */
export function setActivePasskey(session: PasskeySession): void {
  if (active && active !== session) active.end();
  active = session;
  emit();
}

/** Ends the live session, if any, and zeroes its key. */
export function endActivePasskey(): void {
  if (!active) return;
  active.end();
  active = null;
  emit();
}

/** Calls `listener` whenever the live session starts, changes or ends. Returns the unsubscribe. */
export function subscribePasskey(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

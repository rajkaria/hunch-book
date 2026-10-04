// A small in-process cache with a time to live, shared by concurrent requests: while a value is
// loading, every caller waits on the same promise, so a burst of requests costs one round of RPC
// calls. Failures are not cached. The CDN's Cache-Control headers do the rest.

interface Entry {
  expires: number;
  value: Promise<unknown>;
}

const store = new Map<string, Entry>();
const MAX_ENTRIES = 500;

export async function cached<T>(
  key: string,
  ttlMs: number,
  load: () => Promise<T>,
  now = Date.now(),
): Promise<T> {
  const hit = store.get(key);
  if (hit && hit.expires > now) return hit.value as Promise<T>;
  if (store.size >= MAX_ENTRIES) {
    for (const [k, e] of store) if (e.expires <= now) store.delete(k);
    if (store.size >= MAX_ENTRIES) store.clear();
  }
  const value = load();
  store.set(key, { expires: now + ttlMs, value });
  value.catch(() => {
    if (store.get(key)?.value === value) store.delete(key);
  });
  return value;
}

/** Empties the cache (tests). */
export function clearCache(): void {
  store.clear();
}

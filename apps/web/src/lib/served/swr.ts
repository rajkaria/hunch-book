// A stale-while-revalidate cache for the server's chain reads. One value per key, with the time it was
// read. A fresh value is served as it is; a stale one is served at once while one refresh runs in the
// background; with no usable value the caller waits for the read. Concurrent callers share one read, so
// a burst of visitors costs one round of RPC calls. A failed refresh keeps the last good value until it
// is too old to serve. Nothing here knows about the chain: the loader is passed in, and so is the clock.

export interface Served<T> {
  value: T;
  /** Milliseconds since the epoch when the value was read. */
  readAt: number;
}

export interface SwrTimes {
  /** Served without a refresh while younger than this (milliseconds). */
  freshMs: number;
  /** Served while a refresh runs, while younger than this (milliseconds). Older values are not served. */
  maxStaleMs: number;
}

export interface SwrResult<T> {
  served: Served<T>;
  state: "fresh" | "stale";
  /** The background refresh a stale answer started, so a server can keep it alive after responding. */
  refreshing?: Promise<void>;
}

interface Entry {
  value?: Served<unknown>;
  inflight?: Promise<Served<unknown>>;
}

export interface SwrCache {
  get<T>(key: string, times: SwrTimes, load: () => Promise<T>): Promise<SwrResult<T>>;
  /** The value for `key` if one is held, however old, without reading anything. */
  peek<T>(key: string): Served<T> | undefined;
  clear(): void;
}

export function createSwrCache(now: () => number = () => Date.now()): SwrCache {
  const entries = new Map<string, Entry>();

  function refresh<T>(key: string, load: () => Promise<T>): Promise<Served<T>> {
    const entry = entries.get(key) ?? {};
    if (entry.inflight) return entry.inflight as Promise<Served<T>>;
    // Started on a resolved promise, so `inflight` is set before either callback can run.
    const inflight: Promise<Served<T>> = Promise.resolve()
      .then(load)
      .then(
        (value) => {
          const served: Served<T> = { value, readAt: now() };
          entries.set(key, { value: served });
          return served;
        },
        (error: unknown) => {
          // Keep the last good value; only the read in flight is dropped.
          const current = entries.get(key);
          if (current?.inflight === inflight) entries.set(key, { value: current.value });
          throw error;
        },
      );
    entries.set(key, { value: entry.value, inflight });
    return inflight;
  }

  return {
    async get<T>(key: string, times: SwrTimes, load: () => Promise<T>): Promise<SwrResult<T>> {
      const held = entries.get(key)?.value as Served<T> | undefined;
      const age = held ? now() - held.readAt : Number.POSITIVE_INFINITY;
      if (held && age < times.freshMs) return { served: held, state: "fresh" };
      if (held && age < times.maxStaleMs) {
        const refreshing = refresh(key, load).then(
          () => undefined,
          () => undefined,
        );
        return { served: held, state: "stale", refreshing };
      }
      return { served: await refresh(key, load), state: "fresh" };
    },
    peek<T>(key: string): Served<T> | undefined {
      return entries.get(key)?.value as Served<T> | undefined;
    },
    clear(): void {
      entries.clear();
    },
  };
}

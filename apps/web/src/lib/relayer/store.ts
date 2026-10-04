// Counters and one-time claims for the relayer's caps. Two backends:
// - KV: an Upstash Redis (or Vercel KV) REST endpoint, shared by every server instance. Used when
//   KV_REST_API_URL and KV_REST_API_TOKEN are set.
// - Memory: one map per server instance. Caps then hold per instance only, and a restart forgets
//   them, which is why the drip also checks the chain (docs/ACCOUNTS.md, "Limits").
// Daily caps count per UTC day: the day is part of the key.

export interface RelayStore {
  readonly kind: "memory" | "kv";
  /** Adds one to `key`'s counter (kept `windowSeconds`). True while the count is within `limit`. */
  hit(key: string, limit: number, windowSeconds: number): Promise<boolean>;
  /** Claims `key` for `ttlSeconds`. False if it is already claimed. */
  claimOnce(key: string, ttlSeconds: number): Promise<boolean>;
  /** Gives a claim back, for example when the transaction it guarded was never sent. */
  release(key: string): Promise<void>;
}

/** "2026-10-04": the UTC day a daily counter belongs to. */
export function utcDay(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

export const DAY_SECONDS = 86_400;

export class MemoryStore implements RelayStore {
  readonly kind = "memory" as const;
  private readonly entries = new Map<string, { count: number; expires: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  private live(key: string): { count: number; expires: number } | undefined {
    const entry = this.entries.get(key);
    if (entry && entry.expires <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  private prune(): void {
    if (this.entries.size < 10_000) return;
    const now = this.now();
    for (const [key, entry] of this.entries) if (entry.expires <= now) this.entries.delete(key);
  }

  async hit(key: string, limit: number, windowSeconds: number): Promise<boolean> {
    this.prune();
    const entry = this.live(key) ?? { count: 0, expires: this.now() + windowSeconds * 1000 };
    entry.count += 1;
    this.entries.set(key, entry);
    return entry.count <= limit;
  }

  async claimOnce(key: string, ttlSeconds: number): Promise<boolean> {
    this.prune();
    if (this.live(key)) return false;
    this.entries.set(key, { count: 1, expires: this.now() + ttlSeconds * 1000 });
    return true;
  }

  async release(key: string): Promise<void> {
    this.entries.delete(key);
  }
}

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

/** Upstash Redis REST (the protocol Vercel KV speaks too). Fails closed: an error throws. */
export class KvStore implements RelayStore {
  readonly kind = "kv" as const;

  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly prefix = "hunch-book:relayer:",
    private readonly fetchImpl: Fetch = (input, init) => fetch(input, init),
  ) {}

  private async pipeline(commands: (string | number)[][]): Promise<unknown[]> {
    const res = await this.fetchImpl(`${this.url}/pipeline`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: JSON.stringify(commands),
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`The rate-limit store answered ${res.status}.`);
    const body = (await res.json()) as { result?: unknown; error?: string }[];
    if (!Array.isArray(body)) throw new Error("The rate-limit store sent an unexpected answer.");
    return body.map((r) => {
      if (r.error) throw new Error("The rate-limit store refused a command.");
      return r.result;
    });
  }

  async hit(key: string, limit: number, windowSeconds: number): Promise<boolean> {
    const k = this.prefix + key;
    const [count] = await this.pipeline([
      ["INCR", k],
      ["EXPIRE", k, windowSeconds],
    ]);
    return Number(count) <= limit;
  }

  async claimOnce(key: string, ttlSeconds: number): Promise<boolean> {
    const [result] = await this.pipeline([["SET", this.prefix + key, "1", "NX", "EX", ttlSeconds]]);
    return result === "OK";
  }

  async release(key: string): Promise<void> {
    await this.pipeline([["DEL", this.prefix + key]]);
  }
}

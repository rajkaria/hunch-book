import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type Address, getAddress, isAddress } from "viem";

// Who watches what: per Telegram chat, the markets and wallets it asked about. Kept in one JSON file
// (gitignored; on Railway, a mounted volume). Written atomically after every change.

export type WatchKind = "market" | "wallet";

export interface ChatWatches {
  markets: Address[];
  wallets: Address[];
}

export interface SubscriptionsFile {
  version: 1;
  chats: Record<string, ChatWatches>;
}

export type AddResult = "added" | "already" | "full";

const empty = (): SubscriptionsFile => ({ version: 1, chats: {} });

function clean(list: unknown): Address[] {
  if (!Array.isArray(list)) return [];
  const out: Address[] = [];
  for (const v of list) {
    if (typeof v === "string" && isAddress(v, { strict: false })) {
      const a = getAddress(v);
      if (!out.includes(a)) out.push(a);
    }
  }
  return out;
}

/** Parses the file's JSON, keeping every well-formed entry and dropping the rest. */
export function parseSubscriptions(text: string): SubscriptionsFile {
  try {
    const raw = JSON.parse(text) as { chats?: Record<string, { markets?: unknown; wallets?: unknown }> };
    const out = empty();
    for (const [chat, w] of Object.entries(raw.chats ?? {})) {
      if (!/^-?\d{1,20}$/.test(chat) || !w || typeof w !== "object") continue;
      const markets = clean(w.markets);
      const wallets = clean(w.wallets);
      if (markets.length + wallets.length > 0) out.chats[chat] = { markets, wallets };
    }
    return out;
  } catch {
    return empty();
  }
}

export class SubscriptionStore {
  private data: SubscriptionsFile;

  constructor(
    private readonly file: string | null,
    private readonly maxPerChat = 20,
  ) {
    this.data = file && existsSync(file) ? parseSubscriptions(readFileSync(file, "utf8")) : empty();
  }

  private save(): void {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.file);
  }

  list(chat: string): ChatWatches {
    const w = this.data.chats[chat];
    return { markets: [...(w?.markets ?? [])], wallets: [...(w?.wallets ?? [])] };
  }

  add(chat: string, kind: WatchKind, address: Address): AddResult {
    const w = this.data.chats[chat] ?? { markets: [], wallets: [] };
    const list = kind === "market" ? w.markets : w.wallets;
    const a = getAddress(address);
    if (list.includes(a)) return "already";
    if (w.markets.length + w.wallets.length >= this.maxPerChat) return "full";
    list.push(a);
    this.data.chats[chat] = w;
    this.save();
    return "added";
  }

  /** Removes `address` from both lists. Returns false when the chat was not watching it. */
  remove(chat: string, address: Address): boolean {
    const w = this.data.chats[chat];
    if (!w) return false;
    const a = getAddress(address);
    const before = w.markets.length + w.wallets.length;
    w.markets = w.markets.filter((x) => x !== a);
    w.wallets = w.wallets.filter((x) => x !== a);
    if (w.markets.length + w.wallets.length === before) return false;
    if (w.markets.length + w.wallets.length === 0) delete this.data.chats[chat];
    this.save();
    return true;
  }

  removeAll(chat: string): number {
    const w = this.data.chats[chat];
    if (!w) return 0;
    const n = w.markets.length + w.wallets.length;
    delete this.data.chats[chat];
    this.save();
    return n;
  }

  /** Chats watching this market directly. */
  marketWatchers(market: Address): string[] {
    return Object.entries(this.data.chats)
      .filter(([, w]) => w.markets.includes(market))
      .map(([chat]) => chat);
  }

  /** Every watched wallet, with the chats that watch it. */
  walletWatchers(): Map<Address, string[]> {
    const out = new Map<Address, string[]>();
    for (const [chat, w] of Object.entries(this.data.chats)) {
      for (const wallet of w.wallets) out.set(wallet, [...(out.get(wallet) ?? []), chat]);
    }
    return out;
  }

  chatCount(): number {
    return Object.keys(this.data.chats).length;
  }
}

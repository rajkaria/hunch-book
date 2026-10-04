import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Remembered } from "./events.js";

// What the notifier remembers across restarts: each market's last state (so a restart reports what
// changed while it was down, and nothing twice), which "ready to collect" messages went out, and the
// Telegram update offset. Safe to delete: the next cycle starts a fresh baseline.

export interface NotifierState {
  markets: Map<string, Remembered>;
  redeemed: Set<string>;
  telegramOffset: number;
}

export function emptyState(): NotifierState {
  return { markets: new Map(), redeemed: new Set(), telegramOffset: 0 };
}

export function parseState(text: string): NotifierState {
  try {
    const raw = JSON.parse(text) as {
      markets?: Record<string, { phase?: unknown; graduated?: unknown; baseBps?: unknown }>;
      redeemed?: unknown;
      telegramOffset?: unknown;
    };
    const state = emptyState();
    for (const [key, m] of Object.entries(raw.markets ?? {})) {
      if (typeof m?.phase !== "number" || typeof m.graduated !== "boolean") continue;
      state.markets.set(key.toLowerCase(), {
        phase: m.phase,
        graduated: m.graduated,
        baseBps: typeof m.baseBps === "number" ? m.baseBps : null,
      });
    }
    if (Array.isArray(raw.redeemed)) {
      for (const k of raw.redeemed) if (typeof k === "string") state.redeemed.add(k);
    }
    if (typeof raw.telegramOffset === "number" && Number.isSafeInteger(raw.telegramOffset)) {
      state.telegramOffset = raw.telegramOffset;
    }
    return state;
  } catch {
    return emptyState();
  }
}

export function loadState(file: string | null): NotifierState {
  return file && existsSync(file) ? parseState(readFileSync(file, "utf8")) : emptyState();
}

export function saveState(file: string | null, state: NotifierState): void {
  if (!file) return;
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(
    tmp,
    JSON.stringify(
      {
        markets: Object.fromEntries(state.markets),
        redeemed: [...state.redeemed],
        telegramOffset: state.telegramOffset,
      },
      null,
      2,
    ),
  );
  renameSync(tmp, file);
}

import { type Address, getAddress, isAddress } from "viem";
import { welcomeMessage } from "./messages.js";
import type { SubscriptionStore } from "./store.js";

// The bot's commands: /start, /help, /watch <market|wallet>, /unwatch <address|all>, /list.

export type Command =
  | { kind: "start" }
  | { kind: "help" }
  | { kind: "list" }
  | { kind: "watch"; arg: string }
  | { kind: "unwatch"; arg: string }
  | { kind: "unknown"; name: string }
  | { kind: "none" };

/** "/watch@HunchBookBot 0x…" → { kind: "watch", arg: "0x…" }. Plain chat text is "none". */
export function parseCommand(text: string): Command {
  const match = /^\/([a-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!match) return { kind: "none" };
  const name = (match[1] as string).toLowerCase();
  const arg = (match[2] ?? "").trim();
  switch (name) {
    case "start":
      return { kind: "start" };
    case "help":
      return { kind: "help" };
    case "list":
      return { kind: "list" };
    case "watch":
      return { kind: "watch", arg };
    case "unwatch":
      return { kind: "unwatch", arg };
    default:
      return { kind: "unknown", name };
  }
}

/** An address from "0x…", or from a market link such as https://book.playhunch.xyz/m/0x…. */
export function parseTarget(arg: string): Address | null {
  const found = /0x[0-9a-fA-F]{40}/.exec(arg);
  if (!found || !isAddress(found[0], { strict: false })) return null;
  return getAddress(found[0]);
}

export interface CommandDeps {
  store: SubscriptionStore;
  /** Asks the factory whether the address is a Hunch Book market. */
  isMarket(address: Address): Promise<boolean>;
  appUrl: string;
  explorer: string;
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** The reply to one message, or null for plain text the bot ignores. */
export async function handleCommand(chat: string, text: string, deps: CommandDeps): Promise<string | null> {
  const cmd = parseCommand(text);
  switch (cmd.kind) {
    case "none":
      return null;
    case "start":
    case "help":
      return welcomeMessage(deps.appUrl);
    case "unknown":
      return `I do not know /${cmd.name}. Try /help.`;
    case "list": {
      const w = deps.store.list(chat);
      if (w.markets.length + w.wallets.length === 0) {
        return "You are not watching anything yet. Send /watch with a market link or a wallet address.";
      }
      const lines = [
        ...w.markets.map((m) => `Market ${short(m)}: ${deps.appUrl}/m/${m}`),
        ...w.wallets.map((a) => `Wallet ${short(a)}: ${deps.explorer}/address/${a}`),
      ];
      return `You are watching:\n${lines.join("\n")}`;
    }
    case "watch": {
      if (!cmd.arg) return "Send /watch with a market link, a market address or a wallet address.";
      const target = parseTarget(cmd.arg);
      if (!target) return "That is not an address. Send /watch 0x… or paste a market link.";
      const market = await deps.isMarket(target);
      const result = deps.store.add(chat, market ? "market" : "wallet", target);
      if (result === "full")
        return "You are watching as many things as one chat can. /unwatch something first.";
      if (result === "already") return `You are already watching ${short(target)}.`;
      return market
        ? `Watching market ${short(target)}. I will tell you when it graduates, settles, voids or moves a lot.\n${deps.appUrl}/m/${target}`
        : `Watching wallet ${short(target)}. I will tell you when a market it holds graduates, settles or voids, and when it has winnings to collect.`;
    }
    case "unwatch": {
      if (cmd.arg.toLowerCase() === "all") {
        const n = deps.store.removeAll(chat);
        return n === 0 ? "You were not watching anything." : `Stopped watching all ${n}.`;
      }
      const target = parseTarget(cmd.arg);
      if (!target) return "Send /unwatch with the address you are watching, or /unwatch all.";
      return deps.store.remove(chat, target)
        ? `Stopped watching ${short(target)}.`
        : `You were not watching ${short(target)}.`;
    }
  }
}

import { type Deployment, deployments, hunchBookFactoryAbi, stacksOf } from "@hunch-book/shared";
import type { Abi, Address } from "viem";
import { handleCommand } from "./commands.js";
import type { NotifierConfig } from "./config.js";
import { diffMarkets, redeemable, redeemKey } from "./events.js";
import { Health } from "./health.js";
import { errorMessage, log } from "./log.js";
import {
  hasPosition,
  type MarketState,
  type Position,
  positionKey,
  readMarketsFromChain,
  readMarketsFromIndexer,
  readPositions,
} from "./markets.js";
import { eventMessage, type Links, redeemMessage } from "./messages.js";
import { loadState, type NotifierState, saveState } from "./state.js";
import { SubscriptionStore } from "./store.js";
import type { Messenger, TelegramClient } from "./telegram.js";

type Client = Parameters<typeof readMarketsFromChain>[0];

export interface CycleSummary {
  markets: number;
  events: number;
  sent: number;
  source: "chain" | "indexer";
}

export interface NotifierDeps {
  client: Client;
  messenger: Messenger;
  /** The Telegram client for commands; null in dry run. */
  telegram: TelegramClient | null;
  store?: SubscriptionStore;
  state?: NotifierState;
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
}

export class Notifier {
  readonly store: SubscriptionStore;
  readonly state: NotifierState;
  readonly health: Health;
  private readonly deployment: Deployment;
  private readonly links: Links;
  private sentTotal = 0;

  constructor(
    private readonly config: NotifierConfig,
    private readonly deps: NotifierDeps,
  ) {
    this.deployment = deployments[config.network];
    this.store = deps.store ?? new SubscriptionStore(config.subscriptionsFile, config.maxWatchesPerChat);
    this.state = deps.state ?? loadState(config.stateFile);
    this.health = new Health(config.healthFile, {
      network: config.network,
      mode: config.live ? "live" : "dry-run",
    });
    this.links = { appUrl: config.appUrl, explorer: this.deployment.explorer };
  }

  private async readMarkets(): Promise<{ markets: MarketState[]; source: "chain" | "indexer" }> {
    if (this.config.indexerUrl) {
      try {
        return {
          markets: await readMarketsFromIndexer(this.config.indexerUrl, this.deps.fetchImpl, this.deployment),
          source: "indexer",
        };
      } catch (error) {
        log("indexer-failed", { error: errorMessage(error), fallback: "chain" }, "warn");
      }
    }
    return { markets: await readMarketsFromChain(this.deps.client, this.deployment), source: "chain" };
  }

  private async send(chats: Iterable<string>, text: string): Promise<number> {
    let n = 0;
    for (const chat of new Set(chats)) {
      if (await this.deps.messenger.send(chat, text)) n += 1;
    }
    if (n > 0) {
      this.sentTotal += n;
      this.health.update({ messagesSent: this.sentTotal, lastMessageAt: new Date().toISOString() });
    }
    return n;
  }

  /** Chats that should hear about `market`: its watchers, and watchers of wallets that hold it. */
  recipients(market: Address, wallets: Map<Address, string[]>, positions: Map<string, Position>): string[] {
    const chats = new Set(this.store.marketWatchers(market));
    for (const [wallet, walletChats] of wallets) {
      if (hasPosition(positions.get(positionKey(wallet, market)))) for (const c of walletChats) chats.add(c);
    }
    return [...chats];
  }

  /** One pass: read the markets, report what changed, and tell wallets what they can collect. */
  async cycle(): Promise<CycleSummary> {
    const { markets, source } = await this.readMarkets();
    const { events, next } = diffMarkets(this.state.markets, markets, this.config.priceMoveBps);
    this.state.markets = next;

    const allWallets = this.store.walletWatchers();
    const wallets = new Map([...allWallets].slice(0, this.config.maxWallets));
    const positions =
      wallets.size > 0 && markets.length > 0
        ? await readPositions(this.deps.client, markets, [...wallets.keys()])
        : new Map<string, Position>();

    let sent = 0;
    for (const e of events) {
      log("event", {
        kind: e.kind,
        market: e.market.address,
        ...(e.kind === "move" ? { from: e.fromBps, to: e.toBps } : {}),
      });
      sent += await this.send(
        this.recipients(e.market.address, wallets, positions),
        eventMessage(e, this.links),
      );
    }

    for (const [wallet, chats] of wallets) {
      for (const m of markets) {
        const key = redeemKey(wallet, m.address);
        if (this.state.redeemed.has(key)) continue;
        const r = redeemable(m, positions.get(positionKey(wallet, m.address)));
        if (!r) continue;
        log("redeem-ready", { wallet, market: m.address, kind: r.kind, amount: r.amount });
        sent += await this.send(chats, redeemMessage(wallet, m, r, this.links));
        this.state.redeemed.add(key);
      }
    }

    saveState(this.config.stateFile, this.state);
    this.health.update({
      cycles: this.health.current().cycles + 1,
      lastCycleAt: new Date().toISOString(),
      markets: markets.length,
      chats: this.store.chatCount(),
      watchedWallets: allWallets.size,
      source,
    });
    return { markets: markets.length, events: events.length, sent, source };
  }

  /** True when any stack's factory knows the address. */
  async isMarket(address: Address): Promise<boolean> {
    for (const stack of stacksOf(this.deployment)) {
      try {
        const known = (await this.deps.client.readContract({
          address: stack.contracts.factory as Address,
          abi: hunchBookFactoryAbi as Abi,
          functionName: "isMarket",
          args: [address],
        })) as boolean;
        if (known) return true;
      } catch {
        // One stack's factory not answering never hides a market on another.
      }
    }
    return false;
  }

  /** Answers one incoming message. Exposed for tests and the command loop. */
  reply(chat: string, text: string): Promise<string | null> {
    return handleCommand(chat, text, {
      store: this.store,
      isMarket: (a) => this.isMarket(a),
      appUrl: this.config.appUrl,
      explorer: this.deployment.explorer,
    });
  }

  /** Long-polls Telegram for commands until `signal` aborts. Live mode only. */
  async listen(signal: AbortSignal): Promise<void> {
    const telegram = this.deps.telegram;
    if (!telegram) return;
    while (!signal.aborted) {
      try {
        const updates = await telegram.getUpdates(this.state.telegramOffset);
        for (const u of updates) {
          this.state.telegramOffset = Math.max(this.state.telegramOffset, u.update_id + 1);
          const text = u.message?.text;
          const chat = u.message?.chat.id;
          if (!text || chat === undefined) continue;
          const answer = await this.reply(String(chat), text);
          if (answer) await this.send([String(chat)], answer);
        }
        if (updates.length > 0) saveState(this.config.stateFile, this.state);
      } catch (error) {
        if (signal.aborted) break;
        log("telegram-poll-failed", { error: errorMessage(error) }, "warn");
        this.health.error(errorMessage(error));
        await new Promise((r) => setTimeout(r, 5_000));
      }
    }
  }
}

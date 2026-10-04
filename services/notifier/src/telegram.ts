import { log } from "./log.js";

// Telegram's Bot API over HTTPS with long polling (getUpdates), so the notifier needs no public URL
// or webhook. In dry run there is no client at all: messages are printed instead.

export interface Update {
  update_id: number;
  message?: { chat: { id: number }; text?: string };
}

export interface Messenger {
  send(chat: string, text: string): Promise<boolean>;
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export class TelegramClient implements Messenger {
  private readonly base: string;

  constructor(
    token: string,
    private readonly fetchImpl: Fetch = fetch,
  ) {
    this.base = `https://api.telegram.org/bot${token}`;
  }

  private async call<T>(method: string, body: unknown, timeoutMs: number): Promise<T> {
    const res = await this.fetchImpl(`${this.base}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = (await res.json()) as { ok: boolean; result?: T; description?: string };
    if (!data.ok) throw new Error(`Telegram ${method} failed: ${data.description ?? res.status}`);
    return data.result as T;
  }

  /** Long poll: waits up to `waitSeconds` for new messages after `offset`. */
  getUpdates(offset: number, waitSeconds = 25): Promise<Update[]> {
    return this.call<Update[]>(
      "getUpdates",
      { offset, timeout: waitSeconds, allowed_updates: ["message"] },
      (waitSeconds + 10) * 1000,
    );
  }

  async send(chat: string, text: string): Promise<boolean> {
    try {
      await this.call(
        "sendMessage",
        { chat_id: chat, text: text.slice(0, 4_000), link_preview_options: { is_disabled: true } },
        15_000,
      );
      return true;
    } catch (error) {
      log("send-failed", { chat, error: error instanceof Error ? error.message : String(error) }, "warn");
      return false;
    }
  }
}

/** Prints what would be sent. Used when NOTIFIER_ENABLED is off or no TELEGRAM_BOT_TOKEN is set. */
export class DryRunMessenger implements Messenger {
  readonly sent: { chat: string; text: string }[] = [];

  async send(chat: string, text: string): Promise<boolean> {
    this.sent.push({ chat, text });
    log("dry-run-message", { chat, text });
    return true;
  }
}

import { alertRequest } from "@hunch-book/shared";
import { errorMessage, log, redact, toJson } from "./log.js";

// Optional alerts: a POST to KEEPER_ALERT_WEBHOOK on errors, a low MON balance, book requests to Kuru
// and each settlement. Each alert key (event + market) is posted at most once per
// KEEPER_ALERT_REPEAT_SECONDS. Most webhooks get the JSON payload; an ntfy topic (https://ntfy.sh/...)
// gets a short titled text instead, so it reads well as a phone notification. The payload holds
// addresses, numbers and messages only, and passes through the same redaction as the log, so no key or
// token-bearing URL can leave in it. A failed POST is logged, never thrown.

/** One `name: value` line per field, for a phone notification. */
function fieldLines(fields: Record<string, unknown>): string {
  return Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([name, value]) => `${name}: ${typeof value === "string" ? value : toJson(value)}`)
    .join("\n");
}

type Fetch = typeof fetch;

export class Alerter {
  private readonly sent = new Map<string, number>();

  constructor(
    private readonly url: string | undefined,
    private readonly base: { service: string; network: string; keeper: string; enabled: boolean },
    private readonly repeatSeconds: number,
    private readonly fetchFn: Fetch = fetch,
    private readonly clock: () => number = Date.now,
  ) {}

  get enabled(): boolean {
    return this.url !== undefined;
  }

  /** True if an alert with this key would be posted now. */
  due(key: string): boolean {
    const last = this.sent.get(key);
    return last === undefined || this.clock() - last >= this.repeatSeconds * 1000;
  }

  async send(key: string, event: string, fields: Record<string, unknown>, level = "error"): Promise<boolean> {
    if (!this.url || !this.due(key)) return false;
    this.sent.set(key, this.clock());
    const body = redact(
      toJson({ ...this.base, level, event, ts: new Date(this.clock()).toISOString(), ...fields }),
    );
    const service = this.base.service.replace(/^hunch-book-/, "");
    const link = typeof fields.url === "string" && fields.url.startsWith("https://") ? fields.url : undefined;
    const init = alertRequest(this.url, body, {
      title: redact(`Hunch Book ${service} (${this.base.network}): ${event}`),
      text: redact(fieldLines(fields) || event),
      level,
      click: link === undefined ? undefined : redact(link),
    });
    try {
      const res = await this.fetchFn(this.url, { ...init, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) log("alert-failed", { alert: event, status: res.status }, "warn");
      return res.ok;
    } catch (error) {
      log("alert-failed", { alert: event, error: errorMessage(error) }, "warn");
      return false;
    }
  }
}

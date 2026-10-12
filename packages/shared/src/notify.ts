// How the keeper and the watchdog post an alert to a webhook.
//
// Most webhooks (Slack, Discord through a proxy, any JSON endpoint) take the service's JSON as is. An
// ntfy topic (https://ntfy.sh/<topic>, or a self-hosted ntfy server) pushes straight to a phone through
// the ntfy app, but shows the body as plain text: for ntfy the alert goes out as a short text with a
// title, a priority (an error rings through as "urgent") and tags, so it reads well on a lock screen.

export type AlertLevel = "info" | "ok" | "warn" | "error" | "fail";

export interface AlertText {
  title: string;
  /** A few short lines; the first one is what a lock screen shows. */
  text: string;
  level: AlertLevel | string;
  /** Opened when the notification is tapped (ntfy only). */
  click?: string;
}

/** True for an ntfy topic URL: ntfy.sh, or a host named ntfy.* (self-hosted). */
export function isNtfyUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "ntfy.sh" || host.startsWith("ntfy.");
  } catch {
    return false;
  }
}

const PRIORITY: Record<string, string> = {
  fail: "urgent",
  error: "urgent",
  warn: "high",
  info: "default",
  ok: "low",
};
const TAGS: Record<string, string> = {
  fail: "rotating_light",
  error: "rotating_light",
  warn: "warning",
  info: "white_check_mark",
  ok: "white_check_mark",
};

// HTTP header values must be printable ASCII on one line.
const header = (value: string, max = 250) =>
  value
    .replace(/[^\x20-\x7e]/g, "?")
    .slice(0, max)
    .trim();

/** The fetch options for one alert: ntfy text for an ntfy URL, else the JSON body as is. */
export function alertRequest(url: string, json: string, alert: AlertText): RequestInit {
  if (!isNtfyUrl(url)) {
    return { method: "POST", headers: { "content-type": "application/json" }, body: json };
  }
  const headers: Record<string, string> = {
    "content-type": "text/plain; charset=utf-8",
    Title: header(alert.title),
    Priority: PRIORITY[alert.level] ?? "default",
    Tags: TAGS[alert.level] ?? "bell",
  };
  if (alert.click) headers.Click = header(alert.click, 2000);
  // ntfy caps a message at 4,096 bytes; keep well inside it.
  return { method: "POST", headers, body: alert.text.slice(0, 3500) };
}

import type { Address } from "viem";

// Referral and share links. A referral link is /r/<referrer>, optionally with ?next=<a page of this app>
// so a shared market link can carry the referral and still land on the market.

const MAX_NEXT_LENGTH = 200;
const SAFE_PATH = /^\/(?!\/)[A-Za-z0-9\-._~/?=&%]*$/;

/**
 * A `next` value that is a path inside this app, or null. Anything that could leave the site (a full
 * URL, a protocol-relative "//host", a backslash) is refused.
 */
export function safeNextPath(raw: string | string[] | undefined | null): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return null;
  const v = value.trim();
  if (v.length === 0 || v.length > MAX_NEXT_LENGTH) return null;
  return SAFE_PATH.test(v) ? v : null;
}

export function referralPath(referrer: Address, next?: string | null): string {
  const safe = next ? safeNextPath(next) : null;
  return safe ? `/r/${referrer}?next=${encodeURIComponent(safe)}` : `/r/${referrer}`;
}

/** The full referral link on `site` (no trailing slash). */
export function referralUrl(site: string, referrer: Address, next?: string | null): string {
  return `${site.replace(/\/+$/, "")}${referralPath(referrer, next)}`;
}

export function marketPath(market: Address): string {
  return `/m/${market}`;
}

export function marketUrl(site: string, market: Address): string {
  return `${site.replace(/\/+$/, "")}${marketPath(market)}`;
}

/** If `next` is a market page, its address (for the share card of a referral link). */
export function marketInPath(next: string | null): Address | null {
  const match = next ? /^\/m\/(0x[0-9a-fA-F]{40})(?:[/?#]|$)/.exec(next) : null;
  return match ? (match[1] as Address) : null;
}

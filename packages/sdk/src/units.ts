import { USDC_DECIMALS } from "@hunch-book/shared";

// USDC and outcome tokens both use 6 decimals: 1 USDC (or 1 token) is 1,000,000 base units.

/** "12.5" or "12,500.25" to base units. Throws on anything that is not a non-negative amount with at most 6 decimals. */
export function parseUsdc(input: string | number): bigint {
  const s = String(input).trim().replace(/,/g, "");
  if (!/^\d+(\.\d*)?$|^\.\d+$/.test(s)) throw new Error(`"${String(input)}" is not a USDC amount`);
  const [whole = "0", frac = ""] = s.split(".");
  if (frac.length > USDC_DECIMALS) throw new Error(`"${String(input)}" has more than 6 decimals`);
  return BigInt(whole || "0") * 10n ** BigInt(USDC_DECIMALS) + BigInt(frac.padEnd(USDC_DECIMALS, "0") || "0");
}

/** Base units to a plain decimal string: 12500250000n is "12500.25". */
export function formatUsdc(amount: bigint): string {
  const negative = amount < 0n;
  const abs = negative ? -amount : amount;
  const unit = 10n ** BigInt(USDC_DECIMALS);
  const whole = abs / unit;
  const frac = (abs % unit).toString().padStart(USDC_DECIMALS, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

/** Basis points as a percent string: 4167 is "41.67%". */
export function formatBps(bps: number | bigint | null): string | null {
  if (bps === null) return null;
  const n = Number(bps);
  return `${(n / 100).toFixed(n % 100 === 0 ? 0 : 2)}%`;
}

/**
 * A copy of `value` that JSON.stringify can write: bigints become decimal strings, nested objects and
 * arrays are copied. Use it before sending SDK results over HTTP or to an agent.
 */
export function toJsonSafe<T>(value: T): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map((v) => toJsonSafe(v));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== undefined) out[k] = toJsonSafe(v);
    }
    return out;
  }
  return value;
}

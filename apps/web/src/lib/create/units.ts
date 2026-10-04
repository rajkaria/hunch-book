// Fixed-point parsing for numbers a person types: dollar amounts, thresholds, strikes. Exact (no
// floating point), so what the preview shows is exactly what goes into the market's parameters.

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Parses "1,234.5", "$0.0000014" or "-2.5" into an integer scaled by 10^decimals.
 * Returns null for an empty input (nothing to check yet). Never rounds: more decimal places than the
 * unit can hold is an error, so a threshold never silently moves.
 */
export function parseFixed(
  input: string,
  decimals: number,
  { allowNegative = false, unitName = "this unit" }: { allowNegative?: boolean; unitName?: string } = {},
): Parsed<bigint> | null {
  let s = input.trim().replace(/[\s,]/g, "");
  if (s === "") return null;
  let negative = false;
  if (s.startsWith("-")) {
    negative = true;
    s = s.slice(1);
  }
  if (s.startsWith("$")) s = s.slice(1);
  if (s === "" || s === "." || !/^\d*\.?\d*$/.test(s)) {
    return { ok: false, error: "Enter a plain number, like 1.25." };
  }
  if (negative && !allowNegative) return { ok: false, error: "Enter a number above zero." };
  const [whole = "", frac = ""] = s.split(".");
  if (frac.length > decimals) {
    return {
      ok: false,
      error:
        decimals === 0
          ? `Use a whole number: ${unitName} has no decimal places.`
          : `Use at most ${decimals} decimal places: that is the smallest step ${unitName} records.`,
    };
  }
  const scaled = BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
  return { ok: true, value: negative ? -scaled : scaled };
}

/** The reverse of parseFixed, for prefilling an input: no grouping, no trailing zeros. */
export function toInputString(value: bigint, decimals: number): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = (abs / base).toString();
  const frac = decimals === 0 ? "" : (abs % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  const body = frac.length > 0 ? `${whole}.${frac}` : whole;
  return negative && body !== "0" ? `-${body}` : body;
}

/**
 * Rounds a positive fixed-point value to `digits` significant figures (half up), for defaults such as
 * a strike near the current price: 84,721.3 becomes 84,700 with three.
 */
export function roundSignificant(value: bigint, digits = 3): bigint {
  if (value <= 0n) return value;
  const length = value.toString().length;
  if (length <= digits) return value;
  const step = 10n ** BigInt(length - digits);
  return ((value + step / 2n) / step) * step;
}

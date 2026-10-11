// JSON for read results that hold bigints (block numbers, USDC amounts, market ids). A bigint travels as
// {"$bigint": "123"} and comes back as 123n; everything else is plain JSON. Values the server sends this
// way decode to the same shapes the browser's own chain reads produce, so pages render either one.

const TAG = "$bigint";
const INTEGER = /^-?\d+$/;

function isTagged(value: unknown): value is { [TAG]: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  const raw = (value as Record<string, unknown>)[TAG];
  return keys.length === 1 && typeof raw === "string" && INTEGER.test(raw);
}

/** JSON text for `value`, with every bigint tagged. */
export function toWireJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => (typeof v === "bigint" ? { [TAG]: v.toString() } : v));
}

/** The value `toWireJson` wrote, with its bigints restored. */
export function fromWireJson<T>(text: string): T {
  return JSON.parse(text, (_key, v: unknown) => (isTagged(v) ? BigInt(v[TAG]) : v)) as T;
}

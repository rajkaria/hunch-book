// One JSON object per line on stdout. Bigints print as strings. Never pass a private key here; as a
// second line of defence, every registered secret is replaced before a line leaves the process.

export type Level = "info" | "warn" | "error";
type Sink = (line: string) => void;

let sink: Sink = (line) => console.log(line);
let secrets: string[] = [];

/** Tests swap the sink to keep output quiet or to inspect lines. */
export function setLogSink(next: Sink): void {
  sink = next;
}

/** Strings (keys, URLs with tokens) that are cut from every log line and alert. */
export function setRedactions(values: string[]): void {
  secrets = values.filter((v) => v.length >= 8);
}

export function redact(text: string): string {
  let out = text;
  for (const secret of secrets) out = out.split(secret).join("[redacted]");
  return out;
}

export const toJson = (value: unknown, space?: number) =>
  JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? v.toString() : v), space);

export function log(event: string, fields: Record<string, unknown> = {}, level: Level = "info"): void {
  // A field can never overwrite the line's own event, level or time.
  const ts = new Date().toISOString();
  const entry = { ts, level, event, ...fields };
  Object.assign(entry, { ts, level, event });
  sink(redact(toJson(entry)));
}

export function errorMessage(error: unknown): string {
  if (
    error &&
    typeof error === "object" &&
    "shortMessage" in error &&
    typeof error.shortMessage === "string"
  ) {
    const details = "details" in error && typeof error.details === "string" ? error.details : "";
    return details && !error.shortMessage.includes(details)
      ? `${error.shortMessage} ${details}`
      : error.shortMessage;
  }
  return error instanceof Error ? error.message : String(error);
}

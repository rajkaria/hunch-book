// One JSON object per line on stdout. Bigints print as strings. Never pass a private key here.

export type Level = "info" | "warn" | "error";
type Sink = (line: string) => void;

let sink: Sink = (line) => console.log(line);
/** Fields added to every line (the stack and venue a bot quotes on, when it runs several). */
let context: Record<string, unknown> = {};

/** Tests swap the sink to keep output quiet or to inspect lines. */
export function setLogSink(next: Sink): void {
  sink = next;
}

/** Sets the fields added to every line from now on (empty object: none). */
export function setLogContext(next: Record<string, unknown>): void {
  context = next;
}

export function log(event: string, fields: Record<string, unknown> = {}, level: Level = "info"): void {
  // A field can never overwrite the line's own event, level or time.
  const ts = new Date().toISOString();
  const entry = { ts, level, event, ...context, ...fields };
  Object.assign(entry, { ts, level, event });
  sink(JSON.stringify(entry, (_key, value) => (typeof value === "bigint" ? value.toString() : value)));
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

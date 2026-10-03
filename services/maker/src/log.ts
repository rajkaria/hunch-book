// One JSON object per line on stdout. Bigints print as strings. Never pass a private key here.

export type Level = "info" | "warn" | "error";
type Sink = (line: string) => void;

let sink: Sink = (line) => console.log(line);

/** Tests swap the sink to keep output quiet or to inspect lines. */
export function setLogSink(next: Sink): void {
  sink = next;
}

export function log(event: string, fields: Record<string, unknown> = {}, level: Level = "info"): void {
  const entry = { ts: new Date().toISOString(), level, event, ...fields };
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

// Small helpers shared by the app's route handlers.

/** Bodies above this are refused before parsing: every request these routes accept is tiny. */
export const MAX_BODY_BYTES = 4_096;

export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(
    JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
    {
      status,
      headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
    },
  );
}

/** The parsed JSON body, or undefined when it is missing, too large or not JSON. */
export async function readJson(request: Request): Promise<unknown> {
  try {
    const text = await request.text();
    if (!text || text.length > MAX_BODY_BYTES) return undefined;
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Error text safe for a server log: URLs (which can carry RPC keys) are cut out. */
export function safeErrorText(error: unknown): string {
  const raw =
    error && typeof error === "object" && "shortMessage" in error && typeof error.shortMessage === "string"
      ? error.shortMessage
      : error instanceof Error
        ? error.message
        : String(error);
  return raw.replace(/https?:\/\/\S+/g, "[url]").slice(0, 300);
}

/** A 502 for failures reaching the chain, the store or the settings, logged without secrets. */
export function serverError(error: unknown): Response {
  console.error(JSON.stringify({ event: "relayer-error", error: safeErrorText(error) }));
  return jsonResponse(502, {
    ok: false,
    error: "The server could not complete this just now. Nothing was sent. Try again in a minute.",
  });
}

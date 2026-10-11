import { after } from "next/server";
import { buildNetwork, parseNetwork } from "@/lib/config";
import { parseServedKind, servedCacheControl } from "@/lib/served/keys";
import { loadServed } from "@/lib/served/load";
import { toWireJson } from "@/lib/served/wire";

// GET /api/read/markets|proof|landing?network=monad-testnet: what the app's list pages render, read once
// on the server and shared by every visitor (lib/served). The answer is {readAt, data} with bigints
// tagged (lib/served/wire.ts); the CDN keeps it for a few seconds and serves it stale while it refreshes.
// Wallet-specific reads stay in the browser.

export const dynamic = "force-dynamic";

function problem(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export async function GET(
  request: Request,
  context: { params: Promise<{ kind: string }> },
): Promise<Response> {
  const kind = parseServedKind((await context.params).kind);
  if (!kind) return problem(404, "Unknown read. Try markets, proof or landing.");
  const asked = new URL(request.url).searchParams.get("network");
  const network = asked === null ? buildNetwork : parseNetwork(asked);
  if (!network) return problem(400, "Unknown network. Try monad-testnet or monad-mainnet.");
  try {
    const result = await loadServed(kind, network);
    // A stale answer started a refresh: keep the function alive until it lands.
    if (result.refreshing) after(() => result.refreshing);
    return new Response(toWireJson({ readAt: result.served.readAt, data: result.served.value }), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": servedCacheControl(kind),
        "X-Hunch-Read": result.state,
      },
    });
  } catch {
    return problem(503, "Could not read the chain just now. The page reads it directly instead.");
  }
}

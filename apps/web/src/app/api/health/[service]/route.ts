import { buildNetwork, parseNetwork } from "@/lib/config";
import { jsonResponse } from "@/lib/relayer/http";
import { fetchServiceHealth, healthUrl, type ServiceName } from "@/lib/status/health";

// GET /api/health/keeper and /api/health/maker (?network=monad-testnet or monad-mainnet; the build's
// network by default): the services' health snapshots for the status page. The services' /health
// endpoints send no CORS headers, so the browser asks this route, which fetches the network's URL
// (KEEPER_HEALTH_URL / MAKER_HEALTH_URL on testnet, with _MAINNET on mainnet, each also read with a
// NEXT_PUBLIC_ prefix) and passes on only known fields.

export const runtime = "nodejs";

const SERVICES: readonly ServiceName[] = ["keeper", "maker"];

export async function GET(
  request: Request,
  context: { params: Promise<{ service: string }> },
): Promise<Response> {
  const { service } = await context.params;
  if (!(SERVICES as readonly string[]).includes(service)) {
    return jsonResponse(404, { error: "Unknown service. Use keeper or maker." });
  }
  const asked = new URL(request.url).searchParams.get("network");
  const network = asked === null ? buildNetwork : parseNetwork(asked);
  if (!network) return jsonResponse(400, { error: "Unknown network. Use monad-testnet or monad-mainnet." });
  const name = service as ServiceName;
  const view = await fetchServiceHealth(name, healthUrl(name, process.env, network));
  return jsonResponse(200, view, { "cache-control": "public, s-maxage=15, stale-while-revalidate=30" });
}

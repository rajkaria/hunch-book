import { jsonResponse } from "@/lib/relayer/http";
import { fetchServiceHealth, healthUrl, type ServiceName } from "@/lib/status/health";

// GET /api/health/keeper and /api/health/maker: the services' health snapshots for the status page.
// The services' /health endpoints send no CORS headers, so the browser asks this route, which fetches
// NEXT_PUBLIC_KEEPER_HEALTH_URL / NEXT_PUBLIC_MAKER_HEALTH_URL and passes on only known fields.

export const runtime = "nodejs";

const SERVICES: readonly ServiceName[] = ["keeper", "maker"];

export async function GET(
  _request: Request,
  context: { params: Promise<{ service: string }> },
): Promise<Response> {
  const { service } = await context.params;
  if (!(SERVICES as readonly string[]).includes(service)) {
    return jsonResponse(404, { error: "Unknown service. Use keeper or maker." });
  }
  const name = service as ServiceName;
  const view = await fetchServiceHealth(name, healthUrl(name, process.env));
  return jsonResponse(200, view, { "cache-control": "public, s-maxage=15, stale-while-revalidate=30" });
}

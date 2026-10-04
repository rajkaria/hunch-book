import { apiDeps } from "../_lib/deps";
import { getStats } from "../_lib/handlers";
import { preflight } from "../_lib/http";

// GET /api/v1/stats: protocol totals from the chain, and from the indexer when configured (docs/API.md).

export function GET(request: Request): Promise<Response> {
  return getStats(request, apiDeps());
}

export function OPTIONS(): Response {
  return preflight();
}

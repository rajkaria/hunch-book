import { apiDeps } from "../_lib/deps";
import { getMarkets } from "../_lib/handlers";
import { preflight } from "../_lib/http";

// GET /api/v1/markets?phase=&template=&asset=&limit=&offset=&format=csv (docs/API.md).

export function GET(request: Request): Promise<Response> {
  return getMarkets(request, apiDeps());
}

export function OPTIONS(): Response {
  return preflight();
}

import { apiDeps } from "../_lib/deps";
import { getMarkets } from "../_lib/handlers";
import { preflight } from "../_lib/http";

// GET /api/v1/markets?phase=&template=&asset=&limit=&offset=&format=csv (docs/API.md). Each market names
// its `stack`, its book's `venue` ("hunch" or "kuru") and a `venueLabel`.

export function GET(request: Request): Promise<Response> {
  return getMarkets(request, apiDeps());
}

export function OPTIONS(): Response {
  return preflight();
}

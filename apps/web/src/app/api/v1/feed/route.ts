import { apiDeps } from "../_lib/deps";
import { getFeed } from "../_lib/handlers";
import { preflight } from "../_lib/http";

// GET /api/v1/feed: open markets as cards, for the main Hunch app and anyone else (docs/API.md).

export function GET(request: Request): Promise<Response> {
  return getFeed(request, apiDeps());
}

export function OPTIONS(): Response {
  return preflight();
}

import { apiDeps } from "./_lib/deps";
import { getIndex } from "./_lib/handlers";
import { preflight } from "./_lib/http";

// GET /api/v1: the list of endpoints (docs/API.md).

export function GET(request: Request): Response {
  return getIndex(request, apiDeps());
}

export function OPTIONS(): Response {
  return preflight();
}

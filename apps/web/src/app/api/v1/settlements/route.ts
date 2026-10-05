import { apiDeps } from "../_lib/deps";
import { getSettlements } from "../_lib/handlers";
import { preflight } from "../_lib/http";

// GET /api/v1/settlements: every settled or voided market with the read that settled it (docs/API.md).

// A cold archive verifies each market against the chain; give it time.
export const maxDuration = 60;

export async function GET(request: Request): Promise<Response> {
  return getSettlements(request, apiDeps());
}

export function OPTIONS(): Response {
  return preflight();
}

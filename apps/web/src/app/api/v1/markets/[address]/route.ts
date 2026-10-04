import { apiDeps } from "../../_lib/deps";
import { getMarket } from "../../_lib/handlers";
import { preflight } from "../../_lib/http";

// GET /api/v1/markets/{address}: one market in full (docs/API.md).

export async function GET(
  request: Request,
  { params }: { params: Promise<{ address: string }> },
): Promise<Response> {
  return getMarket(request, (await params).address, apiDeps());
}

export function OPTIONS(): Response {
  return preflight();
}

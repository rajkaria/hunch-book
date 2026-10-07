import { apiDeps } from "../../_lib/deps";
import { preflight } from "../../_lib/http";
import { getKuruRequests } from "../../_lib/kuru";

// GET /api/v1/kuru/requests: the setup and book each Kuru v2 market still needs from Kuru (docs/API.md).

export const maxDuration = 60;

export async function GET(request: Request): Promise<Response> {
  return getKuruRequests(request, apiDeps());
}

export function OPTIONS(): Response {
  return preflight();
}

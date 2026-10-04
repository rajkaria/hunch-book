import { apiDeps } from "../../../_lib/deps";
import { getEvidence } from "../../../_lib/handlers";
import { preflight } from "../../../_lib/http";

// GET /api/v1/markets/{address}/evidence: settlement evidence and its verification (docs/API.md).

export async function GET(
  request: Request,
  { params }: { params: Promise<{ address: string }> },
): Promise<Response> {
  return getEvidence(request, (await params).address, apiDeps());
}

export function OPTIONS(): Response {
  return preflight();
}

import { apiDeps } from "../../../_lib/deps";
import { getTrades } from "../../../_lib/handlers";
import { preflight } from "../../../_lib/http";

// GET /api/v1/markets/{address}/trades?limit=&blocks=&format=csv: fills on the market's book, Kuru's
// or Hunch Book's own (docs/API.md).

export async function GET(
  request: Request,
  { params }: { params: Promise<{ address: string }> },
): Promise<Response> {
  return getTrades(request, (await params).address, apiDeps());
}

export function OPTIONS(): Response {
  return preflight();
}

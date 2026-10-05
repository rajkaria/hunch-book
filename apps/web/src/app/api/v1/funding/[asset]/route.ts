import { apiDeps } from "../../_lib/deps";
import { getFunding } from "../../_lib/handlers";
import { preflight } from "../../_lib/http";

// GET /api/v1/funding/{asset}: the open market on a Perpl perp's funding this period (docs/API.md).

export async function GET(
  request: Request,
  { params }: { params: Promise<{ asset: string }> },
): Promise<Response> {
  return getFunding(request, (await params).asset, apiDeps());
}

export function OPTIONS(): Response {
  return preflight();
}

import { apiDeps } from "../../../api/v1/_lib/deps";
import { getFundingEmbed } from "../../../api/v1/_lib/handlers";

// GET /embed/funding/{asset}: "what does the market think?" about a Perpl perp's funding, as a card for
// an iframe, with no script (docs/API.md, Funding card). Like /embed/m, it may be framed by any site.

export async function GET(
  request: Request,
  { params }: { params: Promise<{ asset: string }> },
): Promise<Response> {
  return getFundingEmbed(request, (await params).asset, apiDeps());
}

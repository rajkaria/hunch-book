import { apiDeps } from "../../../api/v1/_lib/deps";
import { getEmbed } from "../../../api/v1/_lib/handlers";

// GET /embed/m/{address}: a market card for an iframe, with no script (docs/API.md, Embed). Framing
// is allowed from any site here, and only here: next.config.ts denies it everywhere else.

export async function GET(
  request: Request,
  { params }: { params: Promise<{ address: string }> },
): Promise<Response> {
  return getEmbed(request, (await params).address, apiDeps());
}

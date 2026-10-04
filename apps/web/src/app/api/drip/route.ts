import { appNetwork } from "@/lib/config";
import { dripStatus, handleDrip } from "@/lib/relayer/drip";
import { jsonResponse, readJson, serverError } from "@/lib/relayer/http";
import { clientIp, dripDeps, relayerConfig } from "@/lib/relayer/server";

// Gas drip for new accounts (docs/ACCOUNTS.md). GET says whether it runs here; POST { address }
// sends DRIP_AMOUNT_MON once to a new account. Without RELAYER_PRIVATE_KEY both answer that the drip
// is not set up, and the app shows the faucet instead.

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  try {
    const result = dripStatus(relayerConfig(), appNetwork);
    return jsonResponse(result.status, result.body);
  } catch (error) {
    return serverError(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  const body = await readJson(request);
  if (body === undefined) return jsonResponse(400, { ok: false, error: "Send a JSON body." });
  try {
    const result = await handleDrip(body, clientIp(request.headers), dripDeps());
    return jsonResponse(result.status, result.body);
  } catch (error) {
    return serverError(error);
  }
}

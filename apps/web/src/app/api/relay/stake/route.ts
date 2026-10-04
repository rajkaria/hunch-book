import { appNetwork } from "@/lib/config";
import { jsonResponse, readJson, serverError } from "@/lib/relayer/http";
import { handleRelayStake, relayStatus } from "@/lib/relayer/relay";
import { clientIp, relayDeps, relayerConfig } from "@/lib/relayer/server";

// Relayed stakes (docs/ACCOUNTS.md). GET says whether relaying runs here and its limits. POST takes
// { market, user, side, amount, validAfter, validBefore, salt, signature } for
// Market.stakeWithAuthorization, checks it, and submits it from the relayer key. Returns the hash.

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  try {
    const result = relayStatus(relayerConfig(), appNetwork);
    return jsonResponse(result.status, result.body);
  } catch (error) {
    return serverError(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  const body = await readJson(request);
  if (body === undefined) return jsonResponse(400, { ok: false, error: "Send a JSON body." });
  try {
    const result = await handleRelayStake(body, clientIp(request.headers), relayDeps());
    return jsonResponse(result.status, result.body);
  } catch (error) {
    return serverError(error);
  }
}

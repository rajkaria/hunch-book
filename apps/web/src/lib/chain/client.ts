import type { Deployment } from "@hunch-book/shared";
import { type Chain, createPublicClient, http, type PublicClient } from "viem";
import { appChain, appDeployment } from "../config";

/** The subset of a viem public client the read layer uses, so tests can pass a stub. */
export type ReadClient = Pick<PublicClient, "readContract" | "multicall" | "getBlock">;

/** Multicall3 at the canonical address; deployed on Monad testnet and mainnet. */
export const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;

export function makePublicClient(
  deployment: Deployment = appDeployment,
  chain: Chain = appChain,
): PublicClient {
  return createPublicClient({
    chain,
    transport: http(deployment.rpc, { timeout: 12_000, retryCount: 2 }),
  });
}

let shared: PublicClient | undefined;

/** One public client per page load (browser) or per server process. */
export function getPublicClient(): PublicClient {
  shared ??= makePublicClient();
  return shared;
}

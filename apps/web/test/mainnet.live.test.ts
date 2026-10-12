import { chainsByNetwork, deployments, hunchBookFactoryAbi, rpcUrlsOf } from "@hunch-book/shared";
import { createPublicClient, fallback, http, isAddressEqual } from "viem";
import { describe, expect, it } from "vitest";
import { MAINNET_FIRST_MARKET } from "../src/lib/config";

// Opt-in: the address "Live on Monad mainnet" links to is the mainnet factory's first market (eth_call
// only). Run with HUNCH_LIVE_TESTS=1.

describe.skipIf(process.env.HUNCH_LIVE_TESTS !== "1")("Monad mainnet's first market", () => {
  it("is marketAt(0) on the mainnet factory", async () => {
    const mainnet = deployments["monad-mainnet"];
    const factory = mainnet.hunchBook.factory;
    if (!factory) throw new Error("The mainnet factory is not in deployments/monad-mainnet.json.");
    const client = createPublicClient({
      chain: chainsByNetwork["monad-mainnet"],
      transport: fallback(rpcUrlsOf(mainnet).map((url) => http(url))),
    });
    const first = await client.readContract({
      address: factory,
      abi: hunchBookFactoryAbi,
      functionName: "marketAt",
      args: [0n],
    });
    expect(isAddressEqual(first, MAINNET_FIRST_MARKET)).toBe(true);
  });
});

import { deployments, monadTestnet } from "@hunch-book/shared";
import { createPublicClient, http } from "viem";
import { describe, expect, it } from "vitest";
import { evaluateChain } from "../src/lib/status/checks";
import { readStatusSnapshot } from "../src/lib/status/reads";

// Opt-in: the status page's reads against Monad testnet (eth_call only). Run with HUNCH_LIVE_TESTS=1.

describe.skipIf(process.env.HUNCH_LIVE_TESTS !== "1")("status reads against Monad testnet", () => {
  it("reads a snapshot whose obligations add up and whose vault is solvent", async () => {
    const testnet = deployments["monad-testnet"];
    const client = createPublicClient({ chain: monadTestnet, transport: http(testnet.rpc) });
    const s = await readStatusSnapshot(client as never, testnet);
    expect(s.markets.length).toBe(s.factory.marketCount);
    const checks = Object.fromEntries(evaluateChain(s).map((c) => [c.id, c.level]));
    expect(checks.solvency).toBe("ok");
    expect(checks.obligations).toBe("ok");
    expect(checks.supply).toBe("ok");
  });
});

// The dev and start wrapper: which config and which data source the indexer runs with.
import { describe, expect, it } from "vitest";
import { envioEnv } from "../scripts/envio.js";

describe("envio wrapper", () => {
  it("uses HyperSync with an RPC fallback when there is a token", () => {
    const { env, notes } = envioEnv({ ENVIO_API_TOKEN: "set" }, "testnet");
    expect(env).toMatchObject({ ENVIO_CONFIG: "config.yaml", ENVIO_RPC_MODE: "fallback" });
    expect(notes).toEqual([]);
  });

  it("reads logs over RPC alone without a token, and says so", () => {
    const { env, notes } = envioEnv({}, "testnet");
    expect(env.ENVIO_RPC_MODE).toBe("sync");
    expect(notes[0]).toMatch(/No ENVIO_API_TOKEN/);
  });

  it("keeps an explicit RPC mode and maps the repo's RPC variable names", () => {
    const { env } = envioEnv(
      { ENVIO_RPC_MODE: "realtime", MONAD_MAINNET_RPC: "https://example.org/rpc" },
      "mainnet",
    );
    expect(env).toMatchObject({
      ENVIO_CONFIG: "config.mainnet.yaml",
      ENVIO_RPC_MODE: "realtime",
      ENVIO_MONAD_MAINNET_RPC: "https://example.org/rpc",
    });
    expect(
      envioEnv({ ENVIO_MONAD_TESTNET_RPC: "a", MONAD_TESTNET_RPC: "b" }, "testnet").env
        .ENVIO_MONAD_TESTNET_RPC,
    ).toBe("a");
  });

  it("rejects unknown networks", () => {
    expect(() => envioEnv({}, "devnet")).toThrow(/unknown network devnet/);
  });
});

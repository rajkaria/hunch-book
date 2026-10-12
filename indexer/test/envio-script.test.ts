// The dev and start wrapper: which config and which data source the indexer runs with.
import { describe, expect, it } from "vitest";
import { envioEnv, parseArgs } from "../scripts/envio.js";

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

  it("takes the network from our --network flag and removes it", () => {
    expect(parseArgs(["dev"])).toEqual({ network: "testnet", args: ["dev"], hosted: false });
    expect(parseArgs(["start", "--network", "mainnet"])).toEqual({
      network: "mainnet",
      args: ["start"],
      hosted: false,
    });
  });

  it("follows the --config file Envio Cloud passes, and keeps it for Envio", () => {
    expect(parseArgs(["start", "--config", "./config.mainnet.yaml"])).toEqual({
      network: "mainnet",
      args: ["start", "--config", "./config.mainnet.yaml"],
      hosted: true,
    });
    expect(parseArgs(["start", "--config", "config.yaml"]).network).toBe("testnet");
    expect(() => parseArgs(["start", "--config", "other.yaml"])).toThrow(/unknown config other.yaml/);
  });

  it("leaves the hosted service on HyperSync with the RPC as a fallback, token or not", () => {
    const { env, notes } = envioEnv({}, "mainnet", true);
    expect(env).toMatchObject({ ENVIO_CONFIG: "config.mainnet.yaml", ENVIO_RPC_MODE: "fallback" });
    expect(notes).toEqual([]);
    expect(envioEnv({ ENVIO_RPC_MODE: "sync" }, "mainnet", true).env.ENVIO_RPC_MODE).toBe("sync");
  });
});

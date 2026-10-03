import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { describeConfig, loadEnvFile, MIN_TOTAL_SPREAD, parseConfig, parseEnvFile } from "../src/config.js";

// A throwaway key generated for this test file only; it holds nothing on any network.
const KEY = `0x${"ab".repeat(32)}`;

describe("parseConfig", () => {
  it("defaults to testnet with the kill switch off", () => {
    const config = parseConfig({});
    expect(config.network).toBe("monad-testnet");
    expect(config.enabled).toBe(false);
    expect(config.rpcUrl).toBe("https://testnet-rpc.monad.xyz");
    expect(config.quote.minSpread).toBe(MIN_TOTAL_SPREAD);
    expect(config.quote).toMatchObject({ minPrice: 0.01, maxPrice: 0.99, levels: 1, inventoryCap: 100 });
  });

  it("turns on only with an explicit yes and a key", () => {
    expect(() => parseConfig({ MAKER_ENABLED: "1" })).toThrow(/MAKER_PRIVATE_KEY/);
    expect(parseConfig({ MAKER_ENABLED: "true", MAKER_PRIVATE_KEY: KEY }).enabled).toBe(true);
    expect(parseConfig({ MAKER_ENABLED: "0", MAKER_PRIVATE_KEY: KEY }).enabled).toBe(false);
    expect(parseConfig({ MAKER_ENABLED: "maybe", MAKER_PRIVATE_KEY: KEY }).enabled).toBe(false);
  });

  it("picks the RPC: override, then the network's variable, then deployments", () => {
    expect(parseConfig({ MAKER_NETWORK: "monad-mainnet" }).rpcUrl).toBe("https://rpc.monad.xyz");
    expect(parseConfig({ MONAD_TESTNET_RPC: "http://a" }).rpcUrl).toBe("http://a");
    expect(parseConfig({ MONAD_TESTNET_RPC: "http://a", MAKER_RPC_URL: "http://b" }).rpcUrl).toBe("http://b");
  });

  it("rejects bad values with the variable's name", () => {
    expect(() => parseConfig({ MAKER_NETWORK: "goerli" })).toThrow(/MAKER_NETWORK/);
    expect(() => parseConfig({ MAKER_INVENTORY_CAP: "-5" })).toThrow(/MAKER_INVENTORY_CAP/);
    expect(() => parseConfig({ MAKER_LEVELS: "9" })).toThrow(/MAKER_LEVELS/);
    expect(() => parseConfig({ MAKER_PRIVATE_KEY: "0x1234" })).toThrow(/MAKER_PRIVATE_KEY/);
    expect(() => parseConfig({ MAKER_MARKETS: "0xnope" })).toThrow(/MAKER_MARKETS/);
  });

  it("never exposes the key when described for logs", () => {
    const described = JSON.stringify(describeConfig(parseConfig({ MAKER_PRIVATE_KEY: KEY })), (_k, v) =>
      typeof v === "bigint" ? v.toString() : v,
    );
    expect(described).not.toContain("abab");
    expect(described).toContain('"privateKey":"set"');
  });
});

describe(".env loading", () => {
  it("parses comments, export, and quotes", () => {
    expect(parseEnvFile('# c\nexport A=1\nB="two words"\nC=3 # note\n\nbad line\n')).toEqual({
      A: "1",
      B: "two words",
      C: "3",
    });
  });

  it("loads only the maker's variables and never overrides the environment", () => {
    const dir = mkdtempSync(join(tmpdir(), "maker-env-"));
    const file = join(dir, ".env");
    writeFileSync(
      file,
      "MAKER_ORDER_SIZE=5\nMAKER_SKEW=0.03\nKEEPER_PRIVATE_KEY=x\nMONAD_TESTNET_RPC=http://r\n",
    );
    const env: Record<string, string | undefined> = { MAKER_SKEW: "0.01" };
    expect(loadEnvFile(file, env).sort()).toEqual(["MAKER_ORDER_SIZE", "MONAD_TESTNET_RPC"]);
    expect(env).toEqual({ MAKER_SKEW: "0.01", MAKER_ORDER_SIZE: "5", MONAD_TESTNET_RPC: "http://r" });
    expect(loadEnvFile(join(dir, "missing"), env)).toEqual([]);
  });
});

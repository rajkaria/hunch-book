import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  configForStack,
  describeConfig,
  loadEnvFile,
  parseConfig,
  parseEnvFile,
  secretsOf,
} from "../src/config.js";

// A throwaway key generated for this test file only; it holds nothing on any network.
const KEY = `0x${"cd".repeat(32)}`;

describe("parseConfig", () => {
  it("defaults to testnet with the kill switch off", () => {
    const config = parseConfig({});
    expect(config).toMatchObject({
      network: "monad-testnet",
      enabled: false,
      privateKey: undefined,
      rpcUrl: "https://testnet-rpc.monad.xyz",
      rpcRequestsPerSecond: 10,
      pollSeconds: 15,
      maxGasPriceGwei: 200,
      maxGasPerTx: 6_000_000n,
      minMon: 0.5,
      claimBatch: 50,
      logRange: 100,
      settleRetrySeconds: 60,
      settleRetryMaxSeconds: 1_800,
      bookRequestSeconds: 21_600,
      healthPort: undefined,
      alertWebhook: undefined,
      indexerUrl: undefined,
      pythApiKey: undefined,
      hermesUrl: "https://hermes.pyth.network",
      markets: undefined,
    });
    expect(config.stateFile).toMatch(/services\/keeper\/\.keeper-state\.json$/);
    expect(config.healthFile).toMatch(/services\/keeper\/health\.json$/);
  });

  it("turns on only with an explicit yes and a key", () => {
    expect(() => parseConfig({ KEEPER_ENABLED: "1" })).toThrow(/KEEPER_PRIVATE_KEY/);
    expect(parseConfig({ KEEPER_ENABLED: "true", KEEPER_PRIVATE_KEY: KEY }).enabled).toBe(true);
    expect(parseConfig({ KEEPER_ENABLED: "on", KEEPER_PRIVATE_KEY: KEY.slice(2) }).privateKey).toBe(KEY);
    expect(parseConfig({ KEEPER_ENABLED: "0", KEEPER_PRIVATE_KEY: KEY }).enabled).toBe(false);
    expect(parseConfig({ KEEPER_ENABLED: "maybe", KEEPER_PRIVATE_KEY: KEY }).enabled).toBe(false);
  });

  it("picks the RPC: override, then the network's variable, then deployments", () => {
    expect(parseConfig({ KEEPER_NETWORK: "monad-mainnet" }).rpcUrl).toBe("https://rpc.monad.xyz");
    expect(parseConfig({ MONAD_TESTNET_RPC: "http://a" }).rpcUrl).toBe("http://a");
    expect(parseConfig({ MONAD_TESTNET_RPC: "http://a", KEEPER_RPC_URL: "http://b" }).rpcUrl).toBe(
      "http://b",
    );
    expect(parseConfig({ KEEPER_NETWORK: "monad-mainnet", MONAD_TESTNET_RPC: "http://a" }).rpcUrl).toBe(
      "https://rpc.monad.xyz",
    );
  });

  it("reads every setting", () => {
    const config = parseConfig({
      KEEPER_RPC_RPS: "5",
      KEEPER_POLL_SECONDS: "30",
      KEEPER_MAX_GAS_PRICE_GWEI: "150",
      KEEPER_MAX_GAS_PER_TX: "4000000",
      KEEPER_MIN_MON: "2",
      KEEPER_CLAIM_BATCH: "25",
      KEEPER_LOG_RANGE: "50",
      KEEPER_SCAN_REQUESTS_PER_CYCLE: "40",
      KEEPER_SETTLE_RETRY_SECONDS: "10",
      KEEPER_SETTLE_RETRY_MAX_SECONDS: "600",
      KEEPER_BOOK_REQUEST_SECONDS: "3600",
      KEEPER_STATE_FILE: "/tmp/s.json",
      KEEPER_HEALTH_FILE: "/tmp/h.json",
      KEEPER_HEALTH_PORT: "8080",
      KEEPER_ALERT_WEBHOOK: "https://hooks.example.com/abc",
      KEEPER_ALERT_REPEAT_SECONDS: "60",
      INDEXER_URL: "https://indexer.example.com/v1/graphql",
      PYTH_API_KEY: "pyth-key-123",
      KEEPER_HERMES_URL: "https://hermes.example.com/",
      KEEPER_MARKETS: "0x2a44b99014cf73065bfb89197a08de09d18d3982, ",
    });
    expect(config).toMatchObject({
      rpcRequestsPerSecond: 5,
      pollSeconds: 30,
      maxGasPriceGwei: 150,
      maxGasPerTx: 4_000_000n,
      minMon: 2,
      claimBatch: 25,
      logRange: 50,
      scanRequestsPerCycle: 40,
      settleRetrySeconds: 10,
      settleRetryMaxSeconds: 600,
      bookRequestSeconds: 3_600,
      stateFile: "/tmp/s.json",
      healthFile: "/tmp/h.json",
      healthPort: 8080,
      alertWebhook: "https://hooks.example.com/abc",
      alertRepeatSeconds: 60,
      indexerUrl: "https://indexer.example.com/v1/graphql",
      pythApiKey: "pyth-key-123",
      hermesUrl: "https://hermes.example.com",
      markets: ["0x2A44B99014cF73065BFb89197a08DE09D18d3982"],
    });
  });

  it("rejects bad values with the variable's name", () => {
    expect(() => parseConfig({ KEEPER_NETWORK: "goerli" })).toThrow(/KEEPER_NETWORK/);
    expect(() => parseConfig({ KEEPER_PRIVATE_KEY: "0x1234" })).toThrow(/KEEPER_PRIVATE_KEY/);
    expect(() => parseConfig({ KEEPER_CLAIM_BATCH: "0" })).toThrow(/KEEPER_CLAIM_BATCH/);
    expect(() => parseConfig({ KEEPER_CLAIM_BATCH: "2.5" })).toThrow(/KEEPER_CLAIM_BATCH/);
    expect(() => parseConfig({ KEEPER_MAX_GAS_PER_TX: "5000" })).toThrow(/KEEPER_MAX_GAS_PER_TX/);
    expect(() => parseConfig({ KEEPER_MIN_MON: "-1" })).toThrow(/KEEPER_MIN_MON/);
    expect(() => parseConfig({ KEEPER_HEALTH_PORT: "70000" })).toThrow(/KEEPER_HEALTH_PORT/);
    expect(() => parseConfig({ KEEPER_MARKETS: "0xnope" })).toThrow(/KEEPER_MARKETS/);
    expect(() => parseConfig({ KEEPER_ALERT_WEBHOOK: "not a url" })).toThrow(/KEEPER_ALERT_WEBHOOK/);
    expect(() => parseConfig({ INDEXER_URL: "ftp://x.example.com" })).toThrow(/INDEXER_URL/);
    expect(() =>
      parseConfig({ KEEPER_SETTLE_RETRY_SECONDS: "100", KEEPER_SETTLE_RETRY_MAX_SECONDS: "50" }),
    ).toThrow(/KEEPER_SETTLE_RETRY_MAX_SECONDS/);
  });

  it("never exposes a secret when described for logs", () => {
    const config = parseConfig({
      KEEPER_PRIVATE_KEY: KEY,
      PYTH_API_KEY: "pyth-secret-value",
      KEEPER_ALERT_WEBHOOK: "https://hooks.example.com/services/T000/B000/secret-token",
      INDEXER_URL: "https://indexer.example.com/graphql?key=indexer-secret",
      KEEPER_RPC_URL: "https://rpc.example.com/v2/rpc-secret",
    });
    const described = JSON.stringify(describeConfig(config), (_k, v) =>
      typeof v === "bigint" ? v.toString() : v,
    );
    for (const secret of ["cdcd", "pyth-secret-value", "secret-token", "indexer-secret", "rpc-secret"]) {
      expect(described).not.toContain(secret);
    }
    expect(described).toContain('"privateKey":"set"');
    expect(described).toContain('"alertWebhook":"set (https://hooks.example.com)"');
    expect(secretsOf(config)).toEqual([
      KEY,
      "pyth-secret-value",
      "https://hooks.example.com/services/T000/B000/secret-token",
      "https://indexer.example.com/graphql?key=indexer-secret",
      "https://rpc.example.com/v2/rpc-secret",
    ]);
  });

  it("does not treat the public RPC as a secret", () => {
    expect(secretsOf(parseConfig({}))).toEqual([]);
    expect(describeConfig(parseConfig({})).rpcUrl).toBe("https://testnet-rpc.monad.xyz");
  });
});

describe("stacks", () => {
  it("reads the Kuru v2 poke interval and the stacks to run", () => {
    expect(parseConfig({})).toMatchObject({
      kuruPokeSeconds: 900,
      kuruBookPokeSeconds: 60,
      stacks: undefined,
    });
    expect(
      parseConfig({
        KEEPER_KURU_POKE_SECONDS: "300",
        KEEPER_KURU_BOOK_POKE_SECONDS: "30",
        KEEPER_STACKS: " primary, kuruV2 ,,",
      }),
    ).toMatchObject({
      kuruPokeSeconds: 300,
      kuruBookPokeSeconds: 30,
      stacks: ["primary", "kuruV2"],
    });
    expect(() => parseConfig({ KEEPER_KURU_POKE_SECONDS: "0" })).toThrow(/KEEPER_KURU_POKE_SECONDS/);
    expect(() => parseConfig({ KEEPER_KURU_BOOK_POKE_SECONDS: "0" })).toThrow(
      /KEEPER_KURU_BOOK_POKE_SECONDS/,
    );
    expect(() => parseConfig({ KEEPER_JOBS_OFF: "kuruFeeds" })).not.toThrow();
  });

  it("gives extra stacks their own state and health files", () => {
    const config = parseConfig({
      KEEPER_STATE_FILE: "/var/k/state.json",
      KEEPER_HEALTH_FILE: "/var/k/health",
    });
    expect(configForStack(config, { name: "primary", primary: true })).toBe(config);
    expect(configForStack(config, { name: "kuruV2", primary: false })).toMatchObject({
      stateFile: "/var/k/state.kuruV2.json",
      healthFile: "/var/k/health.kuruV2",
    });
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

  it("loads only the keeper's variables and never overrides the environment", () => {
    const dir = mkdtempSync(join(tmpdir(), "keeper-env-"));
    const file = join(dir, ".env");
    writeFileSync(
      file,
      [
        "KEEPER_CLAIM_BATCH=5",
        "KEEPER_POLL_SECONDS=99",
        "MAKER_PRIVATE_KEY=x",
        "DEPLOYER_PRIVATE_KEY=y",
        "MONAD_TESTNET_RPC=http://r",
        "INDEXER_URL=http://i",
        "PYTH_API_KEY=k",
        "",
      ].join("\n"),
    );
    const env: Record<string, string | undefined> = { KEEPER_POLL_SECONDS: "10" };
    expect(loadEnvFile(file, env).sort()).toEqual([
      "INDEXER_URL",
      "KEEPER_CLAIM_BATCH",
      "MONAD_TESTNET_RPC",
      "PYTH_API_KEY",
    ]);
    expect(env).toEqual({
      KEEPER_POLL_SECONDS: "10",
      KEEPER_CLAIM_BATCH: "5",
      MONAD_TESTNET_RPC: "http://r",
      INDEXER_URL: "http://i",
      PYTH_API_KEY: "k",
    });
    expect(loadEnvFile(join(dir, "missing"), env)).toEqual([]);
  });
});

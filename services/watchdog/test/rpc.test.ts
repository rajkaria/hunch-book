import { deployments } from "@hunch-book/shared";
import {
  HttpRequestError,
  InternalRpcError,
  LimitExceededRpcError,
  RpcRequestError,
  TimeoutError,
} from "viem";
import { describe, expect, it } from "vitest";
import { isRateLimited, watchdogRpcUrls } from "../src/rpc.js";

describe("which RPCs the watchdog reads", () => {
  const testnet = deployments["monad-testnet"];
  const publicUrls = [testnet.rpc, ...(testnet.rpcFallbacks ?? [])];

  it("uses the deployment's public RPCs in order when no keyed RPC is set", () => {
    expect(watchdogRpcUrls("monad-testnet", testnet, {})).toEqual(publicUrls);
    // An unset repository secret arrives as an empty string.
    expect(watchdogRpcUrls("monad-testnet", testnet, { WATCHDOG_RPC_URL: "  " })).toEqual(publicUrls);
  });

  it("puts a keyed RPC first, ahead of the public ones", () => {
    const keyed = "https://keyed.example/rpc";
    expect(watchdogRpcUrls("monad-testnet", testnet, { WATCHDOG_RPC_URL: keyed })).toEqual([
      keyed,
      ...publicUrls,
    ]);
    expect(watchdogRpcUrls("monad-testnet", testnet, { MONAD_TESTNET_RPC: keyed })[0]).toBe(keyed);
    // The mainnet variable never leaks into a testnet read.
    expect(watchdogRpcUrls("monad-testnet", testnet, { MONAD_MAINNET_RPC: keyed })).toEqual(publicUrls);
  });

  it("prefers WATCHDOG_RPC_URL over the network variable and never repeats a URL", () => {
    const urls = watchdogRpcUrls("monad-testnet", testnet, {
      WATCHDOG_RPC_URL: testnet.rpc,
      MONAD_TESTNET_RPC: "https://other.example",
    });
    expect(urls).toEqual(publicUrls);
  });
});

describe("telling a rate limit apart from a real failure", () => {
  it("recognises HTTP 429, JSON-RPC -32005 and the public RPC's own words", () => {
    expect(isRateLimited(new HttpRequestError({ url: "https://rpc", status: 429 }))).toBe(true);
    expect(isRateLimited(new LimitExceededRpcError(new Error("limit")))).toBe(true);
    // What the liveness run hit on Monad testnet: a JSON-RPC error whose details name the limit.
    const testnetLimit = new RpcRequestError({
      body: { method: "eth_call" },
      error: { code: -32007, message: "requests limited to 15/sec" },
      url: "https://testnet-rpc.monad.xyz",
    });
    expect(isRateLimited(testnetLimit)).toBe(true);
    expect(isRateLimited(new Error("Too Many Requests"))).toBe(true);
    expect(isRateLimited("rate limit reached")).toBe(true);
  });

  it("finds the limit in a wrapped cause", () => {
    const inner = new HttpRequestError({ url: "https://rpc", status: 429 });
    expect(isRateLimited(new Error("multicall failed", { cause: inner }))).toBe(true);
  });

  it("does not call other failures rate limits", () => {
    expect(isRateLimited(new HttpRequestError({ url: "https://rpc", status: 503 }))).toBe(false);
    expect(isRateLimited(new InternalRpcError(new Error("boom")))).toBe(false);
    expect(isRateLimited(new TimeoutError({ body: {}, url: "https://rpc" }))).toBe(false);
    expect(isRateLimited(new Error("execution reverted"))).toBe(false);
    expect(isRateLimited(undefined)).toBe(false);
  });
});

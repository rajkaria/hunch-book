import {
  collateralVaultAbi,
  hunchRouterAbi,
  kuruOrderBookAbi,
  marketAbi,
  testUsdcAbi,
} from "@hunch-book/shared";
import {
  type Abi,
  BaseError,
  ContractFunctionRevertedError,
  encodeErrorResult,
  type Hex,
  parseAbi,
  toFunctionSelector,
} from "viem";
import { describe, expect, it } from "vitest";
import {
  decodeRevert,
  describeTxError,
  KNOWN_ERRORS_ABI,
  revertName,
  withKnownErrors,
} from "../src/lib/wallet/errors";

// A router trade can revert in the router, the vault, the market, Kuru's book or a token. Each revert
// is decoded by name against every known error and turned into one sentence.

/** What viem throws when a simulation reverts with `data`, decoding against `abi`. */
const reverted = (abi: Abi, data: Hex, functionName = "buyYes") =>
  new BaseError("simulation failed", {
    cause: new ContractFunctionRevertedError({ abi, data, functionName }),
  });

const encode = (abi: Abi, errorName: string, args?: readonly unknown[]): Hex =>
  encodeErrorResult({ abi, errorName, args } as never);

describe("decoding reverts from any contract a call touches", () => {
  it("knows each error once, with distinct signatures", () => {
    const keys = KNOWN_ERRORS_ABI.map((e) => `${e.name}(${e.inputs.map((i) => i.type).join(",")})`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const name of [
      "Slippage",
      "SlippageExceeded",
      "Expired",
      "NotTradable",
      "NotResolved",
      "RoundTooStale",
    ]) {
      expect(
        KNOWN_ERRORS_ABI.some((e) => e.name === name),
        name,
      ).toBe(true);
    }
  });

  it("names Kuru's SlippageExceeded() even when the call's ABI is the router's", () => {
    const data = encode(kuruOrderBookAbi as Abi, "SlippageExceeded");
    expect(decodeRevert(data)?.name).toBe("SlippageExceeded");
    // Without the known errors, viem cannot name it; with them, it can.
    expect(revertName(reverted(hunchRouterAbi as Abi, data))).toBe("SlippageExceeded");
    expect(describeTxError(reverted(withKnownErrors(hunchRouterAbi as Abi), data))).toMatch(
      /moved past your slippage limit/,
    );
  });

  it("maps the router's own errors", () => {
    const router = hunchRouterAbi as Abi;
    expect(describeTxError(reverted(router, encode(router, "Slippage")))).toMatch(/slippage limit/);
    expect(describeTxError(reverted(router, encode(router, "Expired")))).toMatch(/deadline passed/);
    expect(describeTxError(reverted(router, encode(router, "NotTradable")))).toMatch(
      /not trading on the book/,
    );
    const extra = parseAbi(["error InsufficientLiquidity()"]);
    const liquidity = encode(extra as Abi, "InsufficientLiquidity");
    expect(liquidity).toBe(toFunctionSelector("InsufficientLiquidity()"));
    expect(describeTxError(reverted(router, liquidity))).toMatch(/does not hold enough orders/);
  });

  it("maps settlement, void, redeem and merge errors", () => {
    const market = marketAbi as Abi;
    expect(describeTxError(reverted(market, encode(market, "NotResolved"), "settle"))).toMatch(
      /^Not resolvable yet/,
    );
    expect(describeTxError(reverted(market, encode(market, "NotExpired"), "voidIfExpired"))).toMatch(
      /cannot be voided yet/,
    );
    expect(describeTxError(reverted(market, encode(market, "WrongPhase", [4]), "stake"))).toMatch(
      /another phase/,
    );
    const vault = collateralVaultAbi as Abi;
    expect(describeTxError(reverted(vault, encode(vault, "LosingSide"), "redeem"))).toMatch(
      /Only the winning side/,
    );
    expect(describeTxError(reverted(vault, encode(vault, "NotMergeable"), "mergeSets"))).toMatch(
      /merge from graduation until settlement/,
    );
  });

  it("maps resolver errors with arguments", () => {
    const resolver = parseAbi([
      "error RoundTooStale(uint80 roundId, uint256 updatedAt, uint256 target)",
    ]) as Abi;
    const data = encode(resolver, "RoundTooStale", [5n, 100n, 4_000n]);
    expect(decodeRevert(data)).toEqual({ name: "RoundTooStale", args: [5n, 100n, 4_000n] });
    expect(describeTxError(reverted(marketAbi as Abi, data, "settle"))).toMatch(/more than an hour old/);
  });

  it("maps token errors: the faucet cap and balances", () => {
    const usdc = testUsdcAbi as Abi;
    expect(describeTxError(reverted(usdc, encode(usdc, "FaucetLimit"), "mint"))).toMatch(/at most 10,000/);
    expect(describeTxError(reverted(usdc, encode(usdc, "InsufficientBalance"), "transfer"))).toMatch(
      /does not hold enough/,
    );
  });

  it("falls back to the error's name, then to viem's words", () => {
    const unknown = parseAbi(["error SomethingNew()"]) as Abi;
    expect(describeTxError(reverted(unknown, encode(unknown, "SomethingNew")))).toBe(
      "The contract refused with SomethingNew.",
    );
    expect(decodeRevert("0x")).toBeNull();
    expect(decodeRevert("0xdeadbeef")).toBeNull();
    expect(describeTxError(new BaseError("insufficient funds for gas * price + value"))).toMatch(
      /enough MON/,
    );
  });
});

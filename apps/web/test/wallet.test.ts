import { deployments, marketAbi, monadMainnet, monadTestnet } from "@hunch-book/shared";
import { BaseError, ContractFunctionRevertedError, encodeErrorResult, UserRejectedRequestError } from "viem";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_NETWORK, isDeployed, NETWORK_LABEL, resolveNetwork } from "../src/lib/config";
import { describeTxError } from "../src/lib/wallet/errors";
import { addChainParameters, addThenSwitch, isUserRejection } from "../src/lib/wallet/network";

describe("network config", () => {
  it("reads NEXT_PUBLIC_HUNCH_NETWORK and falls back to testnet", () => {
    expect(DEFAULT_NETWORK).toBe("monad-testnet");
    expect(resolveNetwork(undefined)).toBe("monad-testnet");
    expect(resolveNetwork("monad-mainnet")).toBe("monad-mainnet");
    expect(resolveNetwork(" Monad-Mainnet ")).toBe("monad-mainnet");
    expect(resolveNetwork("ethereum")).toBe("monad-testnet");
    expect(NETWORK_LABEL["monad-mainnet"]).toBe("Monad mainnet");
  });

  it("treats a deployment without a factory as not deployed", () => {
    expect(isDeployed({ ...deployments["monad-testnet"], hunchBook: {} })).toBe(false);
    expect(
      isDeployed({
        ...deployments["monad-testnet"],
        hunchBook: { factory: "0x00000000000000000000000000000000000000f1" },
      }),
    ).toBe(true);
  });
});

describe("addChainParameters", () => {
  it("puts the deployment RPC first and includes the explorer", () => {
    const p = addChainParameters(monadTestnet, "https://testnet-rpc.monad.xyz");
    expect(p.chainId).toBe("0x279f");
    expect(p.rpcUrls[0]).toBe("https://testnet-rpc.monad.xyz");
    expect(new Set(p.rpcUrls).size).toBe(p.rpcUrls.length);
    expect(p.blockExplorerUrls).toEqual([deployments["monad-testnet"].explorer]);
    expect(addChainParameters(monadMainnet, "https://rpc.monad.xyz").chainId).toBe("0x8f");
  });
});

describe("addThenSwitch", () => {
  const params = addChainParameters(monadTestnet, "https://testnet-rpc.monad.xyz");

  it("adds the chain, then switches", async () => {
    const request = vi.fn().mockResolvedValue(null);
    await addThenSwitch({ request }, monadTestnet, "https://testnet-rpc.monad.xyz");
    expect(request.mock.calls.map((c) => c[0].method)).toEqual([
      "wallet_addEthereumChain",
      "wallet_switchEthereumChain",
    ]);
    expect(request.mock.calls[0]?.[0].params).toEqual([params]);
    expect(request.mock.calls[1]?.[0].params).toEqual([{ chainId: "0x279f" }]);
  });

  it("still switches when a wallet refuses to add a chain it already knows (no 4902 needed)", async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("chain exists"), { code: -32603 }))
      .mockResolvedValueOnce(null);
    await addThenSwitch({ request }, monadTestnet, "https://testnet-rpc.monad.xyz");
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("stops when the person rejects the add", async () => {
    const request = vi.fn().mockRejectedValueOnce(Object.assign(new Error("User rejected"), { code: 4001 }));
    await expect(addThenSwitch({ request }, monadTestnet, "x")).rejects.toMatchObject({ code: 4001 });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("surfaces a failed switch", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(Object.assign(new Error("nope"), { code: -32000 }));
    await expect(addThenSwitch({ request }, monadTestnet, "x")).rejects.toThrow("nope");
  });
});

describe("errors in plain words", () => {
  it("recognises rejections through causes and wording", () => {
    expect(isUserRejection({ code: 4001 })).toBe(true);
    expect(isUserRejection(new Error("User denied transaction signature"))).toBe(true);
    expect(isUserRejection({ cause: { cause: { code: 4001 } } })).toBe(true);
    expect(isUserRejection(new Error("execution reverted"))).toBe(false);
    expect(describeTxError(new UserRejectedRequestError(new Error("x")))).toBe(
      "You rejected the request in your wallet.",
    );
  });

  it("maps market reverts to sentences", () => {
    const data = encodeErrorResult({ abi: marketAbi, errorName: "WalletCapExceeded" });
    const revert = new ContractFunctionRevertedError({ abi: marketAbi, data, functionName: "stake" });
    const wrapped = new BaseError("call failed", { cause: revert });
    expect(describeTxError(wrapped)).toBe("That stake would take your wallet over this market's limit.");
  });

  it("maps ERC-20 allowance errors by selector", () => {
    const revert = new ContractFunctionRevertedError({
      abi: marketAbi,
      data: "0xfb8f41b2000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001",
      functionName: "stake",
    });
    expect(describeTxError(new BaseError("call failed", { cause: revert }))).toMatch(/Approve first/);
  });

  it("falls back to the error's own message", () => {
    expect(describeTxError(new Error("RPC timeout"))).toBe("RPC timeout");
    expect(describeTxError("weird")).toBe("Something went wrong. Try again.");
  });
});

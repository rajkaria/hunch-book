import type { Address, Hex } from "viem";
import { describe, expect, it } from "vitest";
import {
  addressUrl,
  chainsByNetwork,
  collateralOf,
  type Deployment,
  defaultStackOf,
  deploymentForStack,
  deployments,
  loadDeployment,
  rpcUrlsOf,
  stacksOf,
  txUrl,
  venueLabel,
} from "../src/index.js";

const mainnet = deployments["monad-mainnet"];
const testnet = deployments["monad-testnet"];

const a = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;

/**
 * The mainnet file as Deploy.s.sol writes it for the launch (KURU_VERSION=1: one Kuru v1 stack under
 * `hunchBook`, Circle USDC, a separate guardian). Placeholder addresses: nothing here is deployed.
 */
function deployedMainnet(): Deployment {
  return {
    ...mainnet,
    hunchBook: {
      usdc: mainnet.external.usdc,
      marketImplementation: a(1),
      factory: a(2),
      vault: a(3),
      graduator: a(4),
      router: a(5),
      kuruVersion: 1,
      resolvers: { perplFunding: a(6), priceAtTime: a(7) },
      guardian: a(8),
      feeRecipient: a(9),
      deployBlock: 112_514_312,
    },
  };
}

describe("Monad mainnet", () => {
  it("is chain 143, linked to monadscan.com, with fallback RPCs", () => {
    expect(loadDeployment(143)).toBe(mainnet);
    expect(chainsByNetwork["monad-mainnet"].id).toBe(143);
    expect(chainsByNetwork["monad-mainnet"].blockExplorers.default.url).toBe("https://monadscan.com");
    const hash: Hex = `0x${"ab".repeat(32)}`;
    expect(txUrl(mainnet, hash)).toBe(`https://monadscan.com/tx/${hash}`);
    expect(addressUrl(mainnet, a(2))).toBe(`https://monadscan.com/address/${a(2)}`);

    const urls = rpcUrlsOf(mainnet);
    expect(urls[0]).toBe("https://rpc.monad.xyz");
    expect(urls.length).toBeGreaterThanOrEqual(3);
    for (const url of urls) expect(url).toMatch(/^https:\/\//);
    // None of testnet's endpoints leak into mainnet's list.
    for (const url of rpcUrlsOf(testnet)) expect(urls).not.toContain(url);
    expect(rpcUrlsOf(mainnet, "https://private.example/rpc")[0]).toBe("https://private.example/rpc");
  });

  it("has the fields every reader needs, in testnet's shape", () => {
    for (const key of Object.keys(mainnet)) expect(Object.keys(testnet), key).toContain(key);
    expect(mainnet.wallets).toEqual(testnet.wallets);
    expect(mainnet.external.usdc).toBeDefined();
    expect(mainnet.external.kuru.router).toBeDefined();
    expect(mainnet.external.kuru.marginAccount).toBeDefined();
    expect(mainnet.external.perpl.exchange).toBeDefined();
    for (const asset of ["BTC", "ETH", "SOL", "MON"]) {
      expect(mainnet.external.perpl.perps[asset], asset).toBeGreaterThan(0);
      expect(mainnet.external.chainlink[`${asset}/USD`], asset).toBeDefined();
    }
    expect(mainnet.external.pyth.contract).toBeDefined();
  });

  it("collateral is Circle USDC, before and after the deploy", () => {
    expect(collateralOf(mainnet)).toBe(mainnet.external.usdc);
    expect(collateralOf(deployedMainnet())).toBe(mainnet.external.usdc);
  });

  it("lists no stack until the deploy, then one Kuru v1 stack that new markets go to", () => {
    if (!mainnet.hunchBook.factory) expect(stacksOf(mainnet)).toEqual([]);

    const d = deployedMainnet();
    const stacks = stacksOf(d);
    expect(stacks.map((s) => [s.name, s.primary, s.kuruVersion, s.venue])).toEqual([
      ["primary", true, 1, "kuru"],
    ]);
    const first = defaultStackOf(d);
    if (!first) throw new Error("no default stack");
    expect(first.name).toBe("primary");
    expect(venueLabel(first)).toBe("Kuru");
    // A Kuru stack keeps Kuru's own mainnet Router and MarginAccount for its books.
    const view = deploymentForStack(d, first);
    expect(view.external.kuru).toEqual(mainnet.external.kuru);
    expect(view.hunchBook.factory).toBe(a(2));
  });
});

import { isAddress } from "viem";
import { describe, expect, it } from "vitest";
import {
  decodePerplFundingParams,
  decodePriceAtTimeParams,
  deployments,
  encodePerplFundingParams,
  encodePriceAtTimeParams,
  impliedChanceBps,
  loadDeployment,
  marketKey,
  monadMainnet,
  monadTestnet,
  PriceSource,
  poolPayout,
  redemptionPayout,
  splitFee,
  tokenClaim,
} from "../src/index.js";

describe("deployments", () => {
  it("loads both networks by name and chain id", () => {
    expect(loadDeployment("monad-testnet").chainId).toBe(10143);
    expect(loadDeployment(143).network).toBe("monad-mainnet");
    expect(() => loadDeployment(1)).toThrow();
  });

  it("holds only well-formed, non-zero addresses", () => {
    const walk = (value: unknown, path: string): void => {
      if (typeof value === "string" && value.startsWith("0x") && value.length === 42) {
        expect(isAddress(value), path).toBe(true);
        expect(BigInt(value), path).not.toBe(0n);
      } else if (value && typeof value === "object") {
        for (const [k, v] of Object.entries(value)) walk(v, `${path}.${k}`);
      }
    };
    for (const d of Object.values(deployments)) walk(d, d.network);
  });

  it("matches the viem chain ids", () => {
    expect(monadTestnet.id).toBe(deployments["monad-testnet"].chainId);
    expect(monadMainnet.id).toBe(deployments["monad-mainnet"].chainId);
  });
});

describe("template params", () => {
  it("round-trips Perpl funding params", () => {
    const p = { perpId: 16n, startBlock: 100n, endBlock: 9_000n, threshold: -25n, expectedScalingExp: 0 };
    expect(decodePerplFundingParams(encodePerplFundingParams(p))).toEqual(p);
  });

  it("round-trips price params", () => {
    const p = {
      source: PriceSource.Chainlink,
      feed: "0xc1d4C3331635184fA4C3c22fb92211B2Ac9E0546" as const,
      pythId: `0x${"00".repeat(32)}` as const,
      strikeE8: 120_000_00000000n,
      lockTime: 1_800_000_000n,
      closeTime: 1_800_086_400n,
    };
    expect(decodePriceAtTimeParams(encodePriceAtTimeParams(p))).toEqual(p);
  });

  it("derives a stable market key", () => {
    expect(marketKey(1, "0x1234")).toMatch(/^0x[0-9a-f]{64}$/);
    expect(marketKey(1, "0x1234")).not.toBe(marketKey(2, "0x1234"));
  });
});

describe("math", () => {
  it("prices the pool", () => {
    expect(impliedChanceBps(300n, 700n)).toBe(3_000n);
    expect(impliedChanceBps(0n, 0n)).toBe(0n);
  });

  it("pays a pool winner stake plus winnings minus 2%", () => {
    // 100 on YES of 400 YES, 600 NO: gross 150, fee 3, paid 247.
    expect(poolPayout(100n, 400n, 600n)).toEqual({ paid: 247n, fee: 3n });
  });

  it("keeps graduation payoff-identical to the pool, within rounding", () => {
    const yes = 4_000_000n;
    const no = 6_000_000n;
    const total = yes + no;
    const stake = 1_000_000n;
    const tokens = tokenClaim(stake, yes, total);
    const viaTokens = redemptionPayout(tokens, no, total);
    const viaPool = poolPayout(stake, yes, no).paid;
    expect(viaTokens - viaPool).toBeLessThanOrEqual(2n);
    expect(viaPool - viaTokens).toBeLessThanOrEqual(2n);
  });

  it("splits fees 75/25", () => {
    expect(splitFee(100n)).toEqual({ protocol: 75n, creator: 25n });
    expect(splitFee(3n)).toEqual({ protocol: 3n, creator: 0n });
  });
});

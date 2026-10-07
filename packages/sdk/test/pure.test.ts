import {
  deployments,
  encodePerplFundingParams,
  PriceSource,
  TemplateId,
  TouchDirection,
} from "@hunch-book/shared";
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { type Address, getAddress, type Hex, keccak256, toHex } from "viem";
import { describe, expect, it } from "vitest";
import {
  assetMatches,
  buildRewardTree,
  decodeMarketParams,
  decodeRevert,
  ERROR_MESSAGES,
  encodeMarketParams,
  formatBps,
  formatUsdc,
  KNOWN_ERRORS_ABI,
  type MarketParamsInput,
  marketAsset,
  mergeClaims,
  parseUsdc,
  rewardLeaf,
  toJsonSafe,
  verifyRewardProof,
} from "../src/index.js";
import { addr } from "./fixtures.js";

const testnet = { ...deployments["monad-testnet"], stacks: undefined };
const BTC_FEED = testnet.external.chainlink["BTC/USD"] as Address;

describe("units", () => {
  it("parses and formats USDC amounts", () => {
    expect(parseUsdc("12.5")).toBe(12_500_000n);
    expect(parseUsdc("1,000")).toBe(1_000_000_000n);
    expect(parseUsdc(".25")).toBe(250_000n);
    expect(parseUsdc(3)).toBe(3_000_000n);
    expect(() => parseUsdc("1.0000001")).toThrow(/more than 6 decimals/);
    expect(() => parseUsdc("-1")).toThrow(/not a USDC amount/);
    expect(() => parseUsdc("abc")).toThrow();
    expect(formatUsdc(12_500_250_000n)).toBe("12500.25");
    expect(formatUsdc(1n)).toBe("0.000001");
    expect(formatUsdc(-2_000_000n)).toBe("-2");
    expect(formatBps(4167)).toBe("41.67%");
    expect(formatBps(5000)).toBe("50%");
    expect(formatBps(null)).toBeNull();
  });

  it("makes bigints JSON-safe, deeply", () => {
    const value = { a: 1n, b: [2n, { c: 3n }], d: "x", e: undefined, f: null };
    expect(JSON.parse(JSON.stringify(toJsonSafe(value)))).toEqual({
      a: "1",
      b: ["2", { c: "3" }],
      d: "x",
      f: null,
    });
  });
});

describe("params", () => {
  const inputs: MarketParamsInput[] = [
    {
      templateId: 1,
      params: { perpId: 16n, startBlock: 100n, endBlock: 9_000n, threshold: 33n, expectedScalingExp: 2 },
    },
    {
      templateId: 2,
      params: {
        source: PriceSource.Chainlink,
        feed: BTC_FEED,
        pythId: `0x${"00".repeat(32)}`,
        strikeE8: 8_500_000_000_000n,
        lockTime: 1_800_000_000n,
        closeTime: 1_800_003_600n,
      },
    },
    {
      templateId: 3,
      params: {
        feed: BTC_FEED,
        strikeE8: 7_000_000_000_000n,
        direction: TouchDirection.AtOrAbove,
        lockTime: 1_800_000_000n,
        startTime: 1_800_000_000n,
        endTime: 1_800_600_000n,
      },
    },
    {
      templateId: 4,
      params: { perpId: 16n, startBlock: 100n, endBlock: 90_000n, threshold: 40n, expectedScalingExp: 2 },
    },
    {
      templateId: 5,
      params: {
        source: PriceSource.Chainlink,
        feed: BTC_FEED,
        pythId: `0x${"00".repeat(32)}`,
        lowerE8: 8_000_000_000_000n,
        upperE8: 8_500_000_000_000n,
        lockTime: 1_800_000_000n,
        closeTime: 1_800_003_600n,
      },
    },
    {
      templateId: 6,
      params: { legs: [addr(3), addr(1)], lockTime: 1_800_000_000n, closeTime: 1_800_003_600n },
    },
  ];

  it("encodes and decodes every template", () => {
    for (const input of inputs) {
      const bytes = encodeMarketParams(input);
      const decoded = decodeMarketParams(input.templateId, bytes);
      expect(decoded.templateId).toBe(input.templateId);
      expect(decoded.kind).not.toBe("unknown");
      if (decoded.kind === "parlay") {
        // Legs come back in the one canonical (sorted) order.
        expect(decoded.params.legs).toEqual([addr(1), addr(3)]);
      } else if (decoded.kind !== "unknown") {
        expect(decoded.params).toMatchObject(input.params);
      }
    }
  });

  it("returns unknown for malformed bytes and unknown templates, never throws", () => {
    expect(decodeMarketParams(TemplateId.PerplFunding, "0x1234").kind).toBe("unknown");
    expect(decodeMarketParams(9, encodePerplFundingParams(inputs[0]?.params as never)).kind).toBe("unknown");
  });

  it("names the asset from the deployments file", () => {
    const perpl = decodeMarketParams(1, encodeMarketParams(inputs[0] as MarketParamsInput));
    expect(marketAsset(testnet, perpl)).toBe("BTC");
    const price = decodeMarketParams(2, encodeMarketParams(inputs[1] as MarketParamsInput));
    expect(marketAsset(testnet, price)).toBe("BTC/USD");
    const parlay = decodeMarketParams(6, encodeMarketParams(inputs[5] as MarketParamsInput));
    expect(marketAsset(testnet, parlay)).toBeNull();
    expect(assetMatches("BTC/USD", "btc")).toBe(true);
    expect(assetMatches("BTC", "BTC/USD")).toBe(true);
    expect(assetMatches("ETH/USD", "BTC")).toBe(false);
    expect(assetMatches(null, "BTC")).toBe(false);
  });
});

describe("merkle", () => {
  const accounts = (n: number, seed: number): Address[] =>
    Array.from({ length: n }, (_, i) => getAddress(keccak256(toHex(`${seed}-${i}`)).slice(0, 42)));

  it("matches OpenZeppelin's StandardMerkleTree root and proofs for 1 to 40 leaves", () => {
    for (const n of [1, 2, 3, 4, 7, 16, 40]) {
      const epoch = BigInt(n);
      const claims = accounts(n, n).map((account, i) => ({ account, amount: BigInt(1 + i * 1_000_003) }));
      const ours = buildRewardTree(epoch, claims);
      const oz = StandardMerkleTree.of(
        claims.map((c) => [epoch.toString(), c.account, c.amount.toString()]),
        ["uint256", "address", "uint256"],
      );
      expect(ours.root).toBe(oz.root);
      for (const [i, value] of oz.entries()) {
        const claim = ours.claims[i];
        expect(claim?.account).toBe(value[1]);
        expect(claim?.proof).toEqual(oz.getProof(i));
        expect(claim?.leaf).toBe(oz.leafHash(value));
        expect(verifyRewardProof(ours.root, claim?.leaf as Hex, claim?.proof ?? [])).toBe(true);
      }
      expect(ours.total).toBe(claims.reduce((s, c) => s + c.amount, 0n));
    }
  });

  it("uses the distributor's leaf format, binding the epoch", () => {
    const a = addr(7);
    expect(rewardLeaf(3n, a, 7_000_000n)).not.toBe(rewardLeaf(4n, a, 7_000_000n));
    const tree = buildRewardTree(3n, [{ account: a, amount: 7_000_000n }]);
    expect(tree.root).toBe(rewardLeaf(3n, a, 7_000_000n));
    expect(tree.claims[0]?.proof).toEqual([]);
    expect(verifyRewardProof(tree.root, rewardLeaf(4n, a, 7_000_000n), [])).toBe(false);
  });

  it("refuses repeated accounts and zero amounts, and merges claims", () => {
    expect(() => buildRewardTree(1n, [])).toThrow();
    expect(() =>
      buildRewardTree(1n, [
        { account: addr(1), amount: 1n },
        { account: addr(1), amount: 2n },
      ]),
    ).toThrow(/twice/);
    expect(() => buildRewardTree(1n, [{ account: addr(1), amount: 0n }])).toThrow(/leave it out/);
    expect(
      mergeClaims([
        { account: addr(1), amount: 1n },
        { account: addr(1).toLowerCase() as Address, amount: 2n },
        { account: addr(2), amount: 0n },
      ]),
    ).toEqual([{ account: addr(1), amount: 3n }]);
  });
});

describe("errors", () => {
  it("knows every error once and has a sentence for the ones people hit", () => {
    const keys = KNOWN_ERRORS_ABI.map((e) => `${e.name}(${e.inputs.map((i) => i.type).join(",")})`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const name of [
      "Slippage",
      "NotResolved",
      "RoundTooStale",
      "NoTouch",
      "NotASpike",
      "InvalidProof",
      "AlreadyBound",
    ]) {
      expect(KNOWN_ERRORS_ABI.some((e) => e.name === name)).toBe(true);
      expect(ERROR_MESSAGES[name]).toMatch(/\.$/);
    }
    const dash = String.fromCharCode(0x2014);
    for (const message of Object.values(ERROR_MESSAGES)) expect(message.includes(dash)).toBe(false);
  });

  it("decodes raw revert data by name", () => {
    // NotTriggered(uint256 orderId, bool priceAvailable, uint256 priceE6)
    const selector = keccak256(toHex("NotTriggered(uint256,bool,uint256)")).slice(0, 10);
    const data = `${selector}${"0".repeat(63)}7${"0".repeat(63)}1${"0".repeat(58)}6590a0` as Hex;
    expect(decodeRevert(data)).toEqual({ name: "NotTriggered", args: [7n, true, 0x6590a0n] });
    expect(decodeRevert("0x")).toBeNull();
    expect(decodeRevert("0xdeadbeef")).toBeNull();
  });
});

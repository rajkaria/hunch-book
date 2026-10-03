import { deployments, encodePriceAtTimeParams, PriceSource } from "@hunch-book/shared";
import type { Address } from "viem";
import { describe, expect, it } from "vitest";
import {
  chainlinkFeedName,
  decodeMarketParams,
  describeSource,
  fallbackHeadline,
  perpName,
  pythFeedName,
  templateLabel,
} from "../src/lib/market/params";
import { btcFeed, perplParams, priceParams, RESOLVER } from "./fixtures";

const mainnet = deployments["monad-mainnet"];
const testnet = deployments["monad-testnet"];

describe("decodeMarketParams", () => {
  it("decodes both templates with the shared decoders", () => {
    const price = decodeMarketParams(2, priceParams);
    expect(price.kind).toBe("price-at-time");
    if (price.kind === "price-at-time") expect(price.params.strikeE8).toBe(120_000_00000000n);
    const perpl = decodeMarketParams(1, perplParams);
    expect(perpl.kind).toBe("perpl-funding");
    if (perpl.kind === "perpl-funding") expect(perpl.params.perpId).toBe(16n);
  });

  it("never throws on unknown templates or bad bytes", () => {
    expect(decodeMarketParams(99, "0x1234")).toEqual({ kind: "unknown", raw: "0x1234" });
    expect(decodeMarketParams(2, "0xdeadbeef")).toEqual({ kind: "unknown", raw: "0xdeadbeef" });
  });

  it("names templates", () => {
    expect(templateLabel(1)).toBe("Perpl funding");
    expect(templateLabel(2)).toBe("Price at a time");
    expect(templateLabel(9)).toBe("Template 9");
  });
});

describe("names from deployments", () => {
  it("finds perps and feeds by id and address", () => {
    expect(perpName(testnet, 16n)).toBe("BTC");
    expect(perpName(mainnet, 10n)).toBe("MON");
    expect(perpName(mainnet, 999n)).toBeUndefined();
    expect(chainlinkFeedName(mainnet, btcFeed.toLowerCase() as Address)).toBe("BTC/USD");
    expect(pythFeedName(mainnet, mainnet.external.pyth.ids["SOL/USD"] as `0x${string}`)).toBe("SOL/USD");
  });
});

describe("fallbackHeadline", () => {
  it("builds a plain sentence from the params", () => {
    expect(fallbackHeadline(mainnet, decodeMarketParams(2, priceParams))).toBe(
      "Will BTC/USD be at or above $120,000.00 at Sat 16 Jan 2027, 08:00 UTC?",
    );
    expect(fallbackHeadline(testnet, decodeMarketParams(1, perplParams))).toBe(
      "Will BTC longs pay shorts on net on Perpl between block 1,000,000 and block 1,002,000?",
    );
    expect(fallbackHeadline(testnet, { kind: "unknown", raw: "0x" })).toBe("Market with an unknown template");
  });
});

describe("describeSource", () => {
  it("lists the Perpl exchange, perp and window, with the trust note", () => {
    const src = describeSource(testnet, decodeMarketParams(1, perplParams), RESOLVER);
    expect(src.title).toBe("Perpl funding history");
    expect(src.items.find((i) => i.label === "Perpl Exchange")?.href).toBe(
      `${testnet.explorer}/address/${testnet.external.perpl.exchange}`,
    );
    expect(src.items.find((i) => i.label === "Perp")?.value).toBe("BTC (id 16)");
    expect(src.items.find((i) => i.label === "Threshold")?.value).toMatch(/longs pay shorts on net/);
    expect(src.trust).toMatch(/3-of-7 multisig/);
  });

  it("names the Chainlink feed and strike", () => {
    const src = describeSource(mainnet, decodeMarketParams(2, priceParams), RESOLVER);
    expect(src.title).toBe("Chainlink BTC/USD");
    expect(src.items.find((i) => i.label === "Strike")?.value).toBe("$120,000.00");
    expect(src.items[0]).toMatchObject({ label: "Resolver", value: RESOLVER });
  });

  it("names a Pyth feed", () => {
    const pythParams = encodePriceAtTimeParams({
      source: PriceSource.Pyth,
      feed: "0x0000000000000000000000000000000000000000",
      pythId: mainnet.external.pyth.ids["SOL/USD"] as `0x${string}`,
      strikeE8: 200_00000000n,
      lockTime: 1n,
      closeTime: 2n,
    });
    const src = describeSource(mainnet, decodeMarketParams(2, pythParams), RESOLVER);
    expect(src.title).toBe("Pyth SOL/USD");
    expect(src.items.find((i) => i.label === "Pyth contract")?.value).toBe(mainnet.external.pyth.contract);
  });
});

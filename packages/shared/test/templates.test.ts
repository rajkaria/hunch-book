import { type Address, decodeAbiParameters, encodeAbiParameters, getAddress, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import {
  canonicalParlayLegs,
  decodeChainlinkTouchParams,
  decodeParlayParams,
  decodePerplFundingSpikeParams,
  decodePriceRangeParams,
  EMPTY_EVIDENCE,
  encodeChainlinkTouchParams,
  encodeFundingEventEvidence,
  encodeParlayParams,
  encodePerplFundingParams,
  encodePerplFundingSpikeParams,
  encodePriceRangeParams,
  encodeRoundEvidence,
  isTemplateId,
  marketKey,
  PriceSource,
  TEMPLATES,
  TemplateId,
  TOUCH_CHALLENGE_SECONDS,
  TouchDirection,
  templateLabel,
} from "../src/index.js";

const BTC_FEED = "0xc1d4C3331635184fA4C3c22fb92211B2Ac9E0546" as const;
const ZERO_ID = `0x${"00".repeat(32)}` as const;
const A = "0x00000000000000000000000000000000000000a1" as const;
const B = "0x0000000000000000000000000000000000000B02" as const;
const C = "0xC000000000000000000000000000000000000003" as const;
const EM_DASH = String.fromCodePoint(0x2014);

describe("template ids", () => {
  it("numbers the six templates as the factory registers them", () => {
    expect(TemplateId).toEqual({
      PerplFunding: 1,
      PriceAtTime: 2,
      ChainlinkTouch: 3,
      PerplFundingSpike: 4,
      PriceRange: 5,
      Parlay: 6,
    });
    for (const id of Object.values(TemplateId)) {
      expect(TEMPLATES[id].id).toBe(id);
    }
  });

  it("labels known ids and falls back for unknown ones", () => {
    expect(templateLabel(1)).toBe("Perpl net funding");
    expect(templateLabel(2)).toBe("Price at a time");
    expect(templateLabel(3)).toBe("Price touch");
    expect(templateLabel(4)).toBe("Perpl funding spike");
    expect(templateLabel(5)).toBe("Price range");
    expect(templateLabel(6)).toBe("Parlay");
    expect(templateLabel(0)).toBe("Template 0");
    expect(templateLabel(9)).toBe("Template 9");
    expect(isTemplateId(6)).toBe(true);
    expect(isTemplateId(7)).toBe(false);
  });

  it("marks the touch templates as early-YES and the Perpl ones as block-clock", () => {
    const early = Object.values(TEMPLATES)
      .filter((t) => t.earlyYes)
      .map((t) => t.id);
    expect(early).toEqual([3, 4]);
    const blocks = Object.values(TEMPLATES)
      .filter((t) => t.clock === "block")
      .map((t) => t.id);
    expect(blocks).toEqual([1, 4]);
  });

  it("uses plain copy: no em dashes", () => {
    for (const t of Object.values(TEMPLATES)) {
      expect(t.label.includes(EM_DASH)).toBe(false);
      expect(t.question.includes(EM_DASH)).toBe(false);
    }
  });
});

describe("template 3: touch params", () => {
  const p = {
    feed: BTC_FEED,
    strikeE8: 70_000_00000000n,
    direction: TouchDirection.AtOrAbove,
    lockTime: 1_791_288_000n,
    startTime: 1_791_288_000n,
    endTime: 1_791_892_800n,
  };

  it("round-trips", () => {
    expect(decodeChainlinkTouchParams(encodeChainlinkTouchParams(p))).toEqual(p);
    const down = { ...p, direction: TouchDirection.AtOrBelow };
    expect(decodeChainlinkTouchParams(encodeChainlinkTouchParams(down))).toEqual(down);
  });

  it("encodes the struct as six static words, in Solidity's field order", () => {
    const data = encodeChainlinkTouchParams(p);
    expect((data.length - 2) / 2).toBe(6 * 32);
    const [feed, strike, direction, lock, start, end] = decodeAbiParameters(
      [
        { type: "address" },
        { type: "int256" },
        { type: "uint8" },
        { type: "uint64" },
        { type: "uint64" },
        { type: "uint64" },
      ],
      data,
    );
    expect([feed, strike, direction, lock, start, end]).toEqual([
      p.feed,
      p.strikeE8,
      p.direction,
      p.lockTime,
      p.startTime,
      p.endTime,
    ]);
  });

  it("states the challenge period", () => {
    expect(TOUCH_CHALLENGE_SECONDS).toBe(24n * 60n * 60n);
  });
});

describe("template 4: funding spike params", () => {
  it("round-trips, including a negative threshold", () => {
    const p = {
      perpId: 1n,
      startBlock: 110_000_000n,
      endBlock: 112_016_000n,
      threshold: -33n,
      expectedScalingExp: 0,
    };
    expect(decodePerplFundingSpikeParams(encodePerplFundingSpikeParams(p))).toEqual(p);
  });

  it("shares template 1's layout, so only the template id tells them apart", () => {
    const p = { perpId: 16n, startBlock: 100n, endBlock: 9_000n, threshold: 25n, expectedScalingExp: 0 };
    const spike = encodePerplFundingSpikeParams(p);
    expect(spike).toBe(encodePerplFundingParams(p));
    expect(marketKey(TemplateId.PerplFunding, spike)).not.toBe(
      marketKey(TemplateId.PerplFundingSpike, spike),
    );
  });
});

describe("template 5: price range params", () => {
  it("round-trips Chainlink and Pyth ranges", () => {
    const cl = {
      source: PriceSource.Chainlink,
      feed: BTC_FEED,
      pythId: ZERO_ID,
      lowerE8: 80_000_00000000n,
      upperE8: 85_000_00000000n,
      lockTime: 1_791_111_600n,
      closeTime: 1_791_115_200n,
    };
    expect(decodePriceRangeParams(encodePriceRangeParams(cl))).toEqual(cl);
    const py = {
      ...cl,
      source: PriceSource.Pyth,
      feed: "0x0000000000000000000000000000000000000000" as const,
      pythId: "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d" as const,
    };
    expect(decodePriceRangeParams(encodePriceRangeParams(py))).toEqual(py);
  });
});

describe("template 6: parlay params", () => {
  it("sorts legs numerically, whatever their checksum case", () => {
    expect(canonicalParlayLegs([C, A, B])).toEqual([A, B, C]);
  });

  it("rejects repeated legs and counts outside 2 to 5", () => {
    expect(() => canonicalParlayLegs([A, A])).toThrow(/twice/);
    expect(() => canonicalParlayLegs([A, A.toUpperCase().replace("0X", "0x") as Address])).toThrow(/twice/);
    expect(() => canonicalParlayLegs([A])).toThrow(/2 to 5/);
    const six = Array.from({ length: 6 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}` as Address);
    expect(() => canonicalParlayLegs(six)).toThrow(/2 to 5/);
    expect(canonicalParlayLegs(six.slice(0, 5))).toHaveLength(5);
  });

  it("encodes in canonical order, so every ordering is the same market", () => {
    const base = { lockTime: 1_791_288_000n, closeTime: 1_791_892_800n };
    const one = encodeParlayParams({ ...base, legs: [C, A, B] });
    const two = encodeParlayParams({ ...base, legs: [B, C, A] });
    expect(one).toBe(two);
    expect(marketKey(TemplateId.Parlay, one)).toBe(marketKey(TemplateId.Parlay, two));
    expect(decodeParlayParams(one)).toEqual({ ...base, legs: [A, B, C].map((a) => getAddress(a)) });
  });

  it("matches a plain ABI encoding of the struct", () => {
    const legs = [A, B] as const;
    const expected = encodeAbiParameters(
      [
        {
          type: "tuple",
          components: [
            { name: "legs", type: "address[]" },
            { name: "lockTime", type: "uint64" },
            { name: "closeTime", type: "uint64" },
          ],
        },
      ],
      [{ legs, lockTime: 1n, closeTime: 2n }],
    );
    expect(encodeParlayParams({ legs, lockTime: 1n, closeTime: 2n })).toBe(expected);
  });
});

describe("evidence", () => {
  it("encodes a Chainlink round id as one uint80 word", () => {
    const round = (1n << 64n) | 670_990n;
    const data = encodeRoundEvidence(round);
    expect((data.length - 2) / 2).toBe(32);
    expect(decodeAbiParameters([{ type: "uint80" }], data)[0]).toBe(round);
    expect(() => encodeRoundEvidence(1n << 80n)).toThrow();
  });

  it("encodes a funding event block as one uint64 word", () => {
    const data: Hex = encodeFundingEventEvidence(110_368_767n);
    expect(decodeAbiParameters([{ type: "uint64" }], data)[0]).toBe(110_368_767n);
    expect(() => encodeFundingEventEvidence(1n << 64n)).toThrow();
  });

  it("asks for NO with empty evidence", () => {
    expect(EMPTY_EVIDENCE).toBe("0x");
  });
});

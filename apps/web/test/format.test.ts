import { describe, expect, it } from "vitest";
import {
  formatBpsPercent,
  formatChance,
  formatDuration,
  formatE8Usd,
  formatFixed,
  formatInt,
  formatUsdc,
  formatUtc,
  shortAddress,
  shortHash,
} from "../src/lib/format";

describe("formatUsdc", () => {
  it("shows two decimals with thousands separators", () => {
    expect(formatUsdc(1_234_560_000n)).toBe("1,234.56");
    expect(formatUsdc(0n)).toBe("0.00");
    expect(formatUsdc(5_000_000_000n)).toBe("5,000.00");
  });

  it("rounds toward zero so a payout is never overstated", () => {
    expect(formatUsdc(1_999_999n)).toBe("1.99");
    expect(formatUsdc(-1_999_999n)).toBe("-1.99");
  });

  it("shows every base unit when exact", () => {
    expect(formatUsdc(1_234_567n, { exact: true })).toBe("1.234567");
    expect(formatUsdc(1_500_000n, { exact: true })).toBe("1.50");
  });
});

describe("formatFixed", () => {
  it("pads and trims decimals", () => {
    expect(formatFixed(123_450n, 4, { minDecimals: 2 })).toBe("12.345");
    expect(formatFixed(120_000n, 4, { minDecimals: 0 })).toBe("12");
    expect(formatFixed(5n, 18, { minDecimals: 3, maxDecimals: 3 })).toBe("0.000");
  });

  it("formats a 1e18 Kuru price", () => {
    expect(formatFixed(625_000_000_000_000_000n, 18, { minDecimals: 3, maxDecimals: 3 })).toBe("0.625");
  });

  it("never prints negative zero", () => {
    expect(formatFixed(-1n, 6, { maxDecimals: 2 })).toBe("0");
  });
});

describe("formatE8Usd", () => {
  it("formats Chainlink-style 8-decimal prices", () => {
    expect(formatE8Usd(120_000_00000000n)).toBe("$120,000.00");
    expect(formatE8Usd(3_500_000n)).toBe("$0.035");
    expect(formatE8Usd(-150_000_000n)).toBe("-$1.50");
  });
});

describe("formatChance", () => {
  it("turns basis points into a percent with one decimal, truncated", () => {
    expect(formatChance(6_250n)).toBe("62.5%");
    expect(formatChance(7_500)).toBe("75.0%");
    expect(formatChance(3_333n)).toBe("33.3%");
    expect(formatChance(9_999n)).toBe("99.9%");
    expect(formatChance(10_000n)).toBe("100.0%");
    expect(formatChance(0n)).toBe("0.0%");
  });

  it("clamps out-of-range values and handles missing ones", () => {
    expect(formatChance(12_000n)).toBe("100.0%");
    expect(formatChance(-5)).toBe("0.0%");
    expect(formatChance(null)).toBe("n/a");
    expect(formatChance(undefined)).toBe("n/a");
  });

  it("prints rule bounds", () => {
    expect(formatBpsPercent(300)).toBe("3%");
    expect(formatBpsPercent(9_700)).toBe("97%");
    expect(formatBpsPercent(250)).toBe("2.5%");
  });
});

describe("formatDuration", () => {
  it("picks the two largest units", () => {
    expect(formatDuration(2 * 86_400 + 4 * 3_600 + 59)).toBe("2d 4h");
    expect(formatDuration(3 * 3_600 + 12 * 60 + 5)).toBe("3h 12m");
    expect(formatDuration(12 * 60 + 5)).toBe("12m 5s");
    expect(formatDuration(45)).toBe("45s");
    expect(formatDuration(45n)).toBe("45s");
  });

  it("reads 'now' at or after the deadline", () => {
    expect(formatDuration(0)).toBe("now");
    expect(formatDuration(-30)).toBe("now");
    expect(formatDuration(Number.NaN)).toBe("now");
  });
});

describe("formatUtc", () => {
  it("prints a UTC timestamp the same on server and client", () => {
    expect(formatUtc(1_800_086_400n)).toBe("Sat 16 Jan 2027, 08:00 UTC");
    expect(formatUtc(0)).toBe("Thu 1 Jan 1970, 00:00 UTC");
  });
});

describe("addresses and integers", () => {
  it("shortens addresses and hashes", () => {
    expect(shortAddress("0x0f1156Eb25DBebee5386EC80F1EB0B85C7dD232A")).toBe("0x0f11…232A");
    expect(shortHash(`0x${"ab".repeat(32)}`)).toBe("0xababab…ababab");
    expect(shortAddress("0x12")).toBe("0x12");
  });

  it("groups integers", () => {
    expect(formatInt(12_345_678n)).toBe("12,345,678");
    expect(formatInt(999)).toBe("999");
    expect(formatInt(-1_000n)).toBe("-1,000");
  });
});

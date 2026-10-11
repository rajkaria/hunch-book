import { type Deployment, encodeSnapshotParams, TemplateId } from "@hunch-book/shared";
import { type Address, encodeAbiParameters, type Hex, type PublicClient } from "viem";
import { describe, expect, it } from "vitest";
import { parseSnapshotVols } from "../src/config.js";
import { FairValues, PRICED_TEMPLATES } from "../src/fair.js";
import {
  DEFAULT_SNAPSHOT_VOL,
  MARK_PRICE_VOL,
  OPEN_INTEREST_VOL,
  snapshotFairValue,
  snapshotHolds,
  snapshotVolFor,
} from "../src/pricing/snapshot.js";

const HOUR = 3_600;
const DAY = 86_400;

describe("snapshotVolFor", () => {
  it("reads the asset from a mark price label", () => {
    expect(snapshotVolFor(1, "Perpl's BTC mark price (perp 16)")).toBe(MARK_PRICE_VOL.BTC);
    expect(snapshotVolFor(3, "Perpl's ETH mark price (perp 32)")).toBe(MARK_PRICE_VOL.ETH);
    expect(snapshotVolFor(5, "Perpl's SOL mark price (perp 48)")).toBe(MARK_PRICE_VOL.SOL);
    expect(snapshotVolFor(7, "Perpl's MON mark price (perp 64)")).toBe(MARK_PRICE_VOL.MON);
  });

  it("gives open interest and unknown sources the wide prior", () => {
    expect(snapshotVolFor(0, "Perpl's BTC open interest (perp 16)")).toBe(OPEN_INTEREST_VOL);
    expect(snapshotVolFor(9, "Something else entirely")).toBe(DEFAULT_SNAPSHOT_VOL);
    // An asset name inside another word is not that asset.
    expect(snapshotVolFor(9, "SOLAR index price")).toBe(DEFAULT_SNAPSHOT_VOL);
  });

  it("lets an override by source id win", () => {
    expect(snapshotVolFor(1, "Perpl's BTC mark price (perp 16)", { 1: 0.3 })).toBe(0.3);
    expect(snapshotVolFor(3, "Perpl's ETH mark price (perp 32)", { 1: 0.3 })).toBe(MARK_PRICE_VOL.ETH);
  });
});

describe("snapshotHolds", () => {
  it("matches the resolver's four comparators, equality included", () => {
    expect([0, 1, 2, 3].map((c) => snapshotHolds(10n, 10n, c as 0 | 1 | 2 | 3))).toEqual([
      false,
      true,
      false,
      true,
    ]);
    expect([0, 1, 2, 3].map((c) => snapshotHolds(11n, 10n, c as 0 | 1 | 2 | 3))).toEqual([
      true,
      true,
      false,
      false,
    ]);
    expect([0, 1, 2, 3].map((c) => snapshotHolds(9n, 10n, c as 0 | 1 | 2 | 3))).toEqual([
      false,
      false,
      true,
      true,
    ]);
  });
});

describe("snapshotFairValue", () => {
  const base = { value: 8_279_670n, threshold: 8_279_670n, annualVol: 0.5, secondsToClose: 3 * DAY };

  it("is just under one half at the money, for a driftless lognormal", () => {
    const { p, decided } = snapshotFairValue({ ...base, comparator: 1 });
    expect(decided).toBe(false);
    expect(p).toBeLessThan(0.5);
    expect(p).toBeGreaterThan(0.48);
  });

  it("prices below as one minus above", () => {
    for (const threshold of [7_800_000n, 8_279_670n, 8_700_000n]) {
      const above = snapshotFairValue({ ...base, threshold, comparator: 1 }).p;
      const below = snapshotFairValue({ ...base, threshold, comparator: 3 }).p;
      expect(above + below).toBeCloseTo(1, 12);
    }
  });

  it("moves toward the money as the close nears and with more volatility", () => {
    const strike = 8_600_000n; // about 4% above
    const far = snapshotFairValue({ ...base, threshold: strike, comparator: 1, secondsToClose: 7 * DAY }).p;
    const near = snapshotFairValue({ ...base, threshold: strike, comparator: 1, secondsToClose: HOUR }).p;
    expect(near).toBeLessThan(far);
    const calm = snapshotFairValue({ ...base, threshold: strike, comparator: 1, annualVol: 0.2 }).p;
    const wild = snapshotFairValue({ ...base, threshold: strike, comparator: 1, annualVol: 1.2 }).p;
    expect(calm).toBeLessThan(wild);
  });

  it("is fixed once the snapshot is stored, whatever the value now", () => {
    expect(snapshotFairValue({ ...base, comparator: 1, secondsToClose: -60, snapshot: 8_279_670n })).toEqual({
      p: 1,
      decided: true,
    });
    expect(snapshotFairValue({ ...base, comparator: 0, secondsToClose: -60, snapshot: 8_279_670n })).toEqual({
      p: 0,
      decided: true,
    });
  });

  it("follows the current value after close until a snapshot exists, without calling it decided", () => {
    expect(snapshotFairValue({ ...base, value: 8_300_000n, comparator: 1, secondsToClose: 0 })).toEqual({
      p: 1,
      decided: false,
    });
  });

  it("refuses values a lognormal cannot model", () => {
    expect(() => snapshotFairValue({ ...base, value: 0n, comparator: 1 })).toThrow(/lognormal/);
    expect(() => snapshotFairValue({ ...base, threshold: -5n, comparator: 1 })).toThrow(/lognormal/);
    expect(() => snapshotFairValue({ ...base, comparator: 1, annualVol: 0 })).toThrow(/volatility/);
  });
});

describe("parseSnapshotVols", () => {
  it("reads sourceId=vol pairs and rejects anything else", () => {
    expect(parseSnapshotVols(undefined)).toEqual({});
    expect(parseSnapshotVols(" 1=0.45, 7=1.5 ")).toEqual({ 1: 0.45, 7: 1.5 });
    expect(() => parseSnapshotVols("1=0")).toThrow(/MAKER_SNAPSHOT_VOLS/);
    expect(() => parseSnapshotVols("btc=0.5")).toThrow(/MAKER_SNAPSHOT_VOLS/);
  });
});

describe("FairValues for template 7", () => {
  const resolver = "0x1E62C389D7c035acfDD971C7E6b7157C1D34D632" as Address;
  const deployment = { hunchBook: { resolvers: { snapshot: resolver } } } as unknown as Deployment;
  const now = { block: 70_000_000, timestamp: 1_791_700_000 };

  /** A client that answers the three resolver reads the model makes, and counts them. */
  function fakeClient(state: { value: bigint; snapshot?: bigint }) {
    const calls: string[] = [];
    const client = {
      readContract: async ({ functionName }: { functionName: string }) => {
        calls.push(functionName);
        if (functionName === "source")
          return { label: "Perpl's BTC mark price (perp 16)", unit: "USD", decimals: 1 };
        if (functionName === "currentValue") return state.value;
        if (functionName === "snapshotFor") {
          const taken = state.snapshot !== undefined;
          return [
            "0x" as Hex,
            { value: state.snapshot ?? 0n, blockNumber: taken ? 1n : 0n, timestamp: taken ? 1n : 0n },
          ];
        }
        throw new Error(`unexpected read ${functionName}`);
      },
    } as unknown as PublicClient;
    return { client, calls };
  }

  const params = (closeTime: number) =>
    encodeSnapshotParams({
      sourceId: 1,
      threshold: 8_300_000n,
      comparator: 1,
      lockTime: BigInt(closeTime - HOUR),
      closeTime: BigInt(closeTime),
      snapshotWindow: 1_800,
    });

  it("is a priced template", () => {
    expect(PRICED_TEMPLATES).toContain(TemplateId.Snapshot);
  });

  it("prices from the resolver's current value with the source's prior, reading the source once", async () => {
    const { client, calls } = fakeClient({ value: 8_279_670n });
    const fair = new FairValues(client, deployment);
    const result = await fair.forMarket(TemplateId.Snapshot, params(now.timestamp + 3 * DAY), now);
    expect(result.decided).toBe(false);
    expect(result.p).toBeGreaterThan(0.4);
    expect(result.p).toBeLessThan(0.5);
    expect(result.detail).toMatchObject({
      value: 827_967,
      threshold: 830_000,
      annualVol: MARK_PRICE_VOL.BTC,
    });
    await fair.forMarket(TemplateId.Snapshot, params(now.timestamp + 3 * DAY), now);
    expect(calls.filter((c) => c === "source")).toHaveLength(1);
    expect(calls).not.toContain("snapshotFor");
  });

  it("is decided from the stored snapshot after close", async () => {
    const { client } = fakeClient({ value: 1n, snapshot: 8_400_000n });
    const result = await new FairValues(client, deployment).forMarket(
      TemplateId.Snapshot,
      params(now.timestamp - 60),
      now,
    );
    expect(result).toMatchObject({ p: 1, decided: true });
  });

  it("uses an override from config", async () => {
    const { client } = fakeClient({ value: 8_279_670n });
    const result = await new FairValues(client, deployment, { 1: 0.9 }).forMarket(
      TemplateId.Snapshot,
      params(now.timestamp + DAY),
      now,
    );
    expect(result.detail.annualVol).toBe(0.9);
  });

  it("has no model on a stack without a snapshot resolver", async () => {
    const { client } = fakeClient({ value: 8_279_670n });
    const bare = { hunchBook: {} } as unknown as Deployment;
    await expect(
      new FairValues(client, bare).forMarket(TemplateId.Snapshot, params(now.timestamp + DAY), now),
    ).rejects.toThrow(/no snapshot resolver/);
  });

  it("decodes what it is given (sanity: the params round-trip)", () => {
    const raw = params(now.timestamp + DAY);
    expect(raw).toBe(
      encodeAbiParameters(
        [
          {
            type: "tuple",
            components: [
              { name: "sourceId", type: "uint16" },
              { name: "threshold", type: "int256" },
              { name: "comparator", type: "uint8" },
              { name: "lockTime", type: "uint64" },
              { name: "closeTime", type: "uint64" },
              { name: "snapshotWindow", type: "uint32" },
            ],
          },
        ],
        [
          {
            sourceId: 1,
            threshold: 8_300_000n,
            comparator: 1,
            lockTime: BigInt(now.timestamp + DAY - HOUR),
            closeTime: BigInt(now.timestamp + DAY),
            snapshotWindow: 1_800,
          },
        ],
      ),
    );
  });
});

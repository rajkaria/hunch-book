import { decodeAbiParameters, encodeFunctionData, encodeFunctionResult, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import {
  decodeSnapshotParams,
  EMPTY_EVIDENCE,
  encodeSnapshotParams,
  isTemplateId,
  Outcome,
  perplExchangeAbi,
  SNAPSHOT_DEFAULT_WINDOW,
  SNAPSHOT_MAX_WINDOW,
  SNAPSHOT_MIN_WINDOW,
  SnapshotComparator,
  snapshotEvidenceHash,
  snapshotKey,
  snapshotOutcome,
  snapshotResolverAbi,
  snapshotValueFromReturnData,
  snapshotWindowState,
  TEMPLATES,
  TemplateId,
  templateLabel,
  templateParamsCodecV3Abi,
} from "../src/index.js";

const EM_DASH = String.fromCodePoint(0x2014);
const PERPL_MAINNET = "0x34B6552d57a35a1D042CcAe1951BD1C370112a6F" as const;

describe("template 7: id and info", () => {
  it("is registered as id 7, on a time clock, with no early YES", () => {
    expect(TemplateId.Snapshot).toBe(7);
    expect(isTemplateId(7)).toBe(true);
    expect(templateLabel(7)).toBe("Snapshot");
    const t = TEMPLATES[TemplateId.Snapshot];
    expect(t.clock).toBe("time");
    expect(t.earlyYes).toBe(false);
    expect(t.question.includes(EM_DASH)).toBe(false);
  });

  it("takes empty evidence", () => {
    expect(EMPTY_EVIDENCE).toBe("0x");
  });
});

describe("template 7: params", () => {
  const p = {
    sourceId: 1,
    threshold: -125n,
    comparator: SnapshotComparator.Below,
    lockTime: 1_800_086_400n,
    closeTime: 1_800_172_800n,
    snapshotWindow: SNAPSHOT_DEFAULT_WINDOW,
  };

  it("round-trips, negative thresholds included", () => {
    expect(decodeSnapshotParams(encodeSnapshotParams(p))).toEqual(p);
    for (const comparator of Object.values(SnapshotComparator)) {
      const q = { ...p, comparator, threshold: 954_501n };
      expect(decodeSnapshotParams(encodeSnapshotParams(q))).toEqual(q);
    }
  });

  it("encodes the struct as six static words, in Solidity's field order", () => {
    const data = encodeSnapshotParams(p);
    expect((data.length - 2) / 2).toBe(6 * 32);
    // The same bytes `cast abi-encode 'f((uint16,int256,uint8,uint64,uint64,uint32))'` produces.
    expect(data).toBe(
      "0x0000000000000000000000000000000000000000000000000000000000000001ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff830000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000006b4b2380000000000000000000000000000000000000000000000000000000006b4c75000000000000000000000000000000000000000000000000000000000000000258",
    );
    const fields = decodeAbiParameters(
      [
        { type: "uint16" },
        { type: "int256" },
        { type: "uint8" },
        { type: "uint64" },
        { type: "uint64" },
        { type: "uint32" },
      ],
      data,
    );
    expect(fields).toEqual([
      p.sourceId,
      p.threshold,
      p.comparator,
      p.lockTime,
      p.closeTime,
      p.snapshotWindow,
    ]);
  });

  it("matches the codec's ABI and the resolver's window limits", () => {
    const fn = templateParamsCodecV3Abi.find((x) => x.type === "function" && x.name === "snapshot");
    expect(fn?.inputs[0]?.components.map((c) => c.name)).toEqual([
      "sourceId",
      "threshold",
      "comparator",
      "lockTime",
      "closeTime",
      "snapshotWindow",
    ]);
    expect(SNAPSHOT_MIN_WINDOW).toBe(60);
    expect(SNAPSHOT_MAX_WINDOW).toBe(1_800);
    expect(SNAPSHOT_DEFAULT_WINDOW).toBeGreaterThanOrEqual(SNAPSHOT_MIN_WINDOW);
    expect(SNAPSHOT_DEFAULT_WINDOW).toBeLessThanOrEqual(SNAPSHOT_MAX_WINDOW);
  });
});

describe("template 7: snapshot key and evidence hash", () => {
  it("keys a snapshot by source, close time and window, as SnapshotStore does", () => {
    // cast keccak $(cast abi-encode 'f(uint16,uint64,uint32)' 0 1800172800 600)
    expect(snapshotKey(0, 1_800_172_800n, 600)).toBe(
      "0x9ad96da60029167139ccaf508f69e2a060723ff418c0301406683d338559d02b",
    );
    expect(snapshotKey(0, 1_800_172_800n, 601)).not.toBe(snapshotKey(0, 1_800_172_800n, 600));
    expect(snapshotKey(1, 1_800_172_800n, 600)).not.toBe(snapshotKey(0, 1_800_172_800n, 600));
  });

  it("hashes the call, the word, the value and the block, as SnapshotResolver does", () => {
    const callData = encodeFunctionData({
      abi: perplExchangeAbi,
      functionName: "getPerpetualInfoV2",
      args: [1n],
    });
    expect(callData).toBe("0x9b335b9e0000000000000000000000000000000000000000000000000000000000000001");
    // cast keccak $(cast abi-encode 'f(address,bytes,uint16,int256,uint64,uint64)' <exchange> <callData>
    //   17 954501 110407333 1791099059)
    expect(
      snapshotEvidenceHash({
        target: PERPL_MAINNET,
        callData,
        valueWord: 17,
        value: 954_501n,
        blockNumber: 110_407_333n,
        timestamp: 1_791_099_059n,
      }),
    ).toBe("0xc56536061f0cc535ce56bd4e675604263aee7b22ec3199349e4de30cc6ba6712");
  });
});

describe("template 7: rule and window", () => {
  it("compares with the four comparators, equal counting only for the 'at or' forms", () => {
    const t = 100n;
    const table: [SnapshotComparator, Outcome, Outcome, Outcome][] = [
      // comparator, value t - 1, value t, value t + 1
      [SnapshotComparator.Above, Outcome.No, Outcome.No, Outcome.Yes],
      [SnapshotComparator.AtOrAbove, Outcome.No, Outcome.Yes, Outcome.Yes],
      [SnapshotComparator.Below, Outcome.Yes, Outcome.No, Outcome.No],
      [SnapshotComparator.AtOrBelow, Outcome.Yes, Outcome.Yes, Outcome.No],
    ];
    for (const [c, below, equal, above] of table) {
      expect(snapshotOutcome(t - 1n, t, c)).toBe(below);
      expect(snapshotOutcome(t, t, c)).toBe(equal);
      expect(snapshotOutcome(t + 1n, t, c)).toBe(above);
    }
    expect(snapshotOutcome(-5n, -4n, SnapshotComparator.Below)).toBe(Outcome.Yes);
  });

  it("opens the window at close and keeps it open through its last second", () => {
    const close = 1_800_172_800n;
    expect(snapshotWindowState(close, 600, close - 1n)).toBe("before");
    expect(snapshotWindowState(close, 600, close)).toBe("open");
    expect(snapshotWindowState(close, 600, close + 600n)).toBe("open");
    expect(snapshotWindowState(close, 600, close + 601n)).toBe("after");
  });
});

describe("template 7: reading a value from return data", () => {
  // Perpl's PerpetualInfoV2 with realistic BTC values (mainnet, October 2026).
  const info = {
    name: "BTC Perp",
    symbol: "BTC",
    priceDecimals: 1n,
    lotDecimals: 5n,
    linkFeedId: `0x${"00".repeat(31)}04` as Hex,
    priceTolPer100K: 5000n,
    marginTol: 100n,
    marginTolDecimals: 9n,
    refPriceMaxAgeSec: 60n,
    positionBalanceCNS: 275_313_396_602n,
    insuranceBalanceCNS: 178_711_208_704n,
    markPNS: 849_859n,
    markTimestamp: 1_791_096_503n,
    lastPNS: 850_150n,
    lastTimestamp: 1_791_096_502n,
    oraclePNS: 849_803n,
    oracleTimestampSec: 1_791_096_522n,
    longOpenInterestLNS: 954_503n,
    shortOpenInterestLNS: 954_503n,
    fundingStartBlock: 55_077_246n,
    fundingRatePct100k: -4,
    absFundingClampPctPer100K: 10n,
    status: 4,
    basePricePNS: 0n,
    maxBidPriceONS: 850_149n,
    minBidPriceONS: 1n,
    maxAskPriceONS: 6_198_000n,
    minAskPriceONS: 850_150n,
    numOrders: 303n,
    ignOracle: false,
    fundingSumScalingExp: 0n,
  };
  const data = encodeFunctionResult({
    abi: perplExchangeAbi,
    functionName: "getPerpetualInfoV2",
    result: info,
  });

  it("reads words by index: 17 open interest, 11 mark, and 20, Perpl's signed funding rate", () => {
    expect(snapshotValueFromReturnData(data, { tuple: true, valueWord: 17, signed: false })).toBe(954_503n);
    expect(snapshotValueFromReturnData(data, { tuple: true, valueWord: 11, signed: false })).toBe(849_859n);
    expect(snapshotValueFromReturnData(data, { tuple: true, valueWord: 20, signed: true })).toBe(-4n);
    // Read flat, word 0 is the head offset.
    expect(snapshotValueFromReturnData(data, { tuple: false, valueWord: 0, signed: false })).toBe(32n);
  });

  it("refuses what the resolver refuses: short data, a bad head, an unsigned value past int256", () => {
    expect(snapshotValueFromReturnData("0x", { tuple: false, valueWord: 0, signed: false })).toBeNull();
    expect(
      snapshotValueFromReturnData(data.slice(0, 2 + 64 * 18) as Hex, {
        tuple: true,
        valueWord: 17,
        signed: false,
      }),
    ).toBeNull();
    const badHead = `0x${"0".repeat(60)}1000${"0".repeat(63)}7` as Hex;
    expect(snapshotValueFromReturnData(badHead, { tuple: true, valueWord: 0, signed: false })).toBeNull();
    expect(snapshotValueFromReturnData(badHead, { tuple: false, valueWord: 1, signed: false })).toBe(7n);
    const top = `0x8${"0".repeat(63)}` as Hex;
    expect(snapshotValueFromReturnData(top, { tuple: false, valueWord: 0, signed: false })).toBeNull();
    expect(snapshotValueFromReturnData(top, { tuple: false, valueWord: 0, signed: true })).toBe(
      -(1n << 255n),
    );
  });
});

describe("template 7: resolver ABI", () => {
  it("exposes the snapshot entry points, the event and the errors the keeper and app use", () => {
    const names = (type: string) =>
      snapshotResolverAbi.filter((x) => x.type === type).map((x) => ("name" in x ? x.name : ""));
    expect(names("function")).toEqual(
      expect.arrayContaining([
        "snapshot",
        "snapshotOf",
        "snapshotFor",
        "snapshotKey",
        "currentValue",
        "source",
        "sourceCount",
        "sourcePin",
        "validate",
        "describe",
        "resolve",
      ]),
    );
    expect(names("event")).toEqual(["SnapshotTaken"]);
    expect(names("error")).toEqual(
      expect.arrayContaining([
        "OutsideSnapshotWindow",
        "SnapshotExists",
        "SourceChanged",
        "ValueStale",
        "SourceCallFailed",
        "GuardCallFailed",
      ]),
    );
  });
});

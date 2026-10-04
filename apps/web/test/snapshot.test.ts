import {
  decodeSnapshotParams,
  deployments,
  encodeSnapshotParams,
  Outcome,
  Phase,
  type SnapshotParams,
  snapshotEvidenceHash,
  snapshotKey,
  TemplateId,
} from "@hunch-book/shared";
import { type Address, encodeAbiParameters, type Hex } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fromLocalInput, toLocalInput } from "../src/lib/create/clock";
import {
  buildSnapshotParams,
  defaultSnapshotDraft,
  type SnapshotDraft,
  snapshotLockTime,
  suggestedThreshold,
} from "../src/lib/create/snapshot";
import { parseTemplateParam, templateById } from "../src/lib/create/templates";
import {
  decodeMarketParams,
  describeSource,
  fallbackHeadline,
  templateLabel,
} from "../src/lib/market/params";
import { planSettlement } from "../src/lib/market/settle";
import {
  checkSnapshot,
  formatSnapshotValue,
  parseSource,
  readSnapshotFor,
  readSnapshotSources,
  type SnapshotSourceView,
  windowSentence,
} from "../src/lib/snapshot";
import { runVerification } from "../src/lib/verify/read";
import { makeMarket } from "./fixtures";

// Template 7 in the app: the create form's builder, the settle plan, the market model and the verifier,
// against stub clients. The values are the shapes testnet's SnapshotResolver returns (its sources list
// BTC open interest in BTC with 5 decimals and the BTC mark in USD with 1 decimal).

const RESOLVER = "0x1E62C389D7c035acfDD971C7E6b7157C1D34D632" as Address;
const PERPL = deployments["monad-testnet"].external.perpl.exchange as Address;
const NOW = 1_800_000_000;
const CALL: Hex = "0x12345678000000000000000000000000000000000000000000000000000000000000000000000010";

const BTC_OI: SnapshotSourceView = parseSource(0, {
  label: "Perpl's BTC open interest (perp 16)",
  unit: "BTC",
  decimals: 5,
  target: PERPL,
  callData: CALL,
  tuple: false,
  valueWord: 1,
  signed: false,
  timestampWord: 0,
  maxAge: 0,
});
const BTC_MARK: SnapshotSourceView = {
  ...BTC_OI,
  id: 1,
  label: "Perpl's BTC mark price (perp 16)",
  unit: "USD",
  decimals: 1,
  maxAge: 120,
};

const P: SnapshotParams = {
  sourceId: 0,
  threshold: 2_000_000n, // 20 BTC
  comparator: 0,
  lockTime: BigInt(NOW - 86_400),
  closeTime: BigInt(NOW),
  snapshotWindow: 600,
};
const PARAMS = encodeSnapshotParams(P);

describe("snapshot values and sources", () => {
  it("writes a value in its unit, as the resolver's sentence does", () => {
    expect(formatSnapshotValue(2_357_534n, BTC_OI)).toBe("23.57534 BTC");
    expect(formatSnapshotValue(852_138n, BTC_MARK)).toBe("$85,213.8");
    expect(formatSnapshotValue(-15n, BTC_MARK)).toBe("-$1.5");
    expect(formatSnapshotValue(2_000_000n, BTC_OI)).toBe("20 BTC");
  });

  it("lists the resolver's sources and reads the stored snapshot, none while the block is zero", async () => {
    const client = {
      readContract: vi.fn(async ({ functionName }: { functionName: string }) =>
        functionName === "sourceCount"
          ? 2n
          : [snapshotKey(0, P.closeTime, P.snapshotWindow), { value: 0n, blockNumber: 0n, timestamp: 0n }],
      ),
      multicall: vi.fn(async () => [
        { status: "success", result: { ...BTC_OI, decimals: 5 } },
        { status: "failure", error: new Error("x") },
      ]),
    };
    const sources = await readSnapshotSources(client as never, RESOLVER);
    expect(sources.map((s) => s.label)).toEqual(["Perpl's BTC open interest (perp 16)"]);
    expect(await readSnapshotFor(client as never, RESOLVER, PARAMS)).toEqual({
      key: snapshotKey(0, P.closeTime, P.snapshotWindow),
      snapshot: null,
    });
  });

  it("says where the window stands in one sentence", () => {
    expect(windowSentence("open", false)).toMatch(
      /^The snapshot window is open\. Settling now takes the snapshot/,
    );
    expect(windowSentence("after", false)).toMatch(/voids at its deadline/);
    expect(windowSentence("after", true)).toMatch(/final/);
  });
});

describe("the create form's builder", () => {
  const draft = (over: Partial<SnapshotDraft> = {}): SnapshotDraft => ({
    sourceId: "0",
    comparator: 1,
    threshold: "20.5",
    close: toLocalInput(NOW + 3 * 86_400),
    lockLead: "day",
    lock: "",
    window: 600,
    ...over,
  });

  it("encodes the canonical params, with the threshold in the source's raw units", () => {
    const b = buildSnapshotParams(draft(), { sources: [BTC_OI, BTC_MARK], now: NOW });
    expect(b.issues).toEqual([]);
    const close = fromLocalInput(draft().close) as number;
    expect(decodeSnapshotParams(b.params as Hex)).toEqual({
      sourceId: 0,
      threshold: 2_050_000n,
      comparator: 1,
      lockTime: BigInt(close - 86_400),
      closeTime: BigInt(close),
      snapshotWindow: 600,
    });
  });

  it("reports every problem against its field", () => {
    const sources = [BTC_OI, BTC_MARK];
    const issues = (over: Partial<SnapshotDraft>) =>
      buildSnapshotParams(draft(over), { sources, now: NOW }).issues.map((i) => i.field);
    expect(issues({ sourceId: "" })).toEqual(["source"]);
    expect(issues({ threshold: "" })).toEqual(["threshold"]);
    expect(issues({ threshold: "1.123456" })).toEqual(["threshold"]);
    expect(issues({ threshold: "-1" })).toEqual(["threshold"]);
    expect(issues({ window: 30 })).toEqual(["window"]);
    expect(issues({ window: 3_600 })).toEqual(["window"]);
    expect(issues({ close: toLocalInput(NOW + 3_600) })).toEqual(["close"]);
    expect(issues({ lockLead: "custom", lock: toLocalInput(NOW + 4 * 86_400) })).toEqual(["lock"]);
    expect(buildSnapshotParams(draft({ threshold: "x" }), { sources, now: NOW }).params).toBeNull();
  });

  it("defaults to the first source, above, a ten-minute window and a close at noon UTC", () => {
    const d = defaultSnapshotDraft(NOW, [BTC_OI]);
    expect(d).toMatchObject({ sourceId: "0", comparator: 0, window: 600, lockLead: "day" });
    const close = fromLocalInput(d.close) as number;
    expect(close % 86_400).toBe(12 * 3_600);
    expect(snapshotLockTime(d, close)).toBe(close - 86_400);
    expect(suggestedThreshold(2_357_534n, BTC_OI)).toBe("23.6");
    expect(suggestedThreshold(852_138n, BTC_MARK)).toBe("85200");
  });

  it("is in the create catalog as template 7", () => {
    expect(templateById(7)?.kind).toBe("snapshot");
    expect(parseTemplateParam("7")).toBe(7);
  });
});

describe("the market model", () => {
  it("decodes template 7 and describes its source", () => {
    const decoded = decodeMarketParams(TemplateId.Snapshot, PARAMS);
    expect(decoded).toEqual({ kind: "snapshot", params: P });
    expect(templateLabel(7)).toBe("Snapshot");
    expect(fallbackHeadline(deployments["monad-testnet"], decoded)).toMatch(
      /^Will snapshot source 0 read above 2000000/,
    );
    const source = describeSource(deployments["monad-testnet"], decoded, RESOLVER);
    expect(source.title).toBe("A value read onchain in a snapshot");
    expect(source.items.map((i) => i.label)).toEqual(["Resolver", "Source", "Snapshot window", "Threshold"]);
    expect(decodeMarketParams(TemplateId.Snapshot, "0x1234")).toEqual({ kind: "unknown", raw: "0x1234" });
  });
});

describe("settling a snapshot market", () => {
  const market = makeMarket({
    templateId: TemplateId.Snapshot,
    params: PARAMS,
    resolver: RESOLVER,
    phase: Phase.Closed,
  });
  let now = NOW + 30;
  beforeEach(() => {
    vi.spyOn(Date, "now").mockImplementation(() => now * 1000);
  });
  afterEach(() => vi.restoreAllMocks());

  const client = (stored: { value: bigint; blockNumber: bigint; timestamp: bigint }, outcome: number) => ({
    readContract: vi.fn(async () => [snapshotKey(0, P.closeTime, P.snapshotWindow), stored]),
    multicall: vi.fn(),
    simulateContract: vi.fn(async (args: { args: unknown[] }) => {
      expect(args.args[1]).toBe("0x");
      return { result: [outcome, `0x${"ab".repeat(32)}`] };
    }),
  });

  it("settles with empty evidence, taking the snapshot inside the window", async () => {
    now = NOW + 30;
    const plan = await planSettlement(
      client({ value: 0n, blockNumber: 0n, timestamp: 0n }, Outcome.Yes) as never,
      market,
    );
    expect(plan).toMatchObject({ status: "ready", evidence: "0x", outcome: Outcome.Yes });
    expect(plan.status === "ready" && plan.note).toMatch(
      /^Settling now takes the snapshot and settles in one transaction/,
    );
  });

  it("answers from a stored snapshot after the window", async () => {
    now = NOW + 5_000;
    const plan = await planSettlement(
      client(
        { value: 2_500_000n, blockNumber: 68_000_000n, timestamp: BigInt(NOW + 1) },
        Outcome.Yes,
      ) as never,
      market,
    );
    expect(plan.status === "ready" && plan.note).toBe(
      "It answers from the snapshot taken at block 68,000,000.",
    );
  });

  it("explains why it cannot answer: no snapshot after the window, or an unreadable source inside it", async () => {
    now = NOW + 5_000;
    const late = await planSettlement(
      client({ value: 0n, blockNumber: 0n, timestamp: 0n }, Outcome.Unresolved) as never,
      market,
    );
    expect(late).toEqual({
      status: "unresolved",
      reason: "Nobody took a snapshot in its window, so this market has no answer. It voids at its deadline.",
    });
    now = NOW + 30;
    const broken = await planSettlement(
      client({ value: 0n, blockNumber: 0n, timestamp: 0n }, Outcome.Unresolved) as never,
      market,
    );
    expect(broken.status === "unresolved" && broken.reason).toMatch(/^The source cannot be read right now/);
  });
});

describe("verifying a snapshot market", () => {
  const VALUE = 2_357_534n;
  const BLOCK = 68_100_000n;
  const TIME = BigInt(NOW + 2);
  const returnData = encodeAbiParameters(
    [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
    [7n, VALUE, 9n],
  );
  const expected = snapshotEvidenceHash({
    target: PERPL,
    callData: CALL,
    valueWord: 1,
    value: VALUE,
    blockNumber: BLOCK,
    timestamp: TIME,
  });

  const stub = (stored: boolean, reread: Hex = returnData) => ({
    getBlock: vi.fn(async () => ({ timestamp: BigInt(NOW + 5_000) })),
    readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
      if (functionName === "snapshotFor") {
        return [
          snapshotKey(0, P.closeTime, P.snapshotWindow),
          stored
            ? { value: VALUE, blockNumber: BLOCK, timestamp: TIME }
            : { value: 0n, blockNumber: 0n, timestamp: 0n },
        ];
      }
      if (functionName === "source") return BTC_OI;
      if (functionName === "currentValue") return 1n;
      throw new Error(functionName);
    }),
    call: vi.fn(async ({ blockNumber }: { blockNumber: bigint }) => {
      expect(blockNumber).toBe(BLOCK);
      return { data: reread };
    }),
    simulateContract: vi.fn(async () => ({ result: [Outcome.Yes, expected] })),
    multicall: vi.fn(),
    getLogs: vi.fn(),
    getTransaction: vi.fn(),
  });

  it("rebuilds the evidence hash, re-reads the source at the snapshot's block and matches the stored values", async () => {
    const m = makeMarket({
      templateId: TemplateId.Snapshot,
      params: PARAMS,
      resolver: RESOLVER,
      phase: Phase.Settled,
      outcome: Outcome.Yes,
      evidenceHash: expected,
    });
    const v = await runVerification(stub(true) as never, deployments["monad-testnet"], m, 68_200_000n);
    expect(v.read.template).toBe("snapshot");
    if (v.read.template !== "snapshot") return;
    expect(v.read.window).toBe("after");
    expect(v.read.outcome).toBe(Outcome.Yes);
    expect(v.read.expectedHash).toBe(expected);
    expect(v.read.reread).toEqual({ value: VALUE, matches: true, error: null });
    expect(v.matches).toEqual({ outcome: true, hash: true, resolver: true });
  });

  it("flags a re-read that differs (a later transaction in the same block moved the value)", async () => {
    const other = encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [7n, VALUE + 1n]);
    const check = await checkSnapshot(stub(true, other) as never, RESOLVER, PARAMS, P, BigInt(NOW + 5_000));
    expect(check.reread).toEqual({ value: VALUE + 1n, matches: false, error: null });
  });

  it("before a snapshot, shows the current value and nothing to compare", async () => {
    const check = await checkSnapshot(stub(false) as never, RESOLVER, PARAMS, P, BigInt(NOW + 10));
    expect(check).toMatchObject({
      window: "open",
      snapshot: null,
      outcome: null,
      expectedHash: null,
      current: 1n,
    });
  });
});

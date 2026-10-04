import {
  encodeSnapshotParams,
  Outcome,
  Phase,
  SnapshotComparator,
  type SnapshotParams,
  snapshotResolverAbi,
} from "@hunch-book/shared";
import { type Address, encodeAbiParameters, type Hex, keccak256, parseAbi, toFunctionSelector } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { beforeEach, describe, expect, it } from "vitest";
import {
  decodeMarketParams,
  encodeMarketParams,
  getMarket,
  planSettlement,
  snapshotAsset,
  takeSnapshot,
  verifySettlement,
} from "../src/index.js";
import { FakeChain, Revert } from "./fake-chain.js";
import {
  addr,
  type FakeMarket,
  registerFactory,
  registerMarket,
  registerResolver,
  timeWindow,
} from "./fixtures.js";

// Template 7 on the fake chain: the plan around the snapshot window, settling from a stored snapshot,
// and verification that rebuilds the evidence hash (written out here from docs/TEMPLATES.md) and reads
// the source again at the snapshot's block.

const RESOLVER = addr(0x7aa);
const SOURCE = addr(0x7bb);
const T = 1_800_000_000n;
const W = 600;
const OI_E5 = 1_234_567n; // 12.34567 BTC at 5 lot decimals
const READ: Hex = toFunctionSelector("read()");

const params: SnapshotParams = {
  sourceId: 0,
  threshold: 1_000_000n,
  comparator: SnapshotComparator.Above,
  lockTime: T - 3_600n,
  closeTime: T,
  snapshotWindow: W,
};

const sourceStruct = {
  label: "Perpl's BTC open interest (perp 16)",
  unit: "BTC",
  decimals: 5,
  target: SOURCE,
  callData: READ,
  tuple: false,
  valueWord: 0,
  signed: false,
  timestampWord: 0,
  maxAge: 0,
  pinnedWords: [],
  guardTarget: "0x0000000000000000000000000000000000000000" as Address,
  guardCallData: "0x" as Hex,
};

/** docs/TEMPLATES.md: keccak256(abi.encode(target, callData, valueWord, value, blockNumber, timestamp)). */
const docHash = (value: bigint, blockNumber: bigint, timestamp: bigint): Hex =>
  keccak256(
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "bytes" },
        { type: "uint16" },
        { type: "int256" },
        { type: "uint64" },
        { type: "uint64" },
      ],
      [SOURCE, READ, 0, value, blockNumber, timestamp],
    ),
  );

let chain: FakeChain;
let stored: { value: bigint; blockNumber: bigint; timestamp: bigint } | null;
let sourceValue: bigint;

function market(overrides: Partial<FakeMarket> = {}): FakeMarket {
  return {
    address: addr(0x707),
    id: 7,
    templateId: 7,
    params: encodeSnapshotParams(params),
    phase: Phase.PoolLocked,
    window: timeWindow(params.lockTime, T, T + BigInt(W) + 604_800n),
    resolver: RESOLVER,
    ...overrides,
  };
}

function setup(m: FakeMarket): void {
  registerFactory(chain, [m]);
  registerMarket(chain, m);
  // The resolver answers like SnapshotResolver: from the stored snapshot, or by taking one inside the window.
  registerResolver(chain, RESOLVER, (_p, evidence) => {
    if (evidence !== "0x") throw new Revert(parseAbi(["error EvidenceNotEmpty()"]), "EvidenceNotEmpty");
    let s = stored;
    const now = chain.block.timestamp;
    if (!s && now >= T && now <= T + BigInt(W))
      s = { value: sourceValue, blockNumber: chain.block.number, timestamp: now };
    if (!s) return [Outcome.Unresolved, `0x${"00".repeat(32)}`];
    return [
      s.value > params.threshold ? Outcome.Yes : Outcome.No,
      docHash(s.value, s.blockNumber, s.timestamp),
    ];
  });
  chain.register(RESOLVER, snapshotResolverAbi, {
    snapshotFor: () => [`0x${"ee".repeat(32)}`, stored ?? { value: 0n, blockNumber: 0n, timestamp: 0n }],
    source: () => sourceStruct,
    snapshot: () => sourceValue,
  });
  chain.register(SOURCE, parseAbi(["function read() view returns (uint256)"]), { read: () => sourceValue });
}

beforeEach(() => {
  chain = new FakeChain();
  stored = null;
  sourceValue = OI_E5;
});

describe("template 7 params and reads", () => {
  it("encodes and decodes snapshot params, and names the asset from the source label", async () => {
    const bytes = encodeMarketParams({ templateId: 7, params });
    expect(decodeMarketParams(7, bytes)).toEqual({ kind: "snapshot", templateId: 7, params });
    expect(snapshotAsset({ label: "Perpl's ETH mark price (perp 32)", unit: "USD" })).toBe("ETH");
    expect(snapshotAsset({ label: "the plain word", unit: "units" })).toBe("units");
    expect(snapshotAsset({ label: "a dollar value", unit: "USD" })).toBeNull();
    chain.block = { number: 100n, timestamp: T - 10n };
    setup(market());
    const info = await getMarket(chain.context(), addr(0x707));
    expect(info).toMatchObject({ templateId: 7, template: "Snapshot", asset: "BTC" });
    expect(info?.snapshotSource).toEqual({ label: sourceStruct.label, unit: "BTC", decimals: 5 });
  });
});

describe("template 7 settlement plan", () => {
  it("waits for the window, settles inside it with empty evidence, and is blocked after it with no snapshot", async () => {
    setup(market());
    chain.block = { number: 100n, timestamp: T - 10n };
    const before = await planSettlement(chain.context(), addr(0x707));
    expect(before.status).toBe("wait");
    expect((before as { reason: string }).reason).toMatch(/snapshot window opens/);

    chain.block = { number: 200n, timestamp: T + 5n };
    const inside = await planSettlement(chain.context(), addr(0x707));
    expect(inside).toMatchObject({
      status: "ready",
      method: "settle",
      evidence: "0x",
      outcome: Outcome.Yes,
      evidenceHash: docHash(OI_E5, 200n, T + 5n),
      detail: { snapshot: "taken by settle" },
    });

    chain.block = { number: 9_000n, timestamp: T + BigInt(W) + 1n };
    const after = await planSettlement(chain.context(), addr(0x707));
    expect(after.status).toBe("blocked");
    expect((after as { reason: string }).reason).toMatch(/voids at its deadline/);
  });

  it("settles from a stored snapshot after the window", async () => {
    stored = { value: 900_000n, blockNumber: 201n, timestamp: T + 3n };
    setup(market());
    chain.block = { number: 9_000n, timestamp: T + 5_000n };
    expect(await planSettlement(chain.context(), addr(0x707))).toMatchObject({
      status: "ready",
      outcome: Outcome.No,
      evidenceHash: docHash(900_000n, 201n, T + 3n),
      detail: { snapshot: "stored", value: 900_000n, snapshotBlock: 201n },
    });
  });

  it("says when the source cannot be read inside the window", async () => {
    setup(market());
    registerResolver(chain, RESOLVER, () => [Outcome.Unresolved, `0x${"00".repeat(32)}`]);
    chain.block = { number: 200n, timestamp: T + 5n };
    const plan = await planSettlement(chain.context(), addr(0x707));
    expect(plan.status).toBe("wait");
    expect((plan as { reason: string }).reason).toMatch(/Try again inside the snapshot window/);
  });

  it("takes the snapshot through the resolver", async () => {
    setup(market());
    chain.block = { number: 200n, timestamp: T + 5n };
    await takeSnapshot(chain.context({ key: generatePrivateKey() }), addr(0x707));
    expect(chain.sent.at(-1)).toMatchObject({ to: RESOLVER, functionName: "snapshot", args: [0, T, W] });
  });
});

describe("template 7 verification", () => {
  it("rebuilds the stored hash and reads the source again at the snapshot's block", async () => {
    stored = { value: OI_E5, blockNumber: 201n, timestamp: T + 3n };
    setup(market({ phase: Phase.Settled, outcome: Outcome.Yes, evidenceHash: docHash(OI_E5, 201n, T + 3n) }));
    chain.block = { number: 9_000n, timestamp: T + 5_000n };
    const v = await verifySettlement(chain.context(), addr(0x707));
    expect(v).toMatchObject({
      status: "settled",
      verified: true,
      matches: { evidenceHash: true, outcome: true, rerun: true },
      recomputed: {
        outcome: "yes",
        reads: {
          value: OI_E5,
          snapshotBlock: 201n,
          rereadValue: OI_E5,
          rereadMatches: true,
          unit: "BTC",
          decimals: 5,
        },
      },
    });
    expect(v.notes).toEqual([]);
  });

  it("flags a reread that a later transaction in the block moved, and a stored hash that does not match", async () => {
    stored = { value: OI_E5, blockNumber: 201n, timestamp: T + 3n };
    sourceValue = OI_E5 + 1n;
    setup(market({ phase: Phase.Settled, outcome: Outcome.Yes, evidenceHash: `0x${"99".repeat(32)}` }));
    chain.block = { number: 9_000n, timestamp: T + 5_000n };
    const v = await verifySettlement(chain.context(), addr(0x707));
    expect(v.verified).toBe(false);
    expect(v.matches.evidenceHash).toBe(false);
    expect(v.recomputed.reads).toMatchObject({ rereadValue: OI_E5 + 1n, rereadMatches: false });
    expect(v.notes.join(" ")).toMatch(/later transaction in that block/);
  });
});

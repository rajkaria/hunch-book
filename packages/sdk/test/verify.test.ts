import { encodeParlayParams, encodePerplFundingParams, marketAbi, Outcome, Phase } from "@hunch-book/shared";
import { type Abi, type Address, encodeAbiParameters, type Hex, keccak256 } from "viem";
import { beforeEach, describe, expect, it } from "vitest";
import { verifySettlement } from "../src/index.js";
import { FakeChain } from "./fake-chain.js";
import {
  addr,
  blockWindow,
  type FakeMarket,
  registerFactory,
  registerMarket,
  registerPerpl,
  registerResolver,
  testnet,
  timeWindow,
} from "./fixtures.js";

// The verifier on the fake chain: hashes are rebuilt here straight from docs/TEMPLATES.md, so a
// wrong encoding in the SDK would fail. The anvil suite checks the same against the real resolvers.

const EXCHANGE = testnet.external.perpl.exchange;
const RESOLVER = addr(0xaa);

/** Template 1's evidence hash, written out from docs/TEMPLATES.md. */
const perplHash = (sumStart: number, sumEnd: number, eventStart: bigint, eventEnd: bigint): Hex =>
  keccak256(
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "uint256" },
        { type: "uint64" },
        { type: "uint64" },
        { type: "int48" },
        { type: "int48" },
        { type: "uint256" },
        { type: "uint256" },
      ],
      [EXCHANGE, 16n, 1_000n, 2_000n, sumStart, sumEnd, eventStart, eventEnd],
    ),
  );

let chain: FakeChain;

function perplMarket(evidenceHash: Hex, outcome: Outcome, phase: Phase = Phase.Settled): FakeMarket {
  return {
    address: addr(0x101),
    id: 1,
    templateId: 1,
    params: encodePerplFundingParams({
      perpId: 16n,
      startBlock: 1_000n,
      endBlock: 2_000n,
      threshold: 5n,
      expectedScalingExp: 2,
    }),
    phase,
    outcome,
    evidenceHash,
    window: blockWindow(1_000n, 2_000n, 1_900_000_000n),
    resolver: RESOLVER,
  };
}

beforeEach(() => {
  chain = new FakeChain();
  chain.block = { number: 3_000n, timestamp: 1_800_000_000n };
  registerPerpl(chain, EXCHANGE, [
    { block: 900n, sum: 100n },
    { block: 1_900n, sum: 140n },
  ]);
});

describe("verifySettlement", () => {
  it("reproduces a template 1 settlement: hash, outcome and re-run all match", async () => {
    const stored = perplHash(100, 140, 900n, 1_900n);
    const m = perplMarket(stored, Outcome.Yes);
    registerFactory(chain, [m]);
    registerMarket(chain, m);
    registerResolver(
      chain,
      RESOLVER,
      (_p, evidence) => (evidence === "0x" ? [Outcome.Yes, stored] : [0, stored]),
      { exchange: EXCHANGE },
    );
    const v = await verifySettlement(chain.context(), m.address);
    expect(v).toMatchObject({
      status: "settled",
      verified: true,
      stored: { outcome: "yes", evidenceHash: stored },
      recomputed: {
        outcome: "yes",
        evidenceHash: stored,
        evidence: "0x",
        reads: { delta: 40n, threshold: 5n },
      },
      rerun: { outcome: "yes", evidenceHash: stored },
      matches: { evidenceHash: true, outcome: true, rerun: true },
    });
    expect(v.rpc).toBe(testnet.rpc);
  });

  it("flags a stored hash or outcome that the source does not reproduce", async () => {
    const wrong: Hex = `0x${"99".repeat(32)}`;
    const m = perplMarket(wrong, Outcome.No);
    registerFactory(chain, [m]);
    registerMarket(chain, m);
    registerResolver(chain, RESOLVER, () => [Outcome.Yes, perplHash(100, 140, 900n, 1_900n)], {
      exchange: EXCHANGE,
    });
    const v = await verifySettlement(chain.context(), m.address);
    expect(v.verified).toBe(false);
    expect(v.matches).toEqual({ evidenceHash: false, outcome: false, rerun: false });
  });

  it("previews what settling would do for an open market", async () => {
    const m = perplMarket(`0x${"00".repeat(32)}`, Outcome.Unresolved, Phase.Closed);
    registerFactory(chain, [m]);
    registerMarket(chain, m);
    registerResolver(chain, RESOLVER, () => [Outcome.Yes, perplHash(100, 140, 900n, 1_900n)], {
      exchange: EXCHANGE,
    });
    const v = await verifySettlement(chain.context(), m.address);
    expect(v).toMatchObject({
      status: "open",
      verified: null,
      plan: { status: "ready", outcome: Outcome.Yes },
    });
  });

  it("reproduces a parlay from its legs' outcomes and hashes", async () => {
    const legs = [addr(0x601), addr(0x602)] as const;
    const legHash: Hex = `0x${"ab".repeat(32)}`;
    const stored = keccak256(
      encodeAbiParameters(
        [{ type: "address[]" }, { type: "uint8[]" }, { type: "bytes32[]" }],
        [legs, [1, 2], [legHash, legHash]],
      ),
    );
    const parlay: FakeMarket = {
      address: addr(0x606),
      id: 6,
      templateId: 6,
      params: encodeParlayParams({ legs, lockTime: 1n, closeTime: 2n }),
      phase: Phase.Settled,
      outcome: Outcome.No,
      evidenceHash: stored,
      window: timeWindow(1n, 2n, 1_900_000_000n),
      resolver: RESOLVER,
    };
    registerFactory(chain, [parlay]);
    registerMarket(chain, parlay);
    registerResolver(chain, RESOLVER, () => [Outcome.No, stored]);
    chain.register(legs[0], marketAbi as Abi, { outcome: () => Outcome.Yes, evidenceHash: () => legHash });
    chain.register(legs[1], marketAbi as Abi, { outcome: () => Outcome.No, evidenceHash: () => legHash });
    const v = await verifySettlement(chain.context(), parlay.address);
    expect(v).toMatchObject({
      verified: true,
      recomputed: { outcome: "no", evidenceHash: stored, reads: { outcomes: ["yes", "no"] } },
    });
    expect((v.recomputed.reads.legs as Address[]).length).toBe(2);
  });
});

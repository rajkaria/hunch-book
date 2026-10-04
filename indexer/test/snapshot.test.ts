// Template 7: markets link to the snapshot their parameters name, and SnapshotTaken fills it in, whether
// a market's settle() took it or someone called snapshot() directly.
import { describe, expect, it } from "vitest";
import { snapshotId, snapshotKey } from "../src/lib/params.js";
import { ADDR, ALICE, BOB, Outcome, Protocol, Script, Side, snapshotParams, USDC } from "./helpers.js";

const START = 1_791_039_000;
const LOCK = BigInt(START + 3_600);
const CLOSE = BigInt(START + 7_200); // 2026-10-03 16:50:00 UTC
const OI_ABOVE = "0x7000000000000000000000000000000000000001";
const OI_BELOW = "0x7000000000000000000000000000000000000004";
const MARK = "0x7000000000000000000000000000000000000007";
const tokens = (market: string) => ({
  yes: market.replace(/^0x7/, "0x8"),
  no: market.replace(/^0x7/, "0x9"),
});

function createSnapshotMarket(
  p: Protocol,
  market: string,
  terms: { sourceId: number; threshold: bigint; comparator: number; snapshotWindow: number },
  creator = ALICE,
) {
  p.createMarket({
    market,
    ...tokens(market),
    creator,
    templateId: 7n,
    params: snapshotParams({ ...terms, lockTime: LOCK, closeTime: CLOSE }),
    side: Side.Yes,
    amount: USDC(20),
  });
}

/** Two markets on one observation (BTC open interest, source 0, a 10-minute window) and one on another. */
async function setUp() {
  const p = new Protocol(new Script(67_858_400, START));
  p.addTemplates();
  p.addSnapshotTemplate();
  p.s.next({ from: ALICE });
  createSnapshotMarket(p, OI_ABOVE, {
    sourceId: 0,
    threshold: 1_000_000n,
    comparator: 0,
    snapshotWindow: 600,
  });
  p.s.next({ from: BOB });
  createSnapshotMarket(
    p,
    OI_BELOW,
    { sourceId: 0, threshold: 900_000n, comparator: 3, snapshotWindow: 600 },
    BOB,
  );
  p.stake({ market: OI_BELOW, user: BOB, side: Side.No, amount: USDC(5) });
  p.s.next({ from: ALICE });
  createSnapshotMarket(p, MARK, { sourceId: 1, threshold: 8_500_000n, comparator: 1, snapshotWindow: 60 });
  await p.run();
  return p;
}

describe("template 7 markets", () => {
  it("decode their terms and name the snapshot they answer from", async () => {
    const p = await setUp();
    const key = snapshotKey(0, CLOSE, 600);
    const above = await p.indexer.Market.getOrThrow(OI_ABOVE);
    expect(above).toMatchObject({
      template_id: "7",
      question:
        "Will snapshot source 0 read above 1,000,000 (raw units) in the first snapshot taken from 2026-10-03 16:50:00 UTC to 2026-10-03 17:00:00 UTC?",
      threshold: 1_000_000n,
      comparator: "Above",
      snapshotSourceId: 0,
      snapshotWindow: 600,
      snapshotKey: key,
      snapshot_id: snapshotId(ADDR.snapshotResolver, key),
      blockClock: false,
      lockAt: LOCK,
      closeAt: CLOSE,
      settleDeadline: CLOSE + 600n + 7n * 86_400n,
    });
    // Same observation, other threshold and comparator: the same snapshot.
    const below = await p.indexer.Market.getOrThrow(OI_BELOW);
    expect(below).toMatchObject({
      comparator: "AtOrBelow",
      snapshotKey: key,
      snapshot_id: above.snapshot_id,
    });
    const mark = await p.indexer.Market.getOrThrow(MARK);
    expect(mark.snapshotKey).toBe(snapshotKey(1, CLOSE, 60));
    expect(mark.snapshot_id).not.toBe(above.snapshot_id);
    expect(await p.indexer.Snapshot.getAll()).toEqual([]);
    expect((await p.indexer.Template.getOrThrow("7")).marketCount).toBe(3);
  });

  it("record a snapshot taken inside settle(), which every market on the observation then shows", async () => {
    const p = await setUp();
    // The keeper settles the first market five seconds after close: the resolver takes the snapshot.
    p.s.next({ seconds: Number(CLOSE) + 5 - p.s.timestamp, from: ADDR.keeper });
    const block = BigInt(p.s.block);
    p.snapshotTaken({ sourceId: 0, closeTime: CLOSE, window: 600, value: 1_250_000n, caller: OI_ABOVE });
    p.settlePool({ market: OI_ABOVE, outcome: Outcome.Yes, settler: ADDR.keeper });
    // A minute later Bob settles the second market from the stored snapshot: no second SnapshotTaken.
    p.s.next({ seconds: 60, from: BOB });
    p.settlePool({ market: OI_BELOW, outcome: Outcome.No, settler: BOB });
    await p.run();

    const key = snapshotKey(0, CLOSE, 600);
    const snapshot = await p.indexer.Snapshot.getOrThrow(snapshotId(ADDR.snapshotResolver, key));
    expect(snapshot).toMatchObject({
      key,
      resolver: ADDR.snapshotResolver,
      sourceId: 0,
      closeTime: CLOSE,
      snapshotWindow: 600,
      value: 1_250_000n,
      block,
      timestamp: CLOSE + 5n,
      secondsAfterClose: 5n,
      taker: OI_ABOVE,
      takenInSettle: true,
      sender: ADDR.keeper,
      senderIsOurs: true,
    });
    for (const market of [OI_ABOVE, OI_BELOW]) {
      expect((await p.indexer.Market.getOrThrow(market)).snapshot_id).toBe(snapshot.id);
    }
    expect(await p.indexer.Settlement.getOrThrow(OI_ABOVE)).toMatchObject({
      outcome: "Yes",
      latencySeconds: 5n,
      early: false,
    });
    expect(await p.indexer.Settlement.getOrThrow(OI_BELOW)).toMatchObject({
      outcome: "No",
      latencySeconds: 65n,
    });
    const stats = await p.indexer.ProtocolStats.getOrThrow("10143");
    expect(stats).toMatchObject({ snapshotsTaken: 1, snapshotsTakenOurs: 1, settlementsTimed: 2 });
    const days = await p.indexer.DailyStats.getAll();
    expect(days.reduce((n, d) => n + d.snapshotsTaken, 0)).toBe(1);
  });

  it("record a snapshot anyone took with snapshot(), labelled as not ours", async () => {
    const p = await setUp();
    p.s.next({ seconds: Number(CLOSE) + 30 - p.s.timestamp, from: ALICE });
    p.snapshotTaken({ sourceId: 1, closeTime: CLOSE, window: 60, value: 8_612_340n, caller: ALICE });
    await p.run();
    const snapshot = await p.indexer.Snapshot.getOrThrow(
      snapshotId(ADDR.snapshotResolver, snapshotKey(1, CLOSE, 60)),
    );
    expect(snapshot).toMatchObject({
      taker: ALICE,
      takenInSettle: false,
      sender: ALICE,
      senderIsOurs: false,
      secondsAfterClose: 30n,
      value: 8_612_340n,
    });
    expect(await p.indexer.ProtocolStats.getOrThrow("10143")).toMatchObject({
      snapshotsTaken: 1,
      snapshotsTakenOurs: 0,
    });
  });

  it("keep negative values, as signed sources report them", async () => {
    const p = await setUp();
    p.s.next({ seconds: Number(CLOSE) - p.s.timestamp, from: ADDR.keeper });
    p.snapshotTaken({ sourceId: 1, closeTime: CLOSE, window: 60, value: -42n, caller: ADDR.keeper });
    await p.run();
    const [snapshot] = await p.indexer.Snapshot.getAll();
    expect(snapshot).toMatchObject({ value: -42n, secondsAfterClose: 0n, takenInSettle: false });
  });
});

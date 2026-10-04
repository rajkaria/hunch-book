// ImpliedProbabilityOracle pokes (the latest chance per market and the checkpoint history) and the
// price adapters made for outcome tokens.
import { describe, expect, it } from "vitest";
import { ADDR, ALICE, afterPeripheryDeploy, Protocol, SEED, Side, seedTestnetMarket } from "./helpers.js";

const ADAPTER_YES = "0x00000000000000000000000000000000000000a1";
const ADAPTER_NO = "0x00000000000000000000000000000000000000a2";

describe("oracle and price adapters", () => {
  it("keep each market's latest poke, its checkpoints, and who poked", async () => {
    const p = new Protocol();
    seedTestnetMarket(p);
    afterPeripheryDeploy(p, ADDR.keeper);
    p.poke({ market: SEED.market, chanceE6: 594_202n, spreadE6: 1_000_000n, stale: true });
    p.s.next({ seconds: 10, from: ALICE });
    p.poke({ market: SEED.market, chanceE6: 400_500n, spreadE6: 31_000n, checkpoint: false });
    p.s.next({ seconds: 25, from: ADDR.keeper });
    p.poke({ market: SEED.market, chanceE6: 401_000n, spreadE6: 30_000n });
    await p.run();

    const feed = await p.indexer.OracleFeed.getOrThrow(SEED.market);
    expect(feed).toMatchObject({
      market_id: SEED.market,
      chanceE6: 401_000,
      spreadE6: 30_000,
      stale: false,
      pokeCount: 3,
      pokeCountOurs: 2,
      checkpointCount: 2,
      lastPoker: ADDR.keeper,
      lastPokedAtBlock: BigInt(p.s.block),
    });
    expect(feed.lastPokedAt - feed.firstPokedAt).toBe(35n);
    const checkpoints = await p.indexer.OracleCheckpoint.getAll();
    expect(checkpoints.map((c) => [c.chanceE6, c.stale, c.pokerIsOurs])).toEqual([
      [594_202, true, true],
      [401_000, false, true],
    ]);
    expect(checkpoints[0]?.id).toBe(`${SEED.market}-${checkpoints[0]?.block}`);
    expect((await p.indexer.Market.getOrThrow(SEED.market)).oracle_id).toBe(SEED.market);
    expect(await p.indexer.ProtocolStats.getOrThrow("10143")).toMatchObject({
      oraclePokes: 3,
      oraclePokesOurs: 2,
      oracleCheckpoints: 2,
    });
    const days = await p.indexer.DailyStats.getAll();
    expect(days.reduce((n, d) => n + d.oraclePokes, 0)).toBe(3);
  });

  it("record each adapter once, by market and side", async () => {
    const p = new Protocol();
    seedTestnetMarket(p);
    afterPeripheryDeploy(p, ALICE);
    p.adapterCreated({ market: SEED.market, side: Side.Yes, adapter: ADAPTER_YES });
    p.s.next({ from: ADDR.keeper });
    p.adapterCreated({ market: SEED.market, side: Side.No, adapter: ADAPTER_NO });
    await p.run();
    expect(await p.indexer.PriceAdapter.getOrThrow(ADAPTER_YES)).toMatchObject({
      factory: ADDR.adapterFactory,
      market_id: SEED.market,
      side: "Yes",
      creator: ALICE,
      creatorIsOurs: false,
    });
    expect(await p.indexer.PriceAdapter.getOrThrow(ADAPTER_NO)).toMatchObject({
      side: "No",
      creatorIsOurs: true,
    });
    expect((await p.indexer.ProtocolStats.getOrThrow("10143")).priceAdapters).toBe(2);
  });
});

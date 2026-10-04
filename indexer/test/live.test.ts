// Opt-in: indexes real Monad testnet blocks through the configured source and checks the result
// against what the seed and trade scripts did onchain. It only reads the chain, and needs the network,
// so it is off by default:
//
//   INDEXER_LIVE_TESTNET=1 pnpm --filter @hunch-book/indexer exec vitest run test/live.test.ts
//
// Without ENVIO_API_TOKEN it reads logs over RPC (100 blocks per request); the public RPC is slow for
// this, so point ENVIO_MONAD_TESTNET_RPC (or MONAD_TESTNET_RPC) at a faster one, or name an env file
// that sets it with INDEXER_ENV_FILE=/path/to/.env.
import { createTestIndexer } from "envio";
import { beforeAll, describe, expect, it } from "vitest";
import { envioEnv } from "../scripts/envio.js";
import { networkOf } from "../src/lib/network.js";
import { ADDR, SEED } from "./helpers.js";

const live = Boolean(process.env.INDEXER_LIVE_TESTNET);
/** Just after the last trade in contracts/script/TradeTestnet.s.sol. */
const END_BLOCK = 67_863_700;

describe.skipIf(!live)("live: Monad testnet", () => {
  beforeAll(() => {
    if (process.env.INDEXER_ENV_FILE) process.loadEnvFile(process.env.INDEXER_ENV_FILE);
    Object.assign(process.env, envioEnv(process.env, "testnet").env);
  });

  it("indexes the seeded market and the router trades from the deploy block", async () => {
    const indexer = createTestIndexer();
    const start = networkOf(10143).deployBlock as number;
    await indexer.process({ chains: { 10143: { startBlock: start, endBlock: END_BLOCK } } });

    const market = await indexer.Market.getOrThrow(SEED.market);
    expect(market).toMatchObject({
      number: 1,
      stage: "Graduated",
      stakerCount: 11,
      poolTotal: 690_000_000n,
      book_id: SEED.book,
      openingPriceE6: 594_202n,
      asset: "MON",
      solvencyMargin: 0n,
    });
    expect(await indexer.Template.getAll()).toHaveLength(2);
    expect((await indexer.Stake.getAll()).every((s) => s.paidByUs)).toBe(true);
    expect(await indexer.DustSweep.getAll()).toEqual([expect.objectContaining({ amount: 5n })]);

    // TradeTestnet.s.sol: one router trade of each kind, each filling our maker's quote once.
    const routerTrades = await indexer.RouterTrade.getAll();
    expect(routerTrades.map((t) => t.kind).sort()).toEqual(["BuyNo", "BuyYes", "SellNo", "SellYes"]);
    const fills = await indexer.Trade.getAll();
    expect(fills).toHaveLength(4);
    expect(fills.every((f) => f.viaRouter && f.isOurMaker && f.trader === ADDR.guardian)).toBe(true);
    expect(fills.map((f) => [f.takerBuysYes, f.priceE6, f.size])).toEqual([
      [true, 416_000n, 12_019_230n],
      [false, 385_000n, 12_019_230n],
      [false, 385_000n, 5_000_000n],
      [true, 416_000n, 5_000_000n],
    ]);

    const stats = await indexer.ProtocolStats.getOrThrow("10143");
    expect(stats).toMatchObject({
      marketsCreated: 1,
      marketsGraduatedTotal: 1,
      externalWallets: 0, // every wallet so far is ours: the deployer, the seed stakers, the maker
      fillCount: 4,
      ourMakerShareBps: 10_000,
      fillCountBetweenOthers: 0,
      routerTradeCount: 4,
      flashLoanCount: 2,
      solvencyMargin: 0n,
    });
    expect(stats.vaultUsdcBalance).toBe(stats.vaultObligations);
  }, 1_800_000);
});

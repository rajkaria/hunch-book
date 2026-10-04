// Every handler is guarded by the id of the record it writes. If the store already holds the result of
// a log (a log delivered again), handling it again changes nothing.
import { createTestIndexer, type TestIndexer } from "envio";
import { describe, expect, it } from "vitest";
import {
  ADDR,
  ALICE,
  BOB,
  deliver,
  E18,
  json,
  Outcome,
  Protocol,
  SEED,
  Side,
  seedTestnetMarket,
  USDC,
} from "./helpers.js";

const ENTITIES = [
  "Template",
  "Market",
  "OutcomeToken",
  "Wallet",
  "Stake",
  "Staker",
  "Graduation",
  "TokenClaim",
  "DustSweep",
  "Book",
  "Trade",
  "RouterTrade",
  "BookOrder",
  "Position",
  "Settlement",
  "Redemption",
  "PoolPayout",
  "SetFlow",
  "VaultEvent",
  "TokenTransfer",
  "Creator",
  "ProtocolStats",
  "DailyStats",
  "WalletDay",
] as const;

type Store = Record<(typeof ENTITIES)[number], { getAll(): Promise<unknown[]>; set(row: unknown): void }>;

async function everything(indexer: TestIndexer): Promise<Record<string, unknown[]>> {
  const store = indexer as unknown as Store;
  const out: Record<string, unknown[]> = {};
  for (const name of ENTITIES) out[name] = await store[name].getAll();
  return out;
}

/** Indexes `build`'s logs once, then hands the same logs to a second indexer that already holds the result. */
async function deliveredTwice(build: (p: Protocol) => void) {
  const first = new Protocol();
  build(first);
  const logs = first.s.pending();
  await first.run();
  const after = await everything(first.indexer);

  const second = createTestIndexer();
  const store = second as unknown as Store;
  for (const name of ENTITIES) for (const row of after[name] ?? []) store[name].set(row);
  await deliver(second, logs);
  return { once: json(after), twice: json(await everything(second)) };
}

describe("idempotent handlers", () => {
  it("market creation, stakes and deposits", async () => {
    const { once, twice } = await deliveredTwice((p) => {
      p.addTemplates();
      p.s.next({ from: ALICE });
      p.createMarket({ market: SEED.market, yes: SEED.yes, no: SEED.no, creator: ALICE });
      p.s.next({ from: BOB });
      p.stake({ market: SEED.market, user: BOB, side: Side.No, amount: USDC(10) });
      p.s.next({ from: ADDR.keeper });
      p.stake({ market: SEED.market, user: ALICE, side: Side.Yes, amount: USDC(5), relayed: true });
    });
    expect(twice).toEqual(once);
  });

  it("graduation, claims, orders, fills, router trades, sets, settlement and redemption", async () => {
    const { once, twice } = await deliveredTwice((p) => {
      seedTestnetMarket(p);
      p.s.next({ from: ADDR.maker });
      p.orderCreated({
        book: SEED.book,
        orderId: 1n,
        owner: ADDR.maker,
        size: USDC(20),
        priceE6: 385_000n,
        isBuy: true,
      });
      p.orderCreated({
        book: SEED.book,
        orderId: 2n,
        owner: ADDR.maker,
        size: USDC(20),
        priceE6: 416_000n,
        isBuy: false,
      });
      p.s.next({ from: ALICE });
      p.fill({
        book: SEED.book,
        orderId: 1n,
        maker: ADDR.maker,
        taker: ALICE,
        takerBuysYes: false,
        price: E18(0.385),
        size: USDC(5),
        remaining: USDC(15),
      });
      p.s.next({ from: BOB });
      p.routerYes({
        market: SEED.market,
        book: SEED.book,
        user: BOB,
        buy: true,
        orderId: 2n,
        maker: ADDR.maker,
        price: E18(0.416),
        size: USDC(5),
        remaining: USDC(15),
      });
      p.s.next({ from: BOB });
      p.mintSets({ market: SEED.market, payer: BOB, to: BOB, amount: USDC(3) });
      p.s.next({ from: BOB });
      p.mergeSets({ market: SEED.market, holder: BOB, to: BOB, amount: USDC(1) });
      p.s.next({ from: ADDR.maker });
      p.s.emit("KuruOrderBook", "OrdersCanceled", { orderId: [1n, 2n], owner: ADDR.maker }, SEED.book);
      p.s.next({ from: BOB });
      p.flashLoan({ receiver: ADDR.router, amount: USDC(2) });
      p.s.next({ blocks: 500_000, seconds: 200_000, from: ADDR.keeper });
      p.settleGraduated({ market: SEED.market, outcome: Outcome.No });
      p.s.next({ from: SEED.stakers[9] });
      p.redeem({
        market: SEED.market,
        holder: SEED.stakers[9] as string,
        side: Side.No,
        amount: 172_500_000n,
        paid: 171_092_754n,
        fee: 1_407_246n,
        creator: ADDR.guardian,
      });
    });
    expect(twice).toEqual(once);
    // And the first pass did count things, so the comparison is not between two empty stores.
    const stats = (once as Record<string, { fillCount: number; routerTradeCount: number }[]>)
      .ProtocolStats?.[0];
    expect(stats).toMatchObject({ fillCount: 2, routerTradeCount: 1 });
  });
});

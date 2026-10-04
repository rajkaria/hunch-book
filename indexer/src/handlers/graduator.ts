// Graduator: each market's Kuru YES/USDC book. Kuru's events carry no indexed fields, so the indexer
// reads Kuru only from the books registered here (kuru.ts).
import { type Enum, indexer } from "envio";
import { addr } from "../lib/network.js";
import { Unit } from "../lib/store.js";

async function recordBook(
  u: Unit,
  marketId: string,
  bookId: string,
  source: Enum<"BookSource">,
  registrar: string | undefined,
): Promise<void> {
  const book = addr(bookId);
  if (await u.exists("Book", book)) return;
  const market = await u.market(marketId);
  if (market && market.book_id === undefined) market.book_id = book;
  u.create("Book", {
    id: book,
    market_id: addr(marketId),
    source,
    registrar: registrar ? addr(registrar) : undefined,
    fillCount: 0,
    fillCountOurMaker: 0,
    volume: 0n,
    volumeOurMaker: 0n,
    lastPriceE6: undefined,
    orderCount: 0,
    orderCountOurMaker: 0,
    block: u.m.block,
    timestamp: u.m.timestamp,
    tx: u.m.tx,
  });
  u.flush();
}

indexer.contractRegister({ contract: "Graduator", event: "BookCreated" }, async ({ event, context }) => {
  context.chain.KuruOrderBook.add(event.params.book);
});

indexer.contractRegister({ contract: "Graduator", event: "BookRegistered" }, async ({ event, context }) => {
  context.chain.KuruOrderBook.add(event.params.book);
});

indexer.onEvent({ contract: "Graduator", event: "BookCreated" }, async ({ event, context }) => {
  await recordBook(new Unit(context, event), event.params.market, event.params.book, "Created", undefined);
});

indexer.onEvent({ contract: "Graduator", event: "BookRegistered" }, async ({ event, context }) => {
  const { market, book, registrar } = event.params;
  await recordBook(new Unit(context, event), market, book, "Registered", registrar);
});

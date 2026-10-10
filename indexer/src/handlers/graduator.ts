// Graduator: each market's YES/USDC book. Book events carry no indexed fields, so the indexer reads books
// only from those registered here (kuru.ts): a Kuru v1 book as KuruOrderBook, a book of a Kuru v2 stack's
// graduator as KuruSpotBook. A Hunch venue's graduator creates its books on Hunch Book's own order book,
// which speaks Kuru v1's events, so they are KuruOrderBooks too, with venue Hunch. Nothing is read from
// Kuru's own contracts for such a stack.
import { type Enum, indexer } from "envio";
import { addr, booksOf } from "../lib/network.js";
import { emptyBook, Unit } from "../lib/store.js";

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
  const { kuruVersion, venue } = booksOf(u.m.chainId, u.m.src);
  u.create("Book", emptyBook(book, marketId, { source, registrar, kuruVersion, venue }, u.m));
  u.flush();
}

indexer.contractRegister({ contract: "Graduator", event: "BookCreated" }, async ({ event, context }) => {
  if (booksOf(event.chainId, event.srcAddress).kuruVersion === 2)
    context.chain.KuruSpotBook.add(event.params.book);
  else context.chain.KuruOrderBook.add(event.params.book);
});

indexer.contractRegister({ contract: "Graduator", event: "BookRegistered" }, async ({ event, context }) => {
  if (booksOf(event.chainId, event.srcAddress).kuruVersion === 2)
    context.chain.KuruSpotBook.add(event.params.book);
  else context.chain.KuruOrderBook.add(event.params.book);
});

indexer.onEvent({ contract: "Graduator", event: "BookCreated" }, async ({ event, context }) => {
  await recordBook(new Unit(context, event), event.params.market, event.params.book, "Created", undefined);
});

indexer.onEvent({ contract: "Graduator", event: "BookRegistered" }, async ({ event, context }) => {
  const { market, book, registrar } = event.params;
  await recordBook(new Unit(context, event), market, book, "Registered", registrar);
});

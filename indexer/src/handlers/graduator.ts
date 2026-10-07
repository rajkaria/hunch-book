// Graduator: each market's Kuru YES/USDC book. Kuru's events carry no indexed fields, so the indexer
// reads Kuru only from the books registered here (kuru.ts): a Kuru v1 book as KuruOrderBook, a book of
// a Kuru v2 stack's graduator as KuruSpotBook.
import { type Enum, indexer } from "envio";
import { addr, stackOfContract } from "../lib/network.js";
import { emptyBook, Unit } from "../lib/store.js";

/** The Kuru version of the books a graduator registers: its stack's (1 for an unknown graduator). */
function kuruVersionOf(chainId: number, graduator: string): number {
  return stackOfContract(chainId, graduator)?.kuruVersion ?? 1;
}

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
  const kuruVersion = kuruVersionOf(u.m.chainId, u.m.src);
  u.create("Book", emptyBook(book, marketId, { source, registrar, kuruVersion }, u.m));
  u.flush();
}

indexer.contractRegister({ contract: "Graduator", event: "BookCreated" }, async ({ event, context }) => {
  if (kuruVersionOf(event.chainId, event.srcAddress) === 2) context.chain.KuruSpotBook.add(event.params.book);
  else context.chain.KuruOrderBook.add(event.params.book);
});

indexer.contractRegister({ contract: "Graduator", event: "BookRegistered" }, async ({ event, context }) => {
  if (kuruVersionOf(event.chainId, event.srcAddress) === 2) context.chain.KuruSpotBook.add(event.params.book);
  else context.chain.KuruOrderBook.add(event.params.book);
});

indexer.onEvent({ contract: "Graduator", event: "BookCreated" }, async ({ event, context }) => {
  await recordBook(new Unit(context, event), event.params.market, event.params.book, "Created", undefined);
});

indexer.onEvent({ contract: "Graduator", event: "BookRegistered" }, async ({ event, context }) => {
  const { market, book, registrar } = event.params;
  await recordBook(new Unit(context, event), market, book, "Registered", registrar);
});

import {
  createHunchClient,
  formatBps,
  formatPriceE6,
  formatUsdc,
  levelsE6,
  type Network,
  parseUsdc,
} from "@hunch-book/sdk";

// The smallest useful Hunch Book script: list the markets, then read the first trading market's book
// and quote 5 USDC of YES. Read-only: no wallet, no key.

const network = (process.env.NETWORK ?? "monad-testnet") as Network;
const hunch = createHunchClient({ network, rpcUrl: process.env.RPC_URL });

const { total, markets } = await hunch.markets.list({ limit: 20 });
console.log(`${total} market(s) on ${network}\n`);
for (const m of markets) {
  console.log(
    `#${m.id}  ${m.phaseLabel.padEnd(11)} ${(formatBps(m.chance.bps) ?? "n/a").padStart(7)} YES  pool ${formatUsdc(m.pool.total)} USDC`,
  );
  console.log(`     ${m.rule ?? m.template}`);
  console.log(`     ${hunch.explorer.address(m.address)}\n`);
}

const trading = markets.find((m) => m.phaseName === "trading");
if (trading) {
  const book = await hunch.markets.book(trading);
  console.log(
    `Book of #${trading.id}: mid ${formatPriceE6(book.midE6)}, spread ${formatPriceE6(book.spreadE6)}`,
  );
  const asks = levelsE6(book.asks, book.params).slice(0, 3).reverse();
  const bids = levelsE6(book.bids, book.params).slice(0, 3);
  for (const level of asks)
    console.log(`  ask ${formatPriceE6(level.priceE6)}  ${formatUsdc(level.size)} YES`);
  for (const level of bids)
    console.log(`  bid ${formatPriceE6(level.priceE6)}  ${formatUsdc(level.size)} YES`);
  const quote = await hunch.quotes.buyYes(trading, parseUsdc("5"));
  console.log(
    quote.shortfall
      ? `5 USDC of YES cannot fill: ${quote.shortfall}`
      : `5 USDC buys ${formatUsdc(quote.tokens)} YES at an average ${formatPriceE6(quote.avgPriceE6)}, ${quote.impactBps} bps from the mid`,
  );
}

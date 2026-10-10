# Hunch Book maker bot

Status: **building**. On Monad testnet the bot has placed a live two-sided quote on a graduated market
([batchUpdate](https://testnet.monadscan.com/tx/0xc484a70a81232b5b4e61ad8fe201e308638278bd25c204f008d3be5c4f909757)).
It is not yet running continuously. On a network where `deployments/<network>.json` does not list
`hunchBook.factory`, the bot starts, logs that there is nothing to quote, and waits.

## What it does

Hunch Book markets start as USDC pools. When a pool graduates, its YES token opens on a Kuru order book
(YES/USDC). NO trades through the same book: Hunch's router mints or merges complete sets around each
trade. This bot quotes that YES/USDC book for every graduated market, so a trader always finds a price
on both sides.

For each graduated market it:

1. **Prices the question** from onchain data (see [Fair value](#fair-value)).
2. **Builds quotes**: fair value plus and minus a half-spread, shifted against the inventory it holds,
   rounded to Kuru's 0.001 tick (bids down, asks up), kept inside 0.01 to 0.99, never narrower than
   2 cents in total, and wider as close approaches. It only posts: a quote that would cross someone
   else's order is moved one tick behind it.
3. **Sizes them** by a per-market inventory cap and by what it can fund.
4. **Funds them**. Asks need YES. The bot gets YES by minting complete sets on Hunch Book's vault
   (1 USDC in, 1 YES and 1 NO out). It offers the YES and holds the NO. When it has spare YES and NO
   it merges them back into USDC. Bids need USDC in Kuru's margin account. Limit orders on Kuru always
   draw from and settle into that margin account, so the bot deposits only what a requote is short of
   and withdraws fill proceeds it does not need.
5. **Places them** with one Kuru `batchUpdate` per requote: cancel its own resting orders, then place
   the new ones, in one transaction.
6. **Requotes** only when it has nothing resting, after a fill, when fair value or its best price moves
   by the requote threshold, or at most once per heartbeat for smaller changes.
7. **Leaves** the market before close: it cancels everything, withdraws its margin balances and merges
   its sets. It does the same as soon as the answer is already fixed (for example, no Perpl funding event
   is left in the window), because a resting quote could then only be picked off. After settlement it
   redeems winning tokens; after a void it redeems both sides at 0.50.

It never deposits into the AMM vault Kuru creates next to each book. That vault's curve has no 1 USDC
cap, which does not fit a token that ends at 0 or 1.

### On Hunch Book's own order book

A stack with a `venue` of kind `hunch` (testnet: `hunch`, where new markets go) trades on Hunch Book's own
onchain order book ([docs/PROTOCOL.md §8.1](../../docs/PROTOCOL.md#81-kuru)). Its books speak Kuru v1's
interface, so the v1 bot quotes them unchanged, on that stack's view of the deployments file: its margin
account is the stack's own HunchMarginAccount, not Kuru's. What differs there:

- The book takes orders only while its market is in phase Graduated. `marketState()` reads 1 (cancels
  only) before graduation and from close on; the bot then cancels and reports `book-cancels-only`.
  Cancels and margin withdrawals always work.
- No trading fees and no AMM vault.
- Every limit order is post-only. The bot never prices a quote through the outside book it read; if the
  book moves between that read and the batch, the simulation reverts `PostOnlyError`, nothing goes out
  (the batch's cancels included), the bot logs `quote-crossed`, re-reads its own orders from the book and
  requotes next cycle. The same holds on Kuru, whose post-only orders refuse a cross the same way.

Health snapshots and, with several stacks, every log line name the `venue` (`hunch` or `kuru`).
`cancel-all --book` hands each book to the bot whose margin account lists it.

### On Kuru v2 books

A deployments file can hold several stacks; the bot runs one quoter per stack in the same process, one
after another, each on its stack's Kuru version ([docs/PROTOCOL.md §8.1](../../docs/PROTOCOL.md#81-kuru)).
On a Kuru v2 stack (`kuruVersion: 2`) the same decisions run through [`src/v2.ts`](./src/v2.ts):

- Balances live in Kuru's AccountCore under the bot's account id. The bot's first deposit (to its own
  address as owner) opens the account; it deposits only what a requote is short of and withdraws what it
  does not need, as on v1.
- Orders rest in up to 62 slots per book. Each requote is one `batch` call that cancels every occupied
  slot and places the new quotes, good-till-cancelled and post-only. The bot reads which slots are
  occupied, and what Kuru reserves behind them, from the chain each pass: less reserved than last pass
  means a fill.
- Kuru v2 limits each order by notional (minimum and maximum quote), not size, so a level whose notional
  is under the minimum is dropped.
- Leaving a market is `cancelAllOrders`, then withdrawing the account's YES and USDC. Kuru's soft pause
  at close still allows both.
- Paper mode simulates Kuru v1 books only; on a v2 stack it skips markets and says why.

### The bot is labelled

The bot trades from one published address: `wallets.maker` in
[`deployments/monad-testnet.json`](../../deployments/monad-testnet.json) and
[`deployments/monad-mainnet.json`](../../deployments/monad-mainnet.json). Every fill against that address
is counted separately on the proof page, so the bot's own volume is never mixed in with other traders'.
If the bot runs from any other address it logs a warning, because its fills would not be labelled.

## Fair value

Both models are pure functions in [`src/pricing/`](./src/pricing). Their tests run on data recorded from
Monad mainnet (see [Tests](#tests)).

**Perpl funding threshold (template 1).** "Will longs pay more than X in funding on Perpl perp P between
block A and block B?" The bot reads Perpl's `getFundingSumAtBlock` at the funding grid blocks (one event
every 8,571 blocks). The forecast is: funding already paid in the window, plus the most recent
interval's funding times the events left. The uncertainty is measured, not assumed: for every start
point in the perp's own history, the bot compares the same forecast with what was actually paid over the
same horizon. The probability of YES is the share of those historical forecast errors that would put the
total above X (equal is NO). The bot needs at least the window's length plus 300 intervals of history.

**Price at a time (template 2).** "Will ASSET/USD be at or above K at time T?" The bot treats the price as
lognormal with no drift. Its volatility is the realised volatility of the Chainlink feed's own last 300
rounds, read with `getRoundData`, so no API key is needed. It does not quote a feed that has not updated
for an hour, and never uses a volatility below 5% a year.

**Touch, funding spike, range and parlay (templates 3 to 6).** The chance a driftless lognormal price
reaches the strike within the window (corrected for a feed that writes rounds, not a path); the share of
past stretches of Perpl funding events with one increment above the threshold; the difference of two
lognormal tails; and the product of the legs' chances, flagged as assuming independent legs. Template 7
(snapshot) has no model and is not quoted. [docs/MAKER-KIT.md](../../docs/MAKER-KIT.md#pricing-models)
describes each model and its assumptions.

## Maker kit and paper mode

Anyone can run this bot with their own key and capital: [docs/MAKER-KIT.md](../../docs/MAKER-KIT.md)
covers setup, risk limits, every setting, the models, how fills are counted and how maker rewards are
planned to be scored. [`.env.example`](./.env.example) lists every setting.

`MAKER_MODE=paper` quotes exactly as live mode would, with the orders resting only in memory, and fills
them against the book's real Kuru `Trade` events: a paper quote fills only when a real trade printed
strictly through its price, so no queue priority is assumed. It keeps a paper account (USDC, YES and NO
per market, minting, merging, redemption after settlement) and logs `paper-fill` and `paper-pnl`; the
health snapshot shows the account. It never sends a transaction and needs no key.

```sh
MAKER_MODE=paper pnpm --filter @hunch-book/maker start
```

## Run it

Node 22 and pnpm. From the repository root:

```sh
pnpm install

# Dry run (the default): reads everything, prints the quotes it would place, sends nothing.
pnpm --filter @hunch-book/maker once      # one pass, then exit
pnpm --filter @hunch-book/maker start     # keep running

# Live, once the dry run looks right.
MAKER_ENABLED=1 pnpm --filter @hunch-book/maker start

# Cancel every order of ours on every Hunch book and withdraw the margin balances.
MAKER_ENABLED=1 pnpm --filter @hunch-book/maker cancel-all
# Also any other Kuru book:
MAKER_ENABLED=1 pnpm --filter @hunch-book/maker cancel-all --book 0x...
```

The bot reads its settings from the environment. For local runs it also loads the repository's `.env`
file (or the file named by `MAKER_ENV_FILE` or `--env-file <path>`), taking only `MAKER_*` and `MONAD_*`
variables and never overriding one that is already set. It never prints a key.

To stop it, press Ctrl-C (or send SIGTERM). It cancels every order and withdraws its margin balances
before it exits. A second Ctrl-C exits at once.

`cancel-all` finds the bot's orders by walking the book itself, so it works even after a crash with no
local state.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `MAKER_MODE` | `live` | `live` or `paper` (simulated fills against real trades; never sends, needs no key). |
| `MAKER_PAPER_USDC` | `1000` | Paper mode's starting USDC. |
| `MAKER_PRIVATE_KEY` | none | The bot's key. Needed only when `MAKER_ENABLED` is on. |
| `MAKER_NETWORK` | `monad-testnet` | `monad-testnet` or `monad-mainnet`. Picks `deployments/<network>.json`. |
| `MAKER_ENABLED` | off | Kill switch. Only `1`, `true`, `yes` or `on` turns sending on. Off: dry run. |
| `MAKER_RPC_URL` | network default | RPC override. Otherwise `MONAD_TESTNET_RPC` or `MONAD_MAINNET_RPC`, then the deployments file. |
| `MAKER_RPC_RPS` | `10` | Requests per second the bot allows itself. Monad's public testnet RPC refuses more than 15. |
| `MAKER_INVENTORY_CAP` | `100` | The most net YES (or net NO) the bot holds in one market, in tokens. |
| `MAKER_ORDER_SIZE` | `20` | Tokens per price level. |
| `MAKER_LEVELS` | `1` | Price levels per side (1 to 5). |
| `MAKER_LEVEL_STEP` | `0.01` | Distance between levels, in USDC. |
| `MAKER_HALF_SPREAD` | `0.015` | Half the spread around the reservation price, before widening. The total spread is never under 0.02. |
| `MAKER_SKEW` | `0.02` | How far quotes move when inventory sits at the cap, in USDC. |
| `MAKER_REQUOTE_THRESHOLD` | `0.005` | Fair value or best-price move that triggers a requote, in USDC. |
| `MAKER_HEARTBEAT_SECONDS` | `300` | Smaller changes wait at most this long. |
| `MAKER_POLL_SECONDS` | `10` | Time between passes over all markets. |
| `MAKER_CLOSE_BUFFER_SECONDS` | `120` | Leave a market this long before its close. |
| `MAKER_WIDEN_SECONDS` | `3600` | Start widening this long before close. |
| `MAKER_WIDEN_MAX` | `3` | Spread multiplier at close. |
| `MAKER_MAX_GAS_PRICE_GWEI` | `200` | Never send while the base fee is above this, and never bid above it. |
| `MAKER_MAX_GAS_PER_TX` | `3000000` | Upper bound on any transaction's gas limit. |
| `MAKER_DUST` | `1` | Tokens. The USDC float kept in the margin account, and the smallest withdraw or merge worth a transaction. |
| `MAKER_MARKETS` | all | Comma-separated market addresses to quote; all graduated markets when unset. |
| `MAKER_TEMPLATES` | all priced | Comma-separated template ids to quote; every template with a model (1 to 6) when unset. |
| `MAKER_STACKS` | all | Comma-separated stacks to quote on (`primary`, or names under `stacks`, such as `kuruV2` or `hunch`); every deployed stack when unset. |
| `MAKER_HEALTH_FILE` | `services/maker/health.json` | Where the health snapshot is written after every pass. |
| `MAKER_HEALTH_PORT` | none | When set, the snapshot is also served at `GET http://localhost:<port>/health`. |
| `MAKER_ENV_FILE` | repository `.env` | The `.env` file to load. |

## Logs and health

Every action is one JSON line on stdout. Each transaction line carries its hash and an explorer link
built from `deployments/<network>.json`:

```json
{"ts":"…","level":"info","event":"tx","action":"batchUpdate","market":"0x…","book":"0x…","reason":"fair-moved","status":"success","hash":"0x…","url":"https://testnet.monadscan.com/tx/0x…","gasLimit":"…","gasUsed":"…"}
```

Other events: `start`, `quote` (fair value, model inputs, the orders it wants and why), `fill`,
`cancel`, `unwound`, `idle`, `dry-run`, `tx-skipped` (simulation failed or gas price too high),
`tx-unknown`, `market-error`, `low-mon`.

The health snapshot reports when the bot last quoted, its open orders, its inventory per market
(wallet and margin balances, net position), its MON balance and the last error.

## Gas

Monad charges for a transaction's gas limit, not the gas it uses. So every transaction is simulated
first (a call that would revert costs nothing), then sent with an explicit limit: the estimate plus 10%,
never above `MAKER_MAX_GAS_PER_TX`.

Charged on Monad testnet for the bot's first quote on a graduated market (one level a side, 20 YES each),
at about 102 gwei:

| Transaction | Gas charged |
|---|---|
| `batchUpdate`: place 1 bid + 1 ask | 602,076 |
| `mintSets` (20 sets on the vault) | 283,142 |
| margin deposit (YES, then USDC) | 170,086 and 158,810 |
| approvals (vault, margin account) | 57,449 to 69,039 each, once |

That first quote, approvals and minting included, cost about 0.15 MON. Later requotes are one
`batchUpdate` each (cancel 2, place 2), roughly 0.07 MON at one level a side. Measured on a fork of Monad testnet with two
levels a side (gas used, which a fork does not round up to the limit):

| Transaction | Gas used |
|---|---|
| place 2 bids + 2 asks | 766,868 |
| cancel 4 + place 2 bids + 2 asks (a requote) | 939,708 |
| cancel 4 | 364,819 |

## Tests

```sh
pnpm --filter @hunch-book/maker test
```

- **Pricing** runs on data recorded from Monad mainnet: Perpl BTC and MON funding sums, Chainlink BTC,
  ETH and MON rounds, and Kuru's MON-USDC order book (for the L2 decoder). `scripts/capture-fixtures.ts`
  records them into `test/fixtures/`; they are never edited by hand. To refresh them:
  `pnpm --filter @hunch-book/maker capture-fixtures` (`--only <name>` for one). The touch and range
  models run on BTC, ETH, MON and SOL rounds, with the touch formula checked against a Monte Carlo of the
  same price; the spike model on BTC and MON funding, checked against a direct count of the history.
- **Paper fills** replay 60 Kuru MON-USDC trades recorded from Monad mainnet against paper quotes around
  the book as it stood just before them, checked against a trade-by-trade count.
- **Quotes, order tracking and config** are unit tests.
- **Fork tests** start an anvil fork of Monad testnet (Foundry 1.8 or later). One runs the bot's
  execution code against Kuru's real contracts: it creates a book with Kuru's `Router.deployProxy` on mock
  6-decimal tokens, quotes, requotes, takes a fill, unwinds and cancels all. The other runs the whole bot
  loop against stand-ins for Hunch Book's factory, vault and market (same ABI as the frozen interfaces):
  discovery, Perpl pricing from Perpl's real testnet history, minting, quoting, leaving at close, the
  shutdown cancel, and redeeming after settlement. A third runs the v2 maker against Kuru's real v2
  contracts: with Kuru's owner impersonated it sets up a throwaway 6-decimal pair (price sources,
  enabling, whitelisting) and deploys a book with Hunch Book's parameters; the bot opens its account with
  its first deposit, rests quotes in slots, requotes in one batch, sees a taker's swap as a fill, and
  unwinds to an empty account. All skip, rather than fail, when anvil is not installed or the fork cannot
  start.
- **Local chain test** (`test/integration/hunch-venue.test.ts`) starts a fresh anvil chain with Hunch
  Book's real contracts from `contracts/out` (run `forge build` in `contracts/`): the core, the
  HunchOrderBookFactory with its HunchMarginAccount, and the Graduator wired to it. Laid out as on
  testnet (`stacks.hunch`, the default stack), `buildMakers` gives that stack a v1 bot on Hunch Book's
  margin account; it quotes post-only, requotes in one batch, sees a taker's fills, survives a crossing
  quote (`PostOnlyError`, nothing sent, requoted around the outside ask next cycle), cancels when the
  closed market's book takes cancels only, and unwinds. It skips when anvil or `contracts/out` is missing.
- `pnpm --filter @hunch-book/maker smoke:testnet --market 0x… [--test-usdc 100] [--dry-run]` runs one live
  pass of the bot on Monad testnet for one graduated market, from the maker key: it tops the wallet up
  with Hunch Book's test USDC when asked, mints sets, quotes both sides, checks the orders rest on the
  book, and leaves them there. It refuses any other chain.

## Limits

- It polls (every 10 seconds by default). A fill is seen on the next pass, and between passes a resting
  quote can be picked off if the source moves fast.
- The Perpl model assumes the latest interval's funding carries on, and takes its uncertainty from the
  perp's own history. It does not know about Perpl's price administrator's plans or rate clamps.
- Price markets settled by Pyth (assets with no Chainlink feed on Monad, such as SOL) are not quoted:
  historical Pyth updates need an API key. Snapshot markets (template 7) have no model and are not quoted.
- The parlay model multiplies the legs' chances, so it is wrong for legs that move together (two
  questions on one asset). The quote's detail says so.
- Paper mode cannot know how others would have reacted to its quotes, and counts no fill at a price equal
  to a real trade's, so on a quiet book it may show no fills.
- The inventory cap is per market. USDC in Kuru's margin account (v2: its AccountCore account) is shared by
  every book the bot quotes.
- Before close the bot cancels its own orders, but Kuru's book is not Hunch Book's to halt. Orders other
  people leave on the book can still fill after close. A Hunch order book stops matching at close by
  itself (it reads the market's clock).
- After settlement it redeems only what its wallet holds. Tokens it left in Kuru's margin account are
  withdrawn when it leaves the market or on `cancel-all`.
- On testnet the collateral is Hunch Book's own mintable test USDC.

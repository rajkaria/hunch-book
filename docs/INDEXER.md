# Hunch Book indexer

Status: **building**. The indexer in [`indexer/`](../indexer) is an [Envio HyperIndex](https://docs.envio.dev)
3.x project. Its handlers are tested on simulated logs that match what the contracts emit, and an opt-in
test indexes real Monad testnet blocks. It is not deployed to a hosted endpoint yet. The app reads it as
soon as the build names an endpoint (below); until then every page that can use it reads the chain.

It turns Hunch Book's onchain events into a GraphQL API: markets, stakes, graduations, fills on our
Kuru books, positions, settlements, redemptions, and the totals behind the proof page
([PROTOCOL.md section 9.3](./PROTOCOL.md#93-indexer-envio-hyperindex),
[ROADMAP.md, How we measure progress](./ROADMAP.md#how-we-measure-progress)).

## What it reads

| Contract | How the indexer finds it | Events |
|---|---|---|
| `HunchBookFactory` | address in `deployments/<network>.json` | `MarketCreated`, `TemplateAdded` |
| `CollateralVault` | address in the deployments file | `MarketRegistered`, `PoolDeposited`, `PoolGraduated`, `PoolPaid`, `SetsMinted`, `SetsMerged`, `Finalized`, `MarketVoided`, `Redeemed`, `FeesAccrued`, `ProtocolFeesWithdrawn`, `CreatorFeesWithdrawn`, `FlashLoan` |
| `HunchRouter` | address in the deployments file | `Trade` |
| `Graduator` | address in the deployments file | `BookCreated`, `BookRegistered` |
| Collateral token (test USDC on testnet, Circle USDC on mainnet) | address in the deployments file; only transfers into or out of the vault | `Transfer` |
| `Market` (one clone per question) | registered from the vault's `MarketRegistered` and the factory's `MarketCreated` | `Staked`, `Graduated`, `TokensClaimed`, `Settled`, `Voided`, `PoolClaimed`, `DustSwept` |
| `OutcomeToken` (YES and NO) | registered from the vault's `MarketRegistered` | `Transfer` |
| Kuru order book (one per graduated market) | registered from the Graduator's `BookCreated` and `BookRegistered` | `Trade`, `OrderCreated`, `OrderCanceled`, `OrdersCanceled` |

Kuru's events have no indexed fields, so the indexer cannot filter them by topic. It reads them only
from the book addresses the Graduator registered, never from other Kuru markets.

Indexing starts at `hunchBook.deployBlock` (67,856,277 on testnet). The vault registers a market before
the creator's first stake in the same transaction, so a market, its two tokens and the first stake are
all indexed from the creation block.

## Where the addresses come from

`deployments/<network>.json` is the only source of addresses (CLAUDE.md, Rule 3). The indexer does not
copy them by hand: [`indexer/scripts/gen-config.ts`](../indexer/scripts/gen-config.ts) writes

- `indexer/config.yaml`: the Envio config for Monad testnet (chain 10143),
- `indexer/config.mainnet.yaml`: the same for Monad mainnet (chain 143), only once
  `deployments/monad-mainnet.json` has the factory, vault, router, graduator and deploy block,
- `indexer/src/networks.generated.json`: what the handlers need per chain (our wallets, our contracts,
  Perpl perp names, price feed names), in lowercase.

Event signatures in the config come from the ABIs that `scripts/gen-abis.mjs` generates from the
contracts (and Kuru's from `packages/shared/src/kuru/abis.ts`), so the config cannot drift from the
contracts either. The test suite runs the generator in check mode: a stale file fails `pnpm test`.

After a deployment changes `deployments/`, regenerate and commit:

```bash
pnpm --filter @hunch-book/indexer gen-config        # write the files
pnpm --filter @hunch-book/indexer gen-config:check  # or just check them
```

The handlers import nothing from outside `indexer/` at runtime, as Envio Cloud asks of monorepos.

## Entities

Conventions:

- Contract and wallet ids are lowercase addresses. Per-event records use `<block>-<logIndex>`.
- USDC and outcome-token amounts are base units (6 decimals) stored as `BigInt`: 1 USDC is `1000000`.
  Fields ending in `E6` are USDC base units per whole token (0.416 USDC is `416000`).
- Timestamps are unix seconds. GraphQL returns `BigInt` fields as strings.

| Entity | One row per | What it holds |
|---|---|---|
| `Market` | market | template, parameters and a one-sentence question, window, stage, pool totals and implied chance, stakers, book, YES and NO tokens, creator, graduation, fills and volume, outcome, evidence hash, settler, settlement transaction, redemptions, and the market's vault ledger with its solvency margin |
| `Template` | template id | resolver and graduation rule |
| `Stake` | `Staked` event | side, amount, totals after, who paid (the staker, a third party, or the staker through a relayer) |
| `Staker` | wallet and market | stake per side, token claims, pool claim |
| `Wallet` | address | our role, whether it staked or traded, first and last activity, counts and volumes |
| `Graduation` | market | totals, opening price, book, staker count, caller |
| `TokenClaim` | `TokensClaimed` event | side, amount, who pushed the claim |
| `DustSweep` | `DustSwept` event | rounding dust of tokens sent to the fee recipient |
| `Book` | Kuru book | market, created or registered, fills, volume, last price, orders |
| `Trade` | Kuru fill on our books | price, size, USDC notional, side, maker, taker, trader, our-maker flag, block, transaction |
| `RouterTrade` | router `Trade` event | kind (buy or sell, YES or NO), amounts in and out, average price, user |
| `BookOrder` | Kuru limit order on our books | owner, side, price, size, size left, open, filled or cancelled |
| `Position` | wallet and market | YES and NO balances from transfers, stakes, claims, pool payouts, redemptions, sets minted and merged, USDC spent and received |
| `Settlement` | market | outcome or void, evidence hash, settler, latency |
| `Redemption` | `Redeemed` event | side, tokens burned, USDC paid, fee, seconds after settlement |
| `PoolPayout` | pool payout | winnings, refund, or dust moved to the fee balances |
| `SetFlow` | mint or merge | account, recipient, amount, whether it was the router |
| `VaultEvent` | vault event or vault USDC transfer | every ledger movement, kept as a log |
| `TokenTransfer` | YES or NO transfer | from, to, amount |
| `Creator` | market creator | markets, fees accrued, withdrawn and owed |
| `ProtocolStats` | chain (id `10143` or `143`) | the proof page totals (below) |
| `DailyStats` | UTC day (id `<chainId>-<YYYY-MM-DD>`) | the same activity per day, with distinct active wallets |

Every handler is idempotent: it first checks for the record that carries the event's id, so a log that
was already handled changes nothing. Stats are consistent at block boundaries; inside one transaction
the order of events can leave a total briefly out of step until the transaction's last event.

## Run it locally

Envio's dev mode runs Postgres and Hasura in Docker, so it needs Docker.

```bash
pnpm install
pnpm --filter @hunch-book/indexer dev            # Monad testnet, config.yaml
pnpm --filter @hunch-book/indexer dev:mainnet    # Monad mainnet, once config.mainnet.yaml exists
pnpm --filter @hunch-book/indexer stop           # stop it and delete the local database
```

The GraphQL endpoint is `http://localhost:8080/v1/graphql` (Hasura's console is on the same port).
`start` and `start:mainnet` run without the dev tooling, against a Postgres you provide
(`ENVIO_PG_HOST`, `ENVIO_PG_PORT`, `ENVIO_PG_USER`, `ENVIO_PG_PASSWORD`, `ENVIO_PG_DATABASE`).

Tests need neither Docker nor the network:

```bash
pnpm --filter @hunch-book/indexer test      # codegen, then every handler through Envio's test indexer
pnpm --filter @hunch-book/indexer typecheck
```

The opt-in live test indexes real testnet blocks from the deploy block through the seed and trade
scripts' transactions, and checks the result against what those scripts did:

```bash
INDEXER_LIVE_TESTNET=1 pnpm --filter @hunch-book/indexer exec vitest run test/live.test.ts
```

## Environment variables

Put them in the shell or in `indexer/.env` (gitignored). Envio only reads variables that start with
`ENVIO_`, on Envio Cloud too.

| Variable | Default | What it does |
|---|---|---|
| `ENVIO_API_TOKEN` | none | Envio API token for HyperSync. With it, HyperSync is the main source and the RPC is a fallback. |
| `ENVIO_RPC_MODE` | `fallback`; the `dev` and `start` scripts set `sync` when there is no token | `sync` reads every log from the RPC (no token needed), `fallback` uses the RPC only when HyperSync stalls, `realtime` uses HyperSync for history and the RPC at the head. |
| `ENVIO_MONAD_TESTNET_RPC` | `https://testnet-rpc.monad.xyz` (the `rpc` in the deployments file) | Testnet RPC |
| `ENVIO_MONAD_MAINNET_RPC` | `https://rpc.monad.xyz` | Mainnet RPC |
| `MONAD_TESTNET_RPC`, `MONAD_MAINNET_RPC` | none | The repo's own names: the `dev` and `start` scripts copy them into the `ENVIO_` names when those are unset. |

Public Monad RPCs answer `eth_getLogs` for at most 100 blocks per request, so the config asks for 100
blocks at a time. Reading logs over RPC is far slower than HyperSync: Envio sends many range queries
at once, RPC providers limit requests per second, and Envio meets the limit with retries and smaller
ranges. In our run of the live test, the 7,423 blocks from the deploy block to the end of the testnet
trade script took 11 to 14 minutes through a private RPC limited to 25 requests a second; the public
RPC mostly timed out. RPC mode suits short ranges and the chain head. A full sync needs HyperSync.

## Deploy on Envio Cloud

Envio Cloud deploys from git, like Vercel. Steps, by name only (no secrets in the repo):

1. Log in to the Envio app with GitHub, choose the organization, and install the Envio Deployments
   GitHub app on this repository.
2. Add an indexer with root directory `indexer` and config file `config.yaml` (testnet). Mainnet gets
   its own indexer with `config.mainnet.yaml` once that file exists.
3. Pick a deployment branch, for example `envio-testnet`.
4. In the indexer's Environment Variables tab, set `ENVIO_API_TOKEN` (from the Envio app's API tokens
   page). Optionally set `ENVIO_MONAD_TESTNET_RPC`.
5. Push the deployment branch. Each push builds a new deployment that re-indexes from the start block;
   the previous one keeps serving queries until the new one has caught up.
6. Copy the deployment's GraphQL endpoint from the dashboard (or `envio-cloud deployment endpoint`)
   into the app's configuration.

Envio Cloud needs `envio` pinned in `package.json` (it is: 3.12.1) and pnpm 10.32 (the repo uses it).

## Point the app at it

The app (`apps/web`) reads the endpoint from its build environment:

| Variable | For |
|---|---|
| `NEXT_PUBLIC_INDEXER_URL` | the Monad testnet indexer (`config.yaml`) |
| `NEXT_PUBLIC_INDEXER_URL_MAINNET` | the Monad mainnet indexer (`config.mainnet.yaml`), once it exists |

Its queries live in [`apps/web/src/lib/indexer/queries.ts`](../apps/web/src/lib/indexer/queries.ts), and a
test checks them against `schema.graphql`. The proof page, the trade tape, the portfolio's profit and
loss and the creator pages use the indexer when it answers within 8 seconds, serves the right chain
(its `_meta` view) and is within 300 blocks of the chain head. Otherwise they read the chain directly
and say so with a "Live from chain" tag; figures the chain alone cannot give say "needs the indexer"
instead of showing an estimate. After a failure the app leaves the indexer alone for 30 seconds.

## Limits

- **Envio Cloud's free development plan** (as its docs state on 2026-10-04): 3 development indexers per
  organization and 3 deployments per indexer. A deployment is deleted after 30 days or above 20 GB.
  Passing 100,000 processed events, 5 GB of storage, or 7 days without a query starts a 7-day grace
  period, then 3 days read-only, then deletion. The maker bot's quotes produce order events on every
  requote, so a busy testnet book reaches 100,000 events quickly: production needs a paid plan or a
  self-hosted indexer (Docker, Postgres and Hasura).
- **Block-clock markets** (Perpl funding): the settlement deadline is not in the parameters, so
  `Market.settleDeadline` is empty for them; read `window()` on the market contract.
- **Kuru fill notional** is size times price, rounded down, before any Kuru fee. Router trades carry
  the exact USDC the user paid or received.
- **Positions** count tokens in wallets. Tokens a maker has resting in Kuru's margin account show up on
  the margin account's position, not on the maker's. The market, vault and router only pass tokens
  through and get no position.
- **The question text** is a summary built from the parameters (Perpl thresholds in raw funding units).
  The resolver's `describe()` is the exact rule.

## Example queries

The app's queries live in [`indexer/queries/`](../indexer/queries). A test checks that each one selects
and filters only fields the schema has.

| File | For |
|---|---|
| `markets.graphql` | the markets list, filtered with `$where` |
| `market-detail.graphql` | one market with its latest fills, stakes, router trades, graduation and settlement |
| `portfolio.graphql` | a wallet's positions, unclaimed stakes and redemptions |
| `proof-stats.graphql` | protocol totals, the last 30 days, and any market with a negative solvency margin |
| `trade-tape.graphql` | the last fills with block numbers and transactions |

For example, the proof page header:

```graphql
query {
  ProtocolStats_by_pk(id: "10143") {
    marketsCreated
    marketsGraduatedTotal
    wallets
    ourWallets
    fillCount
    fillCountOurMaker
    ourMakerShareBps
    volume
    solvencyMargin
  }
}
```

## How the proof page numbers are computed

Every number comes from indexed events (ROADMAP.md, How we measure progress).

| Metric | Field | Rule |
|---|---|---|
| Markets created, graduated, settled, voided | `ProtocolStats.marketsCreated`, `marketsGraduatedTotal`, `marketsSettled`, `marketsVoided` | one per `MarketCreated`, `Graduated`, `Settled`, `Voided`. `marketsPool` and `marketsGraduated` count markets in each stage now. |
| Distinct wallets that staked or traded | `wallets`, with `ourWallets` and `externalWallets` | an address counts once, the first time it stakes, trades through the router, or is either side of a fill on our books. Receiving tokens does not count. |
| Trades and volume | `fillCount`, `volume` | Kuru fills on our books; volume is the fills' USDC notional |
| Fills against our maker | `fillCountOurMaker`, `volumeOurMaker`, `ourMakerShareBps`, `ourMakerVolumeShareBps` | the maker side is `wallets.maker` from the deployments file; shares are in basis points |
| Fills between other parties | `fillCountBetweenOthers`, `volumeBetweenOthers` | neither the maker nor the trader is one of our wallets |
| Window end to settlement | `avgSettlementLatencySeconds` (price markets), `avgSettlementLatencyBlocks` (Perpl markets) | settlement time minus close, in the market's own clock; touch markets settled early are counted in `earlySettlements` and left out of the averages |
| Settlement to redemption | `avgSecondsToFirstRedemption`, `Redemption.secondsAfterSettlement` | first redemption in a market minus its settlement (or void) time |
| Solvency margin per market | `Market.solvencyMargin` | USDC in (stakes, mints) minus USDC out (payouts, merges, redemptions) minus what the market still owes (pool, sets) minus its fees. Zero when every event is accounted for. |
| Solvency margin of the vault | `ProtocolStats.solvencyMargin` | the vault's USDC balance, summed from transfers in and out, minus pools, sets and fees not yet withdrawn. It must never be negative (PROTOCOL.md section 5.1). |

`DailyStats` keeps the same activity per UTC day, with distinct active and new wallets per day.

## How our own activity is labelled

Rule 4 of CLAUDE.md: our own maker bot's and keeper's activity is labelled as ours wherever it is
counted. The indexer labels a wallet as ours when it is

- `wallets.maker` (role `Maker`), `wallets.keeper` (`Keeper`), `hunchBook.guardian` (`Guardian`) or
  `hunchBook.feeRecipient` (`FeeRecipient`) in the deployments file, or
- an address one of those wallets paid a stake for (`Seeded`). On testnet these are the ten stakers
  the seed script derived from the deployer key (`contracts/script/SeedTestnetMarket.s.sol`).

The label is on `Wallet.ourRole` and `Wallet.isOurs`, and it flows into `Stake.paidByUs`,
`Trade.isOurMaker`, `makerIsOurs`, `traderIsOurs` and `betweenOthers`, `RouterTrade.userIsOurs`,
`Graduation.callerIsOurs`, `TokenClaim.pushedByUs`, `Settlement.settlerIsOurs`,
`Market.creatorIsOurs`, `Creator.isOurs`, `BookOrder.isOurMaker`, and the `Ours` and `OurMaker`
totals in `ProtocolStats` and `DailyStats`. The proof page shows each count next to the part that is
ours.

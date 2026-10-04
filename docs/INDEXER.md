# Hunch Book indexer

Status: **building**. The indexer in [`indexer/`](../indexer) is an [Envio HyperIndex](https://docs.envio.dev)
3.x project. Its handlers are tested on simulated logs that match what the contracts emit, and an opt-in
test indexes real Monad testnet blocks. It is not deployed to a hosted endpoint yet. The app reads it as
soon as the build names an endpoint (below); until then every page that can use it reads the chain.

It turns Hunch Book's onchain events into a GraphQL API: markets, stakes, graduations, fills on our
Kuru books, positions, settlements, redemptions, the totals behind the proof page
([PROTOCOL.md section 9.3](./PROTOCOL.md#93-indexer-envio-hyperindex),
[ROADMAP.md, How we measure progress](./ROADMAP.md#how-we-measure-progress)), template 7's snapshots
([TEMPLATES.md, template 7](./TEMPLATES.md#template-7-snapshot)), and everything the periphery contracts
do ([PERIPHERY.md](./PERIPHERY.md)): auto-redeem settings and redemptions, conditional orders, referral
bindings and the credit they earn, reward epochs and claims, oracle pokes, price adapters, and the
timelock queue.

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
| `SnapshotResolver` (template 7) | `hunchBook.resolvers.snapshot` in the deployments file | `SnapshotTaken` |
| `AutoRedeemer` | `hunchBook.periphery.autoRedeemer` | `OptInSet`, `MarketOptOutSet`, `AutoRedeemed`, `RedeemFailed` |
| `ConditionalOrders` | `hunchBook.periphery.conditionalOrders` | `OrderPlaced`, `OrderCancelled`, `OrderExecuted` |
| `ReferralRegistry` | `hunchBook.periphery.referralRegistry` | `Bound` |
| `MerkleDistributor` | `hunchBook.periphery.merkleDistributor` | `EpochCreated`, `Claimed`, `Swept`, `FunderTransferStarted`, `FunderTransferred` |
| `ImpliedProbabilityOracle` | `hunchBook.periphery.impliedProbabilityOracle` | `Poked` |
| `OutcomeTokenPriceAdapterFactory` (named `PriceAdapterFactory` in the config) | `hunchBook.periphery.priceAdapterFactory` | `AdapterCreated` |
| `TemplateTimelock` | `hunchBook.periphery.templateTimelock` | `OperationQueued`, `OperationExecuted`, `OperationCancelled`, `CreationPauseSet`, `GraduationPauseSet`, `GuardianAccepted` |

Kuru's events have no indexed fields, so the indexer cannot filter them by topic. It reads them only
from the book addresses the Graduator registered, never from other Kuru markets.

Indexing starts at `hunchBook.deployBlock` (67,856,277 on testnet), for every contract. The resolver and
the periphery were deployed later (the periphery at block 68,046,179) and have no logs before that, so
reading them from the same block costs a few empty ranges and keeps one start block per chain. The vault
registers a market before the creator's first stake in the same transaction, so a market, its two tokens
and the first stake are all indexed from the creation block.

## Where the addresses come from

`deployments/<network>.json` is the only source of addresses (CLAUDE.md, Rule 3). The indexer does not
copy them by hand: [`indexer/scripts/gen-config.ts`](../indexer/scripts/gen-config.ts) writes

- `indexer/config.yaml`: the Envio config for Monad testnet (chain 10143),
- `indexer/config.mainnet.yaml`: the same for Monad mainnet (chain 143), only once
  `deployments/monad-mainnet.json` has the factory, vault, router, graduator and deploy block,
- `indexer/src/networks.generated.json`: what the handlers need per chain (our wallets, our contracts,
  resolvers and periphery, Perpl perp names, price feed names), in lowercase.

A network's config needs the core (factory, vault, router, graduator, collateral and deploy block). Template
7's resolver and the periphery contracts are listed whether or not that network has them: one it has no
address for is listed without one, so nothing registers it and it is never read there, and the same
handlers serve both networks. When the periphery is deployed on mainnet, regenerating the config picks it up.

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
| `Market` | market | template, parameters decoded for every template (asset, feed, strike or range, perp and threshold, touch direction and window start, parlay legs) and a one-sentence question, window, stage, pool totals and implied chance, stakers, book, YES and NO tokens, creator, graduation, fills and volume, outcome, evidence hash, settler, settlement transaction, redemptions, the market's vault ledger with its solvency margin; for template 7 the snapshot key, source, window and comparator, and a link to the snapshot; conditional order and auto-redeem counts; a link to the oracle's latest poke |
| `Template` | template id | resolver and graduation rule |
| `Stake` | `Staked` event | side, amount, totals after, who paid (the staker, a third party, or the staker through a relayer) |
| `Staker` | wallet and market | stake per side, token claims, pool claim |
| `Wallet` | address | our role, whether it staked or traded, first and last activity, counts and volumes, its latest referral binding |
| `Graduation` | market | totals, opening price, book, staker count, caller |
| `TokenClaim` | `TokensClaimed` event | side, amount, who pushed the claim |
| `DustSweep` | `DustSwept` event | rounding dust of tokens sent to the fee recipient |
| `Book` | Kuru book | market, created or registered, fills, volume, last price, orders |
| `Trade` | Kuru fill on our books | price, size, USDC notional, side, maker, taker, trader, our-maker flag, block, transaction |
| `RouterTrade` | router `Trade` event | kind (buy or sell, YES or NO), amounts in and out, average price, user (an order's owner when ConditionalOrders made the trade, with a link to the order) |
| `BookOrder` | Kuru limit order on our books | owner, side, price, size, size left, open, filled or cancelled |
| `Position` | wallet and market | YES and NO balances from transfers, stakes, claims, pool payouts, redemptions, sets minted and merged, USDC spent and received |
| `Settlement` | market | outcome or void, evidence hash, settler, latency |
| `Redemption` | `Redeemed` event | side, tokens burned, USDC paid, fee, seconds after settlement, the holder, and whether the AutoRedeemer redeemed for them |
| `PoolPayout` | pool payout | winnings, refund, or dust moved to the fee balances |
| `SetFlow` | mint or merge | account, recipient, amount, whether it was the router |
| `VaultEvent` | vault event or vault USDC transfer | every ledger movement, kept as a log |
| `TokenTransfer` | YES or NO transfer | from, to, amount |
| `Creator` | market creator | markets, fees accrued, withdrawn and owed |
| `ProtocolStats` | chain (id `10143` or `143`) | the proof page totals (below), including the periphery's |
| `DailyStats` | UTC day (id `<chainId>-<YYYY-MM-DD>`) | the same activity per day, with distinct active wallets |

Template 7 and the periphery:

| Entity | One row per | What it holds |
|---|---|---|
| `Snapshot` | observation (id `<resolver>-<key>`) | the key, source, close time and window, the value read, the snapshot's block and time, seconds after close, who took it (a market inside `settle()`, or whoever called `snapshot()`), the transaction sender and whether it is ours, and every market that answers from it |
| `AutoRedeemOptIn` | holder | on or off, times turned on, markets excluded now, redemptions made for the holder, USDC paid, failures |
| `AutoRedeemMarketOptOut` | holder and market (id `<market>-<holder>`) | whether that market is excluded now |
| `AutoRedeemSettingChange` | `OptInSet` or `MarketOptOutSet` event | the change, as a log |
| `AutoRedemption` | `AutoRedeemed` event | market, holder, side, tokens, USDC paid, caller and whether it is ours, and the vault's `Redemption` for it |
| `AutoRedeemFailure` | `RedeemFailed` event | market, holder, the revert data, the transaction sender |
| `ConditionalOrder` | order (id: the order id) | owner, market, kind, condition, trigger, expiry, tip, amount and limit; status (open, executed or cancelled); on execution the executor, price, input spent, output received, tip and the router trade; on cancellation the time and transaction |
| `Referral` | `Bound` event | user, referrer, `boundAt`, `expiresAt`, relayer and whether it relayed, and the fees the user paid while this binding was active |
| `Referrer` | referrer | bindings, distinct users, first and last binding, the latest expiry, fees credited and their protocol share |
| `ReferredUser` | referrer and user (id `<referrer>-<user>`) | bindings, first binding, latest expiry, fees credited |
| `ReferralFee` | fee event credited to a referrer | the binding, user, market, kind (redemption or pool claim), fee and protocol share |
| `ReferralCredit` | referrer and UTC day (id `<referrer>-<YYYY-MM-DD>`) | fees credited that day and their protocol share: what the rewards scorer reads |
| `RewardEpoch` | epoch (id: the epoch number) | token, root, total, claim deadline, claimed, claim count, sweep, still owed, funder |
| `RewardClaim` | account and epoch (id `<epoch>-<account>`) | amount, caller, and whether the account and caller are ours |
| `RewardToken` | reward token | epochs, funded, claimed, swept, still owed |
| `RewardDistributor` | distributor | the funder and any pending funder |
| `OracleFeed` | market | the latest chance and spread (E6, 1000000 is 100%), stale flag, pokes (and ours), checkpoints, first and last poke |
| `OracleCheckpoint` | poke that stored a checkpoint (id `<market>-<block>`) | chance, spread and stale flag at that time: the chance history, at most one point per 30 seconds per market |
| `PriceAdapter` | adapter | market, side, factory, creator |
| `TimelockOperation` | queued operation (id: the operation id) | nonce, selector, the call decoded (kind, a one-sentence summary and each argument), the calldata, `readyAt`, `expiresAt` (14 days later), status, proposer, executor, the transactions |
| `TimelockAction` | pause or guardian acceptance | kind, the new pause value, sender |

Every handler is idempotent: it first checks for the record that carries the event's id (or for a
one-way change it already made: an order closed, an epoch swept, an operation ended, a market already
poked in that block), so a log that was already handled changes nothing. Stats are consistent at block
boundaries; inside one transaction the order of events can leave a total briefly out of step until the
transaction's last event.

## How the periphery fits the ledger

The AutoRedeemer and ConditionalOrders hold nothing between transactions: they act for a holder or an
order's owner. The indexer counts what they do for that person, never for the contract.

- **Auto-redeem.** The vault's `Redeemed` names the AutoRedeemer as holder and the real holder as `to`.
  The indexer records the redemption for `to` (its `Redemption`, `Position`, `Wallet`) and marks it
  `viaAutoRedeemer`. The AutoRedeemer's `AutoRedeemed`, a moment later in the same transaction, becomes an
  `AutoRedemption` linked to that `Redemption`. Tokens that pass through the AutoRedeemer give it no
  `Position`.
- **Conditional orders.** An execution trades through the router with ConditionalOrders as the router's
  user. The router's `Trade` is counted in the market and protocol totals at once, but not for the
  contract's wallet. `OrderExecuted`, the transaction's last event, then moves that `RouterTrade` to the
  owner (`user`, `userIsOurs`, `conditionalOrder`), counts the owner as a wallet that traded, and books
  the owner's USDC: what was spent on a buy, what arrived after the tip on a sell. Tokens moving through
  the contract give it no `Position`.
- **Snapshots.** A template 7 market links to its snapshot from its parameters at creation:
  `Market.snapshot` names `<resolver>-<key>`, and resolves once someone takes the snapshot. Every market
  on the same source, close time and window links to the same row.

## Referral credit

The [referral formula](./PERIPHERY.md#the-referral-formula) needs two inputs: who referred each user at
each moment (the `Bound` events) and every fee each user paid (the vault's `Redeemed`, where the user is
`to`, and each market's `PoolClaimed`). The indexer joins them as they arrive:

1. On `Bound`, it records the `Referral` and points the user's `Wallet.referral` at it.
2. On each fee event with a fee above zero, it takes the user's latest binding. If the event's block time
   `t` has `boundAt <= t < expiresAt`, the fee is credited: a `ReferralFee` row, and the same amounts
   added to the `Referral`, `Referrer`, `ReferredUser` and that day's `ReferralCredit`.
3. Each fee's `protocolShare` is `fee - floor(fee * 2500 / 10000)`, the 75% the protocol keeps, exactly as
   the vault splits it. The creator's 25% is never shared.

The indexer stops there. The share a referrer earns, `referralShareBps`, is published with each epoch,
so the rewards scorer applies it: `floor(protocolShare * referralShareBps / 10000)` per `ReferralFee`,
summed per referrer over the epoch's days. `ReferralCredit` gives the daily sums of the base for a quick
check. Rounding dust moved to the fee balances has no user and is never credited. A fee earlier in the
same block than the user's binding is not credited, since `referrerOf` would not have named the referrer
yet.

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

A second one indexes the blocks where the periphery was deployed and template 7 was registered, so the
periphery's event signatures are checked against logs the contracts really emitted. It reads a few dozen
blocks and takes seconds:

```bash
INDEXER_LIVE_TESTNET=1 pnpm --filter @hunch-book/indexer exec vitest run test/live-periphery.test.ts
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
- **Block-clock markets** (Perpl funding, templates 1 and 4): the settlement deadline is not in the
  parameters, so `Market.settleDeadline` is empty for them; read `window()` on the market contract. A
  parlay (template 6) with such a leg has no `settleDeadline` either, since the resolver takes the latest
  of its legs' deadlines.
- **Kuru fill notional** is size times price, rounded down, before any Kuru fee. Router trades carry
  the exact USDC the user paid or received.
- **Positions** count tokens in wallets. Tokens a maker has resting in Kuru's margin account show up on
  the margin account's position, not on the maker's. The market, vault and router only pass tokens
  through and get no position.
- **The question text** is a summary built from the parameters of every template, 1 to 7 (Perpl
  thresholds in raw funding units, a parlay's legs by market number). The resolver's `describe()` is the
  exact rule. For template 7 the resolver alone keeps each source's label, unit and decimals, so the
  summary names the source by its id and the threshold in raw units; read `source(sourceId)` on the
  resolver for the rest.
- **Expired conditional orders** stay `Open`: expiry is a time, not an event. Compare `expiry` with the
  time, as `open-orders.graphql` does.
- **Fills of a conditional order** name the transaction's sender (the executor) as the trader, as Kuru
  reports it, so a fill our keeper executes for someone else counts as one of ours on the taking side.
  The owner gets the `RouterTrade` and the USDC, and counts as a wallet that traded.
- **Oracle pokes** update `OracleFeed` every time but keep a history row only for pokes that stored a
  checkpoint (at most one per 30 seconds per market), to keep the event count down.
- **Referral credit** is the base for the scorer, not a payout: the share in basis points comes with each
  epoch (above).

## Example queries

The app's queries live in [`indexer/queries/`](../indexer/queries). A test checks that each one selects
and filters only fields the schema has.

| File | For |
|---|---|
| `markets.graphql` | the markets list, filtered with `$where` |
| `market-detail.graphql` | one market with its latest fills, stakes, router trades, graduation and settlement; its snapshot (template 7), oracle chance, price adapters, and order and auto-redeem counts |
| `portfolio.graphql` | a wallet's positions, unclaimed stakes and redemptions |
| `proof-stats.graphql` | protocol totals with the periphery's, the last 30 days, and any market with a negative solvency margin |
| `trade-tape.graphql` | the last fills with block numbers and transactions |
| `open-orders.graphql` | a wallet's open conditional orders (not past expiry at `$now`) and its order history |
| `auto-redeem.graphql` | a holder's auto-redeem setting, excluded markets, redemptions and failures |
| `referrals.graphql` | a referral link's totals, users, bindings, and credit per day and per fee over a date range |
| `rewards.graphql` | reward epochs, one account's claims, totals per token, and the funder |
| `timelock.graphql` | the timelock queue with each call decoded, recent executions and cancellations, and pauses |

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
| Snapshots | `snapshotsTaken`, `snapshotsTakenOurs` | one per `SnapshotTaken`; ours when one of our wallets sent the transaction |
| Auto-redeem | `autoRedeemHolders`, `autoRedemptionCount`, `autoRedeemedUsdc`, `autoRedemptionCountOurCaller`, `autoRedeemFailures` | holders opted in now; one redemption per `AutoRedeemed` (a voided market's two sides are two); ours when one of our wallets called it |
| Conditional orders | `conditionalOrdersPlaced`, `conditionalOrdersOpen`, `conditionalOrdersExecuted`, `conditionalOrdersCancelled`, `conditionalOrdersExecutedByUs` | open counts orders not executed or cancelled, expired ones included |
| Referrals | `referralBindings`, `referralBindingsRelayedByUs`, `referrers`, `referredFeeCount`, `referredFees`, `referredProtocolShare` | one binding per `Bound`; relayed by us when one of our wallets sent someone else's binding; fees as in Referral credit above |
| Rewards | `rewardEpochs`, `rewardClaimCount`, and `RewardToken` per token | amounts are per token, never added across tokens |
| Oracle and adapters | `oraclePokes`, `oraclePokesOurs`, `oracleCheckpoints`, `priceAdapters` | one per `Poked` and `AdapterCreated` |
| Timelock | `timelockQueued`, `timelockExecuted`, `timelockCancelled`, `timelockPending` | pending counts operations queued and not yet executed or cancelled, including ones past their grace period |

`DailyStats` keeps the same activity per UTC day, with distinct active and new wallets per day, and the
periphery's daily counts.

## How our own activity is labelled

Rule 4 of CLAUDE.md: our own maker bot's and keeper's activity is labelled as ours wherever it is
counted. The indexer labels a wallet as ours when it is

- `wallets.maker` (role `Maker`), `wallets.keeper` (`Keeper`), `hunchBook.guardian` (`Guardian`),
  `hunchBook.feeRecipient` (`FeeRecipient`), `hunchBook.periphery.distributorFunder`
  (`DistributorFunder`) or `hunchBook.periphery.timelockProposer` (`TimelockProposer`) in the
  deployments file (on testnet the last four are one address), or
- an address one of those wallets paid a stake for (`Seeded`). On testnet these are the ten stakers
  the seed script derived from the deployer key (`contracts/script/SeedTestnetMarket.s.sol`).

The label is on `Wallet.ourRole` and `Wallet.isOurs`, and it flows into `Stake.paidByUs`,
`Trade.isOurMaker`, `makerIsOurs`, `traderIsOurs` and `betweenOthers`, `RouterTrade.userIsOurs`,
`Graduation.callerIsOurs`, `TokenClaim.pushedByUs`, `Settlement.settlerIsOurs`,
`Market.creatorIsOurs`, `Creator.isOurs`, `BookOrder.isOurMaker`, and the `Ours` and `OurMaker`
totals in `ProtocolStats` and `DailyStats`. For template 7 and the periphery it flows into
`Snapshot.senderIsOurs`, `AutoRedeemOptIn.holderIsOurs`, `AutoRedemption.callerIsOurs` and
`holderIsOurs`, `AutoRedeemFailure.callerIsOurs`, `ConditionalOrder.ownerIsOurs` and `executorIsOurs`,
`Referral.userIsOurs` and `relayerIsOurs`, `Referrer.isOurs`, `RewardClaim.accountIsOurs` and
`callerIsOurs`, `RewardDistributor.funderIsOurs`, `OracleFeed.pokeCountOurs`,
`OracleCheckpoint.pokerIsOurs`, `PriceAdapter.creatorIsOurs`, `TimelockOperation.executorIsOurs`,
`TimelockAction.senderIsOurs`, and the `snapshotsTakenOurs`, `autoRedemptionCountOurCaller`,
`conditionalOrdersExecutedByUs`, `referralBindingsRelayedByUs` and `oraclePokesOurs` totals. Our maker
bot is excluded from maker rewards (PERIPHERY.md); when it appears in a claim anyway,
`RewardClaim.accountIsOurs` shows it. The proof page shows each count next to the part that is ours.

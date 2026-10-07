# Hunch Book keeper

Status: **building**. The keeper's dry run reads every market on Monad testnet and prints what it would
send. It is not yet running continuously. On a network where `deployments/<network>.json` does not list
`hunchBook.factory`, it starts, logs that there is nothing to do, and waits.

## What it does

Every step of a Hunch Book market can be triggered by anyone: graduating a pool, giving stakers their
tokens, settling, voiding. The keeper makes sure someone does, on time, for every market. Each cycle
(every 15 seconds by default) it reads every live market at one block and runs these jobs:

| Job | When | Transaction |
|---|---|---|
| Graduate | The market is a pool, `graduationRuleMet()` is true, graduation is not paused, and a book is ready: the graduator has one for the market (`bookOf`), or can create one (`canCreateBooks`, testnet) | `market.graduate()` |
| Ask Kuru for a book | Mainnet: the rule is met, but only Kuru can create books and there is none yet | None. A `book-request` log line (and webhook post) with the exact `deployProxy` call, at most once per market every 6 hours |
| Register the book | Mainnet: Kuru has deployed the book at the address `deployProxy` gives these parameters | `graduator.registerBook(market, book)`, then `graduate()` next cycle |
| Push token claims | The market has graduated and still holds YES or NO for stakers | `market.claimTokensFor(users)`, in batches of 50 |
| Prove YES | Touch templates (3 and 4): the market is past staking and an observation in its window proves YES | `market.proveYes(proof)`, before or after close |
| Snapshot | Templates that need a separate call to take their snapshot (none today: template 7's `settle` takes it) | the template's snapshot call |
| Settle | The close has passed, the template's resolver can answer, and the settlement deadline has not passed | `market.settle(evidence)` |
| Push pool payouts | A market that never graduated is settled or voided, and its pool still holds USDC | `market.claimPoolFor(users)`, in batches of 50 |
| Void | The settlement deadline has passed with no answer | `market.voidIfExpired()` |

Every decision comes from pure functions in [`src/plan.ts`](./src/plan.ts) of one market's state and
the chain's current block and time, and carries a plain reason. The dry run prints them all.

### Stacks and Kuru v2

A deployments file can hold several stacks (a factory with its graduator, router and periphery): the
primary one under `hunchBook`, extra ones under `stacks` (testnet: `kuruV2`). The keeper runs one keeper per
stack in the same process, one after another (so its transactions never race for a nonce), each with its
own state and health files (`state.json` becomes `state.kuruV2.json`). Log lines carry `stack` when there
is more than one. `KEEPER_STACKS` limits it to the named stacks.

On a Kuru v2 stack (`kuruVersion: 2`, [docs/PROTOCOL.md §8.1](../../docs/PROTOCOL.md#81-kuru)) only Kuru
creates books, after a per-token setup that takes days. So the graduate job changes:

| Step | When | What the keeper does |
|---|---|---|
| Ask for the book | A pool market has no registered book, from creation on | `book-request` log line and webhook post: the token setup with the YES feed's address, the exact `deploySpotMarket` arguments from `GraduatorV2.bookRequest`, and the address the book will land at. Repeated at most every `KEEPER_BOOK_REQUEST_SECONDS`. |
| Register | Kuru has deployed the book at `GraduatorV2.predictedBook` and `bookProblem` is none | `graduatorV2.registerBook(market, book)`, before the pool fills |
| Graduate | The book is registered and the pool meets its rule | `market.graduate()` |

and two cycle jobs do more: the Kuru feeds job (`kuruFeeds`) creates each open market's YES and NO feeds
on the stack's `kuruFeedFactory` (`createAdapter`), and the oracle job pokes every open market, pools too,
at most every `KEEPER_KURU_POKE_SECONDS` (or `KEEPER_ORACLE_POKE_SECONDS` when lower). Kuru's
WithdrawalLimiter reads those feeds and refuses a stale price, and Kuru reads the price when it sets a
token up.

After the markets, four jobs look at every market at once ([`src/jobs/`](./src/jobs)). Each runs only when
its contract is in `hunchBook.periphery` (or, for series, a file is set), and each can be switched off by
name with `KEEPER_JOBS_OFF`:

| Job | When | Transaction |
|---|---|---|
| Auto-redeem (`autoRedeem`) | A graduated market has settled or voided, and holders who opted in on the AutoRedeemer still hold redeemable tokens with an allowance | `autoRedeemer.redeemManyFor(market, holders)`, in batches |
| Conditional orders (`orders`) | An open ConditionalOrders order's trigger holds against its market's book | `conditionalOrders.execute(orderId)` |
| Oracle pokes (`oracle`) | A market with a live book was last poked at least `KEEPER_ORACLE_POKE_SECONDS` ago | `oracle.pokeMany(markets)` |
| Recurring series (`series`) | A series period's creation point has come and the period has no market yet (primary stack only) | `factory.createMarket(...)` with the keeper's first stake ([docs/SERIES.md](../../docs/SERIES.md)) |
| Kuru feeds (`kuruFeeds`, Kuru v2 stacks) | An open market has no YES or NO feed on the stack's `kuruFeedFactory` | `kuruFeedFactory.createAdapter(market, side)` |

### Settlement evidence, per template

Each template has a settler ([`src/settlers/`](./src/settlers)), looked up by template id. A market on a
template with no settler is logged once and skipped; a new template plugs in with
`registry.register(templateId, settler)`.

- **Template 1, Perpl funding.** The resolver reads Perpl's funding history itself, so the evidence is
  empty (`0x`). It can answer once `block.number > endBlock`, when every funding event in the window is
  final. Until then the plan says `waiting for block > <endBlock>`.
- **Template 2, price at a time, Chainlink.** The evidence is `abi.encode(uint80 r)`, where round `r` is
  the one the resolver accepts: `updatedAt(r) <= T < updatedAt(r + 1)`, both rounds in one phase. The
  keeper walks back from `latestRoundData` in doubling steps, then halves the gap, so a T a thousand
  rounds back takes about 20 reads. If no round after T exists yet, it waits. If the last round before
  T is more than an hour older than T, the resolver will never accept it: the keeper says so, alerts,
  and the market voids at its deadline.
- **Template 2, price at a time, Pyth.** The evidence is `abi.encode(bytes[] updateData)`, the first
  update published at or after T, fetched from Pyth's Hermes service
  (`/v2/updates/price/{T}?ids[]=...`, with `PYTH_API_KEY` as a bearer token), and the call carries
  Pyth's update fee as its value. The keeper checks the update was published within 60 seconds after T
  before it spends gas. Without a key, it logs why and tries again later.
- **Template 3, price touch.** YES is proved by pointing at the round that touched: the prover reads every
  Chainlink round of [T1, T2] once, as it is written (in batches through Multicall3, across phases if the
  feed changed aggregator inside the window), applies the resolver's rule (the round answers in itself,
  is positive, and touches the strike with the resolver's rounding for the direction; equal counts), and
  sends `proveYes(abi.encode(roundId))` for the first touch, before or after close. NO is `settle(0x)`,
  sent only once the 24-hour challenge period after T2 is over, the feed has reported at or after T2, and
  the keeper has read every round of the window with no touch: the template's NO assumes an honest prover,
  and the keeper is that prover.
- **Template 4, Perpl funding spike.** YES is proved by pointing at the event: the prover walks Perpl's
  events through its own "last event at or before" answers (the answer for e − 1 is the event before e,
  exactly the read the resolver makes), batched on the funding grid and re-predicted wherever an event is
  off it, and sends `proveYes(abi.encode(uint64 e))` for the first final event whose single-interval
  increment is above the threshold. NO is `settle(0x)` once `block.number > endBlock + challengeBlocks`
  (read from the resolver) and every event of the window has been checked.
- **Template 5, price range.** The same bracketing round (or Pyth update) as template 2.
- **Template 6, parlay.** The evidence is empty. The keeper reads every leg's phase and outcome first and
  settles once any leg settled NO or all settled YES; a voided leg with no NO is reported as never
  settling (the parlay voids at its deadline).
- **Template 7, snapshot.** The evidence is empty, and `settle` takes the snapshot when nobody has yet, so
  the keeper settles at its first cycle after close: one transaction takes the snapshot and settles, and
  every market on the same observation then answers from it. Inside the window, a source that cannot be
  snapshotted right now (its revert is decoded and logged) is retried within 5 seconds rather than with
  the usual doubling wait. After the window with no snapshot, the market can never settle: the keeper
  reports it once and it voids at its deadline.

A proof that the keeper believes in but that would not go through is retried with the same backoff and
reported (`proof-rejected` alert); the keeper never settles NO while it holds a proof of YES.

If a settlement simulation fails (for example the Perpl resolver returns Unresolved and the market
reverts `NotResolved`), the keeper waits 60 seconds, then twice as long each time, up to 30 minutes.

### Finding stakers

Token claims and pool payouts need the list of stakers. By default the keeper reads the market's
`Staked` logs. Monad's public RPCs answer `eth_getLogs` for at most 100 blocks, so it scans forward in
100-block windows from a cursor saved in a state file, starting at the market's creation block (found
the same way, from the factory's `MarketCreated` events, starting at `hunchBook.deployBlock`). Once a
market is past staking and the scan has passed that block, its list is final and is never scanned again.
Each cycle spends at most 300 log requests, so a long scan never holds up the other jobs, and scans
stop 10 blocks short of the head, so a block whose logs a node has not served yet is never skipped.

With `INDEXER_URL` set, one GraphQL query to the indexer replaces the scan; the scan is the fallback
whenever the indexer fails or does not know the market yet. Either way, every address is checked
onchain (`claimableTokens`, `claimablePool`) before it goes into a transaction.

The keeper knows a job is finished from the chain, not from its lists: token claims are done when the
market holds no YES or NO, pool payouts when the market's pool ledger is empty. A market with nothing
left is not read again.

### Auto-redeem, conditional orders and oracle pokes

- **Auto-redeem** ([docs/PERIPHERY.md](../../docs/PERIPHERY.md#autoredeemer)). Who opted in comes from the
  AutoRedeemer's `OptInSet` events, scanned forward from its deploy block with a cursor in the state file
  (at most 50 log requests a cycle, so catching up never holds the other jobs). For each settled or voided
  graduated market, `redeemable(market, holder)` (which already applies per-market opt-outs, balances
  and allowances) picks the holders with something to redeem, and `redeemManyFor` pays them; the vault
  sends the USDC straight to each holder. A market is checked again when the opted-in list changes and
  every `KEEPER_REDEEM_RECHECK_SECONDS`. `redeemManyFor` catches each holder's failure, so a gas estimate
  can be a limit at which every inner redemption runs out of gas and is skipped while the call still
  succeeds; the keeper calls it (`eth_call`) at growing limits until it redeems as many holders as it does
  with all the gas a transaction may have, and sends with that limit.
- **Conditional orders** ([docs/PERIPHERY.md](../../docs/PERIPHERY.md#conditionalorders)). Every open order
  (ids 1 to `orderCount()`) is read each cycle with its market's YES book (`bestBidAsk`). The contract's
  trigger rules are pure functions in [`src/jobs/triggers.ts`](./src/jobs/triggers.ts): bids rounded down
  and asks up to E6, NO prices as 1 − the YES book, an empty side never triggers, expiry inclusive, and
  only while the market trades. A triggered order is simulated first; one that would revert (the owner
  moved their funds or cut the allowance, the limit cannot fill) is logged and retried after 60 seconds,
  doubling to 30 minutes. The tip goes to the keeper's published address.
- **Oracle pokes** ([docs/PERIPHERY.md](../../docs/PERIPHERY.md#impliedprobabilityoracle)). Markets with a
  live book (graduated, not yet settled) whose last poke, read from the oracle itself, is at least
  `KEEPER_ORACLE_POKE_SECONDS` old are poked together in one `pokeMany`. A poke for one market estimated
  at about 300,000 gas on testnet, about 0.03 MON at 102 gwei, so the default is every 30 minutes.

## Safety

- It only calls functions anyone can call. It holds no user funds; its key holds MON for gas.
- It never decides an outcome. `settle` hands evidence to the market's resolver, which reads the source
  and answers or refuses. Wrong evidence makes the transaction revert; it cannot change the answer.
- Pushing a claim sends the staker's own tokens or payout to the staker; nothing passes through the keeper.
- Every transaction is simulated first, so a call that would revert costs nothing.
- The keeper runs from one published address, `wallets.keeper` in
  [`deployments/monad-testnet.json`](../../deployments/monad-testnet.json). Its transactions are ours and
  are labelled as ours wherever they are counted. Running from any other address logs a warning.
- It never prints a key, and cuts the key, the Pyth key, the webhook URL, the indexer URL and a private
  RPC URL out of every log line and alert.

## Run it

Node 22 and pnpm. From the repository root:

```sh
pnpm install
pnpm --filter @hunch-book/shared build

# Dry run (the default): reads every market, prints every plan line and simulates what it would send.
pnpm --filter @hunch-book/keeper once      # one pass, then exit
pnpm --filter @hunch-book/keeper start     # keep running (repeats are logged at most every 10 minutes)

# Live, once the dry run looks right.
KEEPER_ENABLED=1 pnpm --filter @hunch-book/keeper start
```

The keeper reads its settings from the environment. For local runs it also loads the repository's
`.env` file (or the file named by `KEEPER_ENV_FILE` or `--env-file <path>`), taking only `KEEPER_*`,
`MONAD_*`, `INDEXER_URL` and `PYTH_API_KEY`, and never overriding a variable that is already set.

To stop it, press Ctrl-C (or send SIGTERM): it finishes the current cycle, saves its state and exits.
A second Ctrl-C exits at once. Stopping is always safe: every job picks up again from the chain.

To run it as a service (Railway, launchd, or in the background on this machine), see
[`ops/README.md`](../../ops/README.md).

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `KEEPER_PRIVATE_KEY` | none | The keeper's key. Needed only when `KEEPER_ENABLED` is on. |
| `KEEPER_NETWORK` | `monad-testnet` | `monad-testnet` or `monad-mainnet`. Picks `deployments/<network>.json`. |
| `KEEPER_ENABLED` | off | Kill switch. Only `1`, `true`, `yes` or `on` turns sending on. Off: dry run. |
| `KEEPER_RPC_URL` | network default | RPC override. Otherwise `MONAD_TESTNET_RPC` or `MONAD_MAINNET_RPC`, then the deployments file. |
| `KEEPER_RPC_RPS` | `10` | Requests per second the keeper allows itself. Monad's public testnet RPC refuses more than 15. |
| `KEEPER_POLL_SECONDS` | `15` | Time between cycles. |
| `KEEPER_MAX_GAS_PRICE_GWEI` | `200` | Never send while the base fee is above this, and never bid above it. |
| `KEEPER_MAX_GAS_PER_TX` | `6000000` | Upper bound on any transaction's gas limit. A claim batch over it is halved until it fits. |
| `KEEPER_MIN_MON` | `0.5` | Below this balance the keeper logs `low-mon`, health shows `warn`, and the webhook is alerted. |
| `KEEPER_CLAIM_BATCH` | `50` | Stakers per `claimTokensFor` or `claimPoolFor` transaction (1 to 500). |
| `KEEPER_LOG_RANGE` | `100` | Blocks per `eth_getLogs` request. |
| `KEEPER_SCAN_REQUESTS_PER_CYCLE` | `300` | Log requests the keeper may spend per cycle. |
| `KEEPER_SETTLE_RETRY_SECONDS` | `60` | First wait after a settlement that could not go through. Doubles each time. |
| `KEEPER_SETTLE_RETRY_MAX_SECONDS` | `1800` | Longest wait between settlement attempts. |
| `KEEPER_BOOK_REQUEST_SECONDS` | `21600` | How often a book request to Kuru is repeated for one market (Kuru v1 mainnet, and every Kuru v2 stack). |
| `KEEPER_STATE_FILE` | `services/keeper/.keeper-state.json` | Scan cursors, stakers found and book requests sent. Can be deleted at any time; it is rebuilt from the chain. |
| `KEEPER_HEALTH_FILE` | `services/keeper/health.json` | Where the health snapshot is written after every cycle. |
| `KEEPER_HEALTH_PORT` | none | When set, the snapshot is also served at `GET http://localhost:<port>/health` (the primary stack) and `GET /health/<stack>` (each extra stack). |
| `KEEPER_ALERT_WEBHOOK` | none | When set, errors, a low balance, markets that cannot settle (or still have not after the longest retry wait) and book requests are posted there as JSON. |
| `KEEPER_ALERT_REPEAT_SECONDS` | `1800` | The same alert (same event, same market) is posted at most this often. |
| `KEEPER_MARKETS` | all | Comma-separated market addresses to handle; all markets when unset. |
| `KEEPER_JOBS_OFF` | none | Comma-separated jobs to switch off: `prove`, `snapshot`, `autoRedeem`, `orders`, `oracle`, `series`, `kuruFeeds`. |
| `KEEPER_ORACLE_POKE_SECONDS` | `1800` | Poke each market with a live book at most this often; `0` turns pokes off. |
| `KEEPER_KURU_POKE_SECONDS` | `900` | Kuru v2 stacks: poke every open market (pools too) at most this often, to keep Kuru's limiter feeds fresh. Keep it well under the maximum price age Kuru sets for them. |
| `KEEPER_STACKS` | all | Comma-separated stacks to run (`primary`, or names under `stacks` such as `kuruV2`); every deployed stack when unset. |
| `KEEPER_ORACLE_BATCH` | `25` | Markets per `pokeMany` transaction (1 to 200). |
| `KEEPER_REDEEM_BATCH` | `50` | Holders per `redeemManyFor` transaction (1 to 500). |
| `KEEPER_REDEEM_RECHECK_SECONDS` | `600` | A settled market's opted-in holders are checked again this often. |
| `KEEPER_SERIES_FILE` | none | The recurring series file ([docs/SERIES.md](../../docs/SERIES.md)); the series job runs only when set. |
| `KEEPER_SERIES_ENABLED` | off | The series job's own kill switch (it spends the keeper's USDC). Creating needs both this and `KEEPER_ENABLED`. |
| `INDEXER_URL` | none | The indexer's GraphQL endpoint. When set, stakers come from it, with the log scan as fallback. |
| `PYTH_API_KEY` | none | Pyth API key for Hermes. Needed only to settle markets on Pyth prices. |
| `KEEPER_HERMES_URL` | `https://hermes.pyth.network` | The Hermes service. |
| `KEEPER_ENV_FILE` | repository `.env` | The `.env` file to load. |

## Logs, plan and health

Every line on stdout is one JSON object. The dry run's plan is one `plan` line per market and job:

```json
{"ts":"…","level":"info","event":"plan","market":"0x2A44B99014cF73065BFb89197a08DE09D18d3982","template":1,"phase":"Trading","job":"settle","action":"wait","reason":"waiting for block > 68264005"}
```

A running keeper logs a plan line only when a decision changes. Each transaction line carries its hash
and an explorer link built from `deployments/<network>.json`:

```json
{"ts":"…","level":"info","event":"tx","action":"settle","market":"0x…","settler":"perpl-funding","status":"success","hash":"0x…","url":"https://testnet.monadscan.com/tx/0x…","gasLimit":"…","gasUsed":"…"}
```

Other events: `start`, `dry-run` (with the simulation result), `tx-skipped` (simulation failed, gas cap,
gas price), `tx-unknown`, `settle-later` (why, and the wait), `claims-found`, `claims-waiting`,
`batch-split`, `book-request`, `market-done`, `unknown-template`, `job-error`, `low-mon`,
`indexer-failed`.

The health snapshot (file, and `/health` when a port is set):

| Field | Meaning |
|---|---|
| `status` | `ok`, or `warn` when the balance is below `KEEPER_MIN_MON` |
| `enabled`, `keeper`, `network` | Mode, address and network |
| `cycles`, `lastCycleAt`, `lastCycleMs`, `block` | The last cycle: when, how long, at which block |
| `monBalance`, `minMon`, `lowBalance` | The keeper's MON balance and its warning threshold |
| `markets.total`, `markets.done`, `markets.byPhase` | Markets known, markets finished, live markets per phase |
| `jobs.<job>.lastRunAt` | When the job last looked at every market (`discover`, `graduate`, `claims`, `prove`, `snapshot`, `settle`, `void`, `payouts`, `series`, `autoRedeem`, `orders`, `oracle`) |
| `jobs.<job>.info` | What a cycle-level job knows: opted-in holders and scan cursor (`autoRedeem`), open and triggered orders (`orders`), markets due a poke (`oracle`), every series' next period and status (`series`) |
| `jobs.<job>.due` | Markets where the job had something to send in the last cycle |
| `jobs.<job>.lastAction` | The last transaction: market, action, status, hash and explorer link |
| `jobs.<job>.lastError`, `lastError` | The last error, per job and overall |
| `scan.factoryCursor`, `scan.requestsLastCycle` | How far the factory scan has read, and the log requests used |

## Gas

Monad charges for a transaction's gas limit, not the gas it uses. So every transaction is simulated
first, then sent with an explicit limit: the estimate plus 10%, never above `KEEPER_MAX_GAS_PER_TX`.

Charged on Monad testnet for market #1 (sent from our deployer key before the keeper existed), at about
103 gwei:

| Transaction | Gas charged |
|---|---|
| `graduate()`, including the new Kuru book | 1,721,637 ([tx](https://testnet.monadscan.com/tx/0xbc9524391134b6a3cba94f33daba323075ff0db030a8d51563d89ee94fcf8d01)) |
| `claimTokensFor`, 11 stakers | 918,908 ([tx](https://testnet.monadscan.com/tx/0x1e99d69bf985f3208f4882610279dacfa0c66314f8ab0fb88c59fb37e2b2d07d)) |

So graduating a market and pushing 11 stakers' tokens costs about 0.27 MON on testnet; a full batch of
50 stakers is about 4.2 million gas, about 0.42 MON. Gas used on a local anvil chain by the integration
test (the mock graduator creates no Kuru book and the mock resolver reads no source, so real
`graduate` and `settle` cost more):

| Transaction | Gas used |
|---|---|
| `graduate()` without a Kuru book | 379,898 |
| `claimTokensFor`, 3 stakers / 2 stakers | 317,316 / 202,520 |
| `settle(0x)` | about 150,000 |
| `voidIfExpired()` | 84,433 |
| `claimPoolFor`, 1 winner / 2 refunds | 200,926 / 198,115 |

## Tests

```sh
pnpm --filter @hunch-book/keeper test
```

- **Unit tests**: config parsing; one keeper per stack (views, files, `KEEPER_STACKS`); the Kuru v2
  graduate plan (request from creation, register before the pool fills, graduate once both are there);
  v2 book prices for conditional-order triggers; the Chainlink round finder against 301 rounds per feed recorded from
  Monad mainnet (BTC, ETH and MON, the maker's fixtures), checked against brute force for every T in the
  recording; the plan for every phase, including market #1's `waiting for block > 68264005`; batching
  and the gas-cap split; scan windows and cursors surviving a restart; evidence encoding for both
  templates; Hermes requests and the 60-second rule; the indexer query and its fallback; alerts and
  redaction; `sendTx` in dry run and live.
- **Templates 3 to 7**: the touch hunter on the same recorded Chainlink rounds, checked against brute
  force on many windows and strikes, round by round as rounds appear, across a phase change, and never
  complete before T2; the spike hunter on 601 recorded BTC and MON Perpl funding events, with a pause in
  the grid, checked against brute force; the parlay rule for every mix of leg states; the range evidence;
  the snapshot settler before, in and after its window.
- **Cycle jobs**: the conditional-order trigger rules against the contract's cases; opt-in replay and
  the auto-redeem state; oracle poke timing; the series file, schedules, strike rules (with recorded BTC
  funding for the trailing median), params and period identity.
- **Integration tests** (`test/integration/`): a fresh anvil chain with Hunch Book's real factory, vault,
  market and outcome tokens from `contracts/out`, plus the contracts' own mocks for the parts outside
  Hunch Book (a resolver that answers what the test sets, Kuru's Router and Margin Account).
  - The whole loop: the keeper graduates a pool, finds every staker from the logs and pushes their
    tokens in batches, backs off while the resolver has no answer, settles once it has one, voids a
    market past its deadline, pays pool winners and refunds, and then stops reading finished markets.
  - Books on a network where only Kuru can create them, with the real Graduator: the keeper asks Kuru
    once with the exact `deployProxy` parameters, finds the book Kuru deploys at the predicted address,
    registers it (the Graduator verifies it) and graduates into it.
  - A Kuru v2 stack, with the real GraduatorV2, oracle and feeds factory and the contracts' mock of Kuru's
    v2 exchange: from creation the keeper creates the market's feeds, pokes its pool and asks Kuru once
    with the exact `deploySpotMarket` arguments; it registers the book as soon as Kuru deploys it (before
    the pool fills) and graduates into it once the rule is met.
  - A template with no settler is skipped with one warning; a settler registered at startup settles it.
  - The new jobs against the real resolvers for templates 3, 4, 6 and 7 (with the resolvers' own
    Chainlink, Perpl and snapshot-source stand-ins) and the real AutoRedeemer, ConditionalOrders,
    oracle and HunchRouter (with the periphery tests' Kuru book stand-in): a touch proved the cycle its
    round exists; a spike proved once its event is final; snapshot markets settled inside their window
    from one snapshot, and one past its window reported; a stop-loss executed when the bid falls to its
    trigger; the oracle poked once per interval; an opted-in holder's winning tokens redeemed after
    settlement; and touch NO, parlay NO and spike NO settled after their challenge periods.

  They skip, rather than fail, when anvil is not installed or `contracts/out` has not been built
  (`forge build`).

## Limits

- It polls. A pool that meets its rule is graduated on the next cycle, not in the same block.
- The touch and spike hunts keep their progress in memory. After a restart they read the window again,
  once (at most 2,000 round reads a cycle for a touch market).
- Auto-redeem, conditional orders, oracle pokes and recurring series are built and tested on a local
  chain. Each starts sending only when the keeper runs with `KEEPER_ENABLED` and the periphery is in the
  deployments file; series also need `KEEPER_SERIES_FILE` and `KEEPER_SERIES_ENABLED`.
- Snapshot markets (template 7) depend on the keeper settling inside the window. If it is down for the
  whole window and nobody else takes the snapshot, the market voids.
- The default indexer query assumes a `Stake` entity with `market_id` and `user` fields. The indexer is
  planned; until it exists, `INDEXER_URL` stays unset and stakers come from the logs.
- On mainnet, graduation waits for Kuru to create each book. The keeper asks (log line and webhook) and
  registers the book as soon as it exists.

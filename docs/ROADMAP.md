# Hunch Book roadmap

Last updated: 2026-10-06. Status words used below:

- **planned**: designed, not started
- **building**: in progress
- **live**: deployed and usable (a link or contract address will sit next to it)

Live items link their proof in the [README](../README.md#whats-live); every address is in [deployments/](../deployments). The protocol design is in [PROTOCOL.md](./PROTOCOL.md).

## What we are building, in one paragraph

Anyone can start a yes/no market from a template whose answer can be read on the Monad blockchain, such as funding on Perpl or a Chainlink price. A new market starts as a **pool**: people stake USDC on YES or NO, with no market maker needed. Once a pool has proven demand, it **graduates**: in one transaction the pool's USDC becomes fully backed YES and NO tokens, split between the people who staked, and the YES token opens as a spot market on **Kuru's onchain order book**. From then on, anyone can sell before the answer is known. When the observation window closes, the market **settles itself** by reading the source contract, and winning tokens redeem for $1.

## Phases at a glance

| Phase | Window (target) | Goal | Exit criteria |
|---|---|---|---|
| 0. Build sprint | 2026-10-03 → 2026-10-13 | Whole lifecycle working on Monad mainnet with real USDC | One market created, staked, graduated, traded, settled and redeemed onchain; every step has a public transaction |
| 1. Live beta | 2026-10-14 → 2026-11-03 | Keep it running, safely, for real users | 30+ days without a stuck market or an unpaid winner; zero solvency invariant breaks |
| 2. Trader utility | 2026-11 → 2026-12 | Make it a tool a perp trader uses weekly | A Perpl trader can hedge funding in under a minute; weekly markets create themselves |
| 3. Open liquidity | 2027-Q1 | Most liquidity from outside makers, not Hunch | Under 50% of book fills against Hunch's own maker, measured and published |
| 4. Protocol | 2027-Q2 → | A neutral venue others build on | External audit; other apps create and list markets through the SDK |

## Workstreams

Work is split into lanes that can be built in parallel, each with its own directory and tests. Interfaces between lanes are fixed first (Solidity interfaces in `contracts/src/interfaces/`, shared TypeScript types and ABIs in `packages/shared/`).

| Lane | Owns | Builds |
|---|---|---|
| C: Core contracts | `contracts/src/core/` | Factory, Market (pool + graduation + claims), Outcome tokens, Collateral vault, Graduator, Router |
| S: Settlement | `contracts/src/resolvers/` | One resolver per template; fork tests against Monad mainnet |
| V: Venue | `services/maker/`, router tests | Kuru market creation, order routing, open-source maker bot |
| K: Keeper | `services/keeper/` | Graduation, settlement, touch-proof hunting, recurring series, auto-redeem |
| I: Indexer | `indexer/` | Envio HyperIndex over factory, markets, vault and Kuru fills; GraphQL API |
| A: App | `apps/web/` | Markets, market page, trade ticket, create flow, portfolio, settlement verifier, proof page |
| D: Developer surface | `packages/sdk/`, `packages/mcp/` | TypeScript SDK, MCP server, agent examples |
| O: Ops and security | `.github/`, `scripts/`, `deployments/` | CI, deploy scripts, address registry, monitoring, invariant suite |

---

## Phase 0: Build sprint (2026-10-03 → 2026-10-13)

The order below is the build order. A later item never blocks an earlier one.

### 0.1 Contracts core on Monad testnet (target 2026-10-04)

| ID | Deliverable | Status |
|---|---|---|
| C-1 | `CollateralVault`: holds USDC, mints and merges complete sets (1 YES + 1 NO = 1 USDC), redeems after settlement, per-market accounting | live on testnet |
| C-2 | `OutcomeToken`: minimal ERC-20 clone per side per market, mint and burn by the vault only | live on testnet |
| C-3 | `Market` (clone per market): state machine (Pool → Graduated → Closed → Settled or Voided), pool stakes, pool settlement and claims | live on testnet |
| C-4 | `HunchBookFactory`: create a market from a template id and parameters, one canonical market per (template, parameters) hash, creator's first stake required | live on testnet |
| S-1 | `PerplFundingResolver`: settles "net funding paid by longs between block A and block B is above X" by reading Perpl's historical funding accumulator, after every funding event in the window is final | live on testnet |
| S-2 | `PriceAtTimeResolver`: settles "price at or above K at time T" from the Chainlink round that brackets T (Pyth's first update at or after T where Chainlink has no feed) | live on testnet |
| O-1 | Foundry project, CI (build, unit, fuzz, invariant tests), `deployments/monad-testnet.json` as the single address source | live on testnet |

Tests that must pass before anything deploys:
- Solvency: for every market, USDC held ≥ complete sets outstanding (+ accrued fees), after every action and under fuzzing.
- Supply: YES supply equals NO supply equals sets outstanding until settlement.
- Pool claims: the sum of all claims never exceeds the pool; rounding dust is accounted, never lost.
- No address can set an outcome by hand.

### 0.2 Graduation and trading on Kuru (target 2026-10-05)

| ID | Deliverable | Status |
|---|---|---|
| C-5 | `Graduator`: when a pool meets the graduation rules, converts it into complete sets, records each staker's token claim, creates the YES/USDC market on Kuru | live on testnet |
| C-6 | `HunchRouter`: buy YES, sell YES, buy NO (mint a pair, sell YES), sell NO (buy YES, merge), all atomic with slippage limits and deadlines; uses a vault flash loan guarded by the solvency invariant | live on testnet |
| V-1 | Kuru integration on testnet: market creation parameters for $0.01–$0.99 outcome tokens, router order calls, fork tests | live on testnet |
| V-2 | Maker bot v0 (open source, address published): quotes both sides of the YES book from a pricing model, inventory limits, cancels everything at close | live on testnet |

Graduation rules (v0 values, set per template and visible on every market):
- pool total at least $500 and at least 10 distinct stakers
- both sides non-empty, and the pool's implied chance between 3% and 97%
- graduation happens before the pool's lock time; anyone may trigger it

### 0.3 End to end on testnet (target 2026-10-06)

| ID | Deliverable | Status |
|---|---|---|
| I-1 | Envio indexer: markets, stakes, graduations, Kuru fills on our books, positions, settlements, redemptions | building: [indexer](../indexer) built and tested; hosting waits for an Envio account |
| A-1 | App: market list, market page (chance, book depth, rules, source), stake and trade ticket, portfolio with claim and redeem | live on testnet ([book.playhunch.xyz](https://book.playhunch.xyz)) |
| A-2 | Create flow: pick a template, fill parameters, see the exact settlement rule in plain words, make the first stake | live on testnet ([/create](https://book.playhunch.xyz/create), templates 1 to 6) |
| K-1 | Keeper v0: graduates eligible pools, pushes token claims, settles markets at window end, voids after the deadline, pays out pools ([services/keeper](../services/keeper)) | live on testnet ([keeper address](https://testnet.monadscan.com/address/0x1f5AC9bB0DF7d0E0DD133cBd71388e1078475569)) |
| O-2 | Golden path run by a person on testnet, including a hard refresh and two different wallets | building: the market is prepared ([GOLDEN-PATH.md](./GOLDEN-PATH.md), [0x6FFC…D9e](https://testnet.monadscan.com/address/0x6FFC70F919e9B6e20aD76df870854818C310cD9e)); waits for a person with two wallets |

### 0.4 Mainnet beta (target 2026-10-07 → 2026-10-08)

| ID | Deliverable | Status |
|---|---|---|
| O-3 | Contracts on Monad mainnet with native USDC; addresses in `deployments/monad-mainnet.json` and the README | building: rehearsed end to end on a fork of Monad mainnet ([runbook](./DEPLOY.md)); waits for the guardian multisig |
| O-4 | Beta caps: per-market pool cap, per-wallet stake cap, total collateral cap; guardian can pause creation and graduation only (never redemption, never outcomes) | live on testnet; set by the deploy script for mainnet |
| V-3 | Graduation to Kuru mainnet. Kuru's mainnet market creation is owner-only, so Kuru creates each YES/USDC book on request and anyone registers it (the Graduator verifies it). Until Kuru does, mainnet markets run as pools and graduation is shown on testnet | building: register flow rehearsed on a mainnet fork; the keeper sends each book request |
| A-3 | Mainnet app with explorer links on every action | building: every action in the app lists its transaction with an explorer link for the active network, and mainnet pages show a clear not-deployed state; waits for the mainnet deploy |

### 0.5 Proof and utility (target 2026-10-09 → 2026-10-10)

| ID | Deliverable | Status |
|---|---|---|
| A-4 | **Settlement verifier**: every settled market shows the exact read (contract, function, block, returned value) and a button that re-runs that read from your browser, no wallet needed | live on testnet (`/verify/<market>`) |
| A-5 | **Proof page**: live counts of markets, wallets, trades and volume, and the share of book fills taken by Hunch's own maker | live on testnet ([/proof](https://book.playhunch.xyz/proof)); full history once the indexer is hosted |
| S-3 | **Touch markets** ("will MON reach K at any time before T?"): anyone proves YES by pointing at the Chainlink round where it happened; NO settles after a 24h window with no proof | live on testnet (templates 3 and 4, [TEMPLATES.md](./TEMPLATES.md)) |
| A-6 | **Hedge assistant v0**: for a wallet with a Perpl position, show the funding it is paying and a market and size that pays out if funding stays high (needs Perpl position reads confirmed) | live on testnet ([/hedge](https://book.playhunch.xyz/hedge)): reads Perpl positions and sizes a hedge |
| A-7 | Passkey accounts (Mera): a wallet derived from your passkey, no seed phrase or extension; first transactions covered by a capped MON drip, and stakes accepted as signed USDC authorisations a relayer submits | live on testnet: passkey accounts in the connect menu; the gas drip and relayed stakes wait for a relayer key ([ACCOUNTS.md](./ACCOUNTS.md)) |
| A-8 | Live trade tape: each fill with its block number and the time from signature to inclusion | live on testnet ([/tape](https://book.playhunch.xyz/tape)) |

### 0.6 Hardening (target 2026-10-11 → 2026-10-13)

| ID | Deliverable | Status |
|---|---|---|
| O-5 | Internal security review: reentrancy, rounding, flash-loan paths, griefing on graduation and settlement, front-running at graduation; Slither clean or each finding explained | done ([SECURITY-REVIEW.md](./SECURITY-REVIEW.md)) |
| O-6 | Liveness checks: last settlement, last graduation, keeper balance, maker balance, alerts to a phone | live ([watchdog](../services/watchdog), every 30 minutes on GitHub Actions) |
| O-7 | README with live addresses, setup steps a third party can follow, known limitations | done: [README](../README.md) with every live address and transaction, its known limitations, and setup steps run from a fresh clone of GitHub on 2026-10-06 (the full gate passed) |

---

## Phase 1: Live beta (2026-10-14 → 2026-11-03)

Goal: run it with real users and no surprises. Code changes only fix things users can hit.

| ID | Deliverable | Why it matters | Status |
|---|---|---|---|
| K-2 | **Recurring series**: weekly and daily markets that create themselves (e.g. "BTC funding this week") from a schedule anyone can trigger | A market list that is never empty without manual work | live on testnet: the keeper creates each period from a schedule ([SERIES.md](./SERIES.md)); first market [0x2D17…BF74](https://testnet.monadscan.com/tx/0x8143b82a2ab7a81a2d3b840c91076006057192ed96298ab40403424996771462), ours |
| K-3 | **Auto-redeem** (opt in): the keeper redeems winning tokens to your wallet after settlement | Winners get paid without coming back to click | live on testnet: [AutoRedeemer](https://testnet.monadscan.com/address/0x26EFB3D0d50DCBB97FBb369471fcc59a2677A534), the opt-in in the portfolio, and the keeper job that redeems for opted-in holders |
| V-4 | **Maker kit v1**: the maker bot as a package anyone can run with their own capital and model; docs and a test mode | Outside liquidity, so users trade with other people, not with Hunch | live: the open-source bot with models for every template, paper mode and a [maker kit](./MAKER-KIT.md) |
| S-4 | More templates: price ranges (between K1 and K2), single-interval funding spikes on Perpl, ETH and SOL funding. (Perpl open interest and mark price are current-state only, so they wait for snapshot settlement, S-6) | More questions traders care about | live on testnet: templates 4 (funding spike), 5 (price range) and 7 (open interest and mark price); ETH and SOL funding through template 1 ([TEMPLATES.md](./TEMPLATES.md)) |
| O-8 | Bug bounty with a published scope and payout table | Outside eyes on the money paths | planned: scope and rules in [BUG-BOUNTY.md](./BUG-BOUNTY.md); opens with the mainnet beta |
| O-9 | Status page: contract balances, invariants, keeper and maker health, incident log | Users can see it is solvent at any moment | live on testnet ([/status](https://book.playhunch.xyz/status)) |
| A-9 | Notifications: graduation, big price moves, settlement, redemption ready (Telegram first) | People come back when something happens | building: Telegram bot in [services/notifier](../services/notifier); waits for a bot token and a host |

## Phase 2: Trader utility (2026-11 → 2026-12)

Goal: a perp trader opens Hunch Book every week because it saves them money or time.

| ID | Deliverable | Why it matters | Status |
|---|---|---|---|
| A-10 | **Hedge assistant v1**: reads your Perpl positions, prices the funding you expect to pay, builds a hedge across one or more markets, tracks it until settlement | The named first user's weekly job | live on testnet ([/hedge](https://book.playhunch.xyz/hedge)): baskets across several markets on one perp's funding, a scenario table, and tracking until every leg settles ([HEDGE.md](./HEDGE.md)) |
| S-5 | **Ladders**: a family of strikes on one question (funding above 0.01%, 0.02%, 0.03% ...) shown as a probability curve | A market-implied forecast of funding, not one yes/no | live on testnet ([/ladder](https://book.playhunch.xyz/ladder)) |
| A-11 | Limit orders, take-profit and stop-loss on outcome tokens, one-click close | Trading tools traders expect | live on testnet: [ConditionalOrders](https://testnet.monadscan.com/address/0xDf733F2AD02Fcd3eA1a02d319D720c94d67c7eB6), the orders panel and one-click close; the keeper executes triggered orders |
| A-12 | Portfolio: P&L per market, history export | Bookkeeping | live on testnet (portfolio) |
| D-1 | **TypeScript SDK**: create, stake, trade, redeem, read prices and settlement evidence | Other apps and bots build on it | building: [packages/sdk](../packages/sdk) ([SDK.md](./SDK.md)); ready to publish, with the tarball installed and imported in CI and a release workflow ([RELEASE.md](./RELEASE.md)); not on npm yet |
| D-2 | **MCP server and agent examples**: agents can find markets, quote, trade and settle with their own wallets | Agents as traders and makers | building: [packages/mcp](../packages/mcp) and [examples](../examples) ([MCP.md](./MCP.md)); ready to publish ([RELEASE.md](./RELEASE.md)); not on npm yet |
| C-7 | Creator earnings: 25% of Hunch's fee on markets you created, claimable onchain; creator page with markets and earnings | People start markets their community trades | live on testnet: the vault has paid creators 25% of fees since the first deploy; [/creator](https://book.playhunch.xyz/creator/0xD183a7daECF3d539683f37e1111558E3dFC210A8) pages with withdraw |
| C-8 | Referral share on fees, bound to a link, time-limited | Growth paid from revenue, not subsidies | live on testnet: [ReferralRegistry](https://testnet.monadscan.com/address/0x063713eb539f2c9458d4836341ce3a74CF948569) and referral links; payouts through the Merkle distributor are planned |

## Phase 3: Open liquidity and composability (2027-Q1)

Goal: most liquidity comes from outside makers, and outcome tokens are useful outside Hunch Book.

| ID | Deliverable | Why it matters | Status |
|---|---|---|---|
| V-5 | Maker rewards funded from fees, paid for time at the touch and depth, published per maker | Pays for liquidity in proportion to use | building: [MerkleDistributor](https://testnet.monadscan.com/address/0x1872C4AaD2941410F81778467864e113b74Cc2D9) live on testnet; the scorer ([REWARDS.md](./REWARDS.md)) runs as a dry run; no epoch published yet |
| V-6 | **Implied-probability feed**: an onchain view of each market's mid price and time-weighted average, for other protocols to read | Other apps can use "the market's chance funding flips" as an input | live on testnet ([ImpliedProbabilityOracle](https://testnet.monadscan.com/address/0xEc0fCfD5ee0fC6Dd8938B72810697f7BbfdA9134)) |
| V-7 | Outcome tokens as collateral with a partner lending market (haircut set by time to settlement and book depth) | Capital efficiency for hedgers | building: the [price adapter factory](https://testnet.monadscan.com/address/0x348476c0602C3BEfd1064d54636DD791240B508B) is live on testnet; a partner lending market is planned |
| S-6 | **Snapshot settlement** for state that is not readable historically: a permissionless snapshot at the window end with a challenge period, or a Chainlink CRE workflow that attests the value | Many more settleable questions | live on testnet: template 7 ([SnapshotResolver](https://testnet.monadscan.com/address/0x1E62C389D7c035acfDD971C7E6b7157C1D34D632)); [first settlement](https://testnet.monadscan.com/tx/0x8853ced228ce7d6445580bb843da11dfa431c98d57a2a9e7a382e2a4299923a5) |
| S-7 | **Creator-resolved pools**: free-text questions that stay pools (never graduate), with a creator bond and a challenge window | Long-tail questions without exposing traded tokens to a single resolver | not built: it would let a person set an outcome, which the protocol rules out ([design note](./design/creator-resolved-pools.md)) |
| A-13 | Mobile-first swipe feed, shareable market cards | Reach beyond desktop traders | live on testnet ([/feed](https://book.playhunch.xyz/feed) and a share card for every market) |
| A-14 | Listing Hunch Book markets inside the Hunch app | One front door for Hunch users | building: the [feed](https://book.playhunch.xyz/api/v1/feed) and the embeddable market card are live; listing them inside the Hunch app is next |

## Phase 4: Protocol (2027-Q2 →)

| ID | Deliverable | Status |
|---|---|---|
| O-10 | External audit of the vault, market, graduator and router; public report | planned ([AUDIT.md](./AUDIT.md)) |
| O-11 | Template registry with a public review process, so new market types are added without redeploying the core | building: [TemplateTimelock](https://testnet.monadscan.com/address/0xCe858DF2C95851275ed97e9Ba764b22d6394290b) is live on testnet and becomes the guardian by a guardian decision |
| V-8 | Graduation to other venues where an onchain order book exists, with the same pool-first lifecycle | planned ([design note](./design/other-venues.md)) |
| D-3 | Data API: historical implied probabilities and settlement evidence for researchers and funds | live on testnet: [/api/v1](https://book.playhunch.xyz/api/v1/stats) with CSV ([API.md](./API.md)); full history once the indexer is hosted |
| A-15 | Parlays (combinations of outcomes), priced from the underlying books | live on testnet: template 6 and [/parlay](https://book.playhunch.xyz/parlay) |

---

## Utility backlog (ideas not yet scheduled)

Each idea is kept only if it serves a named user. Moved into a phase when it has an owner.

| Idea | Serves | Notes |
|---|---|---|
| "What does the market think?" widget for Perpl's UI | Perp traders | live on testnet: [/embed/funding/MON](https://book.playhunch.xyz/embed/funding/MON) for an iframe and [/api/v1/funding/{asset}](./API.md#get-fundingasset) as JSON; listing it in Perpl's UI is Perpl's call |
| Funding-cost calculator without a wallet | New users | live on testnet: [/calculator](https://book.playhunch.xyz/calculator), linked into the hedge assistant |
| Batch actions (redeem all, claim all) | Active users | live on testnet: "Claim and redeem all" in the portfolio, in one confirmation where the wallet can batch atomically (EIP-5792) and one by one otherwise; `collectAll` in the SDK and `redeem_all` in the MCP server |
| Settlement replay archive | Researchers | live on testnet: [/settlements](https://book.playhunch.xyz/settlements) and [/api/v1/settlements](./API.md#get-settlements), every settlement's read, transaction and check, as JSON or CSV |
| Market health score | Traders | live on testnet: a 0 to 100 score from liquidity, time and source on every card, market page and API answer ([HEALTH.md](./HEALTH.md)) |
| Gas-free first trade for new accounts | New users | Sponsored through the account layer, capped per account |

## How we measure progress

Published on the proof page once live, computed from chain data by the indexer:

- markets created, graduated, settled, voided
- distinct wallets that staked or traded
- trades and volume, split into fills against Hunch's maker and fills between other parties
- time from window end to settlement, and from settlement to redemption
- solvency margin per market (should always be zero or positive)

## What could change this plan

| Risk | Effect | Plan |
|---|---|---|
| Kuru does not create mainnet books for us in time | No mainnet books | Mainnet runs pool-only markets; graduation runs on testnet; ask again with live pool data |
| A source contract changes or stops answering | Markets on that template cannot settle | Each template has a settlement deadline after which the market voids; new markets on that template are paused |
| Thin books after graduation | Wide spreads | Maker bot quotes with published limits; maker kit for outside makers; rewards in Phase 3 |
| A bug in the money path | Loss of user funds | Beta caps, invariant tests, pause of creation and graduation (never of redemption), bug bounty, audit before caps rise |

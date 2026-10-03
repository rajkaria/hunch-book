# Hunch Book roadmap

Last updated: 2026-10-03. Status words used below:

- **planned**: designed, not started
- **building**: in progress
- **live**: deployed and usable (a link or contract address will sit next to it)

Nothing in this file is live yet. The protocol design is in [PROTOCOL.md](./PROTOCOL.md).

## What we are building, in one paragraph

Anyone can start a yes/no market from a template whose answer can be read on the Monad blockchain, such as funding on Perpl or a Pyth price. A new market starts as a **pool**: people stake USDC on YES or NO, with no market maker needed. Once a pool has proven demand, it **graduates**: in one transaction the pool's USDC becomes fully backed YES and NO tokens, split between the people who staked, and the YES token opens as a spot market on **Kuru's onchain order book**. From then on, anyone can sell before the answer is known. When the observation window closes, the market **settles itself** by reading the source contract, and winning tokens redeem for $1.

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
| C-1 | `CollateralVault`: holds USDC, mints and merges complete sets (1 YES + 1 NO = 1 USDC), redeems after settlement, per-market accounting | planned |
| C-2 | `OutcomeToken`: minimal ERC-20 clone per side per market, mint and burn by the vault only | planned |
| C-3 | `Market` (clone per market): state machine (Pool → Graduated → Closed → Settled or Voided), pool stakes, pool settlement and claims | planned |
| C-4 | `HunchBookFactory`: create a market from a template id and parameters, one canonical market per (template, parameters) hash, creator's first stake required | planned |
| S-1 | `PerplFundingResolver`: settles "funding paid by longs between block A and block B is above X" by reading Perpl's historical funding accumulator | planned |
| S-2 | `PythPriceResolver`: settles "price at or above K at time T" from a signed Pyth update published in [T, T + tolerance] | planned |
| O-1 | Foundry project, CI (build, unit, fuzz, invariant tests), `deployments/monad-testnet.json` as the single address source | planned |

Tests that must pass before anything deploys:
- Solvency: for every market, USDC held ≥ complete sets outstanding (+ accrued fees), after every action and under fuzzing.
- Supply: YES supply equals NO supply equals sets outstanding until settlement.
- Pool claims: the sum of all claims never exceeds the pool; rounding dust is accounted, never lost.
- No address can set an outcome by hand.

### 0.2 Graduation and trading on Kuru (target 2026-10-05)

| ID | Deliverable | Status |
|---|---|---|
| C-5 | `Graduator`: when a pool meets the graduation rules, converts it into complete sets, records each staker's token claim, creates the YES/USDC market on Kuru | planned |
| C-6 | `HunchRouter`: buy YES, sell YES, buy NO (mint a pair, sell YES), sell NO (buy YES, merge), all atomic with slippage limits and deadlines; uses a vault flash loan guarded by the solvency invariant | planned |
| V-1 | Kuru integration on testnet: market creation parameters for $0.01–$0.99 outcome tokens, router order calls, fork tests | planned |
| V-2 | Maker bot v0 (open source, address published): quotes both sides of the YES book from a pricing model, inventory limits, cancels everything at close | planned |

Graduation rules (v0 values, set per template and visible on every market):
- pool total at least $500 and at least 10 distinct stakers
- both sides non-empty, and the pool's implied chance between 3% and 97%
- graduation happens before the pool's lock time; anyone may trigger it

### 0.3 End to end on testnet (target 2026-10-06)

| ID | Deliverable | Status |
|---|---|---|
| I-1 | Envio indexer: markets, stakes, graduations, Kuru fills on our books, positions, settlements, redemptions | planned |
| A-1 | App: market list, market page (chance, book depth, rules, source), stake and trade ticket, portfolio with claim and redeem | planned |
| A-2 | Create flow: pick a template, fill parameters, see the exact settlement rule in plain words, make the first stake | planned |
| K-1 | Keeper v0: graduates eligible pools, settles markets at window end | planned |
| O-2 | Golden path run by a person on testnet, including a hard refresh and two different wallets | planned |

### 0.4 Mainnet beta (target 2026-10-07 → 2026-10-08)

| ID | Deliverable | Status |
|---|---|---|
| O-3 | Contracts on Monad mainnet with native USDC; addresses in `deployments/monad-mainnet.json` and the README | planned |
| O-4 | Beta caps: per-market pool cap, per-wallet stake cap, total collateral cap; guardian can pause creation and graduation only (never redemption, never outcomes) | planned |
| V-3 | Graduation to Kuru mainnet. Kuru mainnet market creation is permissioned, so this needs Kuru to authorise the Graduator contract. Until then, mainnet markets run as pools and graduation is shown on testnet | planned |
| A-3 | Mainnet app with explorer links on every action | planned |

### 0.5 Proof and utility (target 2026-10-09 → 2026-10-10)

| ID | Deliverable | Status |
|---|---|---|
| A-4 | **Settlement verifier**: every settled market shows the exact read (contract, function, block, returned value) and a button that re-runs that read from your browser, no wallet needed | planned |
| A-5 | **Proof page**: live counts of markets, wallets, trades and volume, and the share of book fills taken by Hunch's own maker | planned |
| S-3 | **Touch markets** ("will funding turn negative before block B?", "will MON trade above K before T?"): anyone proves YES by pointing at the block or signed price where it happened; NO settles after a 24h window with no proof | planned |
| A-6 | **Hedge assistant v0**: for a wallet with a Perpl position, show the funding it is paying and a market and size that pays out if funding stays high (needs Perpl position reads confirmed) | planned |
| A-7 | Passkey accounts (Mera) next to regular wallets; USDC approval and trade in one confirmation where supported | planned |
| A-8 | Live trade tape: each fill with its block number and the time from signature to inclusion | planned |

### 0.6 Hardening (target 2026-10-11 → 2026-10-13)

| ID | Deliverable | Status |
|---|---|---|
| O-5 | Internal security review: reentrancy, rounding, flash-loan paths, griefing on graduation and settlement, front-running at graduation; Slither clean or each finding explained | planned |
| O-6 | Liveness checks: last settlement, last graduation, keeper balance, maker balance, alerts to a phone | planned |
| O-7 | README with live addresses, setup steps a third party can follow, known limitations | planned |

---

## Phase 1: Live beta (2026-10-14 → 2026-11-03)

Goal: run it with real users and no surprises. Code changes only fix things users can hit.

| ID | Deliverable | Why it matters |
|---|---|---|
| K-2 | **Recurring series**: weekly and daily markets that create themselves (e.g. "BTC funding this week") from a schedule anyone can trigger | A market list that is never empty without manual work |
| K-3 | **Auto-redeem** (opt in): the keeper redeems winning tokens to your wallet after settlement | Winners get paid without coming back to click |
| V-4 | **Maker kit v1**: the maker bot as a package anyone can run with their own capital and model; docs and a test mode | Outside liquidity, so users trade with other people, not with Hunch |
| S-4 | More templates: Perpl open interest and mark price (if historical reads are confirmed), Pyth ranges (between K1 and K2) | More questions traders care about |
| O-8 | Bug bounty with a published scope and payout table | Outside eyes on the money paths |
| O-9 | Status page: contract balances, invariants, keeper and maker health, incident log | Users can see it is solvent at any moment |
| A-9 | Notifications: graduation, big price moves, settlement, redemption ready (Telegram first) | People come back when something happens |

## Phase 2: Trader utility (2026-11 → 2026-12)

Goal: a perp trader opens Hunch Book every week because it saves them money or time.

| ID | Deliverable | Why it matters |
|---|---|---|
| A-10 | **Hedge assistant v1**: reads your Perpl positions, prices the funding you expect to pay, builds a hedge across one or more markets, tracks it until settlement | The named first user's weekly job |
| S-5 | **Ladders**: a family of strikes on one question (funding above 0.01%, 0.02%, 0.03% ...) shown as a probability curve | A market-implied forecast of funding, not one yes/no |
| A-11 | Limit orders, take-profit and stop-loss on outcome tokens, one-click close | Trading tools traders expect |
| A-12 | Portfolio: P&L per market, history export | Bookkeeping |
| D-1 | **TypeScript SDK**: create, stake, trade, redeem, read prices and settlement evidence | Other apps and bots build on it |
| D-2 | **MCP server and agent examples**: agents can find markets, quote, trade and settle with their own wallets | Agents as traders and makers |
| C-7 | Creator earnings: 25% of Hunch's fee on markets you created, claimable onchain; creator page with markets and earnings | People start markets their community trades |
| C-8 | Referral share on fees, bound to a link, time-limited | Growth paid from revenue, not subsidies |

## Phase 3: Open liquidity and composability (2027-Q1)

Goal: most liquidity comes from outside makers, and outcome tokens are useful outside Hunch Book.

| ID | Deliverable | Why it matters |
|---|---|---|
| V-5 | Maker rewards funded from fees, paid for time at the touch and depth, published per maker | Pays for liquidity in proportion to use |
| V-6 | **Implied-probability feed**: an onchain view of each market's mid price and time-weighted average, for other protocols to read | Other apps can use "the market's chance funding flips" as an input |
| V-7 | Outcome tokens as collateral with a partner lending market (haircut set by time to settlement and book depth) | Capital efficiency for hedgers |
| S-6 | **Snapshot settlement** for state that is not readable historically: a permissionless snapshot at the window end with a challenge period, or a Chainlink CRE workflow that attests the value | Many more settleable questions |
| S-7 | **Creator-resolved pools**: free-text questions that stay pools (never graduate), with a creator bond and a challenge window | Long-tail questions without exposing traded tokens to a single resolver |
| A-13 | Mobile-first swipe feed, shareable market cards | Reach beyond desktop traders |
| A-14 | Listing Hunch Book markets inside the Hunch app | One front door for Hunch users |

## Phase 4: Protocol (2027-Q2 →)

| ID | Deliverable |
|---|---|
| O-10 | External audit of the vault, market, graduator and router; public report |
| O-11 | Template registry with a public review process, so new market types are added without redeploying the core |
| V-8 | Graduation to other venues where an onchain order book exists, with the same pool-first lifecycle |
| D-3 | Data API: historical implied probabilities and settlement evidence for researchers and funds |
| A-15 | Parlays (combinations of outcomes), priced from the underlying books |

---

## Utility backlog (ideas not yet scheduled)

Each idea is kept only if it serves a named user. Moved into a phase when it has an owner.

| Idea | Serves | Notes |
|---|---|---|
| "What does the market think?" widget for Perpl's UI | Perp traders | Shows the implied chance funding flips this week |
| Funding-cost calculator without a wallet | New users | Entry point to the hedge assistant |
| Batch actions (redeem all, claim all) | Active users | One transaction for many markets |
| Settlement replay archive | Researchers | Every settlement's inputs, downloadable |
| Market health score | Traders | Depth, spread, time to settlement, source reliability |
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
| Kuru does not authorise mainnet market creation for the Graduator | No mainnet books | Mainnet runs pool-only markets; graduation runs on testnet; ask again with live pool data |
| A source contract changes or stops answering | Markets on that template cannot settle | Each template has a settlement deadline after which the market voids; new markets on that template are paused |
| Thin books after graduation | Wide spreads | Maker bot quotes with published limits; maker kit for outside makers; rewards in Phase 3 |
| A bug in the money path | Loss of user funds | Beta caps, invariant tests, pause of creation and graduation (never of redemption), bug bounty, audit before caps rise |

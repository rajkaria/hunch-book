# Hunch Book architecture

This page shows how the pieces fit: what lives onchain, what runs offchain, how they find each other,
and which of them you have to trust. The protocol rules are in [PROTOCOL.md](./PROTOCOL.md); this page
is the map.

## The short version

- **Money and answers live onchain.** USDC sits in one vault. Outcomes come only from resolvers that read
  other contracts. Nothing offchain can move funds or choose an answer.
- **Everything offchain is a convenience.** The keeper, the maker bot, the indexer, the notifier, the
  watchdog and the app make the protocol pleasant and fast. If all of them stop, anyone can still mint,
  merge, settle (with evidence they fetch themselves) and redeem, straight from the contracts.
- **One address book.** `deployments/<network>.json` is the only source of contract addresses. The deploy
  scripts write it; the app, keeper, maker, indexer, SDK, MCP server, watchdog and docs all read it.

## Layers

```
                      ┌──────────────────────────────────────────────────────────────┐
  people and agents   │  app (Next.js)   SDK   MCP server   examples   data API      │
                      └──────────────┬───────────────────────────────┬───────────────┘
                                     │ transactions                  │ reads
  offchain helpers    ┌──────────────▼──────┐  ┌────────────┐  ┌─────▼──────┐  ┌──────────┐
  (hold no user funds)│ keeper   maker bot  │  │  notifier  │  │  indexer   │  │ watchdog │
                      └──────────────┬──────┘  └────────────┘  └─────▲──────┘  └──────────┘
                                     │                               │ events
  ───────────────────────────────────▼───────────────────────────────┴─────────── Monad ───
  periphery           AutoRedeemer · ConditionalOrders · ReferralRegistry · MerkleDistributor
  (optional)          ImpliedProbabilityOracle · OutcomeTokenPriceAdapter · TemplateTimelock
                      ┌──────────────────────────────────────────────────────────────┐
  core                │ HunchBookFactory → Market clones → CollateralVault → YES/NO  │
                      │ Graduator · HunchRouter                                      │
                      └──────────────┬───────────────────────────────┬───────────────┘
  templates           resolvers 1 to 7 (pure readers)                 │
                      ┌──────────────▼──────┐                 ┌──────▼──────┐
  external sources    │ Perpl · Chainlink · │   venue         │ Kuru order  │
                      │ Pyth                │                 │ book        │
                      └─────────────────────┘                 └─────────────┘
```

## Onchain

### Core ([`contracts/src/core/`](../contracts/src/core))

| Contract | Role | Notes |
|---|---|---|
| `HunchBookFactory` | Creates one market per (template, parameters); keeps the template registry and the beta caps; holds the guardian's limited powers | Deploys the vault in its constructor, so the vault trusts exactly one factory |
| `Market` (clones) | One question: pool ledger, graduation, token claims, settlement, void, pool payouts | Holds no USDC; asks its resolver for the answer |
| `CollateralVault` | Holds every USDC; mints and burns complete sets (1 YES + 1 NO = 1 USDC); redeems; free flash loans guarded by a solvency check | The only contract with user funds |
| `OutcomeToken` (clones) | 6-decimal YES and NO tokens with permit | Minted and burned only by the vault |
| `Graduator` | Gives each market its Kuru YES/USDC book: creates it on testnet, verifies and registers Kuru's on mainnet | Rejects any book whose parameters do not match exactly |
| `HunchRouter` | Buy and sell YES or NO in one transaction through the Kuru book, with a limit and a deadline | Holds nothing between transactions |

### Templates ([`contracts/src/resolvers/`](../contracts/src/resolvers), [TEMPLATES.md](./TEMPLATES.md))

| Id | Question | Source |
|---|---|---|
| 1 | Net funding over a window | Perpl's historical funding accumulator |
| 2 | Price at a time | The Chainlink round that brackets the time (Pyth where Chainlink has no feed) |
| 3 | Price touch | A pointer to the Chainlink round where it happened; NO after a 24-hour challenge |
| 4 | Single funding spike | A pointer to the Perpl funding event; NO after a 24-hour challenge |
| 5 | Price in a range | Same reading as template 2 |
| 6 | Parlay | The legs' own outcomes, read from their market contracts |
| 7 | Open interest or mark price at a time | A permissionless snapshot of Perpl's current state, taken inside a short window after close |

Resolvers hold no funds and no admin keys. They return "unresolved" rather than guessing, and the
market voids at its deadline if no answer ever comes.

### Periphery ([`contracts/src/periphery/`](../contracts/src/periphery), [PERIPHERY.md](./PERIPHERY.md))

Optional contracts that use only public core functions: auto-redeem for opted-in holders, take-profit /
stop-loss / limit orders, referral bindings, Merkle payouts for referral shares and maker rewards, an
implied-probability oracle, a Chainlink-style price adapter for lending markets, and a timelock that can
become the guardian so new templates are public before they go live.

## Offchain

| Component | Path | What it does | Can it hurt users? |
|---|---|---|---|
| Keeper | [`services/keeper`](../services/keeper) | Graduates pools, pushes token claims, settles every template (with proofs for touch and spike markets), voids after deadlines, pays out pools, auto-redeems, executes triggered orders, pokes the oracle, creates recurring series | No: it only calls functions anyone can call |
| Maker bot | [`services/maker`](../services/maker) | Quotes both sides of each graduated book from a pricing model per template; paper mode for testing | Only its own capital; every fill against it is labelled ours |
| Indexer | [`indexer`](../indexer) | Envio HyperIndex over every Hunch Book event and our Kuru books; serves GraphQL | No: read only |
| Notifier | [`services/notifier`](../services/notifier) | Telegram alerts for graduation, settlement, big moves and winnings ready | No: read only |
| Watchdog | [`services/watchdog`](../services/watchdog) | Checks solvency, supply, settlement lag, missed graduations and gas every 30 minutes; opens an issue on problems | No: read only |
| Rewards scorer | [`services/rewards`](../services/rewards) | Scores makers and referrers and writes Merkle epochs for the distributor | No: dry run; a funder publishes epochs |
| App | [`apps/web`](../apps/web) | Markets, trading, create flow, portfolio, verifier, proof, tape, status, hedge assistant, feed, ladders, parlays, rewards | No: every action is a transaction the user signs |
| Relayer routes | `apps/web/src/app/api/` | Small MON drip for new passkey accounts; relays signed USDC stakes | Spends only its own MON; a stake can only go to the market and side the user signed |
| SDK, MCP, data API | [`packages/sdk`](../packages/sdk), [`packages/mcp`](../packages/mcp), `apps/web/src/app/api/v1` | Programmatic access for apps and agents | No: writes are signed by the caller's own key |

## How a market flows through the system

```
create (app or SDK)         factory clones a Market; vault registers YES/NO; creator's first stake
   │
stake (anyone)              USDC moves into the vault's pool ledger for that market
   │
graduate (keeper or anyone) pool becomes complete sets; Graduator creates (testnet) or registers (mainnet)
   │                        the Kuru book; the keeper pushes token claims
trade (anyone)              router trades through Kuru; the maker bot quotes; the indexer records fills
   │
close                       router stops; the maker cancels its orders
   │
settle (keeper or anyone)   the resolver reads its source; the market records the outcome and an
   │                        evidence hash the verifier can recompute from the browser
redeem (holder, or keeper   winners get 1 USDC minus the fixed fee per token; pools pay per PROTOCOL.md §5.2
   for opted-in holders)
```

## Trust boundaries

| You trust | For | You do not trust |
|---|---|---|
| The core and resolver code (open source, tested, reviewed) | Holding funds and applying the rules | Any person to set an outcome |
| The source contracts (Perpl, Chainlink, Pyth) | Reporting the value a template reads | Hunch Book's servers |
| Kuru | Running the order book while a market trades | Kuru for settlement or redemption (they never touch Kuru) |
| The guardian (a multisig on mainnet) | Pausing creation and graduation, adding templates | The guardian for funds or outcomes (it has no such power) |

## Networks

| Network | Status | Collateral | Book creation |
|---|---|---|---|
| Monad testnet (10143) | live | Hunch Book's own mintable test USDC | The Graduator creates each book |
| Monad mainnet (143) | planned ([DEPLOY.md](./DEPLOY.md)) | Circle USDC | Kuru creates each book; anyone registers it |

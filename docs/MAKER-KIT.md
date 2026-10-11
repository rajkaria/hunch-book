# Hunch Book maker kit

Status: **building**. The kit is the same code Hunch Book's own maker runs ([`services/maker`](../services/maker)),
packaged so anyone can run it with their own key and their own capital. Paper mode has run against Monad
testnet's live book; live mode is the bot described in [the maker README](../services/maker/README.md).

A graduated Hunch Book market trades on a Kuru order book: YES against USDC, and NO through the same book
(Hunch Book's router mints or merges complete sets around each trade). A maker rests bids and asks on that
book. This kit prices each market from onchain data, quotes both sides around that price, manages its
inventory by minting and merging complete sets, and leaves every market before it closes.

## Contents

1. [Before you start](#before-you-start)
2. [Set up](#set-up)
3. [Paper mode first](#paper-mode-first)
4. [Go live](#go-live)
5. [Risk limits](#risk-limits)
6. [Every setting](#every-setting)
7. [Pricing models](#pricing-models)
8. [How your fills are counted](#how-your-fills-are-counted)
9. [Maker rewards](#maker-rewards)
10. [Running it as a service](#running-it-as-a-service)

## Before you start

- **Node 22 and pnpm**, or Docker.
- **A key of your own.** Make a fresh key for the bot. It only ever needs MON for gas and the USDC you
  want to quote with. The bot never asks for any other permission.
- **MON for gas.** Monad charges for a transaction's gas limit, not the gas it uses. A requote (cancel
  and place one level a side) is about 0.07 MON at 100 gwei; the first quote on a market, with its
  approvals and minting, about 0.15 MON. The [gas table](../services/maker/README.md#gas) has the
  measured figures.
- **USDC.** Bids are funded with USDC; asks with YES the bot mints from USDC (1 USDC gives 1 YES and
  1 NO). On testnet, Hunch Book's collateral is its own test USDC, which anyone can mint; the smoke
  script can top you up (`--test-usdc`).
- **Understand what you are quoting.** Every market's rule is one sentence on its page and in
  [TEMPLATES.md](./TEMPLATES.md). A YES token pays 1 USDC less a small fee if the answer is YES, and 0 if
  it is NO; a void pays 0.50 per token.

## Set up

From the repository root:

```sh
pnpm install
cp services/maker/.env.example services/maker/.env.maker   # your settings; never commit it
```

The bot loads the file named by `MAKER_ENV_FILE` (or `--env-file <path>`), and only its own variables:
`MAKER_*` and the `MONAD_*` RPC URLs. Variables already set in your environment win. It never prints a
key. [`services/maker/.env.example`](../services/maker/.env.example) lists every variable with its
default.

## Paper mode first

```sh
MAKER_ENV_FILE=services/maker/.env.maker MAKER_MODE=paper pnpm --filter @hunch-book/maker start
```

Paper mode prices and quotes every market exactly as live mode would, but its orders rest only in the
bot's memory, and it never sends a transaction (it needs no key). Each cycle it reads the Kuru `Trade`
events since the last cycle on every book it quotes and works out which of its paper orders those trades
would have hit:

- A taker who sold YES into a bid at price P would have hit a paper bid first only if the paper bid was
  **strictly above** P. A taker who bought from an ask at P would have lifted a paper ask only if it was
  **strictly below** P. A paper quote at the same price as the real order that traded is not filled:
  the bot never assumes it was first in the queue, so paper results lean against you, not for you.
- A trade's size is shared out best price first.
- The paper account starts with `MAKER_PAPER_USDC`. Asks are funded by minting sets, YES and NO pairs
  are merged back, and after a market settles or voids its tokens are redeemed at what the vault pays.

It logs `paper-quote` (what it rests and why), `paper-fill` (each fill, with the real trade it matched),
`paper-merge`, `paper-redeem` and `paper-pnl` (the account: USDC, positions marked at fair value, P&L
against the start). The health snapshot carries the same account under `paper`.

What paper mode cannot tell you: how other traders would react to your quotes being on the book, and
fills against takers who never traded because nothing was quoted where they wanted. On a quiet testnet
book you may see no fills at all.

## Go live

```sh
MAKER_ENV_FILE=services/maker/.env.maker MAKER_ENABLED=1 MAKER_PRIVATE_KEY=... pnpm --filter @hunch-book/maker start
```

(Better: put the key in your environment or the env file, never on a command line.) Live mode sends
only with `MAKER_ENABLED` on and `MAKER_MODE` at `live`. Without the switch it is a dry run: it computes
and logs every quote and simulates every transaction, and sends nothing.

To stop it, press Ctrl-C or send SIGTERM: it cancels every order and withdraws its margin balances
before it exits. `pnpm --filter @hunch-book/maker cancel-all` does the same at any time, finding your
orders by walking each book, so it works after a crash with no local state.

**One copy per key.** Two bots on one key race for nonces and quote against each other.

## Risk limits

| Limit | Setting | What it bounds |
|---|---|---|
| Inventory per market | `MAKER_INVENTORY_CAP` | The most net YES (or net NO) held in one market. Quotes shrink, then stop, on the side that would go past it. |
| Size per level | `MAKER_ORDER_SIZE`, `MAKER_LEVELS` | Tokens per price level, and levels per side (1 to 5). |
| Spread | `MAKER_HALF_SPREAD` | Half the spread before widening. The total is never under 0.02 USDC (2 cents), the protocol's floor. |
| Skew | `MAKER_SKEW` | How far quotes lean against the inventory held, at the cap. |
| Near close | `MAKER_WIDEN_SECONDS`, `MAKER_WIDEN_MAX`, `MAKER_CLOSE_BUFFER_SECONDS` | Spreads widen up to `MAKER_WIDEN_MAX` times over the last hour; every order is cancelled `MAKER_CLOSE_BUFFER_SECONDS` before close. |
| Known answers | none | When a market's answer is fixed before close (a touch already happened, no funding event left), the bot cancels and stops quoting it. |
| Gas | `MAKER_MAX_GAS_PRICE_GWEI`, `MAKER_MAX_GAS_PER_TX` | Never sends above the price, never sets a limit above the cap. |
| Which markets | `MAKER_MARKETS`, `MAKER_TEMPLATES` | Quote only these markets, or only these templates. |

What the bot never does: deposit into the AMM vault Kuru creates next to each book (its curve has no
1 USDC cap, which does not fit a token that ends at 0 or 1), cross the book (a quote that would cross is
moved one tick behind the other side), or take liquidity.

What it cannot prevent: after close, orders other people left on a book can still fill, because Kuru's
book is not Hunch Book's to halt. And between two polls (every `MAKER_POLL_SECONDS`), a fast move in the
source can pick off a resting quote.

## Every setting

| Variable | Default | Meaning |
|---|---|---|
| `MAKER_MODE` | `live` | `live` or `paper`. Paper never sends and needs no key. |
| `MAKER_PAPER_USDC` | `1000` | Paper mode's starting USDC. |
| `MAKER_ENABLED` | off | Live mode's kill switch. Only `1`, `true`, `yes` or `on` turns sending on. |
| `MAKER_PRIVATE_KEY` | none | Your key. Needed only when sending. |
| `MAKER_NETWORK` | `monad-testnet` | `monad-testnet` or `monad-mainnet`; picks `deployments/<network>.json`. |
| `MAKER_RPC_URL` | network default | RPC override; otherwise `MONAD_TESTNET_RPC` or `MONAD_MAINNET_RPC`, then the public RPC. |
| `MAKER_RPC_RPS` | `10` | Requests per second the bot allows itself. Monad's public testnet RPC refuses more than 15. |
| `MAKER_MARKETS` | all | Comma-separated market addresses to quote. |
| `MAKER_TEMPLATES` | all priced | Comma-separated template ids to quote (1 to 7 have models). |
| `MAKER_SNAPSHOT_VOLS` | none | Snapshot markets: annualised volatility per source id over the defaults, as `sourceId=vol` pairs. |
| `MAKER_INVENTORY_CAP` | `100` | Most net YES or NO per market, in tokens. |
| `MAKER_ORDER_SIZE` | `20` | Tokens per price level. |
| `MAKER_LEVELS` | `1` | Price levels per side, 1 to 5. |
| `MAKER_LEVEL_STEP` | `0.01` | Distance between levels, in USDC. |
| `MAKER_HALF_SPREAD` | `0.015` | Half the spread around the reservation price, before widening. |
| `MAKER_SKEW` | `0.02` | How far quotes move when inventory sits at the cap, in USDC. |
| `MAKER_REQUOTE_THRESHOLD` | `0.005` | Fair value or best-price move that triggers a requote, in USDC. |
| `MAKER_HEARTBEAT_SECONDS` | `300` | Smaller changes wait at most this long. |
| `MAKER_POLL_SECONDS` | `10` | Time between passes over all markets. |
| `MAKER_CLOSE_BUFFER_SECONDS` | `120` | Leave a market this long before its close. |
| `MAKER_WIDEN_SECONDS` | `3600` | Start widening this long before close. |
| `MAKER_WIDEN_MAX` | `3` | Spread multiplier at close. |
| `MAKER_MAX_GAS_PRICE_GWEI` | `200` | Never send above this base fee, never bid above it. |
| `MAKER_MAX_GAS_PER_TX` | `3000000` | Upper bound on any transaction's gas limit. |
| `MAKER_DUST` | `1` | Tokens: the smallest USDC float kept in the margin account, and the smallest withdraw or merge worth a transaction. Above it, the float is one bid ladder's worth of USDC, so a requote needs no deposit; idle USDC is withdrawn only past twice the float. |
| `MAKER_HEALTH_FILE` | `services/maker/health.json` | Where the health snapshot is written after every pass. |
| `MAKER_HEALTH_PORT` | none | When set, the snapshot is also served at `GET /health`. |
| `MAKER_ENV_FILE` | repository `.env` | The env file to load. |

## Pricing models

Each model is a pure function in [`services/maker/src/pricing`](../services/maker/src/pricing), tested on
data recorded from Monad mainnet with the capture script (`pnpm --filter @hunch-book/maker
capture-fixtures [--only name]`). Fair value is the chance of YES; quotes sit around it.

| Template | Model | Inputs |
|---|---|---|
| 1, Perpl net funding | Funding paid so far in the window plus the latest interval's funding for every event left; the uncertainty is the perp's own history of errors of that same forecast. | `getFundingSumAtBlock` on Perpl's funding grid |
| 2, price at a time | Lognormal price with no drift: the chance it ends at or above the strike. | Spot and realised volatility from the feed's last 300 Chainlink rounds |
| 3, price touch | The chance a driftless lognormal price reaches the strike in [T1, T2] (closed form). Before the window opens, averaged over where the price may be at T1. The barrier is moved away from spot by exp(0.5826 σ √Δt), Δt the feed's average time between rounds, because a move that never makes it into a round is not a touch. A touch already in a round of the window makes it 1. | As template 2, plus the feed's round spacing |
| 4, Perpl funding spike | The share of past stretches of as many funding events as are left in which one single-interval increment was above the threshold. Funding stays at Perpl's clamp for hours, and whole stretches keep that persistence. With too little history, 1 − (1 − q)^n with q the share of single events above the threshold, flagged as assuming independent events. A spike already in the window makes it 1. | Perpl's single-interval increments |
| 5, price range | The chance of ending at or above the lower bound minus the chance of ending at or above the upper one. | As template 2 |
| 6, parlay | The product of the legs' chances, **flagged as assuming the legs are independent**. Each leg's chance is its book's mid when it has a two-sided book, otherwise the model for its template. A leg settled NO makes it 0; a voided leg makes it 0.50 unless another leg can still settle NO. | Each leg's book and model |
| 7, snapshot | Lognormal value with no drift, as template 2, from the value the resolver reads now. A snapshot source keeps no history onchain, so the volatility is a prior per source: mark price BTC 50%, ETH 65%, SOL 80%, MON 120% a year; open interest and other sources 100%; `MAKER_SNAPSHOT_VOLS` overrides it. Below comparators are one minus the above chance. A stored snapshot makes it 1 or 0. | The resolver's `currentValue`, `source` and `snapshotFor` |

Markets settled by Pyth prices (assets with no Chainlink feed on the network) are not quoted: historical
Pyth updates need an API key. A feed that has not reported for an hour is treated as stopped.

Every `quote` log line carries the model's inputs and its assumptions, so you can check a price by hand.
To use your own model, change the function for the template in `src/fair.ts`; the quoting, funding and
unwinding code does not depend on how fair value is computed.

## How your fills are counted

The indexer ([docs/INDEXER.md](./INDEXER.md)) records every fill on a Hunch Book market's Kuru book as a
`Trade`: the resting order's owner is the maker, and the taker (or, for trades through Hunch Book's
router, the wallet that sent the transaction) is the trader. Only `wallets.maker` in
[`deployments/<network>.json`](../deployments) is labelled as Hunch Book's maker (`isOurMaker`); the proof
page shows the share of fills and volume against that address separately from everything else. A fill
against your address counts as outside liquidity: neither side is one of Hunch Book's wallets, so it is
in the "between other parties" figures.

When the bot runs from an address other than `wallets.maker` it logs `outside-maker` at startup, saying
exactly that.

## Maker rewards

Status: **planned**. The formula is published with the payout contract in
[docs/PERIPHERY.md](./PERIPHERY.md#the-maker-reward-formula-v-5); the scorer that will compute each
epoch from the books is being built (`services/rewards`), and no rewards are paid yet. In short:

1. Once a minute, every resting order on each graduated market's book and the book's mid are sampled.
2. An order within a band B of the mid (planned: 0.03 USDC) scores its size × ((B − distance) / B)²: full
   size at the mid, nothing at the edge of the band.
3. Per sample, a maker's score is max(min(bids, asks), max(bids, asks) / 3): quoting both sides earns up
   to three times as much as quoting one.
4. Each epoch, a market's reward pool is split in proportion to the sum of those scores, and paid through
   the MerkleDistributor, which anyone can claim from for you.

Hunch Book's own maker is excluded from rewards and its share is not redistributed. So the kit's defaults
(one level a side, tight spreads, both sides quoted) are what the formula pays for; quoting one side only,
or far from the mid, earns little.

## Running it as a service

The package has a [`Dockerfile`](../services/maker/Dockerfile) (Node 22, only the maker and the shared
package, non-root, one process so SIGTERM reaches the bot) and a Railway config. From the repository
root:

```sh
docker build -f services/maker/Dockerfile -t hunch-book-maker .
docker run --env-file services/maker/.env.maker -p 8080:8080 hunch-book-maker
```

Give it at least 90 seconds to stop: on SIGTERM it cancels every order and withdraws its margin first.
[ops/README.md](../ops/README.md) covers launchd and Railway.

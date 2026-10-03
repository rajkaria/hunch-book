# Hunch Book

> Prediction markets on Monad that start as pools, move to Kuru's onchain order book once people show up, and pay out by reading the chain. No one decides the answer by hand.

**Status (2026-10-03): design stage.** The protocol spec and roadmap are written. Nothing is deployed yet. Contracts go to Monad testnet next. This page will list every live address and transaction as each piece ships.

## The problem

Prediction markets today make you pick one of two compromises:

- **Pools** (parimutuel betting) work from the first dollar, because nobody has to make a market. But your money is stuck until the answer arrives, and someone has to be trusted to settle.
- **Order books** let you sell any time. But a new market's book is empty until a market maker shows up, so the big venues match orders on their own servers and pay makers to quote.

And on both, an operator usually decides the outcome.

## Who it's for

A trader on Perpl (Monad's perpetuals exchange) who holds a BTC long and pays funding every hour. They want a cheap way to get paid back if funding stays high this week, and to close that hedge whenever they like.

## How it works

1. **Start a market from a template.** The question is one the chain can answer, for example: "Will BTC longs pay shorts on net on Perpl this week?" or "Will MON be at or above $0.035 at 12:00 UTC on Friday?" The creator makes the first stake.
2. **Pool phase.** People stake USDC on YES or NO. The pool's split is the market's chance. No market maker needed.
3. **Graduation.** When a pool has proven demand (v0 rule: at least $500 from at least 10 wallets), one transaction turns it into fully backed YES and NO tokens (1 YES + 1 NO is always backed by 1 USDC) and splits them between the people who staked, so each staker's payout is exactly what the pool would have paid. The YES token then opens as a YES/USDC market on Kuru's order book at the pool's price.
4. **Trade.** Buy or sell YES or NO at any time on the book. Buying NO mints a pair and sells the YES; selling NO buys YES and redeems the pair. One transaction each.
5. **Settlement.** When the observation window ends, anyone can trigger settlement. The resolver reads the answer from the source contract (Perpl's historical funding accumulator, or Chainlink's onchain price feed). Winning tokens redeem for 1 USDC.

Markets whose pool never reaches the graduation rule stay pools and settle as pools.

## Why Monad

- **Kuru** is a fully onchain order book on Monad. A market can graduate into a real book that anyone can quote, not into an offchain matching engine.
- **Perpl** keeps its funding history onchain, readable by block, so a market can settle from it without an oracle committee or a keeper we run.
- Blocks every ~0.3 seconds and low fees make it affordable to give a $500 market its own order book and to re-quote it every block.

## What's in this repo

| Path | What |
|---|---|
| [docs/PROTOCOL.md](./docs/PROTOCOL.md) | Full protocol and product spec: lifecycle, contracts, settlement, fees, risks |
| [docs/ROADMAP.md](./docs/ROADMAP.md) | Phased roadmap with deliverable IDs and exit criteria |
| [SECURITY.md](./SECURITY.md) | Trust model, invariants, how to report a vulnerability |
| [CLAUDE.md](./CLAUDE.md) | Working rules for contributors and coding agents |

Code directories (`contracts/`, `apps/web/`, `services/`, `indexer/`, `packages/`) appear as each part lands.

## What's live

| Piece | Status |
|---|---|
| Contracts on Monad testnet | planned |
| Contracts on Monad mainnet (USDC) | planned |
| Graduation to Kuru | planned (mainnet market creation on Kuru needs Kuru's authorisation) |
| App | planned |

## Prior work and disclosure

Hunch Book is a new codebase started on 2026-10-03. It builds on ideas, not code, from [Hunch](https://playhunch.xyz), the founder's existing prediction-market product: parimutuel pools, the fee rule (a share of winnings, never more than the losing side), and Hunch Bazaar's creator markets. Anything reused from earlier code will be named here when it lands.

AI coding tools are used to build this project (Claude Code). Every change is reviewed and tested before it is merged.

## License

[MIT](./LICENSE)

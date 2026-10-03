# Hunch Book

> Prediction markets on Monad that start as pools, move to Kuru's onchain order book once people show up, and pay out by reading the chain. No one decides the answer by hand.

**Status (2026-10-03): live on Monad testnet, building toward mainnet.** The contracts are deployed on Monad testnet and the first market has graduated into its own Kuru order book. Nothing is on mainnet yet. Every claim below links to an address or a transaction.

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
| [contracts/](./contracts) | Foundry: the vault, outcome tokens, market, factory, resolvers, graduator and router, with unit, fuzz, invariant and fork tests |
| [apps/web/](./apps/web) | The Next.js app at [book.playhunch.xyz](https://book.playhunch.xyz) |
| [packages/shared/](./packages/shared) | ABIs generated from the contracts, the address loader, chain configs, payout math |
| [services/maker/](./services/maker) | The open-source maker bot that quotes graduated markets on Kuru |
| [deployments/](./deployments) | The only source of addresses: `monad-testnet.json`, `monad-mainnet.json` |
| [docs/PROTOCOL.md](./docs/PROTOCOL.md) | Full protocol and product spec: lifecycle, contracts, settlement, fees, risks |
| [docs/ROADMAP.md](./docs/ROADMAP.md) | Phased roadmap with deliverable IDs and exit criteria |
| [SECURITY.md](./SECURITY.md) | Trust model, invariants, how to report a vulnerability |
| [CLAUDE.md](./CLAUDE.md) | Working rules for contributors and coding agents |

## Run it yourself

```bash
git clone --recurse-submodules https://github.com/rajkaria/hunch-book && cd hunch-book
cd contracts && forge test                      # unit, fuzz and invariant tests (Foundry 1.8 or later)
FOUNDRY_PROFILE=fork forge test                 # fork tests against live Monad testnet and mainnet
cd .. && pnpm install && pnpm test && pnpm build  # shared package and app (Node 22, pnpm 10)
```

The fork tests read real Perpl funding, real Chainlink rounds and a real Pyth update, and run the whole lifecycle (create, stake, graduate into a new Kuru book, trade all four ways, settle, redeem) against Kuru's live testnet contracts.

## What's live

| Piece | Status | Proof |
|---|---|---|
| Contracts on Monad testnet | live | [factory](https://testnet.monadscan.com/address/0x2c30da53F8C384D6eD6603E3138a98fd15E4928A), [vault](https://testnet.monadscan.com/address/0x81b04B3567dcaDaE6a859394248C47ddc403ba37), [router](https://testnet.monadscan.com/address/0xB9D22C84c5e2F4329EEee1B52Ad753dF3268c2a6); all addresses and deploy transactions in [deployments/monad-testnet.json](./deployments/monad-testnet.json); source verified on Sourcify |
| Graduation into a Kuru book (testnet) | live | market #1 [graduated](https://testnet.monadscan.com/tx/0xbc9524391134b6a3cba94f33daba323075ff0db030a8d51563d89ee94fcf8d01) into Kuru book [0xdFd0…104a](https://testnet.monadscan.com/address/0xdFd060ac7d3b129261EaB2E3DDd6F76A877D104a). Its pool was filled by our own wallets to meet the rule. |
| Trading YES and NO through the router (testnet) | live | on market #1: [buy YES](https://testnet.monadscan.com/tx/0x64e40cdb81d82301412c84b15586791a59fe21dd291503877054ce0977846ced), [sell YES](https://testnet.monadscan.com/tx/0xd812065e5e64bf2faf44d7111219a56cc0cbcb95f2f03fee6a30da83d3b2cb69), [buy NO](https://testnet.monadscan.com/tx/0xa23645f27ee8cc3bf51ccd6f65bbb545824e3555a4bec957b45be2870cb9ecab), [sell NO](https://testnet.monadscan.com/tx/0xafbee312a270e29d2218bf89890f0d8bc55658e1a9df07b4713113e30b14c72d). These trades came from our own wallet. |
| Open-source maker bot ([services/maker](./services/maker)) | live, not yet running all the time | its first quotes on market #1 rest on the book ([tx](https://testnet.monadscan.com/tx/0xc484a70a81232b5b4e61ad8fe201e308638278bd25c204f008d3be5c4f909757)); its address [0x0f11…232A](https://testnet.monadscan.com/address/0x0f1156Eb25DBebee5386EC80F1EB0B85C7dD232A) is ours and every fill against it counts as ours |
| App | building | [book.playhunch.xyz](https://book.playhunch.xyz) lists testnet markets and can stake; trading in the app comes next |
| Contracts on Monad mainnet (USDC) | planned | on mainnet, Kuru creates each book (its market creation is owner-only) |

## Prior work and disclosure

Hunch Book is a new codebase started on 2026-10-03. It builds on ideas, not code, from [Hunch](https://playhunch.xyz), the founder's existing prediction-market product: parimutuel pools, the fee rule (a share of winnings, never more than the losing side), and Hunch Bazaar's creator markets. Anything reused from earlier code will be named here when it lands.

AI coding tools are used to build this project (Claude Code). Every change is reviewed and tested before it is merged.

## License

[MIT](./LICENSE)

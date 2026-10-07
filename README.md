# Hunch Book

> Prediction markets on Monad that start as pools, move to Kuru's onchain order book once people show up, and pay out by reading the chain. No one decides the answer by hand.

**Status (2026-10-06): live on Monad testnet, mainnet planned.** The whole lifecycle runs on Monad testnet: create a market from seven templates, stake, graduate into a real Kuru order book, trade YES and NO, settle from Perpl or Chainlink, verify the read from your browser, and redeem. Nothing is on mainnet yet; the launch is rehearsed end to end on a fork of Monad mainnet. Every claim below links to an address or a transaction.

**Try it:** [book.playhunch.xyz](https://book.playhunch.xyz) (testnet: get test USDC from the wallet menu, MON from [faucet.monad.xyz](https://faucet.monad.xyz)).

## The problem

Prediction markets today make you pick one of two compromises:

- **Pools** (parimutuel betting) work from the first dollar, because nobody has to make a market. But your money is stuck until the answer arrives, and someone has to be trusted to settle.
- **Order books** let you sell any time. But a new market's book is empty until a market maker shows up, so the big venues match orders on their own servers and pay makers to quote.

And on both, an operator usually decides the outcome.

## Who it's for

A trader on Perpl (Monad's perpetuals exchange) who holds a BTC long and pays funding every hour. They want a cheap way to get paid back if funding stays high this week, and to close that hedge whenever they like. The app's [hedge assistant](https://book.playhunch.xyz/hedge) reads their Perpl position, projects the funding they will pay and sizes a matching market.

## How it works

1. **Start a market from a template.** The question is one the chain can answer, for example: "Will BTC longs pay more than $2 per BTC in funding on Perpl this week?" or "Will MON be at or above $0.035 at 12:00 UTC on Friday?" The app shows the exact rule the contract will apply before you commit. The creator makes the first stake and earns 25% of the fees.
2. **Pool phase.** People stake USDC on YES or NO. The pool's split is the market's chance. No market maker needed.
3. **Graduation.** When a pool has proven demand (v0 rule: at least 500 USDC from at least 10 wallets), one transaction turns it into fully backed YES and NO tokens (1 YES + 1 NO is always backed by 1 USDC) and splits them between the people who staked, so each staker's payout is exactly what the pool would have paid. The YES token opens as a YES/USDC market on Kuru's order book at the pool's price.
4. **Trade.** Buy or sell YES or NO at any time on the book, in one transaction each. Buying NO mints a pair and sells the YES; selling NO buys YES and redeems the pair. Take-profit, stop-loss and limit orders are optional.
5. **Settlement.** When the observation window ends, anyone can settle. The resolver reads the answer from the source contract: Perpl's historical funding, a Chainlink round, a Pyth update, or the outcomes of other markets. The app's verifier re-runs that exact read from your browser, no wallet needed. Winning tokens redeem for 1 USDC minus a fee fixed at graduation (at most 1.94 cents).

Markets whose pool never reaches the graduation rule stay pools and settle as pools.

## Why Monad

- **Kuru** is a fully onchain order book on Monad. A market graduates into a real book that anyone can quote, not into an offchain matching engine.
- **Perpl** keeps its funding history onchain, readable by block, so a market can settle from it without an oracle committee or a keeper we run.
- Blocks about every 0.3 seconds and low fees make it affordable to give a 500 USDC market its own order book and to re-quote it as prices move.

## Templates

| Id | Question | Settles from | Status |
|---|---|---|---|
| 1 | Will longs pay more than X in funding on a Perpl perp over a window? | Perpl's funding history | live on testnet |
| 2 | Will an asset be at or above K at time T? | The Chainlink round that brackets T (Pyth where Chainlink has no feed) | live on testnet |
| 3 | Will an asset reach (or fall to) K at any time in a window? | A pointer to the Chainlink round where it happened | live on testnet |
| 4 | Will any single Perpl funding event in a window charge more than X? | A pointer to that funding event | live on testnet |
| 5 | Will an asset be inside a range at time T? | The bracketing Chainlink round | live on testnet |
| 6 | Will all of 2 to 5 markets settle YES (a parlay)? | The legs' own outcomes | live on testnet |
| 7 | Will Perpl open interest or mark price be above K at time T? | A snapshot of Perpl's state taken right after close | live on testnet ([first settlement](https://testnet.monadscan.com/tx/0x8853ced228ce7d6445580bb843da11dfa431c98d57a2a9e7a382e2a4299923a5), 13 seconds after close) |

Every rule, edge case and source is in [docs/TEMPLATES.md](./docs/TEMPLATES.md).

## What's live

All on Monad testnet. Activity by our own wallets (the deployer, the keeper, the maker bot and the seed wallets) is ours and labelled as ours everywhere it is counted.

| Piece | Status | Proof |
|---|---|---|
| Core contracts | live on testnet | [factory](https://testnet.monadscan.com/address/0x2c30da53F8C384D6eD6603E3138a98fd15E4928A), [vault](https://testnet.monadscan.com/address/0x81b04B3567dcaDaE6a859394248C47ddc403ba37), [router](https://testnet.monadscan.com/address/0xB9D22C84c5e2F4329EEee1B52Ad753dF3268c2a6), [graduator](https://testnet.monadscan.com/address/0x7DC80DB34762A996aae6Ce516F562B2e6142fFE3); every address and deploy transaction in [deployments/monad-testnet.json](./deployments/monad-testnet.json); source verified on Sourcify |
| Templates 1 to 7 | live on testnet | resolver addresses in [docs/TEMPLATES.md](./docs/TEMPLATES.md), each registered on the factory; a snapshot market (template 7) was [settled by the keeper](https://testnet.monadscan.com/tx/0x8853ced228ce7d6445580bb843da11dfa431c98d57a2a9e7a382e2a4299923a5) 13 seconds after it closed; demo markets in [docs/FACTS.md](./docs/FACTS.md#demo-markets-ours) |
| Periphery (auto-redeem, orders, referrals, payouts, oracle, price adapter, timelock) | live on testnet | addresses in [docs/PERIPHERY.md](./docs/PERIPHERY.md) |
| Graduation into a Kuru book | live on testnet | market #1 [graduated](https://testnet.monadscan.com/tx/0xbc9524391134b6a3cba94f33daba323075ff0db030a8d51563d89ee94fcf8d01) into Kuru book [0xdFd0…104a](https://testnet.monadscan.com/address/0xdFd060ac7d3b129261EaB2E3DDd6F76A877D104a). Its pool was filled by our own wallets to meet the rule. |
| Trading YES and NO through the router | live on testnet | on market #1: [buy YES](https://testnet.monadscan.com/tx/0x64e40cdb81d82301412c84b15586791a59fe21dd291503877054ce0977846ced), [sell YES](https://testnet.monadscan.com/tx/0xd812065e5e64bf2faf44d7111219a56cc0cbcb95f2f03fee6a30da83d3b2cb69), [buy NO](https://testnet.monadscan.com/tx/0xa23645f27ee8cc3bf51ccd6f65bbb545824e3555a4bec957b45be2870cb9ecab), [sell NO](https://testnet.monadscan.com/tx/0xafbee312a270e29d2218bf89890f0d8bc55658e1a9df07b4713113e30b14c72d), all from our own wallet |
| Settlement and redemption | live on testnet | market #1 [settled NO](https://testnet.monadscan.com/tx/0x2d53ad4c3cb322c34447839a8beea8cc3dc208c1c8fa1930fc06cab96b20fc72) by the keeper (late: see the [incident log](./docs/INCIDENTS.md)), then our maker bot [redeemed](https://testnet.monadscan.com/tx/0x40b82c5fa558c48297b3bfc635ab952f11052f30034d62b8df1de751b768e518) its NO tokens; a touch market [settled YES from a Chainlink round](https://testnet.monadscan.com/tx/0xd1ec7102a1660a963dd1fa0442394168cf9b9f488ed73bc763c69adae40707f4) |
| Maker bot ([services/maker](./services/maker)) | live on testnet | quoting market #1 from [0x0f11…232A](https://testnet.monadscan.com/address/0x0f1156Eb25DBebee5386EC80F1EB0B85C7dD232A) (ours); open source, with a [maker kit](./docs/MAKER-KIT.md) for outside makers |
| Keeper ([services/keeper](./services/keeper)) | live on testnet | running from [0x1f5A…5569](https://testnet.monadscan.com/address/0x1f5AC9bB0DF7d0E0DD133cBd71388e1078475569) (ours): graduates, settles, proves touches and spikes, voids, pays out, auto-redeems, executes orders, pokes the oracle, creates recurring markets |
| App | live on testnet | [book.playhunch.xyz](https://book.playhunch.xyz): markets with a health score, trading, create flow, portfolio with P&L and one-confirmation claim-all, verifier, settlement archive, proof page, trade tape, status, hedge assistant with baskets, funding-cost calculator, feed, ladders, parlays, rewards, passkey accounts |
| Data API and embed | live on testnet | [/api/v1/stats](https://book.playhunch.xyz/api/v1/stats), [/api/v1/feed](https://book.playhunch.xyz/api/v1/feed), [/api/v1/settlements](https://book.playhunch.xyz/api/v1/settlements), [/embed/funding/MON](https://book.playhunch.xyz/embed/funding/MON), [docs/API.md](./docs/API.md) |
| Liveness checks | live | the [watchdog](./services/watchdog) runs every 30 minutes on GitHub Actions |
| Indexer ([indexer](./indexer)) | building | built and tested; hosting waits for an Envio account |
| SDK and MCP server | building | [docs/SDK.md](./docs/SDK.md), [docs/MCP.md](./docs/MCP.md); packed, installed and imported from their tarballs in CI, not on npm yet ([docs/RELEASE.md](./docs/RELEASE.md)) |
| Kuru v2 books | building | a second testnet stack on Kuru v2 with templates 1 to 7 and the periphery, source verified on Sourcify ([factory 0xd699…125A](https://testnet.monadscan.com/address/0xd6994DD479d845F1ea039b6322fBE00c12Ea125A)): its market #1 ([0x8565…7343](https://testnet.monadscan.com/address/0x85658Be96Ba2663AF6280834B16c7e340c727343)) waits for Kuru to create its book; tested against Kuru's live v2 contracts on a fork ([PROTOCOL.md §8.1](./docs/PROTOCOL.md#81-kuru)) |
| Contracts on Monad mainnet (Circle USDC) | planned | rehearsed on a mainnet fork ([docs/DEPLOY.md](./docs/DEPLOY.md)); Kuru creates each mainnet book |

## Known limitations

- **Testnet only.** Nothing is on Monad mainnet yet. The deploy waits for a guardian multisig, and
  graduation on mainnet waits for Kuru to create each book: mainnet book creation is owner-only at Kuru,
  and Kuru has asked us to use its v2 contracts, which are not on mainnet yet. Our v2 integration runs on
  testnet as a second stack, waiting for Kuru to create its first v2 book. Until v2 is on mainnet a
  mainnet launch would run pools only and say so.
- **Kuru v2 fills do not name their makers,** so they are counted apart, never as our maker's or as
  fills between other parties.
- **Our wallets made the activity.** Every testnet market so far was created and seeded by our own
  wallets (the deployer, the keeper's recurring series, the seed wallets), and our maker bot is the only
  maker. All of it is labelled as ours.
- **The keeper and maker run on one machine.** If it is off, settlement and graduation wait (anyone can
  still call `settle` or `graduate`; nothing is lost). See the [incident log](./docs/INCIDENTS.md).
- **No indexer is hosted yet,** so the app reads the chain directly and trade history is limited to
  recent blocks.
- **Testnet Chainlink feeds update about once a day,** so price markets on testnet can void; they are
  shown working on mainnet forks.
- **The snapshot template (7) has no challenge period:** the first snapshot taker picks the block
  inside a short window ([TEMPLATES.md](./docs/TEMPLATES.md)).
- **Passkey gas and relayed stakes** need a relayer key that is not set, and the Telegram notifier is not
  running.
- **No external audit yet:** an internal review and Slither ([SECURITY-REVIEW.md](./docs/SECURITY-REVIEW.md)).

## What's in this repo

| Path | What |
|---|---|
| [contracts/](./contracts) | Foundry: core (vault, tokens, market, factory, graduator, router), seven resolvers, the periphery, with unit, fuzz, invariant and fork tests |
| [apps/web/](./apps/web) | The Next.js app at [book.playhunch.xyz](https://book.playhunch.xyz), with the data API and the embed |
| [packages/shared/](./packages/shared) | ABIs generated from the contracts, the address loader, template codecs, router and Kuru math |
| [packages/sdk/](./packages/sdk) | TypeScript SDK: reads, quotes, every action, settlement evidence and verification |
| [packages/mcp/](./packages/mcp) | MCP server so agents can find, quote, trade, settle and redeem |
| [services/keeper/](./services/keeper) | The keeper |
| [services/maker/](./services/maker) | The open-source maker bot and maker kit |
| [services/notifier/](./services/notifier) | Telegram alerts |
| [services/watchdog/](./services/watchdog) | Liveness checks |
| [services/rewards/](./services/rewards) | Maker reward and referral scoring into Merkle epochs |
| [indexer/](./indexer) | Envio HyperIndex over every Hunch Book event and our Kuru books |
| [examples/](./examples) | A read-only script, a small trading agent and MCP config |
| [deployments/](./deployments) | The only source of addresses: `monad-testnet.json`, `monad-mainnet.json` |
| [ops/](./ops) | Running the keeper and the maker on a Mac, under launchd, or on Railway |

## Documentation

| Read this | To learn |
|---|---|
| [PROTOCOL.md](./docs/PROTOCOL.md) | The full design: lifecycle, economics, settlement, contracts, security |
| [ARCHITECTURE.md](./docs/ARCHITECTURE.md) | How the pieces fit, and what you have to trust |
| [TEMPLATES.md](./docs/TEMPLATES.md) | Every template's exact rule, source, timing and evidence |
| [PERIPHERY.md](./docs/PERIPHERY.md) | Auto-redeem, orders, referrals, payouts, the oracle, the price adapter, the timelock |
| [GOLDEN-PATH.md](./docs/GOLDEN-PATH.md) | Walk the whole lifecycle on testnet with two browser wallets |
| [ACCOUNTS.md](./docs/ACCOUNTS.md), [HEDGE.md](./docs/HEDGE.md), [HEALTH.md](./docs/HEALTH.md), [NOTIFICATIONS.md](./docs/NOTIFICATIONS.md) | Passkey accounts and gas, the hedge assistant and calculator, market health, alerts |
| [SDK.md](./docs/SDK.md), [MCP.md](./docs/MCP.md), [API.md](./docs/API.md), [RELEASE.md](./docs/RELEASE.md) | Building on Hunch Book, and how the npm packages are released |
| [MAKER-KIT.md](./docs/MAKER-KIT.md), [REWARDS.md](./docs/REWARDS.md), [SERIES.md](./docs/SERIES.md) | Running a maker, rewards, recurring markets |
| [INDEXER.md](./docs/INDEXER.md), [DEPLOY.md](./docs/DEPLOY.md), [ops/README.md](./ops/README.md), [INCIDENTS.md](./docs/INCIDENTS.md) | Operating it, and what went wrong |
| [SECURITY-REVIEW.md](./docs/SECURITY-REVIEW.md), [AUDIT.md](./docs/AUDIT.md), [BUG-BOUNTY.md](./docs/BUG-BOUNTY.md), [SECURITY.md](./SECURITY.md) | Security |
| [ROADMAP.md](./docs/ROADMAP.md), [FACTS.md](./docs/FACTS.md) | What ships when, and where every number comes from |

## Run it yourself

```bash
git clone --recurse-submodules https://github.com/rajkaria/hunch-book && cd hunch-book
pnpm install                                     # Node 22 or later, pnpm 10
bash scripts/verify-all.sh                       # the full gate: contracts, ABIs, TypeScript, build, public boundary
cd contracts && FOUNDRY_PROFILE=fork forge test  # fork tests against live Monad testnet and mainnet (Foundry 1.8 or later)
pnpm --filter @hunch-book/web dev                # the app on http://localhost:3000, reading Monad testnet
```

The fork tests read real Perpl funding, real Chainlink rounds and a real Pyth update, run the whole lifecycle against Kuru's live testnet contracts, and rehearse the mainnet launch on a fork of Monad mainnet with Circle USDC.

Build on it:

```ts
import { createHunchClient } from "@hunch-book/sdk";
const hunch = createHunchClient({ network: "monad-testnet" });
const { markets } = await hunch.markets.list({ limit: 10 });
```

## Prior work and disclosure

Hunch Book is a new codebase started on 2026-10-03. It builds on ideas, not code, from [Hunch](https://playhunch.xyz), the founder's existing prediction-market product: parimutuel pools, the fee rule (a share of winnings, never more than the losing side), creator markets and the visual design. Anything reused from earlier code will be named here when it lands.

AI coding tools are used to build this project (Claude Code). Every change is tested before it is merged.

## License

[MIT](./LICENSE)

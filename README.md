# Hunch Book

> Prediction markets on Monad that start as USDC pools and graduate to Kuru's onchain order book. A pool works from the first dollar; once it proves demand, one transaction turns it into fully backed YES and NO tokens on their own Kuru book, so you can sell before the answer. Every market pays out by reading the chain. No one decides the answer by hand.

**Status (2026-10-12):** live on Monad mainnet and Monad testnet.

- **Mainnet:** contracts and all seven templates live with Circle USDC. [Market #1](https://monadscan.com/address/0x11075eeC0d115b7aB754F54bcf79Fc5A5dc0F511) asks whether BTC/USD is at or above $83,500 at 07:00 UTC on 2026-10-12, and settles itself from Chainlink. We created it and seeded it from our own labelled wallets ([tx](https://monadscan.com/tx/0x72caf4b41b17563b7668d06a1418a78849107319d070619fcbe3b8c7e6de8ea6)).
- **Testnet:** the whole lifecycle on Kuru v1: create, stake, graduate into a Kuru book created in the same transaction, trade YES and NO, settle from Perpl or Chainlink, verify, redeem. Latest settlements (ours): [#11](https://testnet.monadscan.com/tx/0x9346cda9cdd4da363a702c2b4e9dba815170934afcc1245ec21b1e88dca6aa8d) and [#12](https://testnet.monadscan.com/tx/0x1b4419e0299dcc81d3cc785899f73968a13800a57b3584e9efe5b4a75318db3a), both NO, read from Perpl's funding history at 03:00 UTC on 2026-10-12.

**Try it:** [book.playhunch.xyz](https://book.playhunch.xyz). Every market on Kuru: [book.playhunch.xyz/kuru](https://book.playhunch.xyz/kuru). On testnet, take test USDC from the wallet menu and MON from [faucet.monad.xyz](https://faucet.monad.xyz). Read pages need no wallet.

Every claim below links to an address or a transaction. Activity by our own wallets (the deployer, the keeper, the maker bot and the seed wallets) is labelled as ours wherever it is counted.

---

## Contents

1. [Why we built Hunch Book](#why-we-built-hunch-book)
2. [The idea](#the-idea)
3. [How it changes prediction markets](#how-it-changes-prediction-markets)
4. [How it works](#how-it-works)
5. [Who pays whom](#who-pays-whom)
6. [Why Monad](#why-monad)
7. [Hunch Book on Kuru](#hunch-book-on-kuru)
8. [What's live](#whats-live)
9. [What can go wrong, and what happens then](#what-can-go-wrong-and-what-happens-then)
10. [Roadmap: every Hunch market on Monad](#roadmap-every-hunch-market-on-monad)
11. [Templates](#templates)
12. [What's in this repo](#whats-in-this-repo), [Documentation](#documentation), [Run it yourself](#run-it-yourself)
13. [Team, prior work and disclosure](#team-prior-work-and-disclosure)

---

## Why we built Hunch Book

[Hunch](https://playhunch.xyz) is our prediction-market product, running on Base today. People back a hunch on
crypto prices, stocks, weather and onchain numbers, in USDC, and every Hunch market is a parimutuel pool: nobody takes the other side
of your bet, the price is the crowd's odds read straight from the pool, and winners split it. Hunch also runs
Bazaar, where anyone can open a market, a practice arena with play money, and an agents page where software
can read markets and bet.

Running pools taught us three things.

1. **Pools are the right way to start a market.** A pool works from the first dollar. Nobody has to make a
   market, nobody has to quote, and a market nobody has heard of yet can still take its first stake.
2. **Pools are the wrong way to hold a position.** Once you stake, your money is stuck until the answer
   arrives. If the news turns, you cannot get out. If you were right early, you cannot take profit early.
   Serious traders want a market they can leave.
3. **Settlement is where trust breaks.** If a person or a committee decides the answer, every market carries
   that risk, and every market waits on them.

The big order-book venues solve the second problem and keep the first and third: a new market's book is empty
until someone is paid to quote it, orders are matched on the operator's servers, and the outcome goes through
an oracle process with people in it.

Hunch Book is our answer to all three at once: **start as a pool, graduate to a real onchain order book once
the pool proves demand, and settle only from data the chain already holds.** We built it on Monad because
Monad has every piece it needs: Kuru, a fully onchain order book; Perpl, a perpetuals exchange that keeps its
funding history onchain; Chainlink feeds; and blocks fast and cheap enough to give a small market its own
book.

## The idea

```
   1. POOL                    2. GRADUATION (one tx)          3. BOOK ON KURU               4. SETTLEMENT
   stake USDC on YES or NO    pool USDC -> YES + NO tokens    sell or buy any time          anyone calls settle()
   the split is the chance    split between the stakers       YES/USDC book on Kuru          resolver reads the chain
   no market maker needed     Kuru book created or attached   NO trades through the router  winners redeem for USDC
          |                              |                              |                            |
          +---- rule met: enough USDC ---+--- payoff unchanged ---------+---- no one decides --------+
                from enough wallets          for anyone who holds           the answer by hand
```

- A **pool** needs no liquidity to start. Its YES/NO split is the market's chance.
- **Graduation** happens once the pool meets its template's rule (enough USDC from enough wallets, both
  sides staked, chance between 3% and 97%). In one transaction the pool's USDC becomes fully backed YES and
  NO tokens (1 YES + 1 NO is always backed by 1 USDC), split between the stakers so that **each staker's payout
  is exactly what the pool would have paid** ([PROTOCOL.md §5.3](./docs/PROTOCOL.md#53-graduation)). The only
  thing graduation adds is the option to sell.
- The YES token gets its own **YES/USDC book on Kuru**. The book opens with holders and a reference price (the
  pool's split), which is what a maker needs to start quoting. NO trades through the same book via the router.
- At close, **anyone settles** by handing the market's resolver evidence it checks against the source contract:
  Perpl's funding history, a Chainlink round, a Pyth update, a Perpl state snapshot, or other markets'
  outcomes. The resolver either answers or refuses. No address, ours included, can set an outcome.

Markets whose pool never reaches the rule simply stay pools and settle as pools.

## How it changes prediction markets

| | Pools only (parimutuel) | Order books matched offchain | AMM markets | **Hunch Book** |
|---|---|---|---|---|
| Works from the first dollar | yes | no: an empty book until a maker is paid | needs seed liquidity | **yes: every market starts as a pool** |
| Exit before the answer | no | yes | yes, against the curve | **yes, once graduated: a real book, both sides** |
| Where orders match | no orders | the operator's servers | the pool contract | **Kuru, in the contract: price-time priority onchain** |
| Who decides the outcome | usually the operator | an oracle process with people in it | varies | **a resolver reading the source contract; no one can override it** |
| What a market becomes | a pot | an entry in one venue's database | a pool position | **two ERC-20 tokens and a Kuru book: an asset any app can hold, quote or build on** |
| Who can make the market | nobody needs to | approved makers | liquidity providers | **anyone: open-source maker bot and kit, onchain pricing inputs** |

The shift is that **a market is born cheap and grows into an asset.** Small questions do not need a market maker
to exist. Questions with demand get a real book. Every graduated market is a new YES/USDC pair on Kuru, with
holders on day one, which is exactly what an order-book exchange needs to list something new.

**Better for each side:**

- **Traders** can take a position with one stake, and once the market graduates, leave it at any time, in one
  transaction, on either side. Holding to the end pays the same as the pool would have.
- **Creators** open a market from a template in a minute, make the first stake, and earn 25% of its fees.
- **Kuru** gets a new kind of asset: yes/no tokens that open with inventory, a reference price and a maker,
  for questions its users already care about (funding they pay on Perpl, prices they trade).
- **Makers** get everything they need onchain to price a question: Perpl funding history, mark price and open
  interest, Chainlink rounds, other markets' outcomes. Our [maker kit](./docs/MAKER-KIT.md) is open source.
- **Builders and agents** get a [TypeScript SDK](./docs/SDK.md), an [MCP server](./docs/MCP.md) and a
  [data API](./docs/API.md): find, quote, trade, settle, verify and redeem without our app.

**Who it is for first:** a trader on Perpl who holds a BTC long and pays funding about every 43 minutes. They
want a cheap way to get paid back if funding stays high this week, and to close that hedge whenever they like.
The app's [hedge assistant](https://book.playhunch.xyz/hedge) reads their Perpl position, projects the funding
they will pay and sizes a matching market.

## How it works

1. **Start a market from a template.** The question is one the chain can answer, for example "Will BTC longs
   pay more than $2 per BTC in funding on Perpl this week?" or "Will MON be at or above $0.035 at 12:00 UTC on
   Friday?" The app shows the exact rule the contract will apply before you commit. The creator makes the first
   stake (at least 5 USDC). One market per question: the factory hashes the template and its parameters, so
   the same question cannot be opened twice.
2. **Pool phase.** People stake USDC on YES or NO (at least 1 USDC, at most 1,000 USDC per wallet per market,
   5,000 USDC per pool in this beta). The pool's split is the market's chance.
3. **Graduation to Kuru.** When the pool meets its template's rule, anyone can call `graduate()`. The rule
   differs by network and is read from the template on chain:

   | Network | Graduation rule (every template) | Where the book comes from |
   |---|---|---|
   | Monad mainnet | at least 10 USDC from at least 2 wallets | Kuru creates each YES/USDC book (book creation is owner-only there) and anyone registers it with the Graduator, which checks it is a Kuru book for that market's YES token and USDC |
   | Monad testnet (primary stack) | at least 500 USDC from at least 10 wallets | the graduation transaction calls Kuru's `deployProxy` and creates the book |

   Every rule also needs both sides staked and a chance between 3% and 97%. The keeper pushes each staker's
   tokens right after graduation.
4. **Trade.** Buy or sell YES or NO at any time on the Kuru book, one transaction each, with a slippage limit.
   Buying NO mints a pair from USDC and sells the YES; selling NO buys YES and redeems the pair. Take-profit,
   stop-loss and limit orders are optional ([PERIPHERY.md](./docs/PERIPHERY.md)).
5. **Settlement.** When the observation window ends, anyone can settle. The resolver reads the answer from the
   source contract. The app's [verifier](https://book.playhunch.xyz/verify/0x8d3a79a2FB05644c806CC923c76d81aF5a4F6901)
   re-runs that exact read from your browser, no wallet needed. Winning tokens redeem for 1 USDC minus a fee
   fixed at graduation (at most 1.94 cents); pool winners claim their share, and the keeper pushes payouts so
   nobody has to come back.

## Who pays whom

| Who pays | When | How much | Goes to |
|---|---|---|---|
| Pool winners | when a pool settles | 2% of winnings, never more than the losing side | 75% the protocol's fee recipient, 25% the market's creator |
| Holders of winning tokens | when they redeem | a per-token fee fixed at graduation, at most 0.0194 USDC (2% x 97%) | the same split |
| Traders on a Kuru book | each trade | Kuru's own fees: our books are created with maker and taker fees of 0 | Kuru |
| Anyone | minting or merging YES and NO, void refunds | nothing | |
| Us | every keeper and maker transaction | gas, in MON | Monad validators |

The fee recipient on both networks is our deployer ([0xD183…10A8](https://monadscan.com/address/0xD183a7daECF3d539683f37e1111558E3dFC210A8)).
Losers never pay more than they staked, and a staker who holds through graduation to the end is paid exactly
the pool payout ([PROTOCOL.md §5](./docs/PROTOCOL.md#5-economics)).

## Why Monad

Each reason below is measured, not assumed. Sources: [docs/FACTS.md](./docs/FACTS.md) and
[docs/DEPLOY.md](./docs/DEPLOY.md).

- **A market can go from nothing to a live Kuru book in seconds.** On testnet, market
  [#15](https://book.playhunch.xyz/m/0xaAE5C41202e6b85Ef285b01441fA742Ef6988613) went from its
  [creation](https://testnet.monadscan.com/tx/0xfab8721d41695dbda8289fd48c26bf2740146c4be90bf717009ec57c3e7b48e5)
  through ten stakes to its [graduation](https://testnet.monadscan.com/tx/0x6ab359a8fe1e942e7e770595d36316f26fb782b187fb9411a25c8ec168b8a7ac),
  which created its Kuru book, in 38 blocks: 11 seconds. Graduation itself is one transaction that turns the
  pool into tokens and calls Kuru's `deployProxy`.
- **Fully onchain order books are practical.** Every graduated market gets its own price-time priority book on
  Kuru, matched in the contract. Blocks arrive about every 0.30 seconds (302 ms measured over 200,000 testnet
  blocks), so a maker can requote as prices move.
- **The answers already live on chain.** Perpl keeps its funding history onchain, readable by block, so a
  funding market settles from Perpl itself with no oracle committee. That only works because Perpl is on Monad.
  Chainlink rounds and Pyth updates on Monad cover prices.
- **Small markets are affordable.** Measured on Monad mainnet at 102 gwei: creating a market costs about
  0.12 MON, a stake about 0.02 MON, graduating about 0.04 MON, a YES buy about 0.06 MON, and a maker requote
  (one bid and one ask) about 0.06 MON ([DEPLOY.md](./docs/DEPLOY.md)). A 10 USDC market can have a book.

## Hunch Book on Kuru

Hunch Book brings a new kind of asset to Kuru's spot order book: the YES token of a yes/no question that
settles by reading the chain. A question token is only tradable if its book opens with a price, with inventory
and with someone quoting it, and if both sides of the question trade on one book. That is the infrastructure
this repo adds:

- **Books open with holders and a reference price.** Graduation turns the pool into fully backed YES and NO
  tokens, hands them to the stakers, and creates or attaches the Kuru book in the same transaction
  ([Graduator.sol](./contracts/src/core/Graduator.sol)). The pool's split is the starting chance that makers
  quote around.
- **YES and NO on one book.** The [router](./contracts/src/core/HunchRouter.sol) buys and sells YES on the book;
  buying NO mints a pair and sells the YES, and selling NO buys YES and redeems the pair, each in one
  transaction with a slippage limit, using a vault flash loan so the trader only sends their net cost.
- **A maker that can price a question.** The open-source [maker bot](./services/maker) prices every template from
  onchain data and quotes both sides of each book. The [maker kit](./docs/MAKER-KIT.md) lets anyone run it.
  It pulls its quotes 2 minutes before close.
- **Settlement with no one in charge.** At close anyone settles from the source contract, and winning tokens
  redeem for USDC.

**Kuru v1 on testnet (live, where new markets go).** Kuru's `deployProxy` is open on testnet, so each graduation
transaction creates its book. Market #1
[graduated](https://testnet.monadscan.com/tx/0xbc9524391134b6a3cba94f33daba323075ff0db030a8d51563d89ee94fcf8d01)
into Kuru book [0xdFd0…104a](https://testnet.monadscan.com/address/0xdFd060ac7d3b129261EaB2E3DDd6F76A877D104a),
traded on all four router paths,
[settled](https://testnet.monadscan.com/tx/0x2d53ad4c3cb322c34447839a8beea8cc3dc208c1c8fa1930fc06cab96b20fc72)
and paid out ([redeem](https://testnet.monadscan.com/tx/0x40b82c5fa558c48297b3bfc635ab952f11052f30034d62b8df1de751b768e518)).
On 2026-10-11 three more opened, each graduating into a Kuru v1 book created in its graduation transaction,
quoted by our maker bot, with four router trades each: MON mark price at Oct 13 12:00 UTC
([#10](https://book.playhunch.xyz/m/0xC0Bc38C5140D9289f3CE86d7FdC675485cAD54e1)), ETH funding to about Oct 20
([#14](https://book.playhunch.xyz/m/0x6Edc55D3a4282B65ebB7A76190b0fc0E384b1996)) and BTC funding to about Oct 27
([#15](https://book.playhunch.xyz/m/0xaAE5C41202e6b85Ef285b01441fA742Ef6988613)). Two MON funding markets on Kuru
books, #11 and #12, settled NO at 03:00 UTC on 2026-10-12 ([#11](https://testnet.monadscan.com/tx/0x9346cda9cdd4da363a702c2b4e9dba815170934afcc1245ec21b1e88dca6aa8d), [#12](https://testnet.monadscan.com/tx/0x1b4419e0299dcc81d3cc785899f73968a13800a57b3584e9efe5b4a75318db3a)).
Every pool and every trade there is ours. Books, quotes and trades: [docs/FACTS.md](./docs/FACTS.md#markets-on-kuru-monad-testnet).

**Kuru v1 on mainnet (live; books wait on Kuru).** Book creation on mainnet is owner-only, so Kuru creates each
YES/USDC book with our parameters and anyone registers it with the Graduator, which checks every parameter
against Kuru's margin account. Our keeper asks for each book, with the exact `deployProxy` call, once a pool is
halfway to its rule. A market stays a pool until its book exists. The whole flow, with the book created as
Kuru's owner and registered by an outside address, is rehearsed on a fork of Monad mainnet
([MainnetRehearsal.fork.t.sol](./contracts/test/fork/MainnetRehearsal.fork.t.sol)).

**Kuru v2 (building: waits on Kuru).** A second testnet stack runs on Kuru v2's account model and was tested
against Kuru's live v2 contracts on a fork. Only Kuru's governance creates v2 books, after it sets up each token;
it has not yet set up our test USDC or any YES token, so three filled v2 pools wait, and the stack's first market
[settled as a pool](https://testnet.monadscan.com/tx/0xd7ffd5b3a0e6543545f95a894327df10a2213f20480470d14737a549d93ca13f).
Our keeper publishes the exact setup and `deploySpotMarket` calls at
[/api/v1/kuru/requests](https://book.playhunch.xyz/api/v1/kuru/requests).

**Our fallback book (no new markets).** Hunch Book also has its own onchain order book
([contracts/src/venue](./contracts/src/venue)), built behind Kuru v1's interface as a fallback. Earlier testnet
markets graduated into it. The guardian [paused market creation on its factory](https://testnet.monadscan.com/tx/0x801c5e41764d0b0cd2de7a03abbc1fe889a2cdb000f31ead7b93cd0e01a3d44a)
on 2026-10-12; its markets, all created and seeded by us, trade and settle there as normal
([list](./docs/FACTS.md#earlier-markets-on-the-hunch-stack-ours-seeded-by-us)).

## What's live

| Piece | Status | Proof |
|---|---|---|
| Contracts on Monad mainnet (Circle USDC) | live | [factory 0xAEf7…8cE6](https://monadscan.com/address/0xAEf7f97A739C8ea93D4F5Fc497B0181Cf92d8cE6) ([deploy tx](https://monadscan.com/tx/0xae4e637ba5c7f1592b0f28fae6e4949f0702bb90e20aa19207f8883fc7d13f8b)), [Graduator 0x5582…8B3C](https://monadscan.com/address/0x5582e5Aeb12e15EAda88402E2903Bc628Cc28B3C), [router 0xa0C9…141a](https://monadscan.com/address/0xa0C97ebC345746C37Ac15a10E076c3A3BBd2141a), all 20 contracts verified on Sourcify; every address in [deployments/monad-mainnet.json](./deployments/monad-mainnet.json) |
| Templates 1 to 7 on mainnet | live | registered on the mainnet factory on 2026-10-12 ([template 1](https://monadscan.com/tx/0x4c24bcb28fae6e2d666cc4721199bf281fff2dfdb7c4c9e2f90636f049cd0828)); rule 10 USDC from 2 wallets |
| Mainnet market #1 | live, ours | [0x1107…F511](https://monadscan.com/address/0x11075eeC0d115b7aB754F54bcf79Fc5A5dc0F511): created by us with 5 USDC ([tx](https://monadscan.com/tx/0x72caf4b41b17563b7668d06a1418a78849107319d070619fcbe3b8c7e6de8ea6)), then 15 stakes of 1 USDC we paid for our 15 labelled seed wallets ([list](./docs/FACTS.md#market-1-on-mainnet-ours-seeded-by-us)); no Kuru book, so it settles as a pool |
| Core contracts on testnet | live | the primary stack, where new markets go: [factory](https://testnet.monadscan.com/address/0x2c30da53F8C384D6eD6603E3138a98fd15E4928A), [vault](https://testnet.monadscan.com/address/0x81b04B3567dcaDaE6a859394248C47ddc403ba37), [router](https://testnet.monadscan.com/address/0xB9D22C84c5e2F4329EEee1B52Ad753dF3268c2a6), [graduator](https://testnet.monadscan.com/address/0x7DC80DB34762A996aae6Ce516F562B2e6142fFE3); every address in [deployments/monad-testnet.json](./deployments/monad-testnet.json); verified on Sourcify |
| Graduation into Kuru v1 books | live on testnet | market #1 [graduated](https://testnet.monadscan.com/tx/0xbc9524391134b6a3cba94f33daba323075ff0db030a8d51563d89ee94fcf8d01) into Kuru book [0xdFd0…104a](https://testnet.monadscan.com/address/0xdFd060ac7d3b129261EaB2E3DDd6F76A877D104a); #10, #14 and #15 on 2026-10-11 ([Hunch Book on Kuru](#hunch-book-on-kuru)); every pool filled by our own wallets |
| Trading YES and NO through the router | live on testnet | on market #1's Kuru book: [buy YES](https://testnet.monadscan.com/tx/0x64e40cdb81d82301412c84b15586791a59fe21dd291503877054ce0977846ced), [sell YES](https://testnet.monadscan.com/tx/0xd812065e5e64bf2faf44d7111219a56cc0cbcb95f2f03fee6a30da83d3b2cb69), [buy NO](https://testnet.monadscan.com/tx/0xa23645f27ee8cc3bf51ccd6f65bbb545824e3555a4bec957b45be2870cb9ecab), [sell NO](https://testnet.monadscan.com/tx/0xafbee312a270e29d2218bf89890f0d8bc55658e1a9df07b4713113e30b14c72d), all from our own wallet |
| Settlement and redemption | live on testnet | #11 and #12 [settled NO](https://testnet.monadscan.com/tx/0x9346cda9cdd4da363a702c2b4e9dba815170934afcc1245ec21b1e88dca6aa8d) from Perpl's funding history on 2026-10-12; a snapshot market [settled 13 seconds after close](https://testnet.monadscan.com/tx/0x8853ced228ce7d6445580bb843da11dfa431c98d57a2a9e7a382e2a4299923a5); a touch market [settled YES from a Chainlink round](https://testnet.monadscan.com/tx/0xd1ec7102a1660a963dd1fa0442394168cf9b9f488ed73bc763c69adae40707f4); our maker bot [redeemed](https://testnet.monadscan.com/tx/0x40b82c5fa558c48297b3bfc635ab952f11052f30034d62b8df1de751b768e518) its winning tokens |
| Keeper ([services/keeper](./services/keeper)) | live on both networks | from [0x1f5A…5569](https://testnet.monadscan.com/address/0x1f5AC9bB0DF7d0E0DD133cBd71388e1078475569) (ours): graduates, settles, proves touches and spikes, voids, pushes tokens and payouts, auto-redeems, executes orders, publishes Kuru book requests |
| Maker bot ([services/maker](./services/maker)) | live on testnet | quoting the graduated testnet books on Kuru from [0x0f11…232A](https://testnet.monadscan.com/address/0x0f1156Eb25DBebee5386EC80F1EB0B85C7dD232A) (ours); on mainnet it waits for a Kuru book; open source, with a [maker kit](./docs/MAKER-KIT.md) |
| Liveness watchdog | live | checks solvency, supply, settlement lag, graduation, gas and service health from the chain every 10 minutes and sends phone alerts ([ops/README.md](./ops/README.md#always-on-where-the-services-run-today)), with a GitHub Actions backstop for both networks |
| App | live | [book.playhunch.xyz](https://book.playhunch.xyz): markets, every market on Kuru at [/kuru](https://book.playhunch.xyz/kuru), trading, create flow, portfolio with P&L and claim-all, verifier, settlement archive, proof page, trade tape, status, hedge assistant, funding-cost calculator, ladders, parlays, rewards, passkey accounts |
| Data API and embed | live | [/api/v1/stats](https://book.playhunch.xyz/api/v1/stats), [/api/v1/feed](https://book.playhunch.xyz/api/v1/feed), [/api/v1/settlements](https://book.playhunch.xyz/api/v1/settlements), [/api/v1/kuru/requests](https://book.playhunch.xyz/api/v1/kuru/requests), [/embed/funding/MON](https://book.playhunch.xyz/embed/funding/MON), [docs/API.md](./docs/API.md) |
| Periphery (auto-redeem, orders, referrals, payouts, oracle, price adapter, timelock) | live on testnet, deployed on mainnet | addresses in [docs/PERIPHERY.md](./docs/PERIPHERY.md) |
| Indexer ([indexer](./indexer)) | live | Envio HyperIndex over every Hunch Book event and every book, hosted on Envio Cloud for [mainnet](https://indexer.dev.hyperindex.xyz/f21dfe4/v1/graphql) and [testnet](https://indexer.dev.hyperindex.xyz/0a7dab8/v1/graphql), synced over HyperSync. It feeds the app's proof page, trade tape, portfolio profit and loss and creator pages, which fall back to reading the chain if it is slow or down ([docs/INDEXER.md](./docs/INDEXER.md)) |
| SDK and MCP server | building | [docs/SDK.md](./docs/SDK.md), [docs/MCP.md](./docs/MCP.md); packed and installed from their tarballs in CI, not on npm yet |
| Kuru v2 books | building: waits on Kuru | a second testnet stack ([factory 0xd699…125A](https://testnet.monadscan.com/address/0xd6994DD479d845F1ea039b6322fBE00c12Ea125A)), fork tested against Kuru's live v2 contracts ([list](./docs/FACTS.md#kuru-v2-the-kuruv2-stack)) |

## What can go wrong, and what happens then

We would rather you read this here than find it out.

- **You cannot leave a pool before it graduates.** Until then a stake is a parimutuel bet. On mainnet a market
  graduates only once Kuru creates its book; a market whose book never arrives settles as a pool.
- **If our keeper stops, money waits; it is never lost.** `settle`, `graduate`, `claimTokensFor`,
  `claimPoolFor` and `voidIfExpired` are permissionless: anyone can call them. A market nobody settles voids
  at its settlement deadline (close plus 7 days) and every stake is refunded in full. It happened once on
  testnet: market #1 settled 18 hours late while the keeper was stopped ([incident log](./docs/INCIDENTS.md)).
  That is why the keeper now runs as an always-on service with an outside watchdog that sends phone alerts.
- **A void after graduation pays 0.50 USDC per token.** Someone who bought YES at 0.80 loses 0.30 per token.
  Templates read historical data that stays readable, so voids should be rare; every market page says this.
- **Nobody can override a resolver, including us.** If the source contract reports a strange value, that value
  settles the market. We chose this on purpose: a market that can be corrected by hand can be changed by hand.
- **The guardian can pause new markets and graduation, nothing else.** It cannot pause settlement or
  redemption, move user funds, or set an outcome. On mainnet it is a single key today, separate from the
  deployer; it moves to a multisig.
- **Mainnet is new and small.** One market, ours, seeded by our own labelled wallets; no outside wallet has
  staked on mainnet yet. Its rule (10 USDC from 2 wallets) is low so a first market can graduate with little
  money, which also makes it easy for one person with two wallets to meet.
- **Our wallets made the activity so far,** and our maker bot is the only maker. All of it is labelled as
  ours, in the app, the API and [docs/FACTS.md](./docs/FACTS.md).
- **Testnet Chainlink feeds update about once a day,** so price markets on testnet can void; price settlement is
  shown on mainnet and on mainnet forks.
- **The snapshot template (7) has no challenge period:** the first snapshot taker picks the block inside a short
  window ([TEMPLATES.md](./docs/TEMPLATES.md)).
- **No external audit yet:** an internal review, Slither, and 698 unit, fuzz and invariant tests
  ([SECURITY-REVIEW.md](./docs/SECURITY-REVIEW.md), [FACTS.md](./docs/FACTS.md#tests-2026-10-10)).

## Roadmap: every Hunch market on Monad

Hunch Book is the engine; Hunch is the product people already use. The goal is to run every Hunch market on
Monad through Hunch Book: start as a pool, graduate to Kuru when it has demand, settle from the chain. Status
words: **planned** (designed, not started), **building**, **live**. Dates are targets, not promises; the full
plan is in [docs/ROADMAP.md](./docs/ROADMAP.md).

| Step | What it means | Status |
|---|---|---|
| The engine on Monad | pools, graduation, Kuru books, seven chain-read templates, keeper, maker, app | live (mainnet and testnet) |
| Always-on operations | keeper and maker as hosted services, watchdog every 10 minutes, phone alerts | live |
| A mainnet market on a Kuru book | Kuru creates the first mainnet YES/USDC book; our maker quotes it | building: waits on Kuru |
| Outside stakers and makers | real users on mainnet; makers other than us, paid from the rewards distributor | building |
| Hunch's price markets | Hunch's UP or DOWN price questions as recurring series on Monad, opened by the keeper on a schedule and settled from Chainlink | planned (the series engine is built and ran on testnet) |
| Bazaar on Monad | anyone opens a market from a template, with the creator earning 25% of its fees | building (the create flow is live on testnet) |
| More questions | stocks, other assets and onchain numbers, only where a source contract on Monad can answer them; never by hand | planned |
| Hunch's agents | agents find, quote, trade and settle through the SDK and the MCP server | building |
| Kuru v2 | graduation into Kuru v2 books | building: waits on Kuru |
| Hosted indexer | Envio HyperIndex behind the proof page, trade tape, portfolio P&L and creator pages | live (both networks) |
| Hardening | guardian to a timelock and multisig, external audit, higher caps | planned |

What success looks like: a Perpl trader hedges a week of funding in under a minute; most fills on our books
come from makers who are not us, measured and published; and a question anyone cares about can go from an idea
to a Kuru book in one afternoon.

## Templates

| Id | Question | Settles from | Status |
|---|---|---|---|
| 1 | Will longs pay more than X in funding on a Perpl perp over a window? | Perpl's funding history | live on testnet; registered on mainnet |
| 2 | Will an asset be at or above K at time T? | The Chainlink round that brackets T (Pyth where Chainlink has no feed) | live on testnet; live on mainnet ([Market #1](https://monadscan.com/address/0x11075eeC0d115b7aB754F54bcf79Fc5A5dc0F511)) |
| 3 | Will an asset reach (or fall to) K at any time in a window? | A pointer to the Chainlink round where it happened | live on testnet; registered on mainnet |
| 4 | Will any single Perpl funding event in a window charge more than X? | A pointer to that funding event | live on testnet; registered on mainnet |
| 5 | Will an asset be inside a range at time T? | The bracketing Chainlink round | live on testnet; registered on mainnet |
| 6 | Will all of 2 to 5 markets settle YES (a parlay)? | The legs' own outcomes | live on testnet; registered on mainnet |
| 7 | Will Perpl open interest or mark price be above K at time T? | A snapshot of Perpl's state taken right after close | live on testnet ([first settlement](https://testnet.monadscan.com/tx/0x8853ced228ce7d6445580bb843da11dfa431c98d57a2a9e7a382e2a4299923a5), 13 seconds after close); registered on mainnet |

Every rule, edge case and source is in [docs/TEMPLATES.md](./docs/TEMPLATES.md).

## What's in this repo

| Path | What |
|---|---|
| [contracts/](./contracts) | Foundry: core (vault, tokens, market, factory, graduator and router for Kuru v1 and v2), seven resolvers, the fallback order book, the periphery, with unit, fuzz, invariant and fork tests |
| [apps/web/](./apps/web) | The Next.js app at [book.playhunch.xyz](https://book.playhunch.xyz), with the data API and the embed |
| [packages/shared/](./packages/shared) | ABIs generated from the contracts, the address loader, template codecs, router and Kuru math |
| [packages/sdk/](./packages/sdk) | TypeScript SDK: reads, quotes, every action, settlement evidence and verification |
| [packages/mcp/](./packages/mcp) | MCP server so agents can find, quote, trade, settle and redeem |
| [services/keeper/](./services/keeper) | The keeper |
| [services/maker/](./services/maker) | The open-source maker bot and maker kit |
| [services/watchdog/](./services/watchdog) | Liveness checks and phone alerts |
| [services/notifier/](./services/notifier) | Telegram alerts for users |
| [services/rewards/](./services/rewards) | Maker reward and referral scoring into Merkle epochs |
| [indexer/](./indexer) | Envio HyperIndex over every Hunch Book event and every book |
| [examples/](./examples) | A read-only script, a small trading agent and MCP config |
| [deployments/](./deployments) | The only source of addresses: `monad-testnet.json`, `monad-mainnet.json` |
| [ops/](./ops) | Running the services: on Railway, under launchd, or by hand |

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

The fork tests read real Perpl funding, real Chainlink rounds and a real Pyth update, run the whole lifecycle
against Kuru's live testnet contracts, and rehearse the mainnet launch on a fork of Monad mainnet with Circle
USDC and a book created as Kuru's owner.

Build on it:

```ts
import { createHunchClient } from "@hunch-book/sdk";
const hunch = createHunchClient({ network: "monad-testnet" });
const { markets } = await hunch.markets.list({ limit: 10 });
```

## Team, prior work and disclosure

**Team.** Hunch Book is built by Raj, founder of [Hunch](https://playhunch.xyz).

**Prior work.** Hunch Book is a new codebase, started on 2026-10-03. It builds on ideas, not code, from Hunch:
parimutuel pools, the fee rule (a share of winnings, never more than the losing side), creator markets and the
visual design. No code from Hunch is in this repository. Third-party code is limited to the pinned dependencies
in the `package.json` files and the two Foundry libraries in `contracts/lib` (forge-std and solady), each under
its own license.

**How it was built.** We used AI coding tools (Claude Code) throughout: to write contracts, services, the app,
tests and these docs, often as several agents working in parallel on separate parts of the repo. Every change
runs through the same gate before it is merged: Foundry unit, fuzz, invariant and fork tests for the contracts,
type checks, lint and tests for every TypeScript package, a production build, and a check that nothing private
enters this public repo. Decisions about money paths, deployments and anything that moves funds were made and
run by a person.

## License

[MIT](./LICENSE)

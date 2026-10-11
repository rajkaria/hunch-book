# Facts

Every number in the README and on the site comes from chain data or from this page, and every number
on this page says where it comes from. Live figures (balances, counts, chances) are read from the
chain by the app at [book.playhunch.xyz](https://book.playhunch.xyz) and the API at
[/api/v1/stats](https://book.playhunch.xyz/api/v1/stats); they are not copied here, because they
change. This page holds the numbers that do not change, and dated snapshots of the ones that do.

## Deployment (Monad testnet, chain id 10143)

| Fact | Value | Source |
|---|---|---|
| First deploy block | 67,856,277 (2026-10-03) | `hunchBook.deployBlock` in [deployments/monad-testnet.json](../deployments/monad-testnet.json) |
| Core contracts | 7 deployed (test USDC, market implementation, factory, graduator, router, two resolvers) plus the vault the factory deploys | the same file, `hunchBook` and `deployTxs` |
| Templates registered | 7 (ids 1 to 7) | `factory.templateOf(id)`; `addTemplate1` to `addTemplate7` in `deployTxs` |
| Periphery contracts | 7 | `hunchBook.periphery` |
| Source verification | every contract above verified on Sourcify (exact match) | `forge verify-check` on each job |
| Guardian and fee recipient on testnet | the deployer, [0xD183…10A8](https://testnet.monadscan.com/address/0xD183a7daECF3d539683f37e1111558E3dFC210A8) | `hunchBook.guardian`, `hunchBook.feeRecipient` |
| Our maker bot | [0x0f11…232A](https://testnet.monadscan.com/address/0x0f1156Eb25DBebee5386EC80F1EB0B85C7dD232A) | `wallets.maker` |
| Our keeper | [0x1f5A…5569](https://testnet.monadscan.com/address/0x1f5AC9bB0DF7d0E0DD133cBd71388e1078475569) | `wallets.keeper` |

## The `hunch` stack: Hunch Book's own order book (Monad testnet)

| Fact | Value | Source |
|---|---|---|
| Deploy block | 69,857,525 (2026-10-10) | `stacks.hunch.deployBlock` in [deployments/monad-testnet.json](../deployments/monad-testnet.json) |
| New contracts | factory and vault, [HunchOrderBookFactory 0x0DDF…46C5](https://testnet.monadscan.com/address/0x0DDF74540B6720B348483084F749907b2c3F46C5) (it deploys the [HunchMarginAccount 0x6dDa…Ee1c](https://testnet.monadscan.com/address/0x6dDaC7a754A2A4bf2fF688B8F08eaA8ADC42Ee1c) and the book implementation), graduator, router, parlay resolver | `stacks.hunch` and its `deployTxs` |
| Reused from the primary stack | test USDC, market implementation, the resolvers of templates 1 to 5 and 7 (none of them is tied to a factory) | the same addresses under `hunchBook` and `stacks.hunch` |
| Templates registered | 7 (ids 1 to 7) | `addTemplate1` to `addTemplate7` in `stacks.hunch.deployTxs` |
| Graduation rule | pool of at least 100 USDC, at least 3 stakers, chance between 3% and 97% | `factory.templateOf(id).rule`; `GRADUATION_MIN_POOL=100 GRADUATION_MIN_STAKERS=3` at deploy |
| Trading fees on the book | 0 | `HunchOrderBookFactory` accepts fee 0 only |
| Source verification | all 9 new contracts verified on Sourcify (exact match) | `forge verify-contract --verifier sourcify` |
| Default for new markets | yes (`defaultStack: "hunch"`) | the deployments file |

### Markets on the `hunch` stack (ours, seeded by us)

Each was created by the deployer with a 50 USDC first stake on YES; four addresses derived from the deployer key
(label "hunch-book testnet seed") staked 30 USDC YES twice and 45 USDC NO twice, so each pool held 110 USDC YES and
90 USDC NO from 5 stakers, all ours. Each graduated in one transaction that also created its order book.

| Market | Question | Book | Creation | Graduation | Closes |
|---|---|---|---|---|---|
| [0x2B31…Ffff](https://testnet.monadscan.com/address/0x2B31160548b1211958339BEa9b39561bA3fFFfff) | Will MON longs pay shorts on net in funding on Perpl (perp 64) between blocks 69,880,803 and 70,737,903? | [0x3f1D…37AF](https://testnet.monadscan.com/address/0x3f1D3C83515ae03D289b7F7E2A0e63Af5b4f37AF) | [tx](https://testnet.monadscan.com/tx/0x63ba5c01ccd516c35d17bfec5a3bf95870efe9d5bab62ceccc504d7920976724) | [tx](https://testnet.monadscan.com/tx/0x6a358f135309610ec9d38528ae590049cfda586a422c3a185e2bd0f5208693cf) | block 70,737,903, about 2026-10-13 17:00 UTC |
| [0x21dc…D41B](https://testnet.monadscan.com/address/0x21dc581cBC26E7C42adA3462C35Ce9f49d9FD41B) | Will BTC longs pay shorts on net in funding on Perpl (perp 16) between blocks 69,880,937 and 73,995,017? | [0x06F5…9e12](https://testnet.monadscan.com/address/0x06F5D1375d40ADF2b3f52c410CEbcC773d2f9e12) | [tx](https://testnet.monadscan.com/tx/0x7eb3c6fe4542761748defff5029671b69e33d07f4982877e6693690a3d5c9925) | [tx](https://testnet.monadscan.com/tx/0x4b535cf1afc73d2cdeb1f5acbfc6307591e4fe8570dd2a89ec8793bbab0e915e) | block 73,995,017, about 2026-10-25 |

Our maker bot quoted both books from its first cycle after the restart (MON market: bid 0.475, ask 0.506,
[tx](https://testnet.monadscan.com/tx/0x91dac539ea3d2d72c81a985d1da40841b326232f5d56ce1649949f014f1a1136); BTC
market: bid 0.97, ask 0.99, [tx](https://testnet.monadscan.com/tx/0x558b01f421ba65bb9ee9c15f30ae0341bab000917638a1de95e998ca3106a47e)).
Router trades on the MON market from the deployer (ours), 5 USDC or 5 tokens each:
[buy YES](https://testnet.monadscan.com/tx/0x7d2966d4dbd043b23b02754e4cc355a47b852cf05b6403c28707c6df5632d905) (9.881422 YES),
[sell YES](https://testnet.monadscan.com/tx/0x88cd250052de49736357572fac3a31eb1a0173790b997569df6fa72c753f679b) (4.693675 USDC),
[buy NO](https://testnet.monadscan.com/tx/0x86f16a248b1854ae4cdcd3c39ce41629e3816e602084eff4dde264ef712c45b9) (paid 2.625 USDC),
[sell NO](https://testnet.monadscan.com/tx/0x7b7be1b5cceaf68076db986479f42995d358828eb0634b072c177e1f005317fe) (received 2.47 USDC).

Eight more markets were added on 2026-10-11, so the stack has ten graduated markets on its own books (market #3
is the golden path market, still a pool). Seven of them read Perpl: snapshot markets (template 7) on Perpl's mark
price and open interest, settled from a snapshot the keeper takes right after close, and Perpl funding markets
(template 1); the eighth is a parlay (template 6) of markets #6 and #7. Each threshold sits near the value at
creation, so each opened close to even. Testnet Chainlink feeds update about once a day, so these markets use
Perpl, which updates continuously. Each was created by the deployer with a first stake on YES, and two
addresses derived from the deployer key (label "hunch-book testnet seed") staked one on each side, so each pool
held 120 USDC from 3 stakers, all ours, split close to our maker's fair value. Each graduated in the same run
([SeedTestnetMarket.s.sol](../contracts/script/SeedTestnetMarket.s.sol), about 0.29 MON each) and our maker bot
quotes every book.

| Market | Question | Book | Creation | Graduation | Closes |
|---|---|---|---|---|---|
| #4 [0xb9cA…00A9](https://testnet.monadscan.com/address/0xb9cA87cb725aa34444d3Be1906D5472C63bB00A9) | Will Perpl's MON mark price be at or above $0.025 at Oct 12, 16:00 UTC? | [0xb4E8…6742](https://testnet.monadscan.com/address/0xb4E876BFbede62BAA225A1F0e90768E9D2826742) | [tx](https://testnet.monadscan.com/tx/0xb6bec762989117f366335ab01b33ac2cf3c57a7c257a98018037345e3f422557) | [tx](https://testnet.monadscan.com/tx/0xedff52c226aa5326236ca184f174506550ffac38ebb5a4f908171b7bcb92eeb0) | 2026-10-12 16:00 UTC (snapshot) |
| #5 [0xb100…a829](https://testnet.monadscan.com/address/0xb1001c4e99B5e02d45eBFDe9f5e0A1E4F521a829) | Will Perpl's SOL mark price be at or above $110 at Oct 14, 12:00 UTC? | [0x089f…AD69](https://testnet.monadscan.com/address/0x089f2990161DEa18768F2B8B67436C9E50BBAD69) | [tx](https://testnet.monadscan.com/tx/0x6fab9048c4a44f5983e62dd9081c253426002a650bbf6ffc26d76eca8184854e) | [tx](https://testnet.monadscan.com/tx/0x05158f9570c3fa7b63f73358ff266edc7ad35eb47f750d3e266a72a3fb1a538d) | 2026-10-14 12:00 UTC (snapshot) |
| #6 [0x1bD9…61D9](https://testnet.monadscan.com/address/0x1bD941E0C23B3888a2B2FB735F01943Fa40561D9) | Will Perpl's ETH mark price be at or above $2,500 at Oct 15, 12:00 UTC? | [0x4AEf…56Ad](https://testnet.monadscan.com/address/0x4AEff8DC30810D6C05c1f39daED6E50D9c4A56Ad) | [tx](https://testnet.monadscan.com/tx/0xb6a2dfb51fc0b60e30d73aca22a00c73c34f6fbd78cfad635de808533aacf852) | [tx](https://testnet.monadscan.com/tx/0x2a0de158cfd6ee27c25ce3ea178259cea5e6f34c93bfb79c43215d44cff98238) | 2026-10-15 12:00 UTC (snapshot) |
| #7 [0xEe77…4Ae8](https://testnet.monadscan.com/address/0xEe776E63D97caE73Fcf6f10cd8ac354f24554Ae8) | Will Perpl's BTC mark price be at or above $83,000 at Oct 16, 12:00 UTC? | [0x4a8e…27d2](https://testnet.monadscan.com/address/0x4a8e497C1218dD445FFff3d7f46df5acb51127d2) | [tx](https://testnet.monadscan.com/tx/0x211ea6d1d2b7088d77fff3ef3cd208aeda8eeacde8d64a1159553ac4b0260bd8) | [tx](https://testnet.monadscan.com/tx/0x4625ca5ca4a364623031b1998c3e0c660d080972680372f89daf03178cc33718) | 2026-10-16 12:00 UTC (snapshot) |
| #8 [0x4bFD…77f3](https://testnet.monadscan.com/address/0x4bFD5ffE767c0cd04c240bA753416300ADF077f3) | Will Perpl's BTC open interest be at or above 22 BTC at Oct 15, 18:00 UTC? | [0xf073…1BE4](https://testnet.monadscan.com/address/0xf07395112CF70Be0218f0D5c8838d0bC11121BE4) | [tx](https://testnet.monadscan.com/tx/0x3748f25061c6889c7bb8a6b286e2c6bf8358feebae1a8dc0e3fae075d1c4e0d2) | [tx](https://testnet.monadscan.com/tx/0x6dcafa6c1c607d7cfcfc8c9a37969bf6afbb3192ec3bf2cdb31d72119a7f4307) | 2026-10-15 18:00 UTC (snapshot) |
| #9 [0x0826…F3c4](https://testnet.monadscan.com/address/0x0826ed891c5aE419F7Ce1BD10a37D6469d69F3c4) | Will ETH longs pay more than $6.25 per ETH in funding on Perpl (perp 32) between blocks 70,032,379 and 70,889,479? | [0x4c7B…A348](https://testnet.monadscan.com/address/0x4c7Bab8b3F9e8B4A4d3919cC5De07Be78bEeA348) | [tx](https://testnet.monadscan.com/tx/0xf7a56655b3f4e4995629af67bb337b42b71cf356cc26abfee4031798dfa9672d) | [tx](https://testnet.monadscan.com/tx/0xa3db969bc77423c938aa4d8c1bf4d8aace8fd2f397232bb0d8d67b8d96edda72) | block 70,889,479, about 2026-10-14 05:45 UTC |
| #10 [0xFb79…6E49](https://testnet.monadscan.com/address/0xFb798e4BF4c0D1e5e9ec46916B2288D8a68f6E49) | Will SOL longs pay shorts on net in funding on Perpl (perp 48) between blocks 70,032,484 and 71,172,427? | [0xec40…6B43](https://testnet.monadscan.com/address/0xec40ee86065E7d83bB8011ffDC67144D96056B43) | [tx](https://testnet.monadscan.com/tx/0x41cb7bb752700269e086c1b5205ef95990d38b3d9488dd6aeaa4b6c29c4a2638) | [tx](https://testnet.monadscan.com/tx/0x8d69b590396cd8864c4fbed7d22e89f5b83bdb9215b37d018cd14ce03ce4c3d2) | block 71,172,427, about 2026-10-15 05:30 UTC |
| #11 [0x07d3…0348](https://testnet.monadscan.com/address/0x07d3fD19Ac0C283e646758BbC19700ec7D5b0348) | Parlay: will markets #6 and #7 both settle YES? | [0x86fA…613F](https://testnet.monadscan.com/address/0x86fA30181fFFA3a782E4c17c119367C64fd1613F) | [tx](https://testnet.monadscan.com/tx/0x20758355f9541d9ec454c9f7fb8ca24f40b42c4b27a03845edd7cfa9da48f28a) | [tx](https://testnet.monadscan.com/tx/0x33bbba7fa3756b167ef62f7c6694311b674f20142d0222499b1e6f69c5170cc0) | 2026-10-16 12:00 UTC |

## Market #1 (our own, seeded by us)

| Fact | Value | Source |
|---|---|---|
| Address | [0x2A44…3982](https://testnet.monadscan.com/address/0x2A44B99014cF73065BFb89197a08DE09D18d3982) | `factory.marketAt(0)` |
| Template | 1, Perpl MON funding (perp 64), threshold 1,500 raw units | `market.params()` |
| Window | blocks 68,058,301 to 68,264,005 | `market.window()` |
| Pool at graduation | 410 USDC YES, 280 USDC NO, 11 stakers, all our own wallets | `market.poolTotals()`; [graduation tx](https://testnet.monadscan.com/tx/0xbc9524391134b6a3cba94f33daba323075ff0db030a8d51563d89ee94fcf8d01) |
| Kuru book | [0xdFd0…104a](https://testnet.monadscan.com/address/0xdFd060ac7d3b129261EaB2E3DDd6F76A877D104a) | `market.book()` |
| Router trades | 4, one per path, from our own wallet | the four transactions linked in the README |
| Settlement | NO, settled by the keeper at block 68,488,249 (2026-10-05 19:45 UTC), 18 hours 49 minutes after close, because the keeper was stopped ([incident](./INCIDENTS.md)); inside the 7-day deadline | [settle tx](https://testnet.monadscan.com/tx/0x2d53ad4c3cb322c34447839a8beea8cc3dc208c1c8fa1930fc06cab96b20fc72) |
| Redemption | our maker bot redeemed its 20 NO tokens for USDC | [redeem tx](https://testnet.monadscan.com/tx/0x40b82c5fa558c48297b3bfc635ab952f11052f30034d62b8df1de751b768e518) |

## Demo markets (ours)

Opened by our own wallets to show each template working. They count as ours wherever activity is counted.

| Market | Template | Opened by | Creation | Result so far |
|---|---|---|---|---|
| [0x63Be…D71e](https://testnet.monadscan.com/address/0x63Be009161a92470a9A2C311671F629d9D11D71e) | 7, Perpl MON mark price at or above $0.03352 at 15:06 UTC on 2026-10-04 | deployer, `DemoMarkets.s.sol` | [tx](https://testnet.monadscan.com/tx/0xfbbd2cb1545dbe929da7f9e51a00ef32bfa06dbaa1925f69c2e3e900a152c5ed) | settled NO ($0.03305) by the keeper's snapshot, [13 seconds after close](https://testnet.monadscan.com/tx/0x8853ced228ce7d6445580bb843da11dfa431c98d57a2a9e7a382e2a4299923a5) |
| [0xD45e…1000](https://testnet.monadscan.com/address/0xD45e536b84169983B908aF3259c10992Dd8A1000) | 3, Chainlink BTC/USD reaches $86,000 by 2026-10-07 13:06 UTC | deployer, `DemoMarkets.s.sol` | [tx](https://testnet.monadscan.com/tx/0x3b67872c992af0bc3b409d8f53b5f2161012e4ee929eae7a2960e64933337560) | settled YES: the keeper proved the Chainlink round of 2026-10-04 21:12 UTC at $86,024.04 ([tx](https://testnet.monadscan.com/tx/0xd1ec7102a1660a963dd1fa0442394168cf9b9f488ed73bc763c69adae40707f4)) |
| [0xc723…114a](https://testnet.monadscan.com/address/0xc72315b8C01702Da99b3d60E39EfA587BC6d114a) | 6, parlay of the touch market and the weekly BTC funding market | deployer, `DemoMarkets.s.sol` | [tx](https://testnet.monadscan.com/tx/0xe8a1da313b69a1081d87912a7e343a8a73d0952c467fbe165c20735792922240) | open |
| [0x2D17…BF74](https://testnet.monadscan.com/address/0x2D1768F57a2eE76bFD23140EdFeBE29F6b91BF74) | 4, any single MON funding event spikes in the next day | keeper, recurring series | [tx](https://testnet.monadscan.com/tx/0x8143b82a2ab7a81a2d3b840c91076006057192ed96298ab40403424996771462) | settled YES: the keeper proved the funding event at block 68,190,876 (increment 135 against a threshold of 134, [tx](https://testnet.monadscan.com/tx/0x557c5bda0639e0e366affb129f86fe3433539b30638b1d56841da90612265c3e)) |
| [0x9c50…4CF5](https://testnet.monadscan.com/address/0x9c509488821B90B09139419C925f681AA2D14CF5) | 1, BTC funding this week above the trailing median | keeper, recurring series | [tx](https://testnet.monadscan.com/tx/0x6f9ce824fbf4a8fac6db415316816cdcf2effd632b69fe4a11a968de918f322d) | open |
| [0x6FFC…D9e](https://testnet.monadscan.com/address/0x6FFC70F919e9B6e20aD76df870854818C310cD9e) | 1, the golden path market: MON longs pay more than -$0.00000031 per MON between blocks 68,713,707 and 68,730,849 | deployer, `GoldenPath.s.sol` | [tx](https://testnet.monadscan.com/tx/0x001f11a404576309bbe7953f20fd1df942bbdeb2779e6baf34b8255315f6417b) | no outside wallet staked before the lock, so it never graduated; settled NO as a pool by the keeper ([tx](https://testnet.monadscan.com/tx/0x5bb2f79e48250d85621971cbe45af2be2ad7200e48bf5639dd3b0a028920e429)), which then paid the pool out ([tx](https://testnet.monadscan.com/tx/0x0f0507eb95f4b651e60d16d9b9c56b47ada1836ec8bae4e28e124c45894bff0e)) |
| [0x8565…7343](https://testnet.monadscan.com/address/0x85658Be96Ba2663AF6280834B16c7e340c727343) (Kuru v2 stack, its market 1) | 1, MON longs pay more than -$0.00000114 per MON between blocks 70,033,641 and 70,050,783 (lock about 2026-10-11 06:34 UTC) | deployer, `GoldenPath.s.sol` with `STACK=kuruV2` | [tx](https://testnet.monadscan.com/tx/0x0150994a815a5fcefbd1e56f14b2f04fe9e0012ee1436cdf065614f9edda5666) | pool open: 240 USDC YES and 240 USDC NO from 8 of our wallets; its Kuru v2 book waits for Kuru to create it |

## Protocol parameters (v0)

From [PROTOCOL.md §12](./PROTOCOL.md#12-parameters-v0) and the deploy script; the same on every network and stack except where a row says otherwise.

| Parameter | Value |
|---|---|
| Pool fee | 2% of winnings, never more than the losing side |
| Creator share of fees | 25% |
| Highest redemption fee per winning token | 0.0194 USDC (2% × 97%) |
| Graduation rule | pool of at least 500 USDC, at least 10 stakers, chance between 3% and 97% (testnet `hunch` stack: 100 USDC, 3 stakers) |
| Pool cap per market | 5,000 USDC |
| Stake cap per wallet per market | 1,000 USDC |
| Minimum stake | 1 USDC; the creator's first stake at least 5 USDC |
| Vault collateral cap | 50,000 USDC |
| Settlement deadline | close + 7 days (touch and spike templates: + 24-hour challenge first) |
| Kuru book | precisions 1e6 and 1e6, tick 0.001 USDC, minimum 1 YES, maximum the pool cap, fees 0 and 0 |

## Chain facts we rely on

| Fact | Value | Source |
|---|---|---|
| Monad block time | about 0.30 seconds (302 ms measured over 200,000 testnet blocks on 2026-10-03) | block timestamps |
| Perpl funding interval | 8,571 blocks | Perpl's funding grid ([PROTOCOL.md §8.2](./PROTOCOL.md#82-perpl)) |
| Public RPC log range | 100 blocks per `eth_getLogs` | Monad public RPC limits |
| Testnet gas price | about 100 gwei base fee | `eth_gasPrice`, 2026-10-03 |
| Kuru mainnet market creation | owner-only (`Unauthorized()` for anyone else) | the mainnet rehearsal fork test |

## Tests (2026-10-10)

| Suite | Count | Run |
|---|---|---|
| Contracts: unit, fuzz and invariant | 698 | `cd contracts && forge test` |
| Contracts: fork tests on live Monad testnet and mainnet | 60 | `FOUNDRY_PROFILE=fork forge test` |
| TypeScript: app, shared, SDK, MCP, keeper, maker, indexer, notifier, watchdog, rewards, examples | 1,618 passing | `pnpm test` |
| npm packages: the four tarballs as published, plus 3 checker tests | 4 packages | `node scripts/check-packages.mjs` (CI adds `--install`) |
| Local services script: settings, exec, start and stop | 28 checks | `bash scripts/test/run-local-services.test.sh` |

The full gate is `bash scripts/verify-all.sh`; CI runs it on every push, plus the fork suites.

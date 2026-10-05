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
| [0x6FFC…D9e](https://testnet.monadscan.com/address/0x6FFC70F919e9B6e20aD76df870854818C310cD9e) | 1, the golden path market: MON longs pay more than -$0.00000031 per MON between blocks 68,713,707 and 68,730,849 | deployer, `GoldenPath.s.sol` | [tx](https://testnet.monadscan.com/tx/0x001f11a404576309bbe7953f20fd1df942bbdeb2779e6baf34b8255315f6417b) | pool open: 240 USDC YES and 240 USDC NO from 8 of our wallets, waiting for two outside wallets ([GOLDEN-PATH.md](./GOLDEN-PATH.md)) |

## Protocol parameters (v0)

From [PROTOCOL.md §12](./PROTOCOL.md#12-parameters-v0) and the deploy script; the same on every network.

| Parameter | Value |
|---|---|
| Pool fee | 2% of winnings, never more than the losing side |
| Creator share of fees | 25% |
| Highest redemption fee per winning token | 0.0194 USDC (2% × 97%) |
| Graduation rule | pool of at least 500 USDC, at least 10 stakers, chance between 3% and 97% |
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

## Tests (2026-10-04)

| Suite | Count | Run |
|---|---|---|
| Contracts: unit, fuzz and invariant | 548 | `cd contracts && forge test` |
| Contracts: fork tests on live Monad | separate profile | `FOUNDRY_PROFILE=fork forge test` |
| TypeScript: app, shared, SDK, MCP, keeper, maker, indexer, notifier, watchdog, rewards, examples | 1,344 passing | `pnpm test` |

The full gate is `bash scripts/verify-all.sh`; CI runs it on every push, plus the fork suites.

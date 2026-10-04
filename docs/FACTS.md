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

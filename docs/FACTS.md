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

## Deployment (Monad mainnet, chain id 143)

| Fact | Value | Source |
|---|---|---|
| Deploy block | 112,517,059 (2026-10-11) | `hunchBook.deployBlock` in [deployments/monad-mainnet.json](../deployments/monad-mainnet.json) |
| Venue | Kuru v1: Graduator [0x5582…8B3C](https://monadscan.com/address/0x5582e5Aeb12e15EAda88402E2903Bc628Cc28B3C) on Kuru's router [0xd651…95CC](https://monadscan.com/address/0xd651346d7c789536ebf06dc72aE3C8502cd695CC). Kuru creates each book; anyone registers it | `hunchBook.graduator`, `external.kuru` |
| Collateral | Circle USDC [0x7547…b603](https://monadscan.com/address/0x754704Bc059F8C67012fEd69BC8A327a5aafb603) | `hunchBook.usdc` |
| Core contracts | 6 deployed (market implementation, [factory](https://monadscan.com/tx/0xae4e637ba5c7f1592b0f28fae6e4949f0702bb90e20aa19207f8883fc7d13f8b), [graduator](https://monadscan.com/tx/0xe56f3337961785804259dc9c77a1c3204cdd6e87376bfbebd8d3e6cdc6df3050), [router](https://monadscan.com/tx/0x614439faa00cd0588933a97285aedac2d251d5c3e3c5a5f5d962615673563959), two resolvers) plus the vault the factory deploys | `hunchBook` and `deployTxs` |
| Periphery contracts | 8 | `hunchBook.periphery` and its `deployTxs` |
| Source verification | all 20 contracts verified on Sourcify (match) | `forge verify-contract --verifier sourcify` |
| Templates registered | 7 (ids 1 to 7), by the guardian on 2026-10-12 ([template 1](https://monadscan.com/tx/0x4c24bcb28fae6e2d666cc4721199bf281fff2dfdb7c4c9e2f90636f049cd0828)) | `factory.templateOf(id)`; `addTemplate1` to `addTemplate7` in `deployTxs` |
| Graduation rule (every template) | a pool of at least 10 USDC from at least 2 wallets, stakes on both sides, chance between 3% and 97% | `factory.templateOf(1).rule` |
| Guardian | [0xCaA4…4Bf8](https://monadscan.com/address/0xCaA404541A30c277a05F2A500f3F4430250f4Bf8), a single key separate from the deployer, to be rotated to a multisig | `hunchBook.guardian` |
| Fee recipient | the deployer, [0xD183…10A8](https://monadscan.com/address/0xD183a7daECF3d539683f37e1111558E3dFC210A8) | `hunchBook.feeRecipient` |
| Deploy gas | about 3.74 MON for core and periphery, about 1.77 MON for templates 3 to 7 and the registrations | the deployer's balance before and after |
| Markets | 2, both opened 2026-10-12 by us ([Market #1](https://monadscan.com/address/0x11075eeC0d115b7aB754F54bcf79Fc5A5dc0F511) and [Market #2](https://monadscan.com/address/0x253BD48a07AEF48A0eb9281ACdfd331F31ED69E7), below) | `factory.marketCount()` |

### Market #1 on mainnet (ours, seeded by us)

"Will BTC/USD be at or above $83,500 at 2026-10-12 07:00:00 UTC, per Chainlink's BTC/USD feed?" (template 2,
Chainlink BTC/USD [0xc1d4…0546](https://monadscan.com/address/0xc1d4C3331635184fA4C3c22fb92211B2Ac9E0546)). Staking stops at
06:30 UTC. We created it and filled its pool: this activity is ours, not outside demand.

| Fact | Value | Source |
|---|---|---|
| Market | [Market #1](https://monadscan.com/address/0x11075eeC0d115b7aB754F54bcf79Fc5A5dc0F511) | `factory.marketAt(0)` |
| Created | by the deployer with 5 USDC on YES, block 112,637,798 ([tx](https://monadscan.com/tx/0x72caf4b41b17563b7668d06a1418a78849107319d070619fcbe3b8c7e6de8ea6)) | `MarketCreated` |
| Seeded stakes | 15 x 1 USDC, paid by the deployer for the 15 seed wallets below (7 YES, 8 NO): [1](https://monadscan.com/tx/0xdff0439fb6821280c9fd2d86ad03d1cbcb6c18c08ca90d033930c92464b1b492), [2](https://monadscan.com/tx/0x5bae8794705f3b8a40c595d38d01d1f46ab50d5fa3f108863379bfc4c149b7e5), [3](https://monadscan.com/tx/0x2dd190584334541a569bc3be9f09805915805e2a370ddb50d2db994a62d9af8c), [4](https://monadscan.com/tx/0x219eea577b5dd4c0766b3621924292390b596194ea090e7ed2f1ae7ed41cde3f), [5](https://monadscan.com/tx/0x3e9170e33663556d24610726dc6abca05bc618ead7db1fa8684fc0f21a607d3f), [6](https://monadscan.com/tx/0x2babd6f39cde371f4670b06c4598081df1692103d9afbe19fbdeb0d839dd8b57), [7](https://monadscan.com/tx/0x881554a6d8b6184b595b1f9d8dcd3204ef828d5e6d06efd7698c1090bd044558), [8](https://monadscan.com/tx/0x54061440e50078d53a73f716f15cc1f4103e34c5d53e66d4bd0454cddc1c579c), [9](https://monadscan.com/tx/0x3c55a7bb44a2b4116f2162deb255a08c93c51f0c51319fb76613c3d88e8a8210), [10](https://monadscan.com/tx/0xcb2213acc4cca2d4982a78bae3e6556c206b96c72bcd4d106dc778d96cf74ad1), [11](https://monadscan.com/tx/0xc61e8671081876c8ef566f0cea9398a9a3abbaedd5dd7b1f1b6e91a4ae7e9138), [12](https://monadscan.com/tx/0xb50b15ebf34562f09d0deb7a80d8493e349f88bf0b74d421e8a535b351790406), [13](https://monadscan.com/tx/0x98f0f04caf1c9198315ef4775c40a73be4a1c5c3be6d85f5ea3d8544dc486faf), [14](https://monadscan.com/tx/0x4b6b114fe1fea8dcac953004938fc11b818a4258f80f9be6ecb1b662010cc4c3), [15](https://monadscan.com/tx/0x8dd0b04c990b3767c1d9d7ec23de7ad83d6e378941513ca6aafcdb7377b69ea5) | `Staked`, `PoolDeposited` |
| Pool when seeded | 12 USDC YES, 8 USDC NO, 16 stakers; graduation rule met (10 USDC from 2 wallets) | `market.poolTotals()` |
| Book | none: Kuru creates mainnet books by hand, so this market settles as a pool | `market.book()` |
| Gas | 0.487 MON for the approval, the market and the 15 stakes, at 102 gwei | the receipts |

### Market #2 on mainnet (ours)

"Will MON/USD be at or above $0.03 at 2026-11-02 12:00:00 UTC, per Chainlink's MON/USD feed?" (template 2, Chainlink
MON/USD [0xBcD7…22fb](https://monadscan.com/address/0xBcD78f76005B7515837af6b50c7C52BCf73822fb)). Staking stops at
2026-11-01 12:00 UTC. We created it with our own 5 USDC on YES and no seed stakes, so its pool does not meet the
graduation rule yet (it needs at least 10 USDC from 2 wallets with both sides staked).

| Fact | Value | Source |
|---|---|---|
| Market | [Market #2](https://monadscan.com/address/0x253BD48a07AEF48A0eb9281ACdfd331F31ED69E7) | `factory.marketAt(1)` |
| Created | by the deployer with 5 USDC on YES, block 112,671,579 ([tx](https://monadscan.com/tx/0x21e32936d4cdc0ff4e0f64dd97d2f72a1d8f84e844b588722c403e83c71b72d7); [approval](https://monadscan.com/tx/0x467908d3f4d0bca2512b5f5c98637f864c9ae34c69cbfecc66d89ad99670d0dd)) | `MarketCreated` |
| YES token | HB2-YES [0x1064…9D66](https://monadscan.com/address/0x1064f0bb79443f398512c97c97E8E3E9dFD59D66) | `market.yes()` |
| Kuru book | none yet. Kuru's router computes [0x35B0…15C0](https://monadscan.com/address/0x35B011c0045c95e5Abae1f6B8754f5D1e96315C0) for our parameters; our keeper posted the `deployProxy` request | `Router.computeAddress`, keeper `book-request` |
| Gas | 0.132 MON for the approval and the market, at 102 gwei | the receipts |

### Our seed wallets on mainnet (ours, labelled)

These 15 wallets are ours. We created them to stake in our own mainnet markets, so a market can show
both sides and meet the graduation rule before outside money arrives. Their stakes are paid by the
deployer (the fee recipient above) with `stakeFor`, using
[contracts/script/SeedMainnetMarket.s.sol](../contracts/script/SeedMainnetMarket.s.sol), so each one is
counted as ours, never as an outside wallet: the indexer and the app read this list from `wallets.seeded`
in [deployments/monad-mainnet.json](../deployments/monad-mainnet.json) and also label any wallet whose
stake one of our wallets paid.

| # | Address | # | Address | # | Address |
|---|---|---|---|---|---|
| 1 | [0xBFE1…Ea12](https://monadscan.com/address/0xBFE10471aAf8c29b1Cf13D37945bCDB8A0F1Ea12) | 6 | [0xa53B…14b7](https://monadscan.com/address/0xa53BAC403BA5BE39Ee2FB6785c937A82D36E14b7) | 11 | [0xb9Ba…6251](https://monadscan.com/address/0xb9Bad31782C350786166d1CF537e409EEf5a6251) |
| 2 | [0xaF2e…8Cd4](https://monadscan.com/address/0xaF2e0cAE320e0b4f4551CD66E198e737774D8Cd4) | 7 | [0x417b…ffAa](https://monadscan.com/address/0x417ba60fB1b4FbBD6Ce98A84E2B09171d17effAa) | 12 | [0x5ee7…C5D2](https://monadscan.com/address/0x5ee7B628F5d36cab57359B3c73E99400E87AC5D2) |
| 3 | [0xcD1E…e6f2](https://monadscan.com/address/0xcD1EcAEa11147756C4822421278c61F6a01Fe6f2) | 8 | [0x426c…65e2](https://monadscan.com/address/0x426cEde991D641a7Ae24575F5e85912d3b9f65e2) | 13 | [0xDae9…8565](https://monadscan.com/address/0xDae9A48A88132c3905671BA1CaA01B50F6258565) |
| 4 | [0xe1fd…1fEa](https://monadscan.com/address/0xe1fd1d4FB20feA452aF3227E9fC0CbA3D8a81fEa) | 9 | [0x7c03…d730](https://monadscan.com/address/0x7c03fc419fA0b218a40B5Da15D6c3BcE25cCd730) | 14 | [0x5E1E…d38C](https://monadscan.com/address/0x5E1E4A59edC725141F68C1f5f01114068ba8d38C) |
| 5 | [0x342f…f442](https://monadscan.com/address/0x342f975C18D8D3a93639021b60EFC18D9f5Bf442) | 10 | [0x6798…4f27](https://monadscan.com/address/0x6798151D37A5Bf59B283690C68abB97E13884f27) | 15 | [0x0602…c13f](https://monadscan.com/address/0x0602863Cc4448f5B57C8FC8BDFb053955C80c13f) |

## Markets on Kuru (Monad testnet)

Kuru is the venue for every new market. New markets go to the primary stack, whose books are Kuru v1 books
(`defaultStack` in [deployments/monad-testnet.json](../deployments/monad-testnet.json)); markets on the `kuruV2`
stack wait for Kuru to create their v2 books.

### Kuru v1: the primary stack

#### Market #1 (our own, seeded by us)

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

#### Markets opened on 2026-10-11 (ours, seeded by us)

On 2026-10-11 we opened three more markets on the primary stack, whose books are Kuru v1 spot books. Each was
created by the deployer with a first stake on YES, and ten addresses derived from the deployer key (label
"hunch-book testnet seed") staked five on each side, so each pool held 500 USDC from 11 stakers, all ours, split
close to our maker's fair value at creation (0.52, 0.49, 0.49). That meets the primary stack's rule (at least
500 USDC from at least 10 stakers). Each graduated in the same run
([SeedTestnetMarket.s.sol](../contracts/script/SeedTestnetMarket.s.sol)), and the graduation transaction itself
created the market's YES/USDC book on Kuru through Kuru's `deployProxy`. Our maker bot quotes every book.

From the creation transaction to the graduation transaction that created the Kuru book, with the ten seed stakes
in between, took 67 blocks and 20 seconds for #10 (blocks 70,075,497 to 70,075,564), 41 blocks and 13 seconds for
#14 (70,081,840 to 70,081,881) and 38 blocks and 11 seconds for #15 (70,081,968 to 70,082,006): block numbers
from the receipts of the transactions linked below, seconds from those blocks' timestamps.

| Market | Question | Kuru book | Creation | Graduation | First quotes | Closes |
|---|---|---|---|---|---|---|
| #10 [0xC0Bc…54e1](https://testnet.monadscan.com/address/0xC0Bc38C5140D9289f3CE86d7FdC675485cAD54e1) | Will Perpl's MON mark price be at or above $0.025 at Oct 13, 12:00 UTC? | [0xAac9…4fe7](https://testnet.monadscan.com/address/0xAac99728483Ed7707E81B278c6eefD1112894fe7) | [tx](https://testnet.monadscan.com/tx/0x9dee03d3180c176b33072e6e8673258be3cf9af1f53a7baff1488b1afa9cfa5a) | [tx](https://testnet.monadscan.com/tx/0x8158ed8b27ff3f61a19face0166cc1a4591d6a7b5acc368a94af89bc83034f55) | bid 0.498, ask 0.529, [tx](https://testnet.monadscan.com/tx/0xddb43eb3fe7085eca2914e2252753f67bf04cdc66a7ef3602cac219d33503b7d) | 2026-10-13 12:00 UTC (snapshot) |
| #14 [0x6Edc…1996](https://testnet.monadscan.com/address/0x6Edc55D3a4282B65ebB7A76190b0fc0E384b1996) | Will ETH longs pay more than $18.25 per ETH in funding on Perpl (perp 32) between blocks 70,101,757 and 72,698,770? | [0x9591…D9c2](https://testnet.monadscan.com/address/0x9591287afbe0465636dD1C88f54B6358742bD9c2) | [tx](https://testnet.monadscan.com/tx/0xd35840ee5c96b95e9621217e9f704aeb67f998c49ee4a2cf1d545c5763f84b85) | [tx](https://testnet.monadscan.com/tx/0x16ea32512a1bb52df91a89aedb65785e910a91bcb7546e38d533ce513dd154ab) | bid 0.454, ask 0.485, [tx](https://testnet.monadscan.com/tx/0xde606b7c17b2e5981090613c2bb3da27f0ba590965fcca1106533f0f22ae0e61) | block 72,698,770, about 2026-10-20 14:10 UTC |
| #15 [0xaAE5…8613](https://testnet.monadscan.com/address/0xaAE5C41202e6b85Ef285b01441fA742Ef6988613) | Will BTC longs pay more than $1,080 per BTC in funding on Perpl (perp 16) between blocks 70,101,889 and 74,695,945? | [0x0A93…565D](https://testnet.monadscan.com/address/0x0A936f92C3C9845Fae2a7da45bEeAA1DAdBd565D) | [tx](https://testnet.monadscan.com/tx/0xfab8721d41695dbda8289fd48c26bf2740146c4be90bf717009ec57c3e7b48e5) | [tx](https://testnet.monadscan.com/tx/0x6ab359a8fe1e942e7e770595d36316f26fb782b187fb9411a25c8ec168b8a7ac) | bid 0.417, ask 0.448, [tx](https://testnet.monadscan.com/tx/0x596e7274d0dfc68385403a8a6f5218011c77388b7713d882a2e223f51e26ccb2) | block 74,695,945, about 2026-10-27 14:15 UTC |

Router trades on each of these Kuru books from the deployer (ours, [TradeTestnet.s.sol](../contracts/script/TradeTestnet.s.sol)),
5 USDC or 5 tokens each, every one filled against our maker's quotes:

| Market | Buy YES | Sell YES | Buy NO | Sell NO |
|---|---|---|---|---|
| #10 MON mark | [9.090909 YES for 5 USDC](https://testnet.monadscan.com/tx/0x082892a5ce4ec0327496beeddb5a98f42905434ca0a173f7ac1cb8b0bb0b55fb) | [4.718181 USDC back](https://testnet.monadscan.com/tx/0xc8918eaa0949c5cb7516d64860706160e4f8eea38a43e0c1110eda247058994f) | [5 NO for 2.405 USDC](https://testnet.monadscan.com/tx/0x06d4d20f42fcf28b8f65b6643e91bea4f1806c7be0b69d043b44e37a20091ea7) | [2.25 USDC back](https://testnet.monadscan.com/tx/0xd8c93f6741be53be077edd19e03dd4c44a6b672894fa582a9d4dc66d4ac80d96) |
| #14 ETH funding | [10.309278 YES for 5 USDC](https://testnet.monadscan.com/tx/0xafff4d675fc8befccecc0465e34e50d91afadc3bd823e2011a70569b10dfb498) | [4.680412 USDC back](https://testnet.monadscan.com/tx/0x5d11c2e06edbb0fa20a1539becec9d3046ecb10c9183b3c3536b93ded752e787) | [5 NO for 2.73 USDC](https://testnet.monadscan.com/tx/0xb2bf72d1251e7b9e02d47e5e626291a0822f4d6eeebf379122aec23acda1dffe) | [2.575 USDC back](https://testnet.monadscan.com/tx/0xfe3e4800fdf2c622bf045cbbdce32ce5195b4f5e0776485a9e0eafc5d2c53f7f) |
| #15 BTC funding | [11.160714 YES for 5 USDC](https://testnet.monadscan.com/tx/0x7af9b4508ca423c59e0498549d17065cf1b7cea0962208d0202bf2a09ee478d8) | [4.654017 USDC back](https://testnet.monadscan.com/tx/0xa69ca6b6aec5df48abea31173730bfc3ee15b3e8a957063517ac693e30faaab2) | [5 NO for 2.915 USDC](https://testnet.monadscan.com/tx/0x258957ba23d212c3f17c3d09c96d489dd47f88925a6b1d8f50fc01a66c103a27) | [2.76 USDC back](https://testnet.monadscan.com/tx/0x8b45b694980001b6a65d65b1beaa19aa4d9351a27fb6a3a03c25231d8da84d3d) |

The same run also opened three markets we did not intend, all ours. Two used the script's defaults by mistake (a
shell variable that did not expand), so they ask the same short question; both graduated into Kuru books that our
maker quotes, and both close about 17 hours after creation. The third timed out on the public RPC halfway through
seeding, so it locked before it reached the rule and stays a pool; it settles as a pool.

| Market | Question | Kuru book | Creation | Graduation | Closes |
|---|---|---|---|---|---|
| #11 [0x8d3a…6901](https://testnet.monadscan.com/address/0x8d3a79a2FB05644c806CC923c76d81aF5a4F6901) | Will MON longs pay more than $0.000015 per MON in funding on Perpl (perp 64) between blocks 70,078,605 and 70,284,309? | [0x9E9F…6EC7](https://testnet.monadscan.com/address/0x9E9F7686CEa548cbb82dC950b5C406f216aB6EC7) | [tx](https://testnet.monadscan.com/tx/0x9b5a2c5403044f43944790b125cd896c24673ab5ef1d1ca9c4f7ca7108656cb8) | [tx](https://testnet.monadscan.com/tx/0x295045b3b52e2187d13a9a1d2a75d36c41dd3d500e7f53dfc64936f5f8472359) | block 70,284,309; settled NO from Perpl's funding history by the keeper at 02:58 UTC on 2026-10-12 ([tx](https://testnet.monadscan.com/tx/0x9346cda9cdd4da363a702c2b4e9dba815170934afcc1245ec21b1e88dca6aa8d)) |
| #12 [0x2791…2dCA](https://testnet.monadscan.com/address/0x2791906DEFe7d530A5ae93503A5a695091Aa2dCA) | Will MON longs pay more than $0.000015 per MON in funding on Perpl (perp 64) between blocks 70,078,812 and 70,284,516? | [0xC2f7…06d6](https://testnet.monadscan.com/address/0xC2f723215977A60fDC9E2a15091afAC2D7A406d6) | [tx](https://testnet.monadscan.com/tx/0xb0e7a800cd9d02a79b206bea87cccc11c899e54ee84a3c3c194f2a2c75531e33) | [tx](https://testnet.monadscan.com/tx/0x71c887e8a9a5b4f0a49dd3556c7cc3979b666e52c01d92229f6233532cf271bd) | block 70,284,516; settled NO from Perpl's funding history by the keeper at 02:59 UTC on 2026-10-12 ([tx](https://testnet.monadscan.com/tx/0x1b4419e0299dcc81d3cc785899f73968a13800a57b3584e9efe5b4a75318db3a)) |
| #13 [0x3244…f10a](https://testnet.monadscan.com/address/0x324478E02735bbA813AeB1657DD363bf2F51f10a) | Will ETH longs pay more than $18.25 per ETH in funding on Perpl (perp 32) between blocks 70,079,933 and 72,676,946? | none (pool: 245 USDC YES, 51 USDC NO from 7 stakers, all ours) | [tx](https://testnet.monadscan.com/tx/0xe1bca75d5bb4c7bb16d777eb4dac0961b153ecdab50483ba9adf4e804b4aff6c) | did not graduate | block 72,676,946, about 2026-10-20 12:20 UTC |

### Kuru v2: the `kuruV2` stack

Kuru v2 books can only be created by Kuru's governance (`SpotRouter.deploySpotMarket`), after Kuru sets up each
token (a price source on its withdrawal limiter, then `configureSpotToken` and `whitelistSpotToken`). Our keeper
publishes each market's exact request at [/api/v1/kuru/requests](https://book.playhunch.xyz/api/v1/kuru/requests),
and registers and graduates the market once the book exists.

The stack's market #1 [0x8565…7343](https://testnet.monadscan.com/address/0x85658Be96Ba2663AF6280834B16c7e340c727343)
reached its lock with no Kuru book, so it stayed a pool. Our keeper settled it YES from Perpl's funding history
([settle tx](https://testnet.monadscan.com/tx/0xd7ffd5b3a0e6543545f95a894327df10a2213f20480470d14737a549d93ca13f),
2026-10-11) and paid the pool out to its stakers
([payout tx](https://testnet.monadscan.com/tx/0x4d41b5fd4384654e06b1639b1b7feccaad830466a95f641f963e0748a5b65eeb)).
As of 2026-10-11, Kuru's v2 testnet has not set up our test USDC or any YES token, and no v2 book exists for a
Hunch Book market (`SpotRouter.whitelistedSpotTokens` and `AccountCore.spotTokenConfigs` return false for both).

On 2026-10-11 we opened three more markets on the `kuruV2` stack. Each was created by the deployer with a first stake
on YES, and ten addresses derived from the deployer key staked five on each side, so each pool holds 500 USDC from
11 stakers, all ours, split close to our maker's fair value (0.46, 0.47, 0.48) and already meeting the rule. The same
run created each market's YES and NO price feeds for Kuru's withdrawal limiter and took the oracle's first
observation ([SeedTestnetMarket.s.sol](../contracts/script/SeedTestnetMarket.s.sol) with `STACK=kuruV2
GRADUATE=false`). Each graduates once Kuru deploys its book at the address below, any time before its lock.

| Market | Question | YES token | YES feed | Book Kuru would deploy | Creation | Lock | Closes |
|---|---|---|---|---|---|---|---|
| #2 [0xBb17…4400](https://testnet.monadscan.com/address/0xBb17B0254F3DA5CD0b3dF27a56865dCfF4c84400) | Will Perpl's MON mark price be at or above $0.025 at Oct 20, 12:00 UTC? | [0xFd39…07D0](https://testnet.monadscan.com/address/0xFd39Dd93dA6d212f5388Ee8d69aE8296c8dc07D0) | [0x12a7…6d1B](https://testnet.monadscan.com/address/0x12a738F920fc34eC47Cb4Fa2c3C1eE120cFd6d1B) | 0xaE9d…6Fa7 | [tx](https://testnet.monadscan.com/tx/0x1c5def3c34fa4a9cff946346b14e8d53fe212428eb02cbf21a27fc95d2859f23) | 2026-10-17 12:00 UTC | 2026-10-20 12:00 UTC (snapshot) |
| #3 [0x48fb…a234](https://testnet.monadscan.com/address/0x48fb7050B678271e0ac9eb2565bE7d39096bA234) | Will Perpl's ETH mark price be at or above $2,500 at Oct 23, 12:00 UTC? | [0x4cE8…D8aA](https://testnet.monadscan.com/address/0x4cE8c65b9446a383E7C143281507bB6df302D8aA) | [0x4321…0727](https://testnet.monadscan.com/address/0x432197ed2fd5BBF0c6496378D8584732804a0727) | 0xDec2…69c6 | [tx](https://testnet.monadscan.com/tx/0x3b67503959f74d0933979c09b79e26e8af5245ed7a10196393857f139103396c) | 2026-10-20 12:00 UTC | 2026-10-23 12:00 UTC (snapshot) |
| #4 [0x0177…55b1](https://testnet.monadscan.com/address/0x0177f158e9Dd657Bc276E83f5ED5F834057F55b1) | Will Perpl's BTC mark price be at or above $83,000 at Oct 27, 12:00 UTC? | [0xb3b0…cB11](https://testnet.monadscan.com/address/0xb3b068110939e87647a4865A57EF9540c1edcB11) | [0xE34f…CF87](https://testnet.monadscan.com/address/0xE34f6F64cF0a0D01e49378614B073a12103BCF87) | 0xA70b…d12E | [tx](https://testnet.monadscan.com/tx/0x86da05037c66146aff468ddb21b8bae8ce0ea792243c5cacb7dfd076534fb924) | 2026-10-24 12:00 UTC | 2026-10-27 12:00 UTC (snapshot) |

The book address is `GraduatorV2.predictedBook(market)`: where `SpotRouter.deploySpotMarket` puts a book with exactly
the parameters in `GraduatorV2.bookRequest(market)` (size and price precision 1,000,000, tick 1,000, passive spread 10
ticks, minimum notional 1 USDC, maximum 5,000 USDC, taker fee 7,000 and maker fee 4,000 pps, quote token our test USDC).
If a Kuru market lock passes with no book, the market settles as a pool, as market #1 did.

## Our fallback book: the `hunch` stack (Monad testnet)

Hunch Book's own onchain order book, built as a fallback behind Kuru v1's interface. It takes no new markets:
new markets go to Kuru, and the guardian [paused market creation](https://testnet.monadscan.com/tx/0x801c5e41764d0b0cd2de7a03abbc1fe889a2cdb000f31ead7b93cd0e01a3d44a) on this stack's factory on 2026-10-12. Its earlier markets, below, run
to settlement on their books.

| Fact | Value | Source |
|---|---|---|
| Deploy block | 69,857,525 (2026-10-10) | `stacks.hunch.deployBlock` in [deployments/monad-testnet.json](../deployments/monad-testnet.json) |
| New contracts | factory and vault, [HunchOrderBookFactory 0x0DDF…46C5](https://testnet.monadscan.com/address/0x0DDF74540B6720B348483084F749907b2c3F46C5) (it deploys the [HunchMarginAccount 0x6dDa…Ee1c](https://testnet.monadscan.com/address/0x6dDaC7a754A2A4bf2fF688B8F08eaA8ADC42Ee1c) and the book implementation), graduator, router, parlay resolver | `stacks.hunch` and its `deployTxs` |
| Reused from the primary stack | test USDC, market implementation, the resolvers of templates 1 to 5 and 7 (none of them is tied to a factory) | the same addresses under `hunchBook` and `stacks.hunch` |
| Templates registered | 7 (ids 1 to 7) | `addTemplate1` to `addTemplate7` in `stacks.hunch.deployTxs` |
| Graduation rule | pool of at least 100 USDC, at least 3 stakers, chance between 3% and 97% | `factory.templateOf(id).rule`; `GRADUATION_MIN_POOL=100 GRADUATION_MIN_STAKERS=3` at deploy |
| Trading fees on the book | 0 | `HunchOrderBookFactory` accepts fee 0 only |
| Source verification | all 9 new contracts verified on Sourcify (exact match) | `forge verify-contract --verifier sourcify` |
| Takes new markets | no: market creation is [paused](https://testnet.monadscan.com/tx/0x801c5e41764d0b0cd2de7a03abbc1fe889a2cdb000f31ead7b93cd0e01a3d44a) (2026-10-12), and new markets go to the primary stack, on Kuru | `factory.creationPaused()`; `defaultStack` in the deployments file |

### Earlier markets on the `hunch` stack (ours, seeded by us)

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
| [0x8565…7343](https://testnet.monadscan.com/address/0x85658Be96Ba2663AF6280834B16c7e340c727343) (Kuru v2 stack, its market 1) | 1, MON longs pay more than -$0.00000114 per MON between blocks 70,033,641 and 70,050,783 (lock about 2026-10-11 06:34 UTC) | deployer, `GoldenPath.s.sol` with `STACK=kuruV2` | [tx](https://testnet.monadscan.com/tx/0x0150994a815a5fcefbd1e56f14b2f04fe9e0012ee1436cdf065614f9edda5666) | Kuru never created its v2 book, so it locked as a pool (240 USDC YES and 240 USDC NO from 8 of our wallets); settled YES as a pool by the keeper ([tx](https://testnet.monadscan.com/tx/0xd7ffd5b3a0e6543545f95a894327df10a2213f20480470d14737a549d93ca13f)), which then paid the pool out ([tx](https://testnet.monadscan.com/tx/0x4d41b5fd4384654e06b1639b1b7feccaad830466a95f641f963e0748a5b65eeb)) |

## Protocol parameters (v0)

From [PROTOCOL.md §12](./PROTOCOL.md#12-parameters-v0) and the deploy script; the same on every network and stack except where a row says otherwise.

| Parameter | Value |
|---|---|
| Pool fee | 2% of winnings, never more than the losing side |
| Creator share of fees | 25% |
| Highest redemption fee per winning token | 0.0194 USDC (2% × 97%) |
| Graduation rule | pool of at least 500 USDC, at least 10 stakers, chance between 3% and 97% (testnet fallback `hunch` stack: 100 USDC, 3 stakers) |
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

# Deploying Hunch Book

This is the runbook for putting Hunch Book on a Monad network. Testnet is live (addresses in
[`deployments/monad-testnet.json`](../deployments/monad-testnet.json)). Mainnet is **building**, on Kuru
v1: the core and the periphery were deployed on 2026-10-11 (addresses and transactions in
[`deployments/monad-mainnet.json`](../deployments/monad-mainnet.json)); templates 3 to 7 and the
guardian's template registrations (steps 3 and 4) are next, so no market can be created there yet. Every
step below has been rehearsed on a fork of Monad mainnet.

`deployments/<network>.json` is the only source of contract addresses. The deploy script writes it,
and the app, keeper, maker, indexer and docs all read it.

## What gets deployed

| Contract | Holds funds | Notes |
|---|---|---|
| `HunchBookFactory` | no | Deploys the `CollateralVault` in its constructor, so the vault trusts exactly one factory |
| `CollateralVault` | all USDC | One per factory |
| `Market` implementation | no | Every market is a minimal clone of it |
| `PerplFundingResolver` (template 1) | no | Pins Perpl's contract version at deploy time |
| `PriceAtTimeResolver` (template 2) | no | Chainlink feeds allowlisted at deploy time; Pyth only for assets with no Chainlink feed |
| `Graduator` | no | Testnet: creates Kuru books. Mainnet: verifies and registers books Kuru creates |
| `HunchRouter` | never between transactions | Buy and sell YES or NO in one transaction |
| `TestUSDC` | testnet only | Mintable test collateral, because Kuru's testnet USDC cannot be minted |

Templates 3 to 6 (touch, funding spike, price range, parlay) are deployed with
`DeployTemplatesV2.s.sol` and template 7 (snapshot) with `DeploySnapshotTemplate.s.sol`; the periphery with
`DeployPeriphery.s.sol`. See [TEMPLATES.md](./TEMPLATES.md) and [PERIPHERY.md](./PERIPHERY.md).

## Parameters set at deploy

From [PROTOCOL.md §10.3 and §12](./PROTOCOL.md#103-beta-limits-v0):

| Parameter | Value | Where |
|---|---|---|
| Pool cap per market | 5,000 USDC | `Deploy.betaCaps()` |
| Stake cap per wallet per market | 1,000 USDC | `Deploy.betaCaps()` |
| Minimum stake | 1 USDC | `Deploy.betaCaps()` |
| Creator's first stake | at least 5 USDC | `Deploy.betaCaps()` |
| Total USDC the vault may hold | 50,000 USDC | `Deploy.COLLATERAL_CAP` |
| Graduation rule | `GRADUATION_MIN_POOL` USDC pool and `GRADUATION_MIN_STAKERS` stakers (default 500 and 10), chance between 3% and 97% | `GraduationRuleEnv.sol`, read by `Deploy.s.sol` and `GuardianBatch.s.sol` |
| Kuru book | precisions 1e6 and 1e6, tick 0.001 USDC, minimum 1 YES, maximum = pool cap, fees 0 and 0, AMM spread 30 | `Deploy._deployTrading` |

Caps apply to markets created after a change. Existing markets keep the caps they started with. A
template's graduation rule is fixed when the guardian adds it; every template on a deployment gets
template 1's rule (`GuardianBatch.s.sol` copies it once template 1 is registered).

## Roles

| Role | Testnet | Mainnet |
|---|---|---|
| Deployer | a hot key, `DEPLOYER_PRIVATE_KEY` | a key used for the deploy only, then emptied. `--account`, `--ledger` or `--interactive` work as well as the env key |
| Guardian | the deployer | **a separate address**, ideally a multisig. `Deploy.s.sol` stops on mainnet if `GUARDIAN` is unset or is the deployer |
| Fee recipient | the deployer | an address chosen by Hunch, ideally the guardian multisig. It can hand the role on (`setFeeRecipient`) |

The guardian can pause market creation and graduation, add templates and set caps for future
markets. It can never pause settlement, redemption, merges or refunds, never move funds and never
set an outcome ([PROTOCOL.md §7.3](./PROTOCOL.md#73-access-control)).

## Mainnet, step by step

The mainnet stack is Kuru v1 (`KURU_VERSION=1`, the default): Kuru's mainnet Router, MarginAccount and
order books, with Circle USDC as collateral. On mainnet Kuru's `Router.deployProxy` is owner-only, so
Kuru creates each market's YES/USDC book and anyone registers it with the Graduator, which checks
every parameter. Until a market's book is registered, the market runs as a pool; if it never arrives,
the pool settles (or voids) and pays out without Kuru.

### 0. Before you start

- The guardian address (a multisig is best) and the fee recipient address.
- MON for gas on the deployer and, for a single-key guardian, on the guardian. Monad charges the gas
  **limit**, not the gas used, so keep `--gas-estimate-multiplier 110`. Measured on an anvil fork of
  mainnet at 102 gwei (gas limits as sent):

  | Step | Transactions | Gas | MON |
  |---|---|---|---|
  | `Deploy.s.sol` (core, Kuru v1) | 7 | 21.3 million | 2.18 |
  | `DeployTemplatesV2.s.sol` (templates 3 to 6) | 4 | 10.6 million | 1.08 |
  | `DeploySnapshotTemplate.s.sol` (template 7) | 1 | 7.3 million | 0.74 |
  | `DeployPeriphery.s.sol` | 8 | 15.0 million | 1.53 |
  | Guardian: 7 `addTemplate` calls | 7 | about 0.7 million | 0.07 |

  Forge's "Estimated amount required" prices a whole script at the maximum fee it bids (about twice
  the base fee), so give the deployer more than it spends: 8 MON at least. Passing
  `--with-gas-price 120gwei --priority-gas-price 2gwei` lowers that check to 1.2 times the base fee;
  Monad still charges base fee plus tip.
- `forge --version` reports 1.8 or later. `contracts/foundry.toml` sets `network = "monad"`.

### 1. Rehearse on a fork

Three fork suites run the real deploy script on a fork of Monad mainnet, with Circle USDC, Kuru's
mainnet Router, MarginAccount and order book, and Chainlink's BTC/USD feed. They skip when the RPC is
unreachable.

```bash
cd contracts
FOUNDRY_PROFILE=fork forge test --match-path "test/fork/Mainnet*" -vv
```

- `MainnetKuruV1.fork.t.sol`: the money paths, with USDC moved from a real Circle USDC holder.
  `deployProxy` refuses everyone but Kuru's owner. With no book, `graduate()` reverts and the pool
  locks, settles and pays every winner in full, or voids and refunds every stake. With the book Kuru's
  owner creates (at the address `computeAddress` predicts), anyone registers it, the market
  graduates, and trades route through Kuru.
- `MainnetRehearsal.fork.t.sol`: the whole launch, guardian batch included, and the Kuru v2 paths.
- `HunchVenueMainnet.fork.t.sol`: the fallback, Hunch Book's own order book (`VENUE=hunch`), where books
  are created inside `graduate()`.

The gas table above comes from broadcasting the real scripts to a local anvil fork, and
`RehearseMainnetMarket.s.sol` walks one market through its life there (it refuses any RPC but
anvil):

```bash
anvil --fork-url https://rpc.monad.xyz --network monad --auto-impersonate --port 18643
# give the deployer, a stand-in guardian, the keeper, the maker and Kuru's owner MON: cast rpc anvil_setBalance ...
GUARDIAN=<stand-in> forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:18643 --unlocked \
  --sender <deployer> --broadcast --slow --gas-estimate-multiplier 110
forge script script/GuardianBatch.s.sol --sig "register()" --rpc-url http://127.0.0.1:18643 --unlocked \
  --sender <stand-in> --broadcast --slow --gas-estimate-multiplier 110
forge script script/RehearseMainnetMarket.s.sol --rpc-url http://127.0.0.1:18643 --unlocked \
  --sender <keeper> --broadcast --slow --gas-estimate-multiplier 110
git checkout deployments/   # the anvil run wrote the deployments file
```

### 2. Deploy

```bash
cd contracts
GUARDIAN=0xGuardian FEE_RECIPIENT=0xFeeAddress GRADUATION_MIN_POOL=200 GRADUATION_MIN_STAKERS=5 \
forge script script/Deploy.s.sol --rpc-url "$MONAD_MAINNET_RPC" --account deployer \
  --broadcast --slow --gas-estimate-multiplier 110
forge script script/Deploy.s.sol --sig "record()" --rpc-url "$MONAD_MAINNET_RPC"
```

Run it once without `--broadcast` (and with `--sender <deployer address>` in place of `--account`)
first: a dry run prints every address and writes nothing. The broadcast run writes the addresses into
`deployments/monad-mainnet.json` under `hunchBook`, and `record()` adds the deploy transaction hashes.
`DEPLOYER_PRIVATE_KEY` in `.env` works in place of `--account`; Foundry reads `.env` from the directory
it runs in, so the key never goes on the command line.

The 2026-10-11 mainnet deploy ran this script with `KURU_VERSION=1` (now the default) and a separate
guardian, so it registered no template.

`GRADUATION_MIN_POOL` and `GRADUATION_MIN_STAKERS` set the rule every template gets. The defaults (500
USDC, 10 stakers) are the testnet v0 rule; the line above uses 200 USDC from 5 stakers as an example.
Choose before the guardian's first registration: a template's rule cannot change once the guardian adds
it.

**Other venues.** `VENUE=hunch` deploys the fallback, Hunch Book's own order book, instead
(HunchOrderBookFactory, its HunchMarginAccount and the book implementation, with the v1 Graduator and
HunchRouter on it): every market graduates into its own book on the spot, with no third party
([PROTOCOL.md §8.1](./PROTOCOL.md#81-order-book-venues)). Its rehearsal is
`test/fork/HunchVenueMainnet.fork.t.sol`. `KURU_VERSION=2` deploys GraduatorV2 and HunchRouterV2 against
`external.kuruV2`, once Kuru publishes v2 mainnet addresses; until then `KURU_VERSION=2 WIRE_KURU=0`
deploys everything but the graduator and router, and `WireKuruV2.s.sol` wires them later with the same
deployer (the factory's `setGraduator` is one-time and deployer-only). `KURU_TAKER_FEE_PPS` and
`KURU_MAKER_FEE_PPS` set the fees asked of Kuru for v2 books (default 7000 and 4000 parts per 10^7).
GraduatorV2 accepts any book Kuru creates within its limits (tick up to 0.01 USDC, minimum order up to
10 USDC, taker fee up to 0.3%), so a different choice by Kuru does not need a redeploy.

Then verify the contracts on Sourcify (the same way testnet was verified):

```bash
forge verify-contract <address> <path:Contract> --chain 143 --verifier sourcify
```

### 3. The guardian registers templates 1 and 2

The deployer is not the guardian on mainnet, so it cannot register templates. The other template
scripts copy template 1's rule, so templates 1 and 2 come first.

A multisig guardian (a Safe): generate the batch, which sends nothing.

```bash
cd contracts
GRADUATION_MIN_POOL=200 GRADUATION_MIN_STAKERS=5 forge script script/GuardianBatch.s.sol --rpc-url "$MONAD_MAINNET_RPC"
```

This writes `deployments/guardian/monad-mainnet-add-templates.json` in the Safe Transaction Builder
format, one `addTemplate(templateId, resolver, rule)` call per deployed template not yet registered. In
the Safe app, open Transaction Builder, drop the file in, check every call against this document, and
sign. A single-key guardian sends the same calls from its own wallet; the script stops unless the
wallet is the factory's guardian:

```bash
GRADUATION_MIN_POOL=200 GRADUATION_MIN_STAKERS=5 forge script script/GuardianBatch.s.sol --sig "register()" \
  --rpc-url "$MONAD_MAINNET_RPC" --account guardian --broadcast --slow --gas-estimate-multiplier 110
```

### 4. The other templates and the periphery

```bash
cd contracts
forge script script/DeployTemplatesV2.s.sol --rpc-url "$MONAD_MAINNET_RPC" --account deployer --broadcast --slow
forge script script/DeployTemplatesV2.s.sol --sig "record()" --rpc-url "$MONAD_MAINNET_RPC"
forge script script/DeploySnapshotTemplate.s.sol --rpc-url "$MONAD_MAINNET_RPC" --account deployer --broadcast --slow
forge script script/DeploySnapshotTemplate.s.sol --sig "record()" --rpc-url "$MONAD_MAINNET_RPC"
TIMELOCK_PROPOSER=0xGuardian DISTRIBUTOR_FUNDER=0xGuardian \
  forge script script/DeployPeriphery.s.sol --rpc-url "$MONAD_MAINNET_RPC" --account deployer --broadcast --slow
forge script script/DeployPeriphery.s.sol --sig "recordTxs()" --rpc-url "$MONAD_MAINNET_RPC"
```

These scripts only deploy. Then the guardian registers templates 3 to 7 exactly as in step 3 (the
batch and `register()` skip what is already registered and use template 1's rule), and the
registrations are recorded:

```bash
FROM_BLOCK=<block of the first addTemplate> forge script script/GuardianBatch.s.sol --sig "record()" \
  --rpc-url "$MONAD_MAINNET_RPC"
pnpm exec biome format --write deployments/
```

### 5. Commit the deployment record

Commit `deployments/monad-mainnet.json` with the deploy transaction hashes, then push. The app
shows mainnet as soon as the file has a factory address, and the indexer config for mainnet is
generated from it (`pnpm --filter @hunch-book/indexer gen-config`).

### 6. Books on mainnet

On a Kuru v1 stack, Kuru creates each book:

1. The keeper asks for it. Once a pool is `KEEPER_BOOK_REQUEST_AT` of the way to its rule (0.5 on
   mainnet: half the pool and half the stakers), the keeper logs, and posts to its webhook, the exact
   `deployProxy` call and the address the book will land at. By hand:

   ```bash
   MARKET=0x... forge script script/RegisterBook.s.sol --sig "request()" --rpc-url "$MONAD_MAINNET_RPC"
   ```

2. Kuru's owner calls `deployProxy` with those arguments.
3. Anyone registers the book; the Graduator refuses any book whose parameters differ. The keeper does it
   on its next cycle, or by hand:

   ```bash
   MARKET=0x... BOOK=0x... REGISTRAR_PRIVATE_KEY=... \
   forge script script/RegisterBook.s.sol --rpc-url "$MONAD_MAINNET_RPC" --broadcast
   ```

4. The keeper (or anyone) calls `graduate()` once the pool meets its rule.

Until a book is registered a market runs as a pool, and if its book never arrives it settles as a pool.
Nothing is lost. On a `VENUE=hunch` stack there is nothing to do: `graduate()` creates each book. On
Kuru v2 the flow is the same with `RegisterBookV2.s.sol`, plus Kuru's per-token setup.

### 7. Start the services

See [ops/README.md](../ops/README.md) for the keeper and the maker bot: environment variables,
hosting, gas budgets and health checks. On mainnet both take `KEEPER_NETWORK=monad-mainnet` and
`MAKER_NETWORK=monad-mainnet`; [`ops/services.mainnet.env.example`](../ops/services.mainnet.env.example)
runs them next to the testnet pair from the same checkout. Measured mainnet gas, at 102 gwei:

| Who | Transaction | Gas limit | MON |
|---|---|---|---|
| Creator | `createMarket` (template 2) | 1.19 million | 0.12 |
| Staker | `approve`, then `stake` | 0.08 million, 0.22 million | 0.01, 0.02 |
| Kuru's owner | `deployProxy` (one book) | 1.39 million | 0.14 |
| Keeper | `registerBook`, `graduate`, `claimTokensFor` (6 stakers) | 0.20, 0.36, 0.59 million | 0.02, 0.04, 0.06 |
| Maker | first quote on a new book (mint, deposits, two orders) | about 1.5 million | 0.15 |
| Maker | requote, one bid and one ask | 0.58 million | 0.06 |
| Trader | `buyYes`, `sellYes`, `buyNo` | 0.56, 0.54, 0.79 million | 0.06, 0.05, 0.08 |

## Testnet

Testnet was deployed on 2026-10-03 from block 67,856,277. The same script, with no `GUARDIAN`
set, makes the deployer the guardian and registers templates 1 and 2 in the same run. The
deployments file lists every deploy transaction hash.

Re-running `Deploy.s.sol` on a stack that already has a factory stops with "already deployed on this
stack". A new deployment means a new factory, a new vault and new markets; existing markets keep
working against the old ones.

**Three stacks on testnet.** The `hunch` stack (`stacks.hunch`, the `defaultStack` for new markets)
trades on Hunch Book's own order book. `DeployHunchStack.s.sol` deployed it next to the primary stack,
reusing the primary stack's test USDC, market implementation and the resolvers that are not tied to a
factory, and registered templates 1 to 7 with a 100 USDC, 3-staker rule:

```bash
cd ~/Projects/hunch-book   # the checkout with .env
STACK=hunch GRADUATION_MIN_POOL=100 GRADUATION_MIN_STAKERS=3 \
  forge script <root>/script/DeployHunchStack.s.sol:DeployHunchStack --root <root> \
  --rpc-url monad_testnet --broadcast --slow --gas-estimate-multiplier 110
```

`SeedTestnetMarket.s.sol` and `TradeTestnet.s.sol` take `STACK=hunch` too.

The primary stack (`hunchBook`) uses Kuru v1, where anyone can create a
book, so markets graduate on their own. The Kuru v2 stack sits under `stacks.kuruV2`, reuses the same
test USDC, and graduates once Kuru creates each book:

```bash
cd contracts
STACK=kuruV2 KURU_VERSION=2 DEPLOYER_PRIVATE_KEY=... \
  forge script script/Deploy.s.sol --rpc-url "$MONAD_TESTNET_RPC" --broadcast --gas-estimate-multiplier 110
STACK=kuruV2 DEPLOYER_PRIVATE_KEY=... \
  forge script script/DeployPeriphery.s.sol --rpc-url "$MONAD_TESTNET_RPC" --broadcast --slow
STACK=kuruV2 forge script script/DeployPeriphery.s.sol --sig "recordTxs()" --rpc-url "$MONAD_TESTNET_RPC"
# templates 3 to 7 on that stack (the scripts read STACK too)
STACK=kuruV2 DEPLOYER_PRIVATE_KEY=... \
  forge script script/DeployTemplatesV2.s.sol --rpc-url "$MONAD_TESTNET_RPC" --broadcast --slow
STACK=kuruV2 forge script script/DeployTemplatesV2.s.sol --sig "record()" --rpc-url "$MONAD_TESTNET_RPC"
STACK=kuruV2 DEPLOYER_PRIVATE_KEY=... \
  forge script script/DeploySnapshotTemplate.s.sol --rpc-url "$MONAD_TESTNET_RPC" --broadcast --slow
STACK=kuruV2 forge script script/DeploySnapshotTemplate.s.sol --sig "record()" --rpc-url "$MONAD_TESTNET_RPC"
pnpm exec biome format --write deployments/
```

Every reader (app, keeper, maker, indexer) goes through all stacks in the file.

## Checklist

- [ ] Mainnet fork suites pass today (`FOUNDRY_PROFILE=fork forge test --match-path "test/fork/Mainnet*"`)
- [ ] Guardian address confirmed, separate from the deployer (a multisig is best)
- [ ] Graduation rule chosen (`GRADUATION_MIN_POOL`, `GRADUATION_MIN_STAKERS`)
- [ ] Deployer funded (8 MON or more), dry run reviewed: addresses, caps, guardian, fee recipient, Kuru v1
- [ ] Broadcast run done, `deployments/monad-mainnet.json` written, `record()` run
- [ ] Contracts verified on Sourcify
- [ ] Guardian registered templates 1 and 2
- [ ] Templates 3 to 7 and the periphery deployed and recorded
- [ ] Guardian registered templates 3 to 7; `templateOf(1)` to `templateOf(7)` set; `GuardianBatch.record()` run
- [ ] Deployments file committed and pushed
- [ ] Keeper and maker running against mainnet with their health endpoints green
- [ ] First market created, with its transaction linked in the README

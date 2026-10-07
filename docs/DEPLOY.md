# Deploying Hunch Book

This is the runbook for putting Hunch Book on a Monad network. Testnet is live (addresses in
[`deployments/monad-testnet.json`](../deployments/monad-testnet.json)). Mainnet is **planned**: every
step below has been rehearsed on a fork of Monad mainnet, but nothing has been deployed there yet.

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
| Graduation rule | 500 USDC pool, 10 stakers, chance between 3% and 97% | `Deploy.graduationRule()` and `GuardianBatch.rule()` |
| Kuru book | precisions 1e6 and 1e6, tick 0.001 USDC, minimum 1 YES, maximum = pool cap, fees 0 and 0, AMM spread 30 | `Deploy._deployTrading` |

Caps apply to markets created after a change. Existing markets keep the caps they started with.

## Roles

| Role | Testnet | Mainnet |
|---|---|---|
| Deployer | a hot key, `DEPLOYER_PRIVATE_KEY` | a hot key, used once, then holds nothing |
| Guardian | the deployer | **a multisig**, never a hot key. `Deploy.s.sol` refuses to deploy to mainnet if the guardian is the deployer |
| Fee recipient | the deployer | an address chosen by Hunch, ideally the same multisig |

The guardian can pause market creation and graduation, add templates and set caps for future
markets. It can never pause settlement, redemption, merges or refunds, never move funds and never
set an outcome ([PROTOCOL.md §7.3](./PROTOCOL.md#73-access-control)).

## Mainnet, step by step

### 0. Before you start

- A multisig on Monad mainnet to act as guardian (for example a Safe). Write down its address.
- The fee recipient address.
- About 5 MON on the deployer for gas. Monad charges the gas **limit**, not the gas used, so keep
  the `--gas-estimate-multiplier` at 110.
- `forge --version` reports 1.8 or later. `contracts/foundry.toml` sets `network = "monad"`.

### 1. Rehearse on a fork

The rehearsal runs the real deploy script on a fork of Monad mainnet with Circle USDC, Kuru's
mainnet Router, MarginAccount and order book, and Chainlink's BTC/USD feed. It deploys, registers
the templates from the guardian batch, fills a pool, has Kuru's owner create the book (as Kuru will
on mainnet), registers it from an unrelated address, graduates, quotes, trades through the router,
settles and redeems.

```bash
cd contracts
FOUNDRY_PROFILE=fork forge test --match-path test/fork/MainnetRehearsal.fork.t.sol -vv
```

All tests must pass on the day of the deploy. The file rehearses the Kuru v1 path (Kuru v1 is live on
mainnet) and the Kuru v2 launch path: a deploy with no graduator (`WIRE_KURU=0`) whose pools run and
settle without one. The Kuru v2 contracts themselves are rehearsed on a fork of Monad testnet, against
Kuru's live v2 contracts, with Kuru's owner impersonated for its setup steps:

```bash
FOUNDRY_PROFILE=fork forge test --match-path test/fork/KuruV2.fork.t.sol -vv
```

### 2. Deploy

```bash
cd contracts
GUARDIAN=0xYourMultisig FEE_RECIPIENT=0xYourFeeAddress \
DEPLOYER_PRIVATE_KEY=... \
forge script script/Deploy.s.sol --rpc-url "$MONAD_MAINNET_RPC" \
  --broadcast --gas-estimate-multiplier 110
```

Run it once without `--broadcast` first: a dry run prints every address and writes nothing. The
broadcast run writes the addresses into `deployments/monad-mainnet.json` under `hunchBook`.

**Kuru version.** Mainnet defaults to Kuru v2 (`KURU_VERSION=2`): GraduatorV2 and HunchRouterV2,
pointed at `external.kuruV2` in the deployments file ([PROTOCOL.md §8.1](./PROTOCOL.md#81-kuru)).

- Kuru's v2 mainnet addresses are in the file: deploy as above.
- They are not there yet: deploy with `WIRE_KURU=0`. Everything except the graduator and router goes
  out; pools run and settle as pools. When Kuru publishes the addresses, add them under
  `external.kuruV2` (`accountCore`, `spotRouter`, `withdrawalLimiter`, ...) and wire, with the same
  deployer key (the factory's `setGraduator` is one-time and deployer-only):

  ```bash
  DEPLOYER_PRIVATE_KEY=... forge script script/WireKuruV2.s.sol --rpc-url "$MONAD_MAINNET_RPC" \
    --broadcast --gas-estimate-multiplier 110
  ```

- Kuru v2 slips and Kuru v1 is the plan: `KURU_VERSION=1` (the v1 Graduator and HunchRouter).

`KURU_TAKER_FEE_PPS` and `KURU_MAKER_FEE_PPS` set the fees Hunch Book asks Kuru for on v2 books
(default 7000 and 4000 parts per 10^7, Kuru's testnet defaults). GraduatorV2 accepts any book Kuru
creates within its limits (tick up to 0.01 USDC, minimum order up to 10 USDC, taker fee up to 0.3%),
so a different choice by Kuru does not need a redeploy.

Then verify the contracts on Sourcify (the same way testnet was verified):

```bash
forge verify-contract <address> <path:Contract> --chain 143 --verifier sourcify
```

### 3. The other templates and the periphery

```bash
cd contracts
DEPLOYER_PRIVATE_KEY=... forge script script/DeployTemplatesV2.s.sol --rpc-url "$MONAD_MAINNET_RPC" --broadcast --slow
forge script script/DeployTemplatesV2.s.sol --sig "record()" --rpc-url "$MONAD_MAINNET_RPC"
DEPLOYER_PRIVATE_KEY=... forge script script/DeploySnapshotTemplate.s.sol --rpc-url "$MONAD_MAINNET_RPC" --broadcast --slow
forge script script/DeploySnapshotTemplate.s.sol --sig "record()" --rpc-url "$MONAD_MAINNET_RPC"
TIMELOCK_PROPOSER=0xYourMultisig DISTRIBUTOR_FUNDER=0xYourMultisig DEPLOYER_PRIVATE_KEY=... \
  forge script script/DeployPeriphery.s.sol --rpc-url "$MONAD_MAINNET_RPC" --broadcast --slow
forge script script/DeployPeriphery.s.sol --sig "recordTxs()" --rpc-url "$MONAD_MAINNET_RPC"
pnpm exec biome format --write deployments/
```

On mainnet these scripts only deploy: the deployer is not the guardian, so it cannot register templates.
The periphery needs the router, so on a `WIRE_KURU=0` deploy it waits until after `WireKuruV2.s.sol`.
On a Kuru v2 stack the periphery includes `kuruFeedFactory`: the per-token price feeds Kuru's
WithdrawalLimiter uses.

### 4. The guardian registers the templates

Because the guardian is a multisig, the deployer cannot register templates. Generate the batch:

```bash
cd contracts
forge script script/GuardianBatch.s.sol --rpc-url "$MONAD_MAINNET_RPC"
```

This writes `deployments/guardian/monad-mainnet-add-templates.json` (run
`pnpm exec biome format --write deployments/` before committing it) in the Safe Transaction Builder
format, one `addTemplate(templateId, resolver, rule)` call per template that is deployed (ids 1 to 7). In the Safe app, open
Transaction Builder, drop the file in, check every call against this document, and sign. Templates
that are already registered are skipped, so the file can be regenerated at any time.

### 5. Commit the deployment record

Commit `deployments/monad-mainnet.json` with the deploy transaction hashes, then push. The app
shows mainnet as soon as the file has a factory address.

### 6. Books on mainnet

Only Kuru can create books on mainnet. On Kuru v2 each market's tokens also need Kuru's setup first
(a price source in the WithdrawalLimiter, enabled in AccountCore, whitelisted), which takes Kuru 1 to 2
days for now, so the request goes out when a market is created, not when it fills. Status: the
scripts below, the keeper's v2 steps and the request API are live on testnet, for the `kuruV2` stack;
mainnet waits for Kuru's v2 mainnet contracts.

1. Create the market's YES and NO feeds (`kuruFeedFactory.createAdapter`) and poke the oracle from
   creation so the feeds have history. Then print the request for Kuru:

   ```bash
   MARKET=0x... forge script script/RegisterBookV2.s.sol --sig "request()" --rpc-url "$MONAD_MAINNET_RPC"
   ```

   This prints the `deploySpotMarket` arguments, the address Kuru's SpotRouter will deploy the book
   at, and what is still missing.
2. Kuru sets up both tokens and creates the book.
3. Anyone registers it; GraduatorV2 accepts it only after `bookProblem` finds nothing wrong (BOOK
   defaults to the predicted address):

   ```bash
   MARKET=0x... [BOOK=0x...] REGISTRAR_PRIVATE_KEY=... \
   forge script script/RegisterBookV2.s.sol --rpc-url "$MONAD_MAINNET_RPC" --broadcast
   ```

4. The keeper (or anyone) calls `graduate()` once the pool meets its rule.

Until a book is registered a market runs as a pool, and if its book never arrives it settles as a pool.
Nothing is lost. On Kuru v1 (`KURU_VERSION=1`) use `RegisterBook.s.sol` the same way.

### 7. Start the services

See [ops/README.md](../ops/README.md) for the keeper and the maker bot: environment variables,
hosting, gas budgets and health checks. Fund the keeper with about 1 MON and the maker with MON
for gas plus USDC for inventory.

## Testnet

Testnet was deployed on 2026-10-03 from block 67,856,277. The same script, with no `GUARDIAN`
set, makes the deployer the guardian and registers templates 1 and 2 in the same run. The
deployments file lists every deploy transaction hash.

Re-running `Deploy.s.sol` on a stack that already has a factory stops with "already deployed on this
stack". A new deployment means a new factory, a new vault and new markets; existing markets keep
working against the old ones.

**Two stacks on testnet.** The primary stack (`hunchBook`) uses Kuru v1, where anyone can create a
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

- [ ] Mainnet rehearsal fork test passes today
- [ ] Guardian multisig address confirmed and owned by people, not a hot key
- [ ] Dry run reviewed: addresses, caps, guardian, fee recipient
- [ ] Broadcast run done, `deployments/monad-mainnet.json` written
- [ ] Contracts verified on Sourcify
- [ ] Templates 3 to 7 and the periphery deployed and recorded
- [ ] Guardian batch generated, reviewed and executed; `templateOf(1)` to `templateOf(7)` set
- [ ] Deployments file committed and pushed
- [ ] Keeper and maker running against mainnet with their health endpoints green
- [ ] First market created, with its transaction linked in the README

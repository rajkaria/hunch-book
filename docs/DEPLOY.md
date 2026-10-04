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

Templates 3 to 6 (touch, funding spike, price range, parlay) are added later with
`DeployTemplatesV2.s.sol`; see [TEMPLATES.md](./TEMPLATES.md).

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

All four tests must pass on the day of the deploy.

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

Then verify the contracts on Sourcify (the same way testnet was verified):

```bash
forge verify-contract <address> <path:Contract> --chain 143 --verifier sourcify
```

### 3. The guardian registers the templates

Because the guardian is a multisig, the deployer cannot register templates. Generate the batch:

```bash
cd contracts
forge script script/GuardianBatch.s.sol --rpc-url "$MONAD_MAINNET_RPC"
```

This writes `deployments/guardian/monad-mainnet-add-templates.json` in the Safe Transaction Builder
format, one `addTemplate(templateId, resolver, rule)` call per template. In the Safe app, open
Transaction Builder, drop the file in, check every call against this document, and sign. Templates
that are already registered are skipped, so the file can be regenerated at any time.

### 4. Commit the deployment record

Commit `deployments/monad-mainnet.json` with the deploy transaction hashes, then push. The app
shows mainnet as soon as the file has a factory address.

### 5. Books on mainnet

Kuru's mainnet market creation is owner-only. So for each market that is close to its graduation
rule:

1. The keeper logs a `book-request` line (and calls its alert webhook if set) with the exact
   `deployProxy` arguments. You can print the same thing yourself:

   ```bash
   MARKET=0x... forge script script/RegisterBook.s.sol --sig "request()" --rpc-url "$MONAD_MAINNET_RPC"
   ```

2. Send those arguments to Kuru. Kuru creates the YES/USDC book.
3. Anyone registers it. The Graduator accepts it only if Kuru's MarginAccount knows it and its base,
   quote, precisions, tick, size limits, fees and AMM spread all match:

   ```bash
   MARKET=0x... BOOK=0x... REGISTRAR_PRIVATE_KEY=... \
   forge script script/RegisterBook.s.sol --rpc-url "$MONAD_MAINNET_RPC" --broadcast
   ```

4. The keeper (or anyone) calls `graduate()` once the pool meets its rule.

Until Kuru creates a book, a mainnet market runs as a pool and settles as a pool. Nothing is lost.

### 6. Start the services

See [ops/README.md](../ops/README.md) for the keeper and the maker bot: environment variables,
hosting, gas budgets and health checks. Fund the keeper with about 1 MON and the maker with MON
for gas plus USDC for inventory.

## Testnet

Testnet was deployed on 2026-10-03 from block 67,856,277. The same script, with no `GUARDIAN`
set, makes the deployer the guardian and registers templates 1 and 2 in the same run. The
deployments file lists every deploy transaction hash.

Re-running `Deploy.s.sol` on a network that already has a factory stops with "already deployed on
this network". A new deployment means a new factory, a new vault and new markets; existing markets
keep working against the old ones.

## Checklist

- [ ] Mainnet rehearsal fork test passes today
- [ ] Guardian multisig address confirmed and owned by people, not a hot key
- [ ] Dry run reviewed: addresses, caps, guardian, fee recipient
- [ ] Broadcast run done, `deployments/monad-mainnet.json` written
- [ ] Contracts verified on Sourcify
- [ ] Guardian batch generated, reviewed and executed; `templateOf(1)` and `templateOf(2)` set
- [ ] Deployments file committed and pushed
- [ ] Keeper and maker running against mainnet with their health endpoints green
- [ ] First market created, with its transaction linked in the README

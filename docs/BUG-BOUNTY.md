# Bug bounty (roadmap O-8)

Status: **planned.** The program opens with the mainnet beta. Until then, please still report
anything you find: see [SECURITY.md](../SECURITY.md).

## How to report

Use GitHub's private "Report a vulnerability" button on this repository (Security tab). Include the
affected contract and commit, a description, and a proof of concept (a Foundry test is ideal). We
aim to acknowledge within 24 hours and to give a first assessment within 72 hours.

Please do not test against mainnet funds, do not disclose publicly before a fix ships, and do not
access or move other people's funds. Good-faith research under these rules will not be pursued.

## Scope

In scope: every contract in `contracts/src/core/`, `contracts/src/resolvers/` and
`contracts/src/periphery/` at the addresses listed in `deployments/monad-mainnet.json`.

Out of scope: `contracts/src/mocks/` and anything testnet-only; the app, the keeper, the maker bot,
the notifier and the indexer (they hold no user funds and decide no outcomes); Kuru, Perpl,
Chainlink, Pyth and Circle's USDC themselves; issues that need the guardian multisig to act
maliciously beyond its stated powers; gas optimisations; best-practice notes without impact.

## Severity

| Severity | Examples |
|---|---|
| Critical | Loss of USDC from the vault; minting unbacked YES or NO; redeeming a losing token for value; any address setting an outcome |
| High | Freezing redemption or settlement for a market; making a market settle on the wrong value; the guardian doing more than PROTOCOL.md §7.3 allows |
| Medium | Griefing graduation or settlement at a cost far below the damage; rounding that loses more than dust |
| Low | Incorrect events or views that mislead the app or the indexer without moving funds |

## Rewards

The payout table is set and published before the program opens, sized against the beta collateral
cap (50,000 USDC across the vault at launch). Rewards are paid in USDC.

# External audit: scope and preparation (roadmap O-10)

Status: **planned.** No external audit has been done yet. This page is the package an auditor gets
on day one, so the review spends its time on the code and not on finding things.

## Scope

In scope, in priority order. Lines are approximate and change as the code does; the auditor works
from a pinned commit.

| Priority | Contract | Why it matters |
|---|---|---|
| 1 | `contracts/src/core/CollateralVault.sol` | Holds every USDC. Mint, merge, redeem, flash loans, fee accounting, the solvency check |
| 1 | `contracts/src/core/Market.sol` | Pool ledger, graduation conversion, token claims, settlement and void, pool payouts |
| 1 | `contracts/src/core/HunchRouter.sol` | Moves user funds through Kuru and vault flash loans in one transaction |
| 2 | `contracts/src/core/Graduator.sol` | Verifies that a Kuru book is exactly the right book before a market trades on it |
| 2 | `contracts/src/core/HunchBookFactory.sol`, `OutcomeToken.sol` | Market creation, caps, the guardian's limits; token mint and burn rights |
| 2 | `contracts/src/resolvers/*` | Every outcome comes from these. A wrong read pays the wrong side |
| 3 | `contracts/src/periphery/*` | Auto-redeem, conditional orders, referrals, Merkle payouts, the probability oracle and price adapter, the template timelock |

Out of scope: `contracts/src/mocks/` (testnet only), scripts, the app and offchain services (they
hold no user funds and decide no outcomes; see PROTOCOL.md §9).

## What we want the auditor to try to break

1. **Solvency.** `USDC.balanceOf(vault) >= obligations` after every call, including inside a flash
   loan and across a router trade that touches Kuru.
2. **Supply.** Before settlement, YES supply = NO supply = sets outstanding, per market.
3. **Payoff identity.** A staker who holds through graduation to settlement gets what the pool would
   have paid, to the base unit apart from rounding dust that is counted.
4. **Outcomes.** No call sequence lets any address choose an outcome, settle with a convenient
   price, or redeem a losing token for value.
5. **Guardian limits.** The guardian cannot block settlement, redemption, merges or refunds, or move
   funds.
6. **Graduation griefing and front-running.** Blocking, skewing or sandwiching graduation; a fake
   book; a book deployed by someone else first.
7. **Flash-loan paths.** Buy NO and sell NO through the router with adversarial books.
8. **Rounding.** Dust direction in claims, fees and redemptions; that it is never lost and never
   paid twice.
9. **Resolver edges.** Phase boundaries in Chainlink rounds, stale rounds, Perpl version or scaling
   changes, Pyth update windows, touch-proof pointers, parlay legs that void.

## What the auditor gets

| Item | Where |
|---|---|
| Protocol specification | [PROTOCOL.md](./PROTOCOL.md) |
| Templates and their exact rules | [TEMPLATES.md](./TEMPLATES.md) |
| Periphery contracts | [PERIPHERY.md](./PERIPHERY.md) |
| Internal security review and Slither results | [SECURITY-REVIEW.md](./SECURITY-REVIEW.md) |
| Invariant suite | `contracts/test/invariant/` and `contracts/test/periphery/` |
| Fork tests on live Monad (Kuru, Perpl, Chainlink, Pyth) | `contracts/test/fork/` |
| Mainnet launch rehearsal | `contracts/test/fork/MainnetRehearsal.fork.t.sol` |
| Deployed addresses | `deployments/monad-testnet.json` (and mainnet once deployed) |

```bash
git clone --recurse-submodules https://github.com/rajkaria/hunch-book
cd hunch-book/contracts
forge build && forge test                       # unit, fuzz, invariant
FOUNDRY_PROFILE=fork forge test                 # needs MONAD_TESTNET_RPC and MONAD_MAINNET_RPC
```

## After the audit

- The report is published in this repository, unedited.
- Every finding gets a fix commit or a written reason it is accepted, linked from the report.
- Beta caps (PROTOCOL.md §10.3) are raised only after the audit and the fixes ship.

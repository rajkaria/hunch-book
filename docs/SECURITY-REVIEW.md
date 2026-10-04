# Internal security review (roadmap O-5)

Status: **done for the code on `main` as of 2026-10-04**, re-run before any mainnet deploy. This is an
internal review by the people who wrote the code. It is not an audit; an external audit is planned
([AUDIT.md](./AUDIT.md)).

## Method

1. **Static analysis.** [Slither](https://github.com/crytic/slither) 0.11.6, all 102 detectors, over
   every contract in `contracts/src/` except `mocks/` (testnet-only collateral), with dependencies
   excluded. Every High and Medium result is listed below with its verdict. Low and informational
   results are summarised by detector.
2. **Invariant and fuzz testing.** The Foundry suites in `contracts/test/` (run on every push in CI):
   handler-based invariants for the core and for every periphery contract that moves user funds, and
   fuzz tests on every money formula.
3. **Fork testing on live Monad.** Kuru's real Router, MarginAccount and books; Perpl's real funding
   history; Chainlink's real rounds; a real Pyth update; and a full mainnet launch rehearsal
   (`test/fork/MainnetRehearsal.fork.t.sol`).
4. **Manual review** of the threat list in [PROTOCOL.md §10.2](./PROTOCOL.md#102-threats-and-answers),
   below.

Run it yourself:

```bash
uv tool install slither-analyzer
cd contracts
slither . --filter-paths "lib/|test/|script/|src/mocks/" --exclude-dependencies
```

## Slither: High and Medium results

Slither reported 165 results: 7 High, 30 Medium, 90 Low, 38 Informational. None is an exploitable
bug. (Re-run on 2026-10-04 after template 7, the snapshot resolver, landed: its only new results are
five timestamp comparisons, which are the snapshot window itself, and three style notes.) Each High and Medium result is explained here.

### arbitrary-send-erc20 (High, 5 results): not exploitable

Slither flags every `transferFrom` whose `from` is not `msg.sender`. Each one is deliberate and
bounded:

| Location | Why `from` is safe |
|---|---|
| `CollateralVault.depositPool(from, …)` | Only a market the factory created can call it (`onlyMarket`), and markets pass only the staker who called them, or the payer for `stakeFor`. |
| `CollateralVault.flashLoan(receiver, …)` | The vault first sends `amount` to `receiver` and then pulls back the same `amount`. The receiver's balance cannot fall, and a receiver that is not a flash-loan contract reverts on the callback. |
| `HunchRouter._buyNoInLoan` (pulls the user's net cost) | The router accepts a flash-loan callback only from the vault, only when it started the loan itself, and only for the exact `(amount, data)` it committed to before the call (`_pendingLoan`). An outsider cannot make the router pull from anyone. |
| `AutoRedeemer._redeemSide(holder, …)` | Only holders who opted in and approved this contract; the market must be a factory market; the vault pays the holder directly (`to = holder`), so nothing can be redirected. |
| `ConditionalOrders._fill(order.owner, …)` | Only for the owner's own signed-in order, with the owner's minimum out and deadline; the output goes to the owner, and the contract holds nothing between transactions (invariant-tested). |

### reentrancy-eth (High, 2 results): not exploitable

`Market.settle` and `Market.proveYes` call the resolver (with value, for Pyth fees) before writing
the outcome. Both functions carry the market's `nonReentrant` guard, resolvers are pure readers
registered by the guardian, and a resolver that re-entered could not change the outcome it is about
to return. Moving the writes before the call is not possible: the outcome comes from the call.

### reentrancy-no-eth (Medium, 6 results): not exploitable

`CollateralVault.mergeSets`, `redeem`, `registerMarket` and `flashLoan`, and `Graduator.createBook`.
The external calls go to our own outcome tokens (burn and initialize, no hooks) and to Kuru's Router.
Every vault entry point is `nonReentrant`, and `flashLoan` re-checks solvency after the callback,
which is the whole point of the design (PROTOCOL.md §7.2: "flash loans are open to anyone and free").

### divide-before-multiply (Medium, 1 result): intended

`Market._poolPayout` computes `gross = s · losing / winning`, then the 2% fee on `gross`, rounded up.
Rounding the winnings down first and the fee up means the protocol never pays out more than the pool
holds; the leftover is counted dust (PROTOCOL.md §7.2). The payoff identity fuzz test bounds the error
to one base unit per staker.

### incorrect-equality (Medium, 5 results): intended

All five are in `ImpliedProbabilityOracle` and compare stored timestamps and block numbers with
`==` on purpose: "no checkpoint yet" (`timestamp == 0`), "already poked in this block", and an exact
checkpoint hit in a binary search. None compares a token balance.

### uninitialized-local (Medium, 5 results): intended

Structs and strings declared and then filled field by field (`PriceAtTimeReader`, the touch and
parlay `describe` functions, the factory's market init parameters, a balance delta in
`ConditionalOrders`). Solidity zero-initialises them; every field that matters is assigned before use.

### unused-return (Medium, 13 results): reviewed

| Result | Verdict |
|---|---|
| `HunchRouter._marketBuy/_marketSell` ignore Kuru's return value | The router measures what it received by balance change and checks the minimum out itself, which is stricter than trusting a returned number. |
| `ConditionalOrders._fill` ignores the router's return values | Same: it measures the output by balance change and enforces the order's limit. |
| Tuple reads that skip unused fields (`poolTotals`, `tokens`, `getRoundData`, `latestRoundData`, `consultFull`) | Only the needed fields are used. |

## Slither: Low and informational results

| Detector | Count | Verdict |
|---|---|---|
| timestamp | 36 | Price, touch, parlay and snapshot markets run on unix time by design (PROTOCOL.md §6.2; the snapshot window is a time window). Monad timestamps cannot run ahead of real time by more than a few seconds; a bracketing round or a funding block decides the answer, never the timestamp alone. |
| calls-loop | 19 | Batch helpers (`claimTokensFor`, `claimPoolFor`, `redeemManyFor`, parlay legs, the router's quote walk) call contracts we control or that the factory registered. One failing holder in `redeemManyFor` is caught and skipped. |
| reentrancy-benign, reentrancy-events | 20 | Events emitted after calls to our own tokens or Kuru; no state at risk. |
| missing-zero-check | 7 | Constructor and two-step transfer arguments. `transferGuardian(0)` only clears a pending transfer; the adapter and token initialisers are called by our own factories with checked values. |
| shadowing-local | 7 | Interface parameter names that match state variable names. Cosmetic. |
| events-maths | 1 | `CollateralVault.setCollateralCap` emits nothing, but the only caller, `HunchBookFactory.setCollateralCap`, emits `CollateralCapUpdated`. |
| naming-convention, too-many-digits, assembly, low-level-calls, cyclomatic-complexity, costly-loop, unindexed-event-address | 37 | Style. The assembly reads single words of returned data (the router, and the snapshot resolver copying one word from a source call); low-level calls are `staticcall`s that tolerate contracts without the function. |
| unimplemented-functions | 1 | False positive: `adapterOf` is implemented by a public mapping. |

## Manual review

| Area | What we checked | Result |
|---|---|---|
| Solvency | Every path that moves USDC in or out of the vault updates `totalObligations` in the same call; `flashLoan` checks that surplus did not fall | `invariant_solvent` and `invariant_obligationsAddUp` hold across graduation, trades, settlement, void and redemption |
| Supply | YES and NO are minted and burned only by the vault, always in pairs before settlement | `invariant_setsMatchSupply` holds; outcome tokens have no other minter |
| Payoff identity | Graduation must not change what a staker who holds to the end receives | Fuzzed over random stake sets; error at most one base unit per staker |
| Outcomes | No function takes an outcome as an argument; resolvers read their source and return Unresolved when unsure | `invariant_outcomesOnlyFromSettle` holds; the guardian has no outcome path |
| Guardian limits | Pauses touch only creation and graduation | Settlement, token claims, merge, redemption, pool payouts, void and void refunds all work with both pauses on (`test/core/GuardianLimits.t.sol`) |
| Graduation griefing | Skewing a side costs real, locked stake; a front-run Kuru book with our exact parameters is adopted, not rejected | Tested on a Kuru fork (`test_fork_createBook_adoptsFrontRunBook`) |
| Fake books | `registerBook` checks Kuru's MarginAccount registration, base, quote, precisions, tick, sizes, fees and AMM spread | Every mismatch rejected on a Kuru fork |
| Flash-loan paths | Buy NO and sell NO with thin, empty and adversarial books | Router fuzz tests; the router never holds a balance after a call |
| Rounding | Claims round down, fees round up, dust goes to the fee account and is counted | Pool and token dust tests |
| Resolver edges | Chainlink phase boundaries, stale rounds, rounds after the target; Perpl version, scaling and relisting changes, paused perps; Pyth windows; touch pointers outside the window; parlay legs that void | Unit, fuzz and fork tests per template ([TEMPLATES.md](./TEMPLATES.md)) |
| Periphery | Contracts that pull user tokens never keep a balance or an approval; owners never receive less than their limit | Invariant suites in `test/periphery/` |

## Known limitations (accepted)

- **Kuru books keep trading after close.** Hunch's router and maker stop at close, but other people's
  resting orders on Kuru can still fill. The app warns makers; we ask Kuru to soft-pause books at close.
- **Perpl's trust model.** Perpl's funding is set by its own administrator within limits, and its
  contracts can be upgraded by a multisig. A version change during a window makes the resolver refuse
  to answer, so the market voids rather than paying on rewritten data.
- **Touch markets assume one honest prover.** If a touch happened and nobody proves it within the
  24-hour challenge period, the market settles NO. The keeper hunts proofs for every touch market.
- **USDC can be frozen by its issuer.** Out of our control.

## Next review

Before the mainnet deploy: re-run Slither on the exact commit, re-run every fork suite, and attach the
results to the deploy checklist in [DEPLOY.md](./DEPLOY.md).

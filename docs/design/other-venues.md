# Design note: graduating to other venues (roadmap V-8)

Status: **planned.** Today every market graduates to Kuru's onchain order book on Monad. This note
describes how the same pool-first lifecycle would graduate to another venue without changing any
market's money path.

## What the market needs from a venue

A graduated market needs exactly one thing from the outside world: a place where its YES token
trades against USDC. Everything else (complete sets, redemption, settlement) lives in Hunch Book's
own contracts and does not care where the trading happens. That is why `Market` only stores a `book`
address and the `Graduator` is the only contract that knows about Kuru.

## The seam: the graduator

| Today | With more venues |
|---|---|
| `Graduator` creates (testnet) or verifies (mainnet) a Kuru book | One graduator per venue, each implementing `IGraduator` (`createBook`, `registerBook`, `bookOf`, `canCreateBooks`, `bookParams`) |
| The factory has one graduator | A template (or a market at creation) names which graduator it uses; the rule is fixed for the life of the market |
| `HunchRouter` trades on Kuru | A router per venue, each with the same four atomic paths and the same guarantees: limit, deadline, no balance left between transactions |

A venue qualifies only if:

1. Its books are onchain and permissionless to trade, so anyone can exit a position without asking.
2. A contract can verify that a given book trades exactly this market's YES token against the
   protocol's USDC with known parameters (the check `registerBook` does for Kuru today).
3. Market orders with a minimum output are available to contracts, so the router can promise a limit.
4. The venue's failure stops trading only: mint, merge, settle and redeem never depend on it.

## Rollout

1. Ship a second graduator and router behind a new factory (the current factory's graduator is set
   once and cannot change, by design).
2. Fork-test the full lifecycle on the new venue, the same way `test/fork/EndToEnd.fork.t.sol` does
   for Kuru.
3. Add the venue to the maker bot and the indexer before the first market uses it.

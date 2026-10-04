# Design note: creator-resolved pools (roadmap S-7)

Status: **planned, not built.** This note explains why, and what would be built if the policy changes.

## The question

Many questions people want to bet on have no onchain answer: "Will this team ship v2 by Friday?",
"Will the vote pass?". Roadmap item S-7 proposes free-text markets that stay pools, never graduate to
a book, and are answered by their creator, who posts a bond that anyone can challenge.

## Why it is not built

Hunch Book's first rule for money paths is that **no address, including ours, can set a market's
outcome by hand. Outcomes come only from a resolver reading onchain data.** Every template shipped so
far follows it: Perpl funding, Chainlink and Pyth prices, touch proofs, ranges and parlays all read a
contract. A creator-resolved pool breaks that rule by design, because a person decides the answer.

The rule is what lets the protocol say, on every market page, that nobody can change an answer. A
template that is the exception would weaken that sentence for every market, not just its own. So S-7
waits for an explicit decision to allow a second, clearly separated class of market.

## If it is allowed: the design

The goal is to keep the blast radius small and the incentives honest.

| Piece | Choice | Why |
|---|---|---|
| Market type | Pool only; never graduates; separate factory and vault | A wrong answer can only affect people who chose this class; book-traded tokens never depend on a person |
| Question | Free text plus a resolution source URL, stored as a hash onchain and as text in the event log | People can read exactly what they bet on |
| Creator bond | At least 10% of the pool cap, in USDC, locked until the market is final | The creator has more to lose by lying than to gain |
| Answer | The creator posts YES, NO or INVALID within 48 hours after close | Short, predictable timing |
| Challenge | Anyone posts an equal bond within 48 hours to dispute | One honest person is enough to stop a wrong answer |
| Dispute | Goes to an external optimistic oracle (for example UMA) or a named, published council; never to Hunch | Hunch does not judge its own markets |
| No answer | If the creator stays silent, the market is INVALID: every stake is refunded in full | Silence never pays the creator |
| Payouts | Same pool math as PROTOCOL.md §5.2, 2% fee on winnings | Nothing new for stakers to learn |
| Limits | Lower caps than onchain markets; creator rate limits | Contain abuse while the class is new |

## What would have to change in the docs and app

- CLAUDE.md Rule 3 and PROTOCOL.md §1 would name the second class and its trust model explicitly.
- Every creator-resolved market page would carry a banner: "A person answers this market. Here is
  their bond and how to challenge."
- The proof page would count these markets separately.

Until then, only questions whose answers are onchain and stay readable can be Hunch Book markets.

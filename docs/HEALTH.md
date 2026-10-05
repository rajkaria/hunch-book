# Market health

Status: **live on testnet**. Every open market has a health score from 0 to 100: a badge on the market
cards, a "Market health" panel on the market page, and `health` in the data API's
[`/markets`](./API.md#get-markets) answers. It answers one question: how good is this market to stake in
or trade right now? It is built only from things anyone can read on chain, and every part says why it
scored what it did. The code is [`apps/web/src/lib/health/score.ts`](../apps/web/src/lib/health/score.ts);
the tests are `apps/web/test/health.test.ts`.

A market that has settled or voided has no score ("Finished").

## The three parts

| Part | Points | What it measures |
|---|---|---|
| Liquidity | 50 | A book: the spread and the depth near the mid. A pool: how far it is toward its graduation rule |
| Time | 20 | Enough time left to stake or trade, or a settlement that is not overdue |
| Source | 30 | How reliably the template's answer can be read on this network |

The score is the sum. 70 and up reads as **good**, 40 to 69 as **fair**, under 40 as **thin**.

### Liquidity (50)

A graduated market, from its Kuru book:

- If either side of the book is empty: 0 points (there is no price to trade at).
- Spread: full marks at 2 cents or less, nothing at 20 cents or more, a straight line between.
- Depth: USDC resting within 5 cents of the mid, both sides together; full marks at 500 USDC.
- With the full book (the market page): 30 points for the spread and 20 for depth. Without it (the cards
  and the API, which read only the best bid and ask): all 50 points from the spread, and the reason says so.

A pool: 25 points for its size against the rule's minimum (500 USDC), 15 for its stakers against the
minimum (10), and 10 when both sides have a stake.

### Time (20)

| Situation | Points |
|---|---|
| A pool: staking ends at the lock; a book: trading ends at close. A day or more left | 20 |
| Between one hour and one day left | 10 to 20, in a straight line |
| Under one hour left | 0 to 5 |
| Closed, before settlement can happen (touch and spike markets wait a 24-hour challenge period for NO) | 20 |
| Closed and settlement due for under an hour | 20 |
| Closed and waiting longer | falls to 0 at 24 hours overdue; the reason says how long, and that anyone can settle |

Times of block-clock markets (Perpl) are estimated from the measured block time.

### Source (30)

| Template | Points | Why |
|---|---|---|
| 1 and 4, Perpl funding | 30 | Perpl's funding sums are stored onchain at every block, so the answer can always be read |
| 2, 3 and 5, Chainlink prices, mainnet | 30 | Chainlink rounds are stored onchain; the bracketing round settles it |
| 2, 3 and 5, Chainlink prices, testnet | 15 | Testnet feeds update about once a day, so a round may not bracket the time and the market can void |
| 7, snapshot | 20 | The first snapshot taker picks the block inside a short window, with no challenge period |
| 6, parlay | 20 | Only as reliable as its weakest leg |

## Limits

- The score is a reading of the market's state, not a forecast or advice. A thin market can be the right
  one to trade.
- Cards and the API score liquidity from the best bid and ask; only the market page reads depth.
- Source points are a fixed table per template and network. They change only with this page.

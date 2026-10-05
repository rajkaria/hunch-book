# Hedge assistant

Status: **building**. The page is `/hedge` in the app. It reads Perpl positions and funding live from
Perpl's Exchange and sizes hedges from the markets open on Hunch Book. It sends nothing itself: the
person opens the market page to stake or trade.

## What it does

1. **Reads your Perpl positions.** Enter any wallet (or connect it). The page calls Perpl's Exchange:
   `getAccountByAddr(wallet)` gives the account id and a bitmap of the perps it holds (bit `id % 256`
   of bank `id / 256 + 1`); then `getPositionV2(perpId, accountId)` and `getPerpetualInfoV2(perpId)`
   for each, in one multicall. An address with no Perpl account makes `getAccountByAddr` revert, which
   the page reports as "no Perpl account". You can also type a position in by hand (perp, side, size).
2. **Shows the funding it pays.** For each position: size, entry and mark price, the funding paid or
   received since entry (Perpl's own `premiumPnlCNS`), the funding of the last interval and a chart of
   the last 48 intervals from `getFundingSumAtBlock`.
3. **Projects the funding ahead**, over the next 24 hours or 7 days, with the math on screen.
4. **Proposes hedges** from open Hunch Book markets on that perp's funding, each sized so its win
   covers the projected funding. If none fits, it builds a new market for `/create`.
5. **Builds a basket**: one hedge across one or more of those markets (other windows, other
   thresholds, templates 1 and 4), sized by an even split, with a table of what it pays if funding
   flips, halves, holds or doubles.
6. **Tracks** a chosen basket in the browser (localStorage): funding paid since you started tracking
   against what the basket is worth, leg by leg, until every leg settles.

The read-only ABI is in `apps/web/src/lib/hedge/abi.ts`. The interface the resolvers use
(`contracts/src/interfaces/external/IPerplExchange.sol`) has no position getters, so these entries come
from Perpl's published ABI (PerplFoundation/dex-sdk, `crates/sdk/abi/dex/Exchange.json`, contract
1.7.5). Each was checked against the testnet Exchange.

## Units

Perpl keeps a cumulative funding sum `F` per perp, updated at each funding event (every 8,571 blocks).
A rising `F` means longs paid shorts.

| Quantity | Formula |
|---|---|
| USD per one unit of the base asset | `ΔF / 10^(priceDecimals + fundingSumScalingExp)` |
| Position size in units | `lotLNS / 10^lotDecimals` |
| Price in USD | `pricePNS / 10^priceDecimals` |
| Funding a position paid | `+size × ΔF_usd` for a long, `-size × ΔF_usd` for a short |

Check on testnet (BTC, perp 16: `priceDecimals` 1, `lotDecimals` 5, scaling 0): account 12 holds a
short of 5,978 lots (0.05978 BTC). Between its entry and now `F` went from 0 to 120,442, which is
12,044.2 USD per BTC. 0.05978 × 12,044.2 = 720.002276 USD received, exactly Perpl's `premiumPnlCNS`
for that position (720,002,276 at 6 decimals). The unit test `hedge.test.ts` keeps this example.

## The projection

```
funding events ahead  n = seconds × 1000 / (ms per block × 8,571)
rate per interval     r = the last interval's ΔF, or the mean over the last 24 hours (your choice)
projected             cost = sign × size × n × r / 10^(priceDecimals + scalingExp)
```

`ms per block` is measured on chain over the last 10,000 blocks (the same clock the market pages use).
`sign` is +1 for a long and -1 for a short. A positive cost means the position pays. The assumption
"the rate holds" is shown next to every number: funding changes every interval.

## Which markets can hedge a position

| Position | Holds | On | Pays when |
|---|---|---|---|
| Long | YES | template 1, "longs pay more than X between block A and block B" | net funding in the window is above X |
| Long | YES | template 4, a single funding event above X | one event charges longs more than X |
| Short | NO | template 1 | net funding in the window is X or less |

A spike market (template 4) does not cover a short, so it is listed as skipped with the reason. A
market is used only while it can still be entered: a pool before its lock (stake), or a graduated
market with a live book (buy), with its window ending after the current block.

For each market the target is the funding the position is projected to pay over the funding events
left in that market's window, from `max(now, A)` to `B`:

```
events left  k = steps(B) − steps(max(head, A)),   steps(x) = floor((x − lastEvent) / 8,571)
target       T = sign × size × k × r_usd
```

If `T ≤ 0` at the current rate (the position receives funding over that window) there is nothing to
cover and the market is skipped.

## Sizing a hedge

**Pool (stake).** A stake `s` on the hedge side, with `W` USDC on that side and `L` on the other,
wins `(1 − φ) · s · L / (W + s)` with `φ = 0.02` (PROTOCOL.md §5.2). Setting that equal to `T`:

```
s = T · W / ((1 − φ) · L − T)
```

The winnings can never exceed `(1 − φ) · L`, so when `T` is at or above that, no stake covers it in
full: the page stakes up to the room left (`min(wallet cap, pool cap − pool)`) and says what share it
covers. An empty hedge side (`W = 0`) needs only the minimum stake. The numbers use the pool as it is
now; later stakes on either side move the payout.

**Book (buy tokens).** A token bought at `p` redeems for `1 − f` if it wins, where `f` is the
redemption fee fixed at graduation: `f_YES = φ · N / T_pool`, `f_NO = φ · Y / T_pool` (§5.3). Each
winning token adds `1 − f − p`, so:

```
tokens = T / (1 − f − p),   cost = tokens × p,   payout = tokens × (1 − f)
```

YES is priced at the best ask; NO at `1 − best YES bid` (the router mints a pair and sells the YES).
A larger order walks the book, so the market page's trade ticket shows the exact fill before you
sign. If `p + f ≥ 1`, a winning token pays back no more than it costs and the page says so.

Either way: if the hedge side loses, the hedge loses what it cost. That is the price of the cover.

## Baskets

A basket is one hedge made of one or more legs. Each leg is a market on the same perp's funding, a
side (YES for a long, NO for a short, as above) and a size. The proposal list adds and removes
markets; the first market that can be sized starts in the basket, so a basket of one leg is the
single-market hedge above.

**The rule: an even split.**

```
events     K = funding events inside at least one leg's window, from max(now, A) to B
cost       C = sign × size × K × r_usd                 (the projection, over those events)
target     T = cover × C                               (cover between 10% and 200%, 100% by default)
share      S = T / n                                   (n legs that can be sized)
each leg   sized so that, if it wins, it pays back its cost plus S
```

The page offers a cover of 50%, 75%, 100% or 150%; the sizing function keeps any cover between 10%
and 200%.

Each leg is sized with the rule of its market from the section above: a pool stake
`s = S · W / ((1 − φ) · L − S)`, or `S / (1 − f − p)` tokens on the book, priced as the single
hedge prices it (the pool as it is now; the best ask for YES, 1 − the best bid for NO). If every leg
wins, the basket pays back its cost plus `T`. A leg that loses loses what it cost.

Windows that overlap count their shared events once, and a gap between two windows counts nothing,
so `C` is the funding the legs can see. Legs at higher thresholds win only when funding runs higher,
so a basket of thresholds on the same window pays more as funding rises: a ladder. A market that
cannot be sized at all (no price on its side of the book, nobody on the other side of its pool, a
full pool) is left out of the split and listed with the reason; whether it can be sized does not
depend on the amount. A leg whose pool or wallet cap stops a full stake covers less than its share,
and the page says what share of `T` the basket covers.

**Rounding.** USDC and outcome tokens have 6 decimals. Every amount is rounded to whole
micro-USDC: the share, stakes, tokens and costs up (what you pay), payouts down (what you get). A
target that rounds to zero is refused, as is a projected cost of zero or less: at that rate the
position receives funding and there is nothing to cover.

The page writes the math out in words for the basket on screen: the events, the projected funding,
the target, the share, then each leg's size, cost and payout, with a link to its market page.

## The scenario table

Under the basket, a table runs four funding cases:

| Case | Rate per interval |
|---|---|
| Funding flips sign | −1 × r |
| Half the rate | 0.5 × r |
| The rate holds | r |
| Twice the rate | 2 × r |

For each case and each leg, the page runs the case's rate over every funding event left in that leg's
window and checks the leg's rule, the way its resolver does:

- template 1: YES if the window's net funding (what it has counted so far, plus rate × events left)
  is more than the threshold. For a window that has already started, what it has counted so far is
  `F(now) − F(A)`, read from Perpl's Exchange at block `A`;
- template 4: YES if one event charges longs more than the threshold. At a steady rate every event is
  the same, so that is the rate itself, if an event is left.

Each row then shows:

| Column | Formula |
|---|---|
| Position | funding paid over the basket's events: `case multiple × C` (negative: it receives) |
| Legs that win | how many legs' sides win |
| Basket pays out | the sum of the winning legs' payouts |
| Net with the basket | payout − the basket's cost − funding paid |
| Net without | − funding paid |

A steady rate is a simplification: real funding moves every interval, so a spike market can win when
the average says it would not. Pool legs pay at the pool as it is now; later stakes move them.

## A new market when none fits

The page builds a template 1 market and links to `/create` with it filled in:

| Field | Value |
|---|---|
| window start `A` | the first funding event on Perpl's grid at least 30 minutes ahead (staking stays open until `A`) |
| window end `B` | `A + n × 8,571`, with `n` the events in the chosen horizon |
| threshold `X` | 0 ("longs pay at all"), or half or all of `|r| × n` in raw units; positive for a long, negative for a short |
| side | YES for a long, NO for a short |

The link speaks the create form's own language, which snaps the window back onto the grid with its own
measured block pace: `/create?template=1&asset=<BTC|ETH|SOL|MON>&start=<unix>&end=<unix>&threshold=<USD
per unit, signed>&side=<yes|no>`. The threshold is written exactly, to Perpl's own decimals.

## Tracking

"Track this basket" stores, in this browser only, the position (perp, side, size), the funding sum and
block at that moment, the cover ratio and each leg (market, side, stake or tokens, cost, payout if it
wins). The tracked list then shows, for each basket:

- each leg's status: open (pool, pool locked), graduated (live book), closed, settled with its
  outcome and whether the leg won, or voided;
- each leg's value: before settlement, a pool stake at `payout if it wins × the market's chance`, or
  tokens at the book's mid; after settlement, its payout (or 0 if it lost); after a void, the pool
  refund or 0.50 per token;
- the basket's value: the sum of its legs, once every leg's market is read;
- funding paid since tracking: `sign × size × (F(until) − F(start))` in USD, where `until` is now,
  or the end of the last leg's window once the chain is past it (funding after that is not hedged);
- net so far: basket value − cost − funding paid. Once every leg settles it is final.

Tracking does not read your wallet; it assumes you took each leg as sized.

**Storage.** Schema v1 keeps `{ version: 1, baskets: [...] }` under `hunch-book:hedge-baskets`.
Before baskets, the page kept an array of single-market hedges under `hunch-book:hedges:v1` (schema
v0, whatever the key's name says). The first read moves each valid v0 hedge into a basket of one leg
with the same id, cover 100% and the same numbers, then removes the old key. If the new write fails
(private mode, full storage), the old key stays and the next read tries again; ids are merged, so
nothing is counted twice. A payload with a newer version than the page knows is shown as empty and
never overwritten.

## Links into the page

`/hedge?perp=<BTC|ETH|SOL|MON>&side=<long|short>&size=<units>` opens the page with that position added,
as if typed in by hand: `perp` is the perp's name in the deployments file (any case), `side` is long
when left out, `size` is in units of the base asset (`0.5` is half a BTC). The page reads Perpl's lot
decimals for the perp and then adds it. A link it cannot use (an unknown perp, a size of zero, anything
malformed) is ignored. Code: `apps/web/src/lib/hedge/prefill.ts` and `usePrefill.ts`.

## The calculator

`/calculator` answers the question before the hedge, with no wallet: what would this position pay in
funding? Pick a perp, a side, a size in units or in USD notional (turned into units at Perpl's mark
price), a horizon (24 hours, 7 days, or any number of hours or days up to a year) and the rate (the last
interval, or the mean over the last 24 hours). It reads the same funding history as this page and uses
the same math (the projection above), shows the assumption in plain words and the funding chart, and
lists the open markets on that perp's funding that would hedge it, sized as in "Sizing a hedge". Each
links to its market page, and the page links here with the position filled in. Its inputs live in the
address, so a result can be shared: `/calculator?perp=BTC&side=long&size=0.5&unit=units&horizon=7d`.

Code: `apps/web/src/app/calculator/`, `apps/web/src/components/calculator/` and
`apps/web/src/lib/calculator/` (input parsing and the cost, on top of `lib/hedge/math.ts`). Tests:
`calculator.test.ts` (inputs, the cost for longs and shorts, both rates, the address, the hedge page's
prefill) and `calculator-ui.test.tsx` (the page against mocked reads, and the prefill on this page).

## Limits

- Funding is set by Perpl's own price administrator within Perpl's clamp, and Perpl's contracts can be
  upgraded by its multisig. Every Perpl market pays on what Perpl records.
- The projection is "the rate holds". It is an estimate, not a forecast.
- The basket's split is even and fixed: when a pool caps a leg, the shortfall is not moved to the
  other legs. The page says what share it covers.
- The scenario table assumes a steady rate in each case. It shows how the legs combine, not what
  funding will do.
- Positions are read on the app's network. Testnet positions hedge with testnet markets.

## Code and tests

| Path | What |
|---|---|
| `apps/web/src/lib/hedge/abi.ts` | the read-only Perpl ABI |
| `apps/web/src/lib/hedge/perpl.ts` | position and funding reads |
| `apps/web/src/lib/hedge/math.ts` | units, projection, sizing, rounding, proposals, the new-market suggestion |
| `apps/web/src/lib/hedge/basket.ts` | baskets: the even split, the scenario table, a tracked basket's value |
| `apps/web/src/lib/hedge/tracking.ts` | the browser's tracked baskets, schema v1, and the move from v0 |
| `apps/web/src/components/hedge/` | the page's components |

`apps/web/test/hedge.test.ts` checks the units against Perpl's own premium PnL, the bitmap, steps and
grid counting, both sizing rules (including partial cover, caps and rounding to 6 decimals), the
proposals for long and short positions on pools and books, the suggestion and its link, and the reads
with a fake client. `hedge-basket.test.ts` checks the basket: the cover bounds, events across
overlapping and separate windows, the even split (one leg equals the single hedge; a zero, negative or
dust cost; a leg priced at 0 or 1; a capped pool; rounding), each leg's rule in every scenario, the
table's numbers, storage v1 and the move from v0, and a basket's value in every phase.
`hedge-ui.test.tsx` renders the page against mocked reads: building a basket of two legs, the scenario
table, tracking, and a v0 hedge shown as a basket of one leg.

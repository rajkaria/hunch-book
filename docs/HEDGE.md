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
5. **Tracks** a chosen hedge in the browser (localStorage): funding paid since you started tracking
   against what the hedge is worth, until the market settles.

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

"Track this hedge" stores, in this browser only, the position (perp, side, size), the funding sum and
block at that moment, and the hedge (market, side, stake or tokens, cost). The tracked list then shows:

- funding paid since tracking: `sign × size × (F(now) − F(start))` in USD;
- the hedge's value: before settlement, a pool stake at `payout if it wins × the market's chance`, or
  tokens at the book's mid; after settlement, its payout (or 0 if it lost); after a void, the pool
  refund or 0.50 per token;
- net so far: hedge value − cost − funding paid.

Tracking does not read your wallet; it assumes you took the hedge as proposed.

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
- One market per proposal. Combining several markets into one hedge is planned (roadmap A-10).
- Positions are read on the app's network. Testnet positions hedge with testnet markets.

## Code and tests

| Path | What |
|---|---|
| `apps/web/src/lib/hedge/abi.ts` | the read-only Perpl ABI |
| `apps/web/src/lib/hedge/perpl.ts` | position and funding reads |
| `apps/web/src/lib/hedge/math.ts` | units, projection, sizing, proposals, the new-market suggestion |
| `apps/web/src/lib/hedge/tracking.ts` | the browser's tracked hedges |
| `apps/web/src/components/hedge/` | the page's components |

`apps/web/test/hedge.test.ts` checks the units against Perpl's own premium PnL, the bitmap, steps and
grid counting, both sizing rules (including partial cover and caps), the proposals for long and short
positions on pools and books, the suggestion and its link, the reads with a fake client, tracking and
the hedge's value in every phase. `hedge-ui.test.tsx` renders the page against mocked reads.

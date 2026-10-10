# Recurring series

Status: **live on Monad testnet**. Our keeper runs two series there, `btc-funding-weekly` (template 1)
and `mon-funding-spike-daily` (template 4); every market they create is ours and labelled as ours. From
2026-10-10 new periods go to the `hunch` stack (the network's default stack) and are seeded to its
graduation rule from our own wallets (see Seed below), so each one opens its own order book.

A series is a market that repeats on a schedule: "BTC funding this week" every week, "ETH at noon UTC"
every day. The keeper creates each period's market when its creation point arrives, from its own
published address (`wallets.keeper` in [`deployments/<network>.json`](../deployments)), with a first stake
from its own USDC. Those markets and stakes are Hunch Book's own and are labelled as ours wherever they are
counted: the market's creator is the keeper's address.

Code: [`services/keeper/src/jobs/series.ts`](../services/keeper/src/jobs/series.ts), with the schedule and
strike rules as pure functions in [`src/series/`](../services/keeper/src/series/). Example file:
[`services/keeper/series.example.json`](../services/keeper/series.example.json).

## Turning it on

| Variable | Default | Meaning |
|---|---|---|
| `KEEPER_SERIES_FILE` | none | The series file. Without it the job does not run. |
| `KEEPER_SERIES_ENABLED` | off | The series job's own kill switch: creating spends the keeper's USDC. Off, or with `KEEPER_ENABLED` off, the job simulates and logs what it would create. |

Both switches must be on to create markets. The file is read once at startup and checked field by field;
a mistake stops the keeper with a message naming the series and the field.

## The file

```json
{
  "series": [
    {
      "id": "btc-funding-weekly",
      "enabled": true,
      "template": 1,
      "asset": "BTC",
      "schedule": { "anchorBlock": 68100000, "everyBlocks": 2000000, "createBeforeLockBlocks": 60000 },
      "strike": { "rule": "trailing-median-funding", "windows": 8 },
      "firstStake": { "side": "yes", "usdc": "5" }
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `id` | Lower-case letters, digits and dashes; unique in the file. |
| `enabled` | `false` keeps the series in the file without creating anything. Default `true`. |
| `template` | 1 Perpl net funding, 2 price at a time, 3 price touch, 4 Perpl funding spike, 5 price range. Parlays (6) and snapshots (7) have no schedule. |
| `asset` | A Perpl perp name from `external.perpl.perps` ("BTC") for templates 1 and 4; a Chainlink pair from `external.chainlink` ("ETH/USD") for templates 2, 3 and 5. |
| `direction` | Template 3 only: `"up"` (reaches at or above the strike) or `"down"`. Default `"up"`. |
| `schedule` | When each period locks and closes, and when its market is created (below). |
| `strike` | How the strike is chosen (below). |
| `firstStake` | `side` (`"yes"` or `"no"`) and `usdc` (an amount like `"5"`), at least the factory's creator minimum (5 USDC in v0). |
| `seed` | Optional: more stakes the keeper makes right after creating each market, for other wallets of ours (below). |

Any other field (such as `note`) is ignored.

### Seed

A seed lets a series market graduate on its own. Right after the keeper creates a market (its own first
stake already made), it stakes for other wallets of ours with `market.stakeFor(holder, side, amount)`,
paying from its own USDC. With enough stakers and USDC on both sides, the pool meets its graduation rule
at once and the graduate job turns it into a live order book.

```json
"firstStake": { "side": "yes", "usdc": "55" },
"seed": {
  "stakes": [
    { "for": "maker", "side": "no", "usdc": "30" },
    { "for": "guardian", "side": "no", "usdc": "25" }
  ]
}
```

| Field | Meaning |
|---|---|
| `for` | `"maker"` (`wallets.maker`), `"guardian"` (the stack's `guardian`, the deployer on testnet), or a `0x` address. Never `"keeper"`: the keeper creates the market, and its own stake is `firstStake`. Each holder appears once. |
| `side`, `usdc` | As for `firstStake`. Each stake must be at least the market's minimum stake, within its wallet cap, and all of them within its pool cap; the keeper checks this against the market itself and refuses the whole seed (with an alert) if not. |

This is our own money: every seed stake is paid by the keeper and held by a wallet of ours, and it is
labelled as ours wherever it is counted (the keeper's `series-seed` log line names the series, the market
and each holder, with `ours: true`; the indexer counts the maker's and the guardian's stakes as ours). Use
`"maker"` and `"guardian"` rather than other addresses, so every stake stays labelled. The stakes are real
positions: when the market graduates the keeper pushes each holder its tokens, so the maker receives its
side as inventory to quote with.

The keeper pays the seed from its own USDC. On Monad testnet only, when it holds too little, it first
mints the missing amount from Hunch Book's test USDC faucet (`TestUSDC.mint`, at most 10,000 per call).
It never mints anywhere else: on mainnet a short balance leaves the market a pool, logs
`series-seed-unfunded`, alerts, and tries again after half an hour.

### Schedules

Funding templates (1 and 4) count in blocks, like the Perpl markets themselves:

| Field | Meaning |
|---|---|
| `anchorBlock` | The lock (start block A) of period 0. Period k locks at `anchorBlock + k × everyBlocks`. |
| `everyBlocks` | Blocks between consecutive periods. |
| `windowBlocks` | B − A, the observation window. Default: `everyBlocks`, so periods follow one another. |
| `createBeforeLockBlocks` | The market is created this many blocks before its lock. Default 0. |
| `minLeadBlocks` | A period whose lock is closer than this is skipped for the next one. Default 2,000 (about 10 minutes). |

Monad measured about 302 ms per block in October 2026, so a week is about 2,000,000 blocks. The app shows
a block-clock market's estimated times.

Price templates (2, 3 and 5) count in unix time:

| Field | Meaning |
|---|---|
| `anchor` | The close of period 0, as an ISO time in whole seconds (`"2026-10-05T12:00:00Z"`). Period k closes at `anchor + k × every`. |
| `every` | Time between consecutive closes: `"1d"`, `"7d"`, `"12h"`, or a number of seconds. |
| `lockBeforeClose` | lock = close − this. For template 2 and 5, staking stops this long before the observation time. For template 3 it is the touch window: rounds count from the lock to the close. |
| `createBeforeLock` | The market is created this long before its lock. Default 0. |
| `minLead` | A period whose lock is closer than this is skipped. Default `"10m"`. |

Durations accept `s`, `m`, `h`, `d` and `w`.

### Strikes

The strike is measured at the period's **creation point** (its lock minus the creation lead), not at the
moment the keeper happens to run. Reading a past point gives the same number on every run, so a restart
recomputes the same market.

| Rule | Templates | Fields | Strike |
|---|---|---|---|
| `fixed` | 1, 2, 3, 4 | `value` | A fixed threshold: raw Perpl funding units (templates 1 and 4) or USD like `"85000"` (templates 2 and 3). |
| `spot-rounded` | 2 | `step` (USD) | The Chainlink price at the creation point (its last round at or before that time), rounded to the nearest `step`. "Will ETH be at or above today's price?" |
| `spot-offset` | 3 | `offsetPct`, `step` (USD) | The price at the creation point moved `offsetPct` percent away from spot, rounded outwards to `step` (up for `"up"`, down for `"down"`). |
| `range-around-spot` | 5 | `width`, `step` (USD) | A band `width` wide (a whole number of steps) whose lower bound is the price minus half the width, rounded to `step`. |
| `trailing-median-funding` | 1 | `windows` (1 to 100) | The median net funding over the last `windows` windows of the same length, ending at the creation point block: F(C) − F(C − W), F(C − W) − F(C − 2W), ... "Will longs pay more than usual this week?" |
| `funding-increment-quantile` | 4 | `q` (0 to 1), `intervals` | The q-quantile of the single funding events over the last `intervals` events before the creation point. Pick `q` so the question is uncertain: with n events in the window, a spike above the q-quantile shows up with roughly 1 − q^n chance if events were independent. |

A threshold at Perpl's per-market funding clamp can almost never be crossed (docs/TEMPLATES.md, template
4), and a question that is almost certain is not a fair market (PROTOCOL.md §6.3). The trailing rules
keep strikes near what the market has actually been doing.

## What happens each cycle

For every series, the keeper works out the next period whose lock is still at least the minimum lead away,
and then:

1. **Before its creation point:** waits. Health shows when the period will be created.
2. **The period already has a market:** nothing. A period counts as having one when any market the keeper
   created has the same template, asset (perp, or feed and direction) and window, whatever its strike, or
   when the factory already has a market under the exact params (its canonical key,
   `keccak256(abi.encode(templateId, params))`, the same check the factory makes). So a changed strike
   rule never creates a second market for a period.
3. **Funds:** if the keeper's USDC is below the first stake, it logs `series-unfunded`, alerts once per
   half hour (when a webhook is set) and waits. If the guardian paused market creation, it waits.
4. **Approval:** if the vault may not pull the first stake (and the seed, when there is one) yet, the
   keeper approves exactly that amount first.
5. **Create:** `factory.createMarket(template, params, side, stake)`, simulated first. The resolver checks
   the params when the market is created (a lock in the past, a feed not on its list, a window too long);
   if the simulation fails the reason is logged and nothing is sent.
6. **Seed** (when the series has one): one `market.stakeFor` per holder that has no stake in the market
   yet, so a restart between creating and seeding picks up where it stopped and never stakes a holder
   twice. A stake that fails is logged (`series-seed-failed`), alerted, and tried again no sooner than half
   an hour later; the market stays a pool meanwhile. A market that is no longer a pool is not seeded.

Series markets go to the default stack (`defaultStack` in the deployments file; testnet: `hunch`, Hunch
Book's own order book). Before creating a period, the keeper also asks every other stack's factory for a
market with the same exact params, so a period is never created twice when the default stack changes.

Every step logs one line (`series-wait`, `series-exists`, `series-unfunded`, `series-would-create`,
`series-created` with the transaction link, `series-seed` per seed stake, `series-seeded`) when what it
says changes.

## Health

`jobs.series.info` in the keeper's health snapshot:

| Field | Meaning |
|---|---|
| `file` | The series file read. |
| `creating` | `on`, or why it is a dry run. |
| `series[]` | Per series: `id`, `template`, `asset`, `enabled`, `next` (the next period's index, lock, close and creation point), `status` (in words), `lastMarket` and `lastTx` once it has created one, and `seed` (each seed stake's holder, address, side, amount, status and transaction). |

## Costs

Each market costs the first stake (from the keeper's USDC, at risk like any stake) and gas for
`createMarket` (and an approval when needed), plus, with a seed, the seed stakes and one `stakeFor` each
(and on testnet a faucet mint when the keeper is short). Every stake is returned or paid out like anyone's:
each is a real position, labelled as ours.

## Limits

- One market per period per template, asset and window. A ladder of strikes on one window (roadmap S-5)
  needs its own rule.
- Testnet's Chainlink feeds update about once a day, so price series there would mostly void; the example
  file ships them switched off.
- The schedule is fixed in the file. Changing `anchor`, `every` or the window starts a new sequence of
  periods; periods that already have markets are left as they are.

# Hunch Book rewards: maker rewards and referral shares

Status: **building**. The rewards CLI is in [`services/rewards`](../services/rewards). It is a dry run
only: it reads the chain (and the indexer, when one is configured) and writes files. It never sends a
transaction. No epoch has been paid from it yet.

Two programs pay through the [MerkleDistributor](./PERIPHERY.md#merkledistributor), in epochs:

- **Maker rewards (V-5)**: for liquidity on the Kuru books of Hunch Book markets, in proportion to how
  much rested there and how close to the price it was.
- **Referral shares (C-8)**: part of the protocol's fee share from users a referrer brought, while the
  [ReferralRegistry](./PERIPHERY.md#referralregistry) binding is active.

The formulas below are the ones in [PERIPHERY.md](./PERIPHERY.md); this page says how the CLI computes
them. Every input is public chain data, so anyone can recompute a root.

## Maker rewards

### What is sampled

Every N blocks (default 200, about a minute), for every graduated market's book: every resting order
with its price, size left and owner. `getL2Book()` has prices and sizes but no owners, so the CLI
rebuilds each maker's orders from Kuru's own events on that book, replayed from the block the market
graduated:

| Kuru event | Effect |
|---|---|
| `OrderCreated(orderId, owner, size, price, isBuy)` | the order rests |
| `Trade(orderId, ..., updatedSize, ...)` | the maker order `orderId` now has `updatedSize` left; 0 removes it |
| `OrderCanceled(orderId, ...)`, `OrdersCanceled(orderId[], owner)` | the orders leave |

With `--check`, every sample's rebuilt book is compared with what `getL2Book()` returned at that block,
level by level, and a sample that differs is left out of the scores (`makers` says how many).

### The score

With the band `B` (default 0.03 USDC) and the book's mid `m` (the best bid and best ask, halved):

```
order score       = size × ((B − d) / B)²      for an order at distance d = |price − m| < B; 0 otherwise
Qbid, Qask        = a maker's order scores on each side, in one sample
sample score  S   = max(min(Qbid, Qask), max(Qbid, Qask) / 3)
reward(maker)     = floor(R × ΣS(maker) / ΣS(every maker))      over the epoch's samples, per market
```

- An order at the mid scores its full size; at the band's edge, nothing.
- Quoting both sides earns up to three times as much as quoting one.
- A sample whose book has one side empty has no mid and is skipped.
- `R` is the market's pool for the epoch (`--pool`, in USDC, the same for every market), published
  before the epoch starts.
- The CLI computes in whole numbers with no rounding until the last step: prices are doubled so the mid
  is a whole number, `(B − d)²` keeps its numerator (`B²` is the same for every order), and `S` is
  tripled. Those factors cancel in the division.
- **Hunch Book's own maker bot** (`wallets.maker` in the deployments file) is excluded and labelled. Its
  score stays in the denominator and its share is not given to anyone: the epoch file lists what it would
  have earned under `excluded`. Its fills are still counted, and labelled as ours, on the proof page.
- Rounding leftovers are never paid; they come back to the funder through `sweep` after the deadline.

`makers` also reports each maker's **time at the touch**: the share of samples in which the maker had an
order at the best bid or the best ask.

## Referral shares

For each fee a user `u` paid at block time `t`, while `u` was bound to referrer `r`
(`boundAt <= t < expiresAt`):

```
protocolShare(fee) = fee − floor(fee × 2500 / 10000)        the creator's 25% is never shared
credit(r)         += floor(protocolShare(fee) × shareBps / 10000)
```

| Fee event | Emitted by | `u` |
|---|---|---|
| `Redeemed(market, holder, to, side, amount, paid, fee)` | the vault | `to`, the address that received the USDC (auto-redeemed holders count too) |
| `PoolClaimed(user, paid, fee)` | each market | `user` |

`shareBps` is the epoch's policy value (default 2000: 20% of the protocol's share). Fee events come from
the indexer (`Redemption` and `PoolPayout` with kind `Winnings`) when `INDEXER_URL` is set, and from the
logs otherwise. Each user's binding is read with `bindingOf(user)` at the fee's block, so a binding made
or expired later never counts; where the RPC does not keep that block's state, the latest binding is
used, and it counts only if its window covers the fee's time. Rounding dust moved to the fee balances has
no user and earns nothing. Credits are paid from protocol fees the fee recipient has withdrawn, so a
referral never costs a user or a creator anything.

## The epoch file

`epoch` merges maker rewards and referral credits per account (the distributor wants each account once
per epoch) and builds the tree with the SDK's `buildRewardTree`: leaf
`keccak256(bytes.concat(keccak256(abi.encode(uint256 epoch, address account, uint256 amount))))`,
OpenZeppelin's StandardMerkleTree layout, so the distributor verifies every proof. The shape, with the
numbers from the tests:

```json
{
  "network": "monad-testnet",
  "dryRun": true,
  "epoch": "1",
  "token": "0x13c5B2e982F437566991c4d9aC0a30F9f9aC15Ed",
  "distributor": "0x1872C4AaD2941410F81778467864e113b74Cc2D9",
  "total": "26600000",
  "totalUsdc": "26.6",
  "root": "0x...",
  "claimDeadline": "1792310400",
  "claims": [
    { "account": "0x...", "amount": "26150000", "proof": ["0x..."], "makerReward": "26000000", "referralReward": "150000" }
  ],
  "excluded": [
    { "account": "0x0f1156Eb25DBebee5386EC80F1EB0B85C7dD232A", "label": "Hunch Book's own maker bot (ours): ...", "wouldHaveEarned": "75000000" }
  ],
  "fund": {
    "approve": { "to": "<token>", "data": "0x095ea7b3..." },
    "createEpoch": { "to": "<distributor>", "data": "0x..." }
  }
}
```

The epoch id is the distributor's `nextEpoch()` at the time the file is written (or `--epoch`); it is
inside every leaf, so build the file right before funding. The claim deadline is `--claim-days` from now
(default 14; the distributor wants at least 7 days from creation). `fund` holds the two calls the funder
sends, in order, after checking the file: the token approval and `createEpoch(token, root, total,
claimDeadline)`. Anyone can then claim for anyone with the SDK's `claimRewards`, and the USDC always goes
to the account in the leaf.

## Run it

```sh
pnpm install
pnpm --filter "@hunch-book/sdk..." build
cd services/rewards

# 1. Sample every graduated market's book in the epoch's blocks, every 100 blocks, checked against getL2Book.
pnpm rewards sample --from 67863400 --to 67864400 --every 100 --check --out samples.jsonl
# 2. Score makers: 100 USDC per market.
pnpm rewards makers --samples samples.jsonl --pool 100 --out makers.json
# 3. Credit referrers over the same blocks.
pnpm rewards referrals --from 67863400 --to 67864400 --out referrals.json
# 4. Build the epoch file.
pnpm rewards epoch --makers makers.json --referrals referrals.json --out epoch.json
```

On Monad testnet on 2026-10-04, steps 1 and 2 over the blocks of the README's four router trades on
market #1 rebuilt the book from 6 Kuru events, matched `getL2Book()` at all 11 samples, and found one
maker: Hunch Book's own maker bot, at the touch in every sample, so the file paid nobody and listed the
bot under `excluded`. Outside makers are what the program is for.

| Variable | Default | What it does |
|---|---|---|
| `REWARDS_NETWORK` | `monad-testnet` | or `monad-mainnet` |
| `REWARDS_RPC_URL` | the deployment's RPC | sampling with `--check` and per-block bindings need an RPC that keeps past state |
| `INDEXER_URL` | none | fee events from the indexer instead of logs |

Public Monad RPCs answer `eth_getLogs` for at most 100 blocks, so every log read walks its range in
100-block windows, five at a time. Replaying a book from its graduation is a one-time cost per run; a
long epoch on a busy book is faster through a private RPC.

## Tests

```sh
pnpm --filter @hunch-book/rewards test
```

They cover the book rebuilt from events (creations, partial and full fills, single and batch cancels,
events out of order) and its comparison with `getL2Book` levels; the score (full weight at the mid,
a quarter at half the band, nothing at the edge, three times for two sides, one-sided books skipped,
time at the touch); the payout (pool split by score, our maker excluded and its share not redistributed,
rounding down); referral credits (only the protocol's 75%, only while bound, rounding); and the epoch
file (rewards merged per account, every proof verified against the root, the exact `createEpoch` call,
and an empty epoch).

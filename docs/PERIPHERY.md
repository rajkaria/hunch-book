# Hunch Book periphery contracts

Status: **live on Monad testnet** since 2026-10-04 (deployed with
[`DeployPeriphery.s.sol`](../contracts/script/DeployPeriphery.s.sol), source verified on Sourcify); mainnet is planned.
The code and its tests are in [`contracts/src/periphery/`](../contracts/src/periphery/) and
[`contracts/test/periphery/`](../contracts/test/periphery/). Addresses are under `hunchBook.periphery` in
[`deployments/<network>.json`](../deployments), the only address source every reader uses.

| Contract | Monad testnet |
|---|---|
| AutoRedeemer | [`0x26EF…A534`](https://testnet.monadscan.com/address/0x26EFB3D0d50DCBB97FBb369471fcc59a2677A534) |
| ConditionalOrders | [`0xDf73…7eB6`](https://testnet.monadscan.com/address/0xDf733F2AD02Fcd3eA1a02d319D720c94d67c7eB6) |
| ReferralRegistry | [`0x0637…8569`](https://testnet.monadscan.com/address/0x063713eb539f2c9458d4836341ce3a74CF948569) |
| MerkleDistributor | [`0x1872…c2D9`](https://testnet.monadscan.com/address/0x1872C4AaD2941410F81778467864e113b74Cc2D9) |
| ImpliedProbabilityOracle | [`0xEc0f…9134`](https://testnet.monadscan.com/address/0xEc0fCfD5ee0fC6Dd8938B72810697f7BbfdA9134) |
| OutcomeTokenPriceAdapterFactory | [`0x3484…508B`](https://testnet.monadscan.com/address/0x348476c0602C3BEfd1064d54636DD791240B508B) |
| TemplateTimelock (deployed; not yet the factory guardian) | [`0xCe85…290b`](https://testnet.monadscan.com/address/0xCe858DF2C95851275ed97e9Ba764b22d6394290b) |

The periphery adds features around the core without changing it. Every periphery contract talks to the
core only through the public functions anyone can call (or, for the timelock, the guardian functions the
core already has). None of them can set an outcome, pause settlement or redemption, or move a user's funds
anywhere the user did not choose. Those rules live in the core ([PROTOCOL.md §7.3](./PROTOCOL.md#73-access-control))
and nothing here can change them.

| Contract | Roadmap | Holds funds | Has an admin | What it is for |
|---|---|---|---|---|
| [`AutoRedeemer`](#autoredeemer) | K-3 | never between transactions | no | The keeper redeems winning tokens for holders who opted in, paying them directly |
| [`ConditionalOrders`](#conditionalorders) | A-11 | never between transactions | no | Take-profit, stop-loss and limit orders on YES and NO |
| [`ReferralRegistry`](#referralregistry) | C-8 | no | no | Who referred whom, for 180 days |
| [`MerkleDistributor`](#merkledistributor) | C-8, V-5 | yes: each epoch's rewards until claimed | a funder, who can only create epochs and sweep expired leftovers | Pays referral shares and maker rewards |
| [`ImpliedProbabilityOracle`](#impliedprobabilityoracle) | V-6 | no | no | Each market's chance of YES, spot and time-weighted, onchain |
| [`OutcomeTokenPriceAdapter`](#outcometokenpriceadapter) and its factory | V-7 | no | no | A Chainlink-style conservative price of a YES or NO token, for lending markets |
| [`TemplateTimelock`](#templatetimelock) | O-11 | no | a proposer (a multisig) | A public delay before new templates and limits go live |

All values in this document are in USDC base units (6 decimals) unless stated. A price written "E6" is USDC
base units per 1 token, so 0.42 USDC per YES is 420000. Every contract is compiled with solc 0.8.30, is not
upgradeable, uses custom errors, guards every state-changing entry against reentrancy, and emits an event
for every change of state.

---

## AutoRedeemer

Contract: [`AutoRedeemer.sol`](../contracts/src/periphery/AutoRedeemer.sol). Interface:
[`IAutoRedeemer.sol`](../contracts/src/periphery/interfaces/IAutoRedeemer.sol).

### What it is for

A winner should get paid without coming back to click "redeem". Holders opt in once; after a market settles
(or voids), the keeper redeems their tokens and the USDC lands in their wallet.

### Who calls what

| Caller | Function | Effect |
|---|---|---|
| Holder | `setOptIn(true)` | Turns auto-redeem on for every market (`false` turns it off) |
| Holder | `setMarketOptOut(market, true)` | Excludes one market while staying opted in elsewhere |
| Holder | approve this contract on the YES and NO tokens | Sets how much it may redeem, per token |
| Holder | `optInWithPermit(token, value, deadline, v, r, s)` | The approval (EIP-2612 permit on the outcome token) and the opt-in in one transaction |
| Anyone (the keeper) | `redeemFor(market, holder)` | Redeems one holder |
| Anyone (the keeper) | `redeemManyFor(market, holders)` | Redeems a batch, skipping holders with nothing to do |
| Anyone | `redeemable(market, holder)` | What `redeemFor` would redeem and pay right now |

### How a redemption works

For each side to redeem, the amount is `min(balance, allowance)` of the holder towards this contract. The
contract pulls that many tokens from the holder and calls `vault.redeem(market, side, amount, holder)`. The
vault burns the tokens from this contract and sends the USDC **straight to the holder**. This contract never
receives USDC and ends every call holding nothing.

- **Settled market:** only the winning side is redeemed, at `1 - fee` per token (the market's redemption fee,
  fixed at graduation, [PROTOCOL.md §5.3](./PROTOCOL.md#53-graduation)). Losing tokens are never touched.
- **Voided market:** both sides are redeemed at 0.50 per token. The vault rounds half units down, so the
  contract redeems an even amount per side. A holder with an odd balance keeps one base unit (worth nothing
  through a void redemption) instead of losing half a unit to rounding.

`redeemManyFor` runs each holder inside its own try/catch, so one failing holder (for example, an address
USDC refuses to pay) never reverts the batch. A skipped failure emits `RedeemFailed` and moves nothing for that
holder.

### Trust and limits

- Consent is two-layered: the opt-in flag and the token allowance. Without both, nothing moves.
- It can only redeem, and only to the holder whose tokens it burned. It cannot transfer tokens anywhere else,
  sell them, or redeem a losing side.
- It has no owner, no parameters and no upgrade path.
- Anyone can trigger a redemption for an opted-in holder. That is the point: the holder asked to be paid out.
  The caller earns nothing; the keeper pays the gas.

### Fees

None beyond the core's redemption fee, which the holder would pay redeeming by hand.

### Events

`OptInSet(holder, optedIn)`, `MarketOptOutSet(holder, market, optedOut)`,
`AutoRedeemed(market, holder, side, amount, paid, caller)`, `RedeemFailed(market, holder, reason)`. The vault
also emits its own `Redeemed` event with `holder` = this contract and `to` = the holder.

### How the app and keeper use it

- App: a portfolio toggle calls `optInWithPermit` (one signature for the approval, one transaction), or
  `setOptIn` plus `approve`. A per-market switch calls `setMarketOptOut`.
- Keeper: on each `Settled` or `Voided` market event, read opted-in holders from the indexer (`OptInSet`
  events, minus `MarketOptOutSet`), filter with `redeemable`, and call `redeemManyFor` in batches.

---

## ConditionalOrders

Contract: [`ConditionalOrders.sol`](../contracts/src/periphery/ConditionalOrders.sol). Interface:
[`IConditionalOrders.sol`](../contracts/src/periphery/interfaces/IConditionalOrders.sol).

### What it is for

Orders traders expect: take-profit, stop-loss and limit buys on YES and NO, executed through the HunchRouter
when the market's Kuru book reaches a price. (The app's one-click close uses the router directly, not this
contract.)

### Orders

An order is `{owner, market, kind, condition, triggerPriceE6, amountIn, limit, expiry, executorTipBps}`.

| Kind | Trigger price (E6) | `amountIn` | `limit` |
|---|---|---|---|
| `BuyYes` | YES best ask | USDC to spend | minimum YES the owner receives |
| `SellYes` | YES best bid | YES to sell | minimum USDC the owner receives |
| `BuyNo` | NO ask = 1 - YES best bid | NO to buy, exactly | maximum USDC the owner pays |
| `SellNo` | NO bid = 1 - YES best ask | NO to sell | minimum USDC the owner receives |

NO trades through the YES book (the router mints sets and sells YES to buy NO, and buys YES and merges to sell
NO), so NO prices come from the YES book as above. `condition` is `AtOrAbove` (price >= trigger) or `AtOrBelow`
(price <= trigger):

- take-profit = a sell, `AtOrAbove`
- stop-loss = a sell, `AtOrBelow`
- limit buy = a buy, `AtOrBelow`
- a buy `AtOrAbove` is a breakout buy

Prices are read from Kuru's `bestBidAsk()` (scaled to 1e18, empty bid = `type(uint256).max`, empty ask = 0) and
converted to E6. Bids round down and asks round up, so the price an order sees is never better than the book.
An empty side never triggers an order. The trigger can be anything from 0 to 1 USDC; `expiry` is inclusive.

### Who calls what

| Caller | Function | Effect |
|---|---|---|
| Owner | approve this contract for the input token (USDC, YES or NO) | Funds stay in the owner's wallet until execution |
| Owner | `place(request)` | Stores the order. Moves no funds |
| Owner | `cancel(orderId)` | Cancels an open order, at any time |
| Anyone (the keeper, or any bot) | `execute(orderId)` | Executes an open, unexpired, triggered order and earns its tip |
| Anyone | `isTriggered(orderId)`, `currentPrice(market, kind)`, `getOrder(orderId)` | Views |

### How an execution works

1. Checks: the order is open, not expired, and its trigger holds against the book right now. The order is
   marked executed before any token moves.
2. Pulls exactly what the order needs from the owner: `amountIn` (USDC for `BuyYes`, YES for `SellYes`, NO for
   `SellNo`), or `limit` USDC for `BuyNo` (the most it may cost).
3. Approves the router for exactly that amount and calls it with deadline = now. The router's own limit is
   tightened so the owner's limit still holds after the tip: `grossMin = ceil(limit * 10000 / (10000 - tipBps))`.
4. Measures every token by balance change. Sends the output minus the tip to the owner and the tip to the
   caller, returns everything else that came back (unspent USDC, unsold YES, the extra YES Kuru's integer
   matching can credit on a NO sale) to the owner, and resets the approval to zero.
5. Checks again that the owner received at least `limit` (or, for `BuyNo`, exactly `amountIn` NO before the tip).

If the trade cannot fill within the limit, or the market is past close (the router refuses), the whole
execution reverts and the order stays open.

### Trust and limits

- The contract can only ever pull from an order's owner, only the amount that order names, and only while
  executing that order. It holds nothing between transactions (checked by the invariant suite).
- An executor chooses when to execute, so it can execute the moment a trigger is touched, including a touch it
  caused itself. The owner's `limit` is the protection: set it. A stop-loss with a 0 limit accepts any fill.
- Orders expire. An expired order can only be cancelled.
- No owner, no parameters, no upgrade path.

### Fees

`executorTipBps`, chosen by the owner, from 0 to 50 basis points (0.5%) of the output, paid to whoever executes.
For `BuyNo` the tip is paid in NO. Kuru's own trading fees apply as for any router trade (0 on Hunch books today).

### Events

`OrderPlaced(orderId, owner, market, kind, condition, triggerPriceE6, expiry, executorTipBps, amountIn, limit)`,
`OrderCancelled(orderId, owner)`, `OrderExecuted(orderId, owner, executor, priceE6, spent, received, tip)`.

### How the app and keeper use it

- App: the trade ticket places orders and shows `getOrder` state from the indexer; approvals are exact or
  unlimited at the owner's choice.
- Keeper: watches the book (Kuru events or polling `bestBidAsk`), calls `isTriggered` for open orders, and
  calls `execute`. Simulate first: an order whose owner moved their funds or whose limit cannot fill reverts.

---

## ReferralRegistry

Contract: [`ReferralRegistry.sol`](../contracts/src/periphery/ReferralRegistry.sol). Interface:
[`IReferralRegistry.sol`](../contracts/src/periphery/interfaces/IReferralRegistry.sol).

### What it is for

Records which referrer brought a user, for a fixed time. It pays nothing. Referral shares are computed from
indexed fee events and paid through the MerkleDistributor (formula below).

### Rules

- `bind(referrer)`: the caller binds to `referrer`. Not to the zero address, not to themselves.
- A binding lasts `DURATION` seconds from the moment it is made (180 days in the deploy script). While it is
  active it cannot be changed. After it expires, `referrerOf(user)` returns the zero address and the user may
  bind again, to anyone.
- `bindFor(user, referrer, deadline, signature)`: a relayer binds for a user who signed an EIP-712 message
  `Bind(address user, address referrer, uint256 nonce, uint256 deadline)` in domain
  `("Hunch Book Referrals", "1", chainId, registry)`. The nonce is the user's current `nonces(user)` and each
  signature works once. Smart accounts sign through ERC-1271. A relayer cannot change the referrer, replay the
  signature, or use it after the deadline.

### Trust and limits

No owner and no funds. Nobody can bind, change or end someone else's binding. Self-referral through a second
wallet is possible and is accepted: it can only rebate part of the fees that same person paid (see the formula).

### Events

`Bound(user, referrer, boundAt, expiresAt, relayer)`.

### The referral formula

The registry decides **who**; the fee events decide **how much**. For each fee-paying event by a user `u` at block
time `t`, where `referrerOf(u)` was `r` at `t` (that is, `boundAt <= t < boundAt + DURATION`):

```
protocolShare(fee) = fee - floor(fee * 2500 / 10000)      the 75% the protocol keeps (the creator's 25% is never shared)
credit(r)         += floor(protocolShare(fee) * referralShareBps / 10000)
```

Fee-paying events, and who `u` is:

| Event | Emitted by | `u` | `fee` |
|---|---|---|---|
| `Redeemed(market, holder, to, side, amount, paid, fee)` | `CollateralVault` | `to` (the address that received the USDC, so auto-redeemed holders count too) | `fee` |
| `PoolClaimed(user, paid, fee)` | each `Market` | `user` | `fee` |

Rounding dust moved to the fee balances when the last winner claims has no user and earns no credit. Each epoch
(planned: weekly), `credit(r)` is summed per referrer over the epoch's blocks, and the epoch's tree pays it.
`referralShareBps` is a policy value published with each epoch (planned: 2000, which is 20% of the protocol's
share). Credits are paid from protocol fees the fee recipient has withdrawn, so a referral can never cost a user
or a creator anything.

---

## MerkleDistributor

Contract: [`MerkleDistributor.sol`](../contracts/src/periphery/MerkleDistributor.sol). Interface:
[`IMerkleDistributor.sol`](../contracts/src/periphery/interfaces/IMerkleDistributor.sol).

### What it is for

Pays referral shares (C-8) and maker rewards (V-5) in epochs. Offchain code computes who is owed what, builds a
Merkle tree, and the funder deposits the epoch's whole total with its root. Anyone can then claim for anyone.

### Who calls what

| Caller | Function | Effect |
|---|---|---|
| Funder | `createEpoch(token, root, total, claimDeadline)` | Pulls `total` of `token` and opens epoch `nextEpoch()`. The deadline must be at least 7 days away (`MIN_CLAIM_WINDOW`) |
| Anyone | `claim(epoch, account, amount, proof)` | Pays `amount` to `account` (never to the caller) if the proof holds. Once per account per epoch, up to the deadline |
| Anyone | `claimMany(claims)` | Several claims at once; all or nothing |
| Funder | `sweep(epoch, to)` | After the deadline only: sends that epoch's unclaimed remainder to `to`. Once |
| Funder | `transferFunder(pending)`, then the pending funder calls `acceptFunder()` | Two-step handover |

### Tree format

```
leaf = keccak256(bytes.concat(keccak256(abi.encode(uint256 epoch, address account, uint256 amount))))
```

This is OpenZeppelin's `StandardMerkleTree` with values `["uint256", "address", "uint256"]`, pairs hashed in
sorted order. The epoch id is inside every leaf, so a proof for one epoch never works in another. Build the
tree with the id `nextEpoch()` returns, and put each account in it once (merge amounts first).

### Trust and limits

- Each epoch is funded in full when created; the transfer is measured, so a fee-on-transfer token is refused.
- A claim that would take an epoch past its total reverts. A wrong root can therefore never reach another
  epoch's tokens.
- The funder cannot touch an epoch before its deadline, and after it only the unclaimed remainder.
- Per epoch, claimed + swept never exceeds total, and the contract's balance of each token always covers
  `outstanding(token)` (the invariant suite checks both).
- The funder decides the roots, so claimants trust the funder to compute them correctly. Every input to those
  computations is public chain data, and the formulas are on this page, so anyone can recompute a root.

### Events

`EpochCreated(epoch, token, root, total, claimDeadline)`, `Claimed(epoch, account, amount, caller)`,
`Swept(epoch, to, amount)`, `FunderTransferStarted(current, pending)`, `FunderTransferred(previous, current)`.

### The maker-reward formula (V-5)

Rewards pay for liquidity in proportion to how much was there and how close to the price it was:

1. **Samples.** Once per minute, for each graduated market's book, read every resting order (price, remaining
   size and owner, from Kuru's `OrderCreated`, `Trade` and `OrdersCanceled` events) and the book's mid.
2. **Order score.** With a band `B` around the mid (planned: 0.03 USDC) and `d = |price - mid|`, an order with
   `d < B` scores `size * ((B - d) / B)^2`. An order at the mid scores its full size; at the edge of the band, 0.
3. **Two-sided.** For each maker and sample, `Qbid` and `Qask` are the sums over their bids and asks, and the
   sample score is `S = max(min(Qbid, Qask), max(Qbid, Qask) / 3)`. Quoting both sides earns up to three
   times as much as quoting one.
4. **Payout.** With an epoch reward pool `R` for a market (published before the epoch starts),
   `reward(maker) = floor(R * sum of S(maker) / sum of S(every maker))` over the epoch's samples.

Hunch's own maker bot (its address is in `wallets.maker` in the deployments file) is excluded from rewards and
its share is not redistributed. Its fills are still counted, and labelled as ours, on the proof page.
Rounding leftovers stay unclaimed and come back through `sweep` after the deadline.

---

## ImpliedProbabilityOracle

Contract: [`ImpliedProbabilityOracle.sol`](../contracts/src/periphery/ImpliedProbabilityOracle.sol). Interface:
[`IImpliedProbabilityOracle.sol`](../contracts/src/periphery/interfaces/IImpliedProbabilityOracle.sol).

### What it is for

"The market's chance funding flips this week", as an onchain number other protocols can read: spot, and
averaged over time.

### Spot chance

`chanceE6(market)` returns `(chance, stale)` and `quote(market)` returns every input. Only markets the factory
created are accepted.

| Phase | Chance (E6) | Spread |
|---|---|---|
| Pool, PoolLocked | `Y * 1e6 / T` from the pool totals (500000 if the pool is empty) | 1e6 |
| Graduated, Closed, two-sided book | `(bid + ask) / 2`, each capped at 1 USDC | `ask - bid` |
| Graduated, Closed, one-sided book | that side's price | 1e6 |
| Graduated, Closed, empty book | the last recorded observation, or the opening price `Y / T` if there is none; `stale = true` | 1e6 |
| Settled | 1e6 if YES won, 0 if NO won | 0 |
| Voided | 500000 | 0 |

A book that reverts or returns malformed data reads as empty.

### Time-weighted averages

The oracle works like Uniswap's. `poke(market)` (anyone, at most once per block per market; a second poke in the
same block returns false without reverting) records the spot chance and spread. Each recorded value holds from
its poke until the next one, and two accumulators sum value times seconds. `consult(market, secondsAgo)` returns
the average chance over the last `secondsAgo` seconds; `consultFull` adds the average spread and the time of the
latest poke.

- **Storage.** Per market: the latest observation, rewritten by every poke, and a ring of 256 checkpoints.
  A poke stores a checkpoint only if at least 30 seconds (`MIN_SPACING`) passed since the last one, so pokes in
  every block cannot shorten the history. Once a market has been poked for a while, at least
  `maxWindow()` = 255 x 30 = 7650 seconds of history are always available.
- **Precision.** Averages are exact at checkpoints and from the latest checkpoint forward; between two
  checkpoints the accumulator is interpolated linearly.
- **Manipulation.** `consult` never reads the book, so moving the book and reading in one transaction does
  nothing. A value pushed onto the book and poked counts only until the next poke, which anyone can make in the
  next block. The cost of holding a false price grows with the time it must be held.
- **Freshness.** If nobody pokes, the last value keeps being extended. Readers should check `updatedAt` from
  `consultFull`. The keeper pokes every graduated market regularly (planned: every minute).

### Trust and limits

No owner, no parameters, no funds. It only reads the factory, the markets and their books.

### Events

`Poked(market, chanceE6, spreadE6, stale, checkpoint)`.

### Errors worth knowing

`NoObservations` before the first poke; `InsufficientHistory(oldestTimestamp)` when asked for more history than is
stored; `ZeroPeriod` for `secondsAgo` = 0; `UnknownMarket` for an address the factory did not create.

---

## OutcomeTokenPriceAdapter

Contracts: [`OutcomeTokenPriceAdapter.sol`](../contracts/src/periphery/OutcomeTokenPriceAdapter.sol) and
[`OutcomeTokenPriceAdapterFactory.sol`](../contracts/src/periphery/OutcomeTokenPriceAdapterFactory.sol).

### What it is for

A lending market that accepts YES or NO tokens as collateral needs a price feed in the Chainlink format. Each
adapter prices one token (one market, one side) conservatively.

### The price

`decimals()` is 8 and the answer is the value of 1 token in USDC (reported as USD; a lending market that prices
USDC separately should multiply by its USDC price).

| Market state | Value of 1 token |
|---|---|
| Settled, this side won | exactly what redeeming 1 token pays: `1 - ceil(1e6 * feeNumerator / feeDenominator) / 1e6` |
| Settled, this side lost | 0 |
| Voided | 0.50 |
| Otherwise | `twap * (1 - haircut)`, capped at `1 - fee` |

where:

- `twap` is the oracle's average chance of YES over `twapWindow` seconds (for NO, `1 - twap`).
- `haircut = min(timePart + spreadPart, 100%)`.
- `timePart` ramps linearly from `baseHaircutBps` (when close is `rampSeconds` or more away) to
  `closeHaircutBps` (at and after close). Block-clock markets estimate the time left as blocks left x
  `blockTimeMs`, which errs towards a larger haircut.
- `spreadPart = min(ceil(spreadTwap * spreadMultiplierBps / 1e6), maxSpreadHaircutBps)`, using the oracle's
  average spread over the same window. An empty or one-sided book counts as a full spread, so it reaches the cap.
- `fee` is the redemption fee per token this side pays if it wins, rounded up as the vault charges it (fixed at
  graduation; before graduation the full 2% is assumed).

The value is never negative and never above `1 - fee`. Every rounding goes against the token.

The parameters are fixed per factory. The deploy script uses:

| Parameter | Value | Meaning |
|---|---|---|
| `twapWindow` | 1800 seconds | 30-minute average |
| `baseHaircutBps` | 1000 | 10% off while close is 3 days or more away |
| `closeHaircutBps` | 10000 | 100% off at close: positions should be closed out before the answer arrives |
| `rampSeconds` | 259200 (3 days) | the time part rises over the last 3 days |
| `spreadMultiplierBps` | 10000 | a 0.03 USDC average spread adds 3% |
| `maxSpreadHaircutBps` | 2000 | the spread part is at most 20% |
| `blockTimeMs` | 400 | block-clock estimate |

A different set of parameters is a different factory. Within one factory, every (market, side) has exactly one
adapter, at an address known in advance (`predictAdapter`, CREATE2 with salt `keccak256(abi.encode(market, side))`).
Anyone can create one with `createAdapter(market, side)`.

### Rounds and freshness

`latestRoundData` returns `roundId = updatedAt`, `answeredInRound = roundId` and `startedAt = updatedAt`. For a
live market `updatedAt` is the oracle's latest poke: consumers must check it is recent, as with any Chainlink
feed. For a settled or voided market the value is final and `updatedAt` is the current time. Only the latest round
exists: `getRoundData` returns it for its own id and reverts `RoundNotAvailable` for any other. `latestAnswer`,
`latestTimestamp` and `latestRound` are there for older consumers.

Until the oracle has `twapWindow` seconds of history for the market, the adapter reverts (`NoObservations` or
`InsufficientHistory`). List a token only after that.

### Trust and limits

No owner, no funds, nothing to update. The adapter's value is only as fresh as the oracle's pokes and only as
deep as the book: a lending market should size its loan-to-value with the haircut in mind and stop accepting a
token well before its close.

### Events

The factory emits `AdapterCreated(market, side, adapter)`. Adapters emit nothing (they have no state to change).

---

## TemplateTimelock

Contract: [`TemplateTimelock.sol`](../contracts/src/periphery/TemplateTimelock.sol). Interface:
[`ITemplateTimelock.sol`](../contracts/src/periphery/interfaces/ITemplateTimelock.sol).

### What it is for

A new template decides how markets settle. The timelock makes every new template (and every change of limits)
public for a fixed delay before it can go live, so anyone can read the resolver and its parameters first. It is
meant to become the factory's guardian.

### Who calls what

| Caller | Function | Effect |
|---|---|---|
| Proposer | `queueAddTemplate(templateId, resolver, rule)` | Queues `factory.addTemplate`. The resolver must have code and the id must be free |
| Proposer | `queueSetCaps(caps)`, `queueSetCollateralCap(cap)` | Queues the factory's limit changes (they apply to markets created afterwards) |
| Proposer | `queueTransferGuardian(pending)` | Queues a guardian handover, for example to a new timelock |
| Anyone | `execute(data, nonce)` | Runs a queued call from `readyAt` until `readyAt + 14 days` (`GRACE_PERIOD`) |
| Proposer | `cancel(id)` | Drops a queued call |
| Proposer | `setCreationPaused(bool)`, `setGraduationPaused(bool)` | Immediate: pausing only protects users |
| Anyone | `acceptGuardian()` | Completes a guardian handover to this contract |

The delay is fixed at deployment, between 2 days (`MIN_DELAY`) and 30 days (`MAX_DELAY`); the deploy script uses
2 days. `OperationQueued(id, nonce, selector, data, readyAt)` carries the full calldata: decode it with the factory
ABI to see exactly what will run. `operationId(data, nonce) = keccak256(abi.encode(data, nonce))`.

### Trust and limits

- Only the four typed queue functions create operations, so `execute` can only call `addTemplate`, `setCaps`,
  `setCollateralCap` or `transferGuardian`, with the exact arguments that were public for the whole delay.
- The timelock adds no power. The guardian role it holds can never pause settlement, redemption, merges or refunds,
  never move funds and never set an outcome ([PROTOCOL.md §7.3](./PROTOCOL.md#73-access-control)).
- The proposer and delay never change. To change either, deploy a new timelock and queue `transferGuardian` to it,
  which itself waits the delay.

### Events

`OperationQueued`, `OperationExecuted(id, nonce, executor)`, `OperationCancelled(id)`, `CreationPauseSet(paused)`,
`GraduationPauseSet(paused)`, `GuardianAccepted()`.

### Making it the guardian

`DeployPeriphery.s.sol` deploys the timelock but does **not** make it the guardian. That is a separate guardian
action, taken when the team is ready:

1. The current guardian (the multisig) calls `factory.transferGuardian(timelock)`.
2. Anyone calls `timelock.acceptGuardian()`. From then on, new templates and limits wait the delay; pauses stay
   immediate through the proposer.

---

## Deploying

[`DeployPeriphery.s.sol`](../contracts/script/DeployPeriphery.s.sol) deploys all seven contracts against the core in
`deployments/<network>.json` and writes their addresses under `hunchBook.periphery`, only in a broadcast run.

```sh
cd contracts
# Dry run: deploys on a local copy of the chain and prints the result. Writes nothing.
forge script script/DeployPeriphery.s.sol --rpc-url "$MONAD_TESTNET_RPC" --sender "$DEPLOYER_ADDRESS"
# Deploy (the key comes from the environment, never the command line):
DEPLOYER_PRIVATE_KEY=... forge script script/DeployPeriphery.s.sol --rpc-url "$MONAD_TESTNET_RPC" --broadcast
# Record the deployment transaction hashes from forge's broadcast log (sends nothing):
forge script script/DeployPeriphery.s.sol --sig "recordTxs()" --rpc-url "$MONAD_TESTNET_RPC"
```

| Env | Default | Notes |
|---|---|---|
| `TIMELOCK_PROPOSER` | the current guardian (testnet) | Required on mainnet, and must not be the deployer |
| `TIMELOCK_DELAY` | 172800 (2 days) | Seconds, from 2 to 30 days |
| `DISTRIBUTOR_FUNDER` | the protocol fee recipient | Creates epochs and sweeps expired leftovers |

Wiring set at deploy: the AutoRedeemer, ConditionalOrders and oracle read the factory (and the router, for
orders); referral bindings last 180 days; the adapter factory uses the parameters in the table above.

## Testing

Every contract has unit tests for each path and revert, and fuzz tests, in
[`contracts/test/periphery/`](../contracts/test/periphery/). They run on the real core contracts (factory, vault,
markets, outcome tokens and the HunchRouter) with the Kuru order book mock the core suites use. The contracts that
move user funds have invariant suites:

- AutoRedeemer: it never holds a balance; every keeper redemption pays exactly what the holder could redeem
  alone, only to listed, opted-in holders; the vault stays solvent.
- ConditionalOrders: it and the router never hold a balance or an approval; owners never receive less than their
  limit or pay more than their order allows; a failed execution leaves the order open; the vault stays solvent
  and YES supply = NO supply = sets.
- MerkleDistributor: per epoch claimed + swept <= total; the balance of each token equals what was funded minus
  what was paid, and covers what is still owed.

A fork suite ([`contracts/test/fork/Periphery.fork.t.sol`](../contracts/test/fork/Periphery.fork.t.sol)) deploys
the periphery with the deploy script on a fork of Monad testnet and runs the oracle, a price adapter and all four
order kinds against the live book of testnet market #1:

```sh
cd contracts
forge test --match-path "test/periphery/*"
FOUNDRY_PROFILE=fork forge test --match-path test/fork/Periphery.fork.t.sol
```

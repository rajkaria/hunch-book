# Hunch Book protocol specification

Version 0.1 (2026-10-03). Status: design. Nothing here is deployed yet; [ROADMAP.md](./ROADMAP.md) tracks what ships when.

## 1. Summary

Hunch Book runs yes/no prediction markets on Monad in USDC. Every market goes through up to three stages:

1. **Pool.** People stake USDC on YES or NO. The split of the pool is the market's chance. No market maker is needed, so a market works from its first dollar.
2. **Book.** If the pool proves demand before it locks, it **graduates**. In one transaction the pool's USDC becomes fully backed YES and NO tokens, split between the stakers so that each staker's payout is exactly what the pool would have paid, fees included. The YES token opens as a YES/USDC spot market on Kuru, Monad's onchain order book, at the pool's price. From then on anyone can buy or sell either side at any time.
3. **Settlement.** When the observation window ends, anyone can settle the market. A resolver contract reads the answer from onchain data: Perpl's historical funding accumulator, or a price from Chainlink's onchain feeds (or a Pyth price signed by Pyth's publishers). No person, including the Hunch team, can set an outcome.

Pools that never graduate settle as pools.

## 2. Terms

| Term | Meaning |
|---|---|
| Template | A resolver contract plus a parameter schema. It defines a family of questions, for example "funding paid by longs on Perpl market M between blocks A and B is above X". |
| Market | One question created from a template with fixed parameters. There is at most one market per (template, parameters) pair. |
| Complete set | 1 YES token + 1 NO token. Always backed by exactly 1 USDC in the vault until settlement. |
| Pool totals | `Y` = USDC staked on YES, `N` = USDC staked on NO, `T = Y + N`. |
| Implied chance | Pool phase: `p = Y / T`. Book phase: the mid price of the YES/USDC book. |
| Lock | The moment staking stops. Set at or before the start of the observation window, so nobody can stake after information arrives. |
| Close | The end of the observation window. Trading through Hunch's router stops; settlement becomes possible. |
| Settlement deadline | Close + 7 days. Settlement is possible from close up to the deadline; after it, the only action is void. So the answer never depends on who calls first. |

## 3. Users and the jobs they hire it for

| User | Job | What they do |
|---|---|---|
| Perp trader on Perpl | "Pay me back if funding stays high this week, and let me exit early." | Buys YES on a funding-threshold market, sells it when funding cools or holds to settlement. |
| Trader with a view | "Express a view on MON, BTC or funding with a capped loss." | Stakes in a pool or trades the book. |
| Market creator | "Start the market my community wants and earn from it." | Creates a market from a template, makes the first stake, earns 25% of Hunch's fee on it. |
| Market maker | "Quote a fully backed binary with known settlement rules." | Quotes the YES book; mints and merges complete sets to manage inventory. |
| Other protocols (later) | "Read the market's implied chance as an input." | Reads the implied-probability view (roadmap V-6). |

## 4. Market lifecycle

```
            stake (YES/NO)                     trade on Kuru, mint/merge sets
   ┌────────────┐   graduate()   ┌─────────────┐   now ≥ close   ┌──────────┐
──►│    POOL    │───────────────►│  GRADUATED  │────────────────►│  CLOSED  │
   └─────┬──────┘                └─────────────┘                 └────┬─────┘
         │ now ≥ lock, not graduated                                  │ settle(evidence)
         ▼                                                            ▼
   ┌────────────┐            settle(evidence)                 ┌──────────────┐
   │ POOL_LOCKED│────────────────────────────────────────────►│ SETTLED Y/N  │
   └─────┬──────┘                                             └──────────────┘
         │ now > settlement deadline, no answer          (any non-final phase)
         └───────────────────────────────►  VOIDED  ◄────────────────────────
```

| Phase | Allowed actions | Not allowed |
|---|---|---|
| POOL | stake, graduate (if rules met) | trade, mint, merge |
| POOL_LOCKED | settle (after close), void (after deadline) | stake, graduate |
| GRADUATED | claim tokens, trade (router + Kuru), mint, merge | stake |
| CLOSED | settle, merge, claim tokens | router trades, mint |
| SETTLED | redeem winning tokens, claim tokens, claim pool payout | merge (it would let a winner skip the redemption fee by buying a worthless losing token), everything else |
| VOIDED | refund pool stakes, claim tokens, redeem tokens at 0.50 each, merge | everything else |

Notes:
- Touch markets (§6.3) can settle YES before close, as soon as anyone proves the event happened.
- Kuru's book is not ours to halt; only Kuru can pause a market. After close, Hunch's router refuses trades and Hunch's maker cancels all its orders, but orders other people left on the book can still fill, and so can any liquidity someone deposited in the book's built-in AMM vault. The app warns makers about this, and we ask Kuru to soft-pause each book at close.

## 5. Economics

All amounts are in USDC base units (6 decimals). Outcome tokens use 6 decimals, so 1 token redeems for at most 1 USDC.

### 5.1 Collateral

The `CollateralVault` holds every USDC in the protocol and keeps per-market books:

- `poolCollateral[m]`: USDC staked in market `m` while it is a pool
- `sets[m]`: complete sets outstanding (= YES supply = NO supply until settlement)
- `fees`: fees owed but not yet withdrawn, kept as one protocol balance and one balance per creator

Solvency invariant, checked by tests after every action and by the vault after every flash loan:

```
USDC.balanceOf(vault) ≥ Σ_m ( poolCollateral[m] + sets[m] ) + protocolFees + Σ_c creatorFees[c]
```

After settlement, `sets[m]` is replaced by the winning side's outstanding supply.

### 5.2 Pool phase

- Minimum stake 1 USDC. Stakes are final: there is no withdrawal from a pool. This is what makes the pool safe without a market maker, and it also means nobody can flash-stake to trigger graduation.
- The creator makes the first stake (v0 minimum: 5 USDC) when creating the market.
- If a pool settles without graduating, outcome YES pays each YES staker `i`:

```
payout_i = s_i + (1 − φ) · s_i · N / Y          φ = 0.02 (2% of winnings)
```

and symmetrically for NO. Total fees are `φ · N`, which can never exceed the losing side.
- If only one side has stakes at settlement, every stake is refunded in full with no fee.
- If the market voids, every stake is refunded in full with no fee.

### 5.3 Graduation

**When.** Anyone can call `graduate()` while the market is a POOL and before lock, if all of these hold:

| Rule | v0 value |
|---|---|
| Pool total `T` | ≥ 500 USDC |
| Distinct stakers | ≥ 10 |
| Both sides staked | `Y > 0` and `N > 0` |
| Implied chance `p = Y / T` | between 3% and 97% |
| Kuru book ready | a verified Kuru YES/USDC book is registered for the market, or the Graduator can create one on this network (§8.1) |

The rule values are copied from the template into each market at creation and never change for that market.

**What happens, in one transaction:**

1. The market moves `T` USDC from `poolCollateral` to `sets`, and the vault mints `T` YES and `T` NO.
2. Each YES staker `i` can claim `a_i = ⌊T · s_i / Y⌋` YES tokens. Each NO staker `j` can claim `b_j = ⌊T · s_j / N⌋` NO tokens. Claims are pulled (`claimTokens`) or pushed by anyone in batches (`claimTokensFor`); the keeper pushes them right after graduation. Rounding dust (`T − Σ a_i`, `T − Σ b_j`, at most one base unit per staker) goes to the fee account.
3. The redemption fee per winning token is fixed for the life of the market:

```
f_YES = φ · N / T          f_NO = φ · Y / T          (at most 0.02 × 0.97 = 0.0194 USDC per token)
```

4. The market's Kuru YES/USDC book goes live for it: on testnet the Graduator creates it in this transaction; on mainnet Kuru creates it beforehand and it has already been registered (§8.1). The opening reference price is `p = Y / T`.

The YES and NO token contracts are created with the market, not at graduation, so a book can be prepared while the pool is still filling.

**Payoff identity.** Graduation changes nothing for a staker who holds to the end. If YES wins, YES staker `i` redeems:

```
a_i · (1 − f_YES) = (T·s_i / Y) · (1 − φ·N/T) = s_i·T/Y − φ·s_i·N/Y = s_i + (1 − φ) · s_i · N / Y
```

which is the pool payout from §5.2, to the base unit (apart from rounding dust). What graduation adds is the option to sell before the answer arrives.

### 5.4 Book phase

One Kuru market per graduated Hunch market: YES/USDC. NO trades through the same book by construction:

| Action | How the router does it, atomically |
|---|---|
| Buy YES | Market-buy YES on the book with USDC. |
| Sell YES | Market-sell YES on the book for USDC. |
| Buy NO (`k` tokens) | Mint `k` complete sets (cost `k` USDC), market-sell the `k` YES, deliver `k` NO. The user pays `k − proceeds`. A vault flash loan covers the gap so the user only sends their net cost. |
| Sell NO (`k` tokens) | Flash-borrow USDC, market-buy `k` YES, merge `k` YES + `k` NO into `k` USDC, repay, deliver the rest. |

Every router call takes a minimum-out (or maximum-in) amount and a deadline, and reverts once the market is CLOSED. Anyone can also mint and merge complete sets directly on the vault: mint costs exactly 1 USDC per set and merge returns exactly 1 USDC per set, with no fee. That keeps YES + NO prices anchored at 1 USDC.

### 5.5 Settlement payouts

- **Graduated markets.** Each winning token redeems for `1 − f_side` USDC. Losing tokens redeem for 0.
- **Pool-only markets.** Winners claim per §5.2.
- **Fees** go to the vault's fee account: 75% protocol, 25% the market's creator. Creators withdraw their share onchain.

### 5.6 Void

A market voids only if its resolver cannot produce an answer before the settlement deadline (for example, the source contract reverts for 7 days). Then:

- Pool-only markets: every stake is refunded in full, with no fee.
- Graduated markets: every YES and every NO redeems for 0.50 USDC, with no fee. Someone who bought YES at 0.80 on the book loses 0.30 per token in a void. This is stated on every market page. Templates are chosen so voids are close to impossible: they read historical data that stays readable after the window ends.

### 5.7 Fee summary

| Who pays | When | How much |
|---|---|---|
| Pool winners | Pool settlement | 2% of winnings (never more than the losing side) |
| Token holders | Redemption of a winning token | `f_side` per token, fixed at graduation, at most 1.94 cents |
| Book traders | Each Kuru trade | Kuru's own maker/taker fees (go to Kuru, not to Hunch) |
| Anyone | Mint, merge, void refunds | nothing |

## 6. Settlement and templates

### 6.1 Template S-1: Perpl net funding

**Question shapes:** "Will BTC longs pay shorts on net on Perpl between block {A} and block {B}?" and "Will BTC longs pay more than ${X} per BTC in funding on Perpl between block {A} and block {B}?"

- **Source.** Perpl's Exchange contract (mainnet `0x34B6552d57a35a1D042CcAe1951BD1C370112a6F`, testnet `0x1964C32f0bE608E7D29302AFF5E61268E72080cc`):

  ```solidity
  function getFundingSumAtBlock(uint256 perpId, uint256 blockNumber)
      external view returns (int48 fundingSum, uint256 fundingEventBlock);
  ```

  It returns cumulative funding as of the last funding event at or before `blockNumber`. A rising sum means longs paid shorts. Dividing by `10^(priceDecimals + fundingSumScalingExp)` (both from `getPerpetualInfoV2`) gives USD per one unit of the base asset. History is kept in contract storage, so old blocks stay readable without an archive node.
- **Cadence.** Funding events sit on a fixed grid, one every 8,571 blocks (about 43 minutes at today's block times), about 234 a week.
- **Rule.** `ΔF = F(B) − F(A)`. YES if `ΔF > X`; NO otherwise (equal is NO). `X` is stored in Perpl's raw units at creation; the app shows it in USD per unit.
- **Finality.** Perpl can overwrite a scheduled funding value until its event block passes. Settlement therefore requires `block.number > B`, at which point every event at or before `B` is final. The resolver never reads a block at or after the current one.
- **Timing.** Lock is block `A`; close is block `B`. These markets are defined in blocks, so the rule is exact; the app shows estimated clock times.
- **When the resolver refuses to answer** (the market then voids at its deadline): the read reverts (perp removed); the last event at or before `B` is more than two intervals older than `B` (perp paused); `fundingSumScalingExp` differs from the value recorded at creation; or Perpl's contract version (`getContractVersion()`) differs from the one the resolver pinned when it was deployed. A contract cannot read Perpl's proxy implementation slot, so an upgrade that keeps the same version number is not visible onchain; the keeper watches the slot offchain and reports it.
- **Who you trust.** Perpl's funding rates are set by Perpl's own price administrator within a per-market clamp and a tolerance against Chainlink prices, and Perpl's contracts can be upgraded by a 3-of-7 multisig. A Hunch Book market on Perpl funding pays out on what Perpl records. Every Perpl market page says so.

### 6.2 Template S-2: price at a time

**Question shape:** "Will {asset}/USD be at or above {K} at {T} UTC?"

- **Default source: Chainlink price feeds on Monad**, read with `getRoundData`. The settler passes a round id `r`. The resolver accepts it only if rounds `r` and `r + 1` are in the same phase, `updatedAt(r) ≤ T < updatedAt(r + 1)`, and `T − updatedAt(r) ≤ 1 hour`. Exactly one round brackets `T`, so nobody can pick a convenient price, and no API key is needed. If no round after `T` exists yet, settlement waits; if the feed has stopped, the market voids at its deadline.
- **Alternative source: Pyth**, for assets without a Chainlink feed. The settler submits a signed update and the resolver accepts only the first update published at or after `T`, within 60 seconds (`parsePriceFeedUpdatesUnique`). Fetching historical updates from Pyth's Hermes service needs a Pyth API key.
- **Rule.** YES if the price is at or above `K` (decimals normalised); NO otherwise.
- **Timing.** Lock is a set time before `T` (v0: 24 hours for daily markets, 1 hour for intraday); close is `T`.

### 6.3 Touch markets (S-3, proof by pointer)

**Question shapes:** "Will MON/USD reach {K} at any time between {T1} and {T2}, per Chainlink's MON/USD feed?" and (later) "Will any single BTC funding event on Perpl this week charge longs more than {X}?"

- **YES is proved by pointing at the moment it happened.** Price: a Chainlink round `r` with `T1 ≤ updatedAt(r) ≤ T2` and an answer at or above `K`. Funding: a grid event block `e` in the window where `getFundingSumAtBlock(e)` reports `e` as its event block and `F(e) − F(e − 8571) > X`. The resolver checks the pointer onchain and settles YES at once.
- **NO** settles after the window closes plus a 24-hour challenge period in which nobody submitted a valid proof. Hunch's keeper watches every touch market and submits proofs, and so can anyone. The assumption is that at least one honest party submits a proof if one exists.
- A touch question only ships if it is genuinely uncertain. "Will BTC funding turn negative this week?" is rejected: on recent history it resolves YES almost every week.

### 6.4 What makes a template acceptable

A template ships only if:

1. Its source is an onchain contract whose value at the settlement point **stays readable after the fact** (historical getter or signed data), so late settlement reads the same answer. Template 7 (snapshot) meets this for current-state values by reading the value itself in a short window right after close and storing it, write-once ([TEMPLATES.md](./TEMPLATES.md#template-7-snapshot)).
2. Its rule fits in one plain sentence that the app shows next to the market.
3. A single trader cannot cheaply move the source by an amount that flips typical markets. Per-market caps keep market size small next to the cost of moving the source.
4. It has fork tests against real mainnet data, including the edge where the value equals the threshold.

## 7. Contracts

### 7.1 Overview

```
                  ┌─────────────────────┐
  creator ───────►│  HunchBookFactory   │── clones ──► Market (one per question)
                  └─────────┬───────────┘                 │ uses
                            │ registry                     ├──► IResolver (template)
                            ▼                              │
                  ┌─────────────────────┐   mint/merge     │
  users ─────────►│  CollateralVault    │◄─────────────────┤
                  │  (all USDC)         │── clones ──► OutcomeToken YES/NO
                  └─────────┬───────────┘                  │
                            │ flash loan                   │ graduate
                  ┌─────────▼───────────┐       ┌──────────▼──────────┐
  traders ───────►│    HunchRouter      │──────►│ Kuru YES/USDC book  │◄── makers
                  └─────────────────────┘       └──────────▲──────────┘
                                                ┌──────────┴──────────┐
                                                │     Graduator       │──► Kuru Router.deployProxy
                                                └─────────────────────┘
```

| Contract | Upgradeable | Holds funds | Notes |
|---|---|---|---|
| `CollateralVault` | no | all USDC | per-market ledgers, flash loan with solvency check |
| `OutcomeToken` | no (minimal clones) | no | mint/burn only by the vault |
| `Market` | no (minimal clones) | no (funds are in the vault) | state machine, pool ledger, claims |
| `HunchBookFactory` | no (a fix ships as a new factory) | no | canonical market keys, template registry, caps |
| `Graduator` | no | no | creates (testnet) or verifies and registers (mainnet) each market's Kuru book |
| `HunchRouter` | no | never between transactions | approvals set per call and reset |
| Resolvers | no | no | pure readers of their source |

### 7.2 Interfaces (v0, frozen)

The interfaces live in [`contracts/src/interfaces/`](../contracts/src/interfaces/) and are the source of truth; TypeScript reads them through ABIs generated into `packages/shared`. They were frozen on 2026-10-03 before the parallel build started; a change ships in its own commit.

| File | What it defines |
|---|---|
| `IHunchBookTypes.sol` | `Phase`, `Side`, `Outcome`, `Window`, `GraduationRule`, `MarketCaps` |
| `IResolver.sol` | `validate`, `describe`, `resolve` (payable, returns `Unresolved` rather than guessing), `earlyYes` |
| `ITemplates.sol` | parameter structs for S-1 (`PerplFundingParams`) and S-2 (`PriceAtTimeParams`), and the evidence formats |
| `IHunchBookFactory.sol` | `createMarket`, the template registry, canonical market keys, guardian and fee-recipient actions |
| `IMarket.sol` | staking (direct, on behalf of, relayed EIP-3009), `graduate`, token claims, `settle`, `proveYes`, `voidIfExpired`, pool claims, views |
| `ICollateralVault.sol` | `mintSets`, `mergeSets`, `redeem(market, side, amount, to)`, `flashLoan`, `surplus`, fee withdrawals, and the market-only ledger hooks |
| `IOutcomeToken.sol` | the 6-decimal YES/NO token (with permit), minted and burned only by the vault |
| `IGraduator.sol` | `createBook` (testnet), `registerBook` (mainnet), `bookOf` |
| `IHunchRouter.sol` | `buyYes`, `sellYes`, `buyNo`, `sellNo`, each with a limit and a deadline |
| `IFlashLoanReceiver.sol` | the vault's flash-loan callback |

Decisions made at the freeze:

- **One approval.** Stakers approve the vault once; markets ask the vault to pull a stake from the caller. Only markets the factory created can do this, and they only pull from the caller (or, for `stakeFor`, from the payer who called).
- **The factory deploys the vault.** The vault trusts exactly one factory. A fixed factory ships with a new vault; existing markets keep theirs.
- **Relayed stakes are bound to a side.** `stakeWithAuthorization` takes a salt, and the EIP-3009 nonce the user signs must equal `keccak256(chainid, market, user, side, salt)`, so a relayer cannot move the signed USDC to the other side.
- **`redeem` names the side.** After settlement only the winning side redeems (1 − fee per token); after a void either side redeems at 0.50.
- **No merge after settlement.** See the phase table in §4.
- **Settle up to the deadline, void after it.** See §2.
- **Rounding dust** from token claims is sent to the protocol fee recipient as tokens once the last staker on that side has claimed. Pool-claim dust moves to the fee balances (split like any fee) once the last winner has claimed.
- **Flash loans are open to anyone and free**, because the vault checks that its surplus did not fall across the call.

### 7.3 Access control

| Role | Can | Cannot |
|---|---|---|
| Anyone | create markets, stake, graduate, claim for others, settle, prove YES, void after deadline, mint, merge, redeem | set outcomes, move others' funds |
| Guardian (a multisig, not a hot key) | pause new market creation; pause graduation; add a template (new templateId → resolver); set caps for markets created afterwards | pause settlement, redemption, merges or refunds; change an existing market; set outcomes; move funds |
| Fee recipient | withdraw the protocol's share of fees | anything else |
| Creator | withdraw their 25% fee share | anything else |

## 8. Integrations

### 8.1 Kuru

**Book creation.** Kuru's Router creates a spot market and its AMM vault in one call:

```solidity
deployProxy(uint8 _type, address base, address quote, uint96 sizePrecision, uint32 pricePrecision,
            uint32 tickSize, uint96 minSize, uint96 maxSize, uint256 takerFeeBps, uint256 makerFeeBps,
            uint96 kuruAmmSpread) returns (address market)
```

| Network | Router | Who can create markets | Hunch Book flow |
|---|---|---|---|
| Testnet | `0x7EFbE105Ca7415dE98F96622173458ac1c054630` | anyone | the Graduator calls `deployProxy` inside `graduate()` |
| Mainnet | `0xd651346d7c789536ebf06dc72aE3C8502cd695CC` | Kuru's owner only (verified: other callers get `Unauthorized()`; there is no whitelist) | when a pool nears its graduation rule, the keeper asks Kuru to create the book; anyone then calls `registerBook`, which checks it is a Kuru-registered market for this YES token and USDC with the expected parameters |

**Book parameters** for every Hunch Book market:

| Parameter | Value | Why |
|---|---|---|
| `_type` | 0 (no native token) | both sides are ERC-20 |
| base / quote | YES token / USDC | |
| `sizePrecision` / `pricePrecision` | 1e6 / 1e6 | YES and USDC both have 6 decimals, so every conversion is exact and no dust is left |
| `tickSize` | 1,000 (0.001 USDC) | 980 price levels between 0.01 and 0.99 |
| `minSize` / `maxSize` | 1 YES / pool cap | |
| fees | Kuru's choice (Kuru's own mainnet markets charge 0/0) | |
| AMM vault | left empty by Hunch | its constant-product curve has no 1 USDC cap, so it is not a fit for a token that ends at 0 or 1 |

**Trading.** The router uses Kuru's wallet path (`isMargin = false`): it approves the market contract for the exact amount, calls `placeAndExecuteMarketBuy` or `placeAndExecuteMarketSell` with a minimum output, and receives the output directly. A buy then a sell in one transaction was tested on a fork of Kuru's testnet. Limit orders (the maker bot) always settle through Kuru's MarginAccount, so the bot withdraws its fills from there.

**Reading the book.** `getL2Book()` and `bestBidAsk()` onchain are the source of truth; an empty bid reads as `type(uint256).max` and an empty ask as 0.

### 8.2 Perpl

| Item | Mainnet | Testnet |
|---|---|---|
| Exchange (ERC-1967 proxy) | `0x34B6552d57a35a1D042CcAe1951BD1C370112a6F` | `0x1964C32f0bE608E7D29302AFF5E61268E72080cc` |
| Perp ids | BTC 1, MON 10, ETH 20, SOL 31 | BTC 16, ETH 32, SOL 48, MON 64 |
| Funding interval | 8,571 blocks | 8,571 blocks |

Perp ids are enumerated onchain with `getPerpetualExistsBitmap()` and described by `getPerpetualInfoV2(id)`. `getFundingSumAtBlock` is Perpl's only by-block historical getter; mark price, oracle price and open interest are current-state only. Templates 1 to 6 do not use them; template 7 (building) settles on open interest and mark price from a snapshot it takes itself right after close ([TEMPLATES.md](./TEMPLATES.md#template-7-snapshot)).

### 8.3 Price feeds

| Feed | Chainlink proxy (mainnet) | Pyth feed id |
|---|---|---|
| BTC/USD | `0xc1d4C3331635184fA4C3c22fb92211B2Ac9E0546` | `e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43` |
| ETH/USD | `0x1B1414782B859871781bA3E4B0979b9ca57A0A04` | `ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace` |
| MON/USD | `0xBcD78f76005B7515837af6b50c7C52BCf73822fb` | `31491744e2dbf6df7fcf4ac0820d18a609b49076d45066d3568424e62f686cd1` |
| SOL/USD | `0x16F8008c3e89f62e5e2b909Ce70999370D38F4F2` | `ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d` |

Pyth contracts: mainnet `0x2880aB155794e7179c9eE2e38200202908C17B43`, testnet `0xFC6bd9F9f0c6481c6Af3A7Eb46b296A5B85ed379`. All addresses are also kept in `deployments/<network>.json`, which is the copy the code reads.

## 9. Offchain components

None of these hold user funds or decide outcomes. If all of them stop, users can still mint, merge, settle (with evidence they fetch themselves) and redeem.

### 9.1 Keeper

| Job | Trigger | Notes |
|---|---|---|
| Graduate | pool meets the rule | anyone can do it; the keeper makes sure someone does |
| Push token claims | right after graduation | batches of stakers per transaction |
| Settle | close passed | fetches Pyth evidence where needed |
| Prove touches | touch condition observed | submits the pointer |
| Void | settlement deadline passed | rare by design |
| Recurring series (Phase 1) | schedule | creates next week's market from a template |
| Auto-redeem (Phase 1, opt-in) | settlement | redeems to the holder's own wallet |

### 9.2 Maker bot (open source, labelled)

- Fair value per template:
  - Funding threshold: funding accrued so far in the window plus the expected remainder (current rate × blocks left), with uncertainty estimated from Perpl's historical funding changes; `p = P(ΔF > X)`.
  - Price threshold: probability that a lognormal price ends above the strike, using recent realised volatility from the Chainlink feed's own round history (read onchain with `getRoundData`, no API key). Assets with no Chainlink feed use Pyth history instead.
- Quotes `p ± spread/2`, skewed by inventory, clamped to [0.01, 0.99], with a minimum spread of 2 cents and per-market inventory caps. It widens near close and cancels everything at close.
- It mints and merges complete sets to manage inventory.
- Its address is published, and every fill against it is counted separately on the proof page.

### 9.3 Indexer (Envio HyperIndex)

Public Monad RPCs cap `eth_getLogs` at 100 blocks (about 30 seconds of chain), so the indexer reads through Envio HyperSync. Markets are registered dynamically from the factory's `MarketCreated` event.


Entities: `Market`, `Stake`, `Staker`, `Graduation`, `TokenClaim`, `Trade` (Kuru fills on registered books), `Position`, `Settlement`, `Redemption`, `Creator`, `DailyStats`. The proof page's metrics (wallets, trades, volume, maker share) come only from these entities.

### 9.4 App

| Page | What it shows |
|---|---|
| Markets | pools filling, live books, settling, settled; filter by template and asset |
| Market | the rule in one sentence, implied chance, pool or book depth, stake/trade ticket, timeline (lock, close, deadline), source link, void terms |
| Create | pick a template, fill parameters, preview the plain-English rule and window, first stake |
| Portfolio | stakes, tokens, claimable tokens, P&L, redeemable winnings |
| Verify | for a settled market: contract, function, block or publish time, the value read, and a button that re-runs the read from the browser with no wallet |
| Proof | live totals from the indexer, and the share of book fills taken by Hunch's maker |
| Hedge (Phase 0.5/2) | reads a Perpl position and proposes a matching market and size |

Every transaction the app sends is shown with an explorer link.

### 9.5 Accounts and gas

- **Wallets.** Regular browser wallets, plus passkey accounts through Mera: the passkey derives an ordinary Monad account in the browser, with no seed phrase, extension or custody server. Passkey accounts are tied to one domain, so the app is served from a single production domain.
- **Gas.** Monad charges for the gas limit, not the gas used, and new accounts hold no MON. Two paths, both capped per account: a small MON drip on first use, and stakes submitted by a relayer from a signed USDC authorisation (native USDC on Monad supports EIP-2612 `permit` and EIP-3009 `receiveWithAuthorization`, so `stakeWithAuthorization` moves the user's USDC and stakes in one call).
- **No EIP-7702 delegation for user accounts**: on Monad a delegated account cannot drop below a 10 MON reserve through transfers.

## 10. Security

### 10.1 Invariants (enforced by Foundry invariant tests)

1. Vault surplus ≥ 0 after every call, including inside and after flash loans.
2. Before settlement: YES supply = NO supply = `sets[m]` for every market.
3. Σ token claims ≤ `T` per side; Σ pool payouts + fees ≤ pool.
4. Payoff identity of §5.3 holds for random stake sets, within rounding dust.
5. No call sequence lets any address set an outcome or redeem a losing token for value.
6. The guardian cannot block settlement, redemption, merge or refunds.

### 10.2 Threats and answers

| Threat | Answer |
|---|---|
| Re-entrancy through tokens or Kuru calls | Checks-effects-interactions; reentrancy guards on every state-changing entry; the router holds no balance between transactions |
| Flash-staking to force graduation | Stakes cannot be withdrawn, so a flash loan cannot be repaid |
| Blocking graduation by skewing a side | Costs real stake that stays at risk; the market still settles as a pool |
| Choosing a convenient price | Chainlink: only the round that brackets `T` is accepted. Pyth: only the first update at or after `T` |
| Perpl's operators change funding or upgrade the Exchange | Outside our control and disclosed on every Perpl market; an implementation change during the window makes the resolver refuse to answer, so the market voids instead of paying on rewritten data |
| Resting orders filled after the answer is known | Router and maker stop at close; app warns makers; settlement can be triggered immediately |
| Withholding touch proofs | Anyone can prove; the keeper watches every touch market; 24-hour challenge before NO |
| Guardian key compromise | Can only pause creation and graduation |
| USDC issuer freezes the vault | Out of our control; disclosed |
| Kuru outage | Book trading stops; mint, merge, settle and redeem do not depend on Kuru |
| A fake "book" registered for a market | `registerBook` accepts only markets registered in Kuru's MarginAccount with this YES token, USDC and the expected precisions |

### 10.3 Beta limits (v0)

| Limit | Value |
|---|---|
| Max pool per market | 5,000 USDC |
| Max stake per wallet per market | 1,000 USDC |
| Max total USDC in the vault | 50,000 USDC |
| Market creation | open; creator's first stake ≥ 5 USDC |

Limits apply to markets created after a change; existing markets keep the limits they started with.

## 11. Known limitations

- Mainnet graduation depends on Kuru creating each book (Kuru's mainnet market creation is owner-only).
- After graduation, a void pays 0.50 per token, which is not a refund for someone who bought at another price.
- Thin books are likely at first. Until outside makers join, a large share of book fills will be against Hunch's labelled maker; the proof page shows that share.
- Perpl funding markets inherit Perpl's trust model: a permissioned price administrator sets funding rates and a 3-of-7 multisig can upgrade the Exchange.
- Only questions whose answers are onchain and stay readable can be markets. Creator-resolved questions are on the roadmap as pool-only markets (S-7).

## 12. Parameters (v0)

| Parameter | Value |
|---|---|
| Collateral | USDC (native Circle USDC on Monad mainnet `0x754704Bc059F8C67012fEd69BC8A327a5aafb603`) |
| Outcome token decimals | 6 |
| Pool fee `φ` | 2% of winnings |
| Creator share of fees | 25% |
| Graduation rule | T ≥ 500 USDC, ≥ 10 stakers, both sides, 3% ≤ p ≤ 97% |
| Settlement deadline | close + 7 days |
| Touch challenge period | 24 hours |
| Price source | Chainlink round that brackets `T` (staleness ≤ 1 hour); Pyth (60 seconds after `T`) where no Chainlink feed exists |
| Perpl settlement | `block.number > B`; void if paused, rescaled or upgraded during the window |
| Kuru book | precisions 1e6/1e6, tick 0.001 USDC, AMM vault empty (§8.1) |

## 13. Open items before deployment

| Item | Resolved by |
|---|---|
| Kuru: turnaround for creating mainnet books, soft-pausing books at close, legacy vs new exchange contracts | Kuru team |
| Chainlink feeds on Monad testnet | Found: BTC/USD and ETH/USD (in `deployments/monad-testnet.json`). They update about once a day, so testnet price markets often fail the one-hour staleness rule and void; testnet demos use Perpl funding markets, and price markets are tested on a mainnet fork |
| Pyth Hermes API access for historical updates (only needed for assets with no Chainlink feed, such as SOL) | API key, then a fork test with a real update |
| How often Perpl upgrades its Exchange (affects how often the upgrade rule voids markets) | watch the implementation slot during the beta |

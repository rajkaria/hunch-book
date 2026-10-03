# Hunch Book protocol specification

Version 0.1 (2026-10-03). Status: design. Nothing here is deployed yet; [ROADMAP.md](./ROADMAP.md) tracks what ships when.

## 1. Summary

Hunch Book runs yes/no prediction markets on Monad in USDC. Every market goes through up to three stages:

1. **Pool.** People stake USDC on YES or NO. The split of the pool is the market's chance. No market maker is needed, so a market works from its first dollar.
2. **Book.** If the pool proves demand before it locks, it **graduates**. In one transaction the pool's USDC becomes fully backed YES and NO tokens, split between the stakers so that each staker's payout is exactly what the pool would have paid, fees included. The YES token opens as a YES/USDC spot market on Kuru, Monad's onchain order book, at the pool's price. From then on anyone can buy or sell either side at any time.
3. **Settlement.** When the observation window ends, anyone can settle the market. A resolver contract reads the answer from onchain data: Perpl's historical funding accumulator, or a Pyth price signed by Pyth's publishers. No person, including the Hunch team, can set an outcome.

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
| Settlement deadline | Close + 7 days. If the resolver cannot produce an answer by then, the market voids. |

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
| SETTLED | redeem winning tokens, claim pool payout, merge | everything else |
| VOIDED | refund pool stakes, redeem tokens at 0.50 each | everything else |

Notes:
- Touch markets (§6.3) can settle YES before close, as soon as anyone proves the event happened.
- Kuru's book is not ours to halt. After close, Hunch's router refuses trades and Hunch's maker cancels all its orders, but orders other people left on the book can still fill. The app warns makers about this.

## 5. Economics

All amounts are in USDC base units (6 decimals). Outcome tokens use 6 decimals, so 1 token redeems for at most 1 USDC.

### 5.1 Collateral

The `CollateralVault` holds every USDC in the protocol and keeps per-market books:

- `poolCollateral[m]`: USDC staked in market `m` while it is a pool
- `sets[m]`: complete sets outstanding (= YES supply = NO supply until settlement)
- `fees[m]`: fees owed but not yet withdrawn (protocol and creator)

Solvency invariant, checked by tests after every action and by the vault after every flash loan:

```
USDC.balanceOf(vault) ≥ Σ_m ( poolCollateral[m] + sets[m] + fees[m] )      (before settlement)
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
| Kuru book can be created | the Graduator is authorised by Kuru on this network (§8.1) |

The rule values are copied from the template into each market at creation and never change for that market.

**What happens, in one transaction:**

1. The market moves `T` USDC from `poolCollateral` to `sets`, and the vault mints `T` YES and `T` NO.
2. Each YES staker `i` can claim `a_i = ⌊T · s_i / Y⌋` YES tokens. Each NO staker `j` can claim `b_j = ⌊T · s_j / N⌋` NO tokens. Claims are pulled (`claimTokens`) or pushed by anyone in batches (`claimTokensFor`); the keeper pushes them right after graduation. Rounding dust (`T − Σ a_i`, `T − Σ b_j`, at most one base unit per staker) goes to the fee account.
3. The redemption fee per winning token is fixed for the life of the market:

```
f_YES = φ · N / T          f_NO = φ · Y / T          (at most 0.02 × 0.97 = 0.0194 USDC per token)
```

4. The Graduator creates the YES/USDC market on Kuru. The opening reference price is `p = Y / T`.

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

### 6.1 Template S-1: Perpl funding threshold

**Question shape:** "Will funding paid by longs on Perpl's {asset} market between block {A} and block {B} be above {X}?"

- Source: the Perpl Exchange contract on Monad (`0x34B6552d57a35a1D042CcAe1951BD1C370112a6F` on mainnet), function `getFundingSumAtBlock(marketId, block)`, which returns the cumulative funding at a past block. Exact units, sign convention and retention are recorded in §8.2.
- Rule: `ΔF = F(B) − F(A)`. YES if `ΔF > X`; NO otherwise (equal is NO).
- Timing: these markets are defined in **blocks**, so the rule is exact. The app shows an estimated clock time next to each block. Lock is at block `A`; close is at block `B`.
- Settlement: callable by anyone once `block.number > B`. Because the read is historical, settling late reads the same value.

### 6.2 Template S-2: Pyth price threshold

**Question shape:** "Will {asset}/USD be at or above {K} at {T} UTC?"

- Source: Pyth's onchain contract on Monad. The settler submits a signed price update; the resolver accepts only the **first** update published at or after `T`, within a tolerance of 60 seconds (Pyth's "unique" parse), so nobody can choose a convenient update.
- Rule: YES if the price is at or above `K` (exponent-normalised); NO otherwise.
- Timing: lock is a set time before `T` (v0: 24 hours for daily markets, 1 hour for intraday); close is `T`.
- Settlement: anyone, once `now ≥ T`, by submitting the update fetched from Pyth's public service, plus Pyth's update fee.

### 6.3 Touch markets (S-3, proof by pointer)

**Question shapes:** "Will {asset} funding on Perpl be negative over any 1-hour stretch before block {B}?" and "Will {asset}/USD trade at or above {K} at any time before {T}?"

- **YES is proved by pointing at the moment it happened.** For Perpl: a block `b` in the window where `F(b) − F(b − h) < 0`. For Pyth: any signed update in the window with price at or above `K`. The resolver checks the pointer onchain and settles YES immediately.
- **NO** settles after the window closes plus a 24-hour challenge period during which nobody submitted a valid YES proof. Hunch's keeper watches every touch market and submits proofs, and so can anyone else. The assumption is that at least one honest party submits a proof if one exists.

### 6.4 What makes a template acceptable

A template ships only if:

1. Its source is an onchain contract whose value at the settlement point **stays readable after the fact** (historical getter or signed data), so late settlement reads the same answer.
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
| `Graduator` | no | no | the only address Kuru needs to authorise |
| `HunchRouter` | no | never between transactions | approvals set per call and reset |
| Resolvers | no | no | pure readers of their source |

### 7.2 Interfaces (v0, frozen before parallel build starts)

```solidity
enum Phase   { Pool, PoolLocked, Graduated, Closed, Settled, Voided }
enum Side    { Yes, No }
enum Outcome { Unresolved, Yes, No }

struct Window {
    bool    blockClock;      // true: lock/close are block numbers; false: unix seconds
    uint64  lock;            // staking and graduation stop
    uint64  close;           // observation ends, settlement opens
    uint64  settleDeadline;  // void allowed after this (unix seconds)
}

struct GraduationRule {
    uint128 minPool;         // USDC base units
    uint32  minStakers;
    uint16  minChanceBps;    // 300 = 3%
    uint16  maxChanceBps;    // 9700 = 97%
}

interface IResolver {
    /// Reverts if params are invalid. Returns the market's window.
    function validate(bytes calldata params) external view returns (Window memory);
    /// One plain-English sentence describing the exact rule.
    function describe(bytes calldata params) external view returns (string memory);
    /// Unresolved if the answer cannot be determined yet. Never returns a guess.
    function resolve(bytes calldata params, bytes calldata evidence)
        external payable returns (Outcome outcome, bytes32 evidenceHash);
    /// True for touch templates that can settle YES before close.
    function earlyYes() external view returns (bool);
}

interface IHunchBookFactory {
    event MarketCreated(address indexed market, uint32 indexed templateId, bytes32 indexed key,
                        address creator, bytes params);
    function createMarket(uint32 templateId, bytes calldata params, Side firstSide, uint256 firstStake)
        external returns (address market);
    function marketOf(bytes32 key) external view returns (address);   // key = keccak256(templateId, params)
    function resolverOf(uint32 templateId) external view returns (IResolver);
}

interface IMarket {
    event Staked(address indexed user, Side side, uint256 amount, uint256 yesTotal, uint256 noTotal);
    event Graduated(uint256 total, uint256 yesTotal, uint256 noTotal, uint256 openingPriceE6, address book);
    event TokensClaimed(address indexed user, Side side, uint256 amount);
    event Settled(Outcome outcome, bytes32 evidenceHash, address settler);
    event Voided();
    event PoolClaimed(address indexed user, uint256 paid, uint256 fee);

    function stake(Side side, uint256 amount) external;
    function stakeFor(address user, Side side, uint256 amount) external;
    function graduate() external;
    function claimTokens() external;
    function claimTokensFor(address[] calldata users) external;
    function settle(bytes calldata evidence) external payable;
    function proveYes(bytes calldata proof) external payable;      // touch templates only
    function voidIfExpired() external;
    function claimPool() external;                                   // pool-only payout or refund

    function phase() external view returns (Phase);
    function poolTotals() external view returns (uint256 yesTotal, uint256 noTotal, uint32 stakers);
    function outcome() external view returns (Outcome);
    function tokens() external view returns (address yes, address no);
    function book() external view returns (address);
    function feePerToken(Side side) external view returns (uint256);
    function window() external view returns (Window memory);
}

interface ICollateralVault {
    function mintSets(address market, uint256 amount, address to) external;
    function mergeSets(address market, uint256 amount, address to) external;
    function redeem(address market, uint256 amount, address to) external returns (uint256 paid);
    function flashLoan(address receiver, uint256 amount, bytes calldata data) external;
    function surplus() external view returns (int256);   // balance minus obligations; must be ≥ 0
}

interface IGraduator {
    function createBook(address market) external returns (address book);
    function bookOf(address market) external view returns (address);
}

interface IHunchRouter {
    function buyYes (address market, uint256 usdcIn, uint256 minYesOut, uint256 deadline) external returns (uint256);
    function sellYes(address market, uint256 yesIn,  uint256 minUsdcOut, uint256 deadline) external returns (uint256);
    function buyNo  (address market, uint256 noOut,  uint256 maxUsdcIn, uint256 deadline) external returns (uint256);
    function sellNo (address market, uint256 noIn,   uint256 minUsdcOut, uint256 deadline) external returns (uint256);
}
```

### 7.3 Access control

| Role | Can | Cannot |
|---|---|---|
| Anyone | create markets, stake, graduate, claim for others, settle, prove YES, void after deadline, mint, merge, redeem | set outcomes, move others' funds |
| Guardian (a multisig, not a hot key) | pause new market creation; pause graduation; add a template (new templateId → resolver); set caps for markets created afterwards | pause settlement, redemption, merges or refunds; change an existing market; set outcomes; move funds |
| Fee recipient | withdraw the protocol's share of fees | anything else |
| Creator | withdraw their 25% fee share | anything else |

## 8. Integrations

### 8.1 Kuru

- **Market creation.** The Graduator calls Kuru's Router `deployProxy` to create a spot market with base = the YES token and quote = USDC. On Monad testnet market creation is open to anyone. On mainnet it is restricted to Kuru's owner (verified: calls from other addresses revert with `Unauthorized()`), so mainnet graduation needs Kuru to authorise the Graduator, or to create each market on request. Until then, mainnet markets run as pools only.
- **Market parameters** for a token that always trades between 0.01 and 0.99 USDC: see §12; exact values are confirmed against Kuru's contracts before deployment.
- **Trading.** The router places market orders on the Kuru book within one transaction. The maker bot places and cancels limit orders directly.

### 8.2 Perpl

- `getFundingSumAtBlock(marketId, block)` on the Exchange contract is read at the window's start and end blocks. Units, sign and history depth are confirmed by fork tests before the template ships; a read that reverts makes the resolver return `Unresolved`, never a guess.

### 8.3 Pyth

- Price feeds: MON/USD, BTC/USD, ETH/USD, SOL/USD (feed ids recorded in `deployments/<network>.json`).
- Evidence: signed updates fetched from Pyth's public Hermes service for the exact publish time; the resolver pays Pyth's update fee from the value sent by the settler.

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
  - Price threshold: probability that a lognormal price ends above the strike, using recent realised volatility from Pyth history.
- Quotes `p ± spread/2`, skewed by inventory, clamped to [0.01, 0.99], with a minimum spread of 2 cents and per-market inventory caps. It widens near close and cancels everything at close.
- It mints and merges complete sets to manage inventory.
- Its address is published, and every fill against it is counted separately on the proof page.

### 9.3 Indexer (Envio HyperIndex)

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
| Choosing a convenient Pyth price | Only the first update at or after `T` is accepted |
| Moving Perpl funding to win | Per-market caps keep markets small next to the cost of moving funding; disclosed per market |
| Resting orders filled after the answer is known | Router and maker stop at close; app warns makers; settlement can be triggered immediately |
| Withholding touch proofs | Anyone can prove; the keeper watches every touch market; 24-hour challenge before NO |
| Guardian key compromise | Can only pause creation and graduation |
| USDC issuer freezes the vault | Out of our control; disclosed |
| Kuru outage | Book trading stops; mint, merge, settle and redeem do not depend on Kuru |

### 10.3 Beta limits (v0)

| Limit | Value |
|---|---|
| Max pool per market | 5,000 USDC |
| Max stake per wallet per market | 1,000 USDC |
| Max total USDC in the vault | 50,000 USDC |
| Market creation | open; creator's first stake ≥ 5 USDC |

Limits apply to markets created after a change; existing markets keep the limits they started with.

## 11. Known limitations

- Mainnet graduation depends on Kuru authorising the Graduator.
- After graduation, a void pays 0.50 per token, which is not a refund for someone who bought at another price.
- Thin books are likely at first. Until outside makers join, a large share of book fills will be against Hunch's labelled maker; the proof page shows that share.
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
| Pyth tolerance | 60 seconds after `T` |
| Kuru book | tick 0.001 USDC; prices 0.01 to 0.99 (to confirm against Kuru's precision rules) |

## 13. Open items before deployment

| Item | Resolved by |
|---|---|
| Kuru `deployProxy` parameters and the router's market-order calls | fork tests on Kuru testnet |
| Perpl funding units, sign convention and history depth | mainnet fork tests |
| Pyth contract address and feed ids on Monad testnet and mainnet | onchain checks |
| Hermes history depth for touch proofs | test fetch of old updates |

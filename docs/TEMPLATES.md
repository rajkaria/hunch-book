# Hunch Book templates

A template is a family of questions: one resolver contract plus one parameter struct. A market is one
question made from a template with fixed parameters. This page describes every template in full: the
question it asks, the parameters, the onchain source it reads, the exact rule, the timing, the
evidence a settler passes, when the resolver refuses to answer, and who you have to trust.

The protocol design is in [PROTOCOL.md](./PROTOCOL.md) (§6 covers settlement). The code is the source
of truth; every section links to it.

## At a glance

| Id | Template | Resolver | Clock | Early YES | Evidence | Status |
|---|---|---|---|---|---|---|
| 1 | Perpl net funding | [`PerplFundingResolver`](../contracts/src/resolvers/PerplFundingResolver.sol) | blocks | no | empty | live on testnet ([address](https://testnet.monadscan.com/address/0x4ec0077e30EA8B626C5AA087C586E60542150951)) |
| 2 | Price at a time | [`PriceAtTimeResolver`](../contracts/src/resolvers/PriceAtTimeResolver.sol) | unix time | no | Chainlink round id, or Pyth update | live on testnet ([address](https://testnet.monadscan.com/address/0x5582e5Aeb12e15EAda88402E2903Bc628Cc28B3C)) |
| 3 | Price touch | [`ChainlinkTouchResolver`](../contracts/src/resolvers/ChainlinkTouchResolver.sol) | unix time | yes | Chainlink round id (YES), empty (NO) | live on testnet ([address](https://testnet.monadscan.com/address/0x34Ac3F430c8F49735987Efe88634Ef8d9c295727)) |
| 4 | Perpl funding spike | [`PerplFundingSpikeResolver`](../contracts/src/resolvers/PerplFundingSpikeResolver.sol) | blocks | yes | funding event block (YES), empty (NO) | live on testnet ([address](https://testnet.monadscan.com/address/0x3459d8026DD8E7B0f3BE2B1aF21050013b9bCA64)) |
| 5 | Price range | [`PriceRangeResolver`](../contracts/src/resolvers/PriceRangeResolver.sol) | unix time | no | Chainlink round id, or Pyth update | live on testnet ([address](https://testnet.monadscan.com/address/0xBA86Bcf0915c7E79C7D8a7e170CA76F1d82f8694)) |
| 6 | Parlay | [`MarketOutcomeResolver`](../contracts/src/resolvers/MarketOutcomeResolver.sol) | unix time | no | empty | live on testnet ([address](https://testnet.monadscan.com/address/0x1a57bafE8161763c51248af40567FCFf266F9168)) |
| 7 | Snapshot | [`SnapshotResolver`](../contracts/src/resolvers/SnapshotResolver.sol) | unix time | no | empty | building |

Every resolver address is in [`deployments/<network>.json`](../deployments) under `hunchBook.resolvers`.
Templates 3 to 6 are deployed and registered with
[`DeployTemplatesV2.s.sol`](../contracts/script/DeployTemplatesV2.s.sol). On Monad testnet that ran on
2026-10-04 (transactions under `hunchBook.deployTxs`); on a network where it has not run yet, they are
not available there. Template 7 is deployed and registered with
[`DeploySnapshotTemplate.s.sol`](../contracts/script/DeploySnapshotTemplate.s.sol); until that has run
on a network, it is not available there.

The parameter structs are in [`ITemplates.sol`](../contracts/src/interfaces/ITemplates.sol) (templates
1 and 2), [`ITemplatesV2.sol`](../contracts/src/interfaces/ITemplatesV2.sol) (templates 3 to 6) and
[`ITemplatesV3.sol`](../contracts/src/interfaces/ITemplatesV3.sol) (template 7). TypeScript encodes and
decodes them with the same ABI, in [`packages/shared/src/templates.ts`](../packages/shared/src/templates.ts).

## How every template settles

These rules come from the market contract ([`Market.sol`](../contracts/src/core/Market.sol)) and are the
same for every template.

- **No one sets an outcome.** A market's outcome comes only from its resolver reading its source.
  Resolvers have no owner, no admin function and no storage that changes after deployment. Their
  allowlists (which feeds, which Perpl exchange, which factory) are fixed in the constructor; a new feed
  ships as a new resolver under a new template id. The one exception to "no storage" is template 7,
  which keeps the snapshots it takes: written once, and only with a value it has just read itself from
  one of its fixed sources.
- **Each market has a window**, returned by the resolver's `validate` when the market is created:
  - **lock**: staking stops. A pool that has not graduated by then stays a pool.
  - **close**: `settle` opens.
  - **settlement deadline** (unix time): `settle` and `proveYes` work up to it; after it, anyone can
    call `voidIfExpired`. A voided pool refunds every stake; a voided graduated market redeems every
    YES and NO token at 0.50 USDC.
  - Perpl templates count lock and close in blocks; their deadline is an estimate in unix time that
    assumes a slow chain (1,000 ms per block, about three times Monad's real block time), so it never
    arrives early.
- **`settle(evidence)`**: anyone, from close to the deadline. The resolver either answers YES or NO, or
  says it cannot answer yet (`Unresolved`, and the call reverts), or reverts because the evidence is
  malformed or points at the wrong data.
- **`proveYes(proof)`**: touch templates only (3 and 4), anyone, once the market is past its pool phase
  (locked, or graduated) and up to the deadline. The market accepts only a YES. This is how a touch
  market settles before close.
- **Never a guess.** When a resolver cannot vouch for an answer (a read failed, the source changed, the
  data is not final), it returns `Unresolved`. If that lasts until the deadline, the market voids.
- **Evidence hash.** Every answer comes with `evidenceHash`, a hash of exactly what the resolver read.
  The market stores it, so anyone can re-run the read and check it.
- **One market per question.** The factory keys markets by `keccak256(abi.encode(templateId, params))`.
  Every resolver rejects parameters that are not in their one canonical encoding, so the same question
  cannot be created twice with different bytes.

## Template 1: Perpl net funding

**Question.** "Will BTC longs pay more than $X per BTC in funding on Perpl (perp P) between block A and
block B?", or with X = 0, "Will BTC longs pay shorts on net ...?"

**Parameters** (`PerplFundingParams`):

| Field | Meaning |
|---|---|
| `perpId` | Perpl's id for the perpetual (mainnet BTC 1, MON 10, ETH 20, SOL 31; testnet BTC 16, ETH 32, SOL 48, MON 64) |
| `startBlock` | A: the lock, and the first point read |
| `endBlock` | B: the close, and the second point read |
| `threshold` | X, in Perpl's raw funding-sum units. Dividing by 10^(priceDecimals + fundingSumScalingExp) gives USD per unit of the asset |
| `expectedScalingExp` | Perpl's `fundingSumScalingExp` for this perp at creation |

**Source.** Perpl's Exchange (mainnet `0x34B6552d57a35a1D042CcAe1951BD1C370112a6F`, testnet
`0x1964C32f0bE608E7D29302AFF5E61268E72080cc`), function
`getFundingSumAtBlock(perpId, blockNumber) returns (int48 fundingSum, uint256 fundingEventBlock)`: the
cumulative funding sum as of the last funding event at or before that block. A rising sum means longs
paid shorts. Perpl keeps this history in contract storage, so old blocks stay readable.

**Rule.** ΔF = F(B) − F(A). YES if ΔF > X. NO otherwise; equal is NO.

**Timing.** Lock A (in the future at creation), close B. B − A must be at least one funding interval
(8,571 blocks). Settlement needs `block.number > B`: Perpl can rewrite a scheduled funding value until
its event block passes, so only then is every event at or before B final. Deadline: the estimated time
of B plus 7 days.

**Evidence.** Empty. The resolver reads Perpl itself.

**Creation checks.** Perpl's version equals the one pinned when the resolver was deployed; A is in the
future; the perp is listed, not paused, has the expected scaling exponent, and its funding started at
or before A.

**When it refuses to answer** (`Unresolved`, so the market voids at its deadline if this lasts):

- `block.number <= B`;
- Perpl's `getContractVersion()` differs from the pinned version, or the read fails;
- the perp's info cannot be read (removed), its scaling exponent changed, or its funding start block
  moved after A (the id was listed again);
- the funding interval cannot be read or is zero;
- either funding read fails, or reports an event block after the block asked for;
- the last event at or before B is more than two intervals older than B (the perp was paused).

**Who you trust.** Perpl. Its funding rates are set by its own price administrator within a per-market
clamp and a tolerance against Chainlink prices, and its contracts can be upgraded by a 3-of-7 multisig.
A market pays out on what Perpl records. The resolver pins Perpl's version number at deployment and
refuses to answer if it changes; an upgrade that keeps the same version number cannot be seen onchain,
so the keeper watches Perpl's implementation slot offchain and reports it.

**Evidence hash.** `keccak256(abi.encode(address exchange, uint256 perpId, uint64 A, uint64 B, int48 F(A),
int48 F(B), uint256 eventBlock(A), uint256 eventBlock(B)))`.

## Template 2: price at a time

**Question.** "Will BTC/USD be at or above $85,000 at 2026-10-04 12:00:00 UTC, per Chainlink's BTC/USD
feed?"

**Parameters** (`PriceAtTimeParams`):

| Field | Meaning |
|---|---|
| `source` | 0 = Chainlink, 1 = Pyth (only for assets with no Chainlink feed on the network) |
| `feed` | Chainlink proxy (source 0), on the resolver's allowlist; zero for Pyth |
| `pythId` | Pyth price id (source 1), on the resolver's allowlist; zero for Chainlink |
| `strikeE8` | K, in USD with 8 decimals, above zero |
| `lockTime` | unix seconds, in the future at creation |
| `closeTime` | T, the observation time, at or after the lock |

**Source.**

- Chainlink: the proxy's `getRoundData(roundId)`, and `phaseAggregators(phaseId).decimals()` for the
  decimals of the aggregator that wrote that round. Round ids are `(phaseId << 64) | roundInPhase`.
- Pyth: `parsePriceFeedUpdatesUnique(updateData, [id], T, T + 60)`, which verifies the signed update and
  returns only the first update published at or after T.

**Rule.** YES if the price at T is at or above K, NO otherwise.

- Chainlink: the settler names round r. It is accepted only if r and r + 1 are in the same phase,
  `updatedAt(r) <= T < updatedAt(r + 1)`, `T − updatedAt(r) <= 1 hour`, and the answer is positive.
  Within a phase `updatedAt` never decreases, so at most one round brackets T: nobody can pick a
  convenient price.
- Pyth: the first update published in [T, T + 60 seconds]. The settler pays Pyth's update fee in
  `msg.value`; anything left is refunded.
- The price is converted to 8 decimals by truncating. For a positive price and a whole-number strike
  that cannot flip the rule: the truncated price is at or above K exactly when the real price is.

**Timing.** Lock and close as given; settlement after T; deadline T + 7 days.

**Evidence.** Chainlink: `abi.encode(uint80 roundId)`. Pyth: `abi.encode(bytes[] updateData)`.

**When it refuses to answer.** Before T, and while round r + 1 does not exist yet (or cannot be read).
Everything else that is wrong with the evidence reverts: a round that does not bracket T, a round more
than an hour old at T, a missing round, the last round of a phase, a non-positive price, a Pyth update
outside [T, T + 60 seconds], or too small a fee. If the feed stops and no bracketing round ever appears,
the market voids at its deadline.

**Who you trust.** Chainlink's oracle network for the feed's answers, and the feed owner, who can point
the proxy at a new aggregator (rounds from earlier phases stay readable and keep their own decimals).
For Pyth: Pyth's publishers and the guardian set that signs its updates. Monad testnet's Chainlink
feeds update about once a day, so testnet price markets often fail the one-hour rule and void.

**Evidence hash.**

- Chainlink: `keccak256(abi.encode(uint8 0, address feed, uint80 r, int256 answer, uint256 updatedAt(r),
  uint256 updatedAt(r + 1), uint256 T))`.
- Pyth: `keccak256(abi.encode(uint8 1, address pyth, bytes32 id, (int64 price, uint64 conf, int32 expo,
  uint256 publishTime), uint64 T))`.

## Template 3: price touch

**Question.** "YES if Chainlink's BTC/USD feed reports a price at or above $70,000 in any round updated
from 2026-10-06 12:00:00 UTC to 2026-10-13 12:00:00 UTC; NO if nobody proves that by 2026-10-14
12:00:00 UTC, the end of a 24-hour challenge period." The other direction asks "at or below".

**Parameters** (`ChainlinkTouchParams`):

| Field | Meaning |
|---|---|
| `feed` | Chainlink proxy, on the resolver's allowlist |
| `strikeE8` | K, in USD with 8 decimals, above zero |
| `direction` | 0 = reaches at or above K; 1 = falls to at or below K |
| `lockTime` | unix seconds, in the future at creation, at or before `startTime` |
| `startTime` | T1, the first moment a round counts |
| `endTime` | T2, the last moment a round counts; the close. At most 31 days after T1 |

**Source.** The proxy's `getRoundData(roundId)` for a proof, `phaseAggregators(phaseId).decimals()` for
its decimals, and `latestRoundData()` for the NO path.

**Rule.**

- **YES is proved by pointing at the round where it happened.** Round r is accepted only if the proxy
  returns it (and echoes its id), `answeredInRound == r` (an answer carried over from an older round is
  not a new observation), `T1 <= updatedAt(r) <= T2` (both ends count), the answer is positive, and it
  touches K: at or above K for direction 0, at or below K for direction 1. **Equal to K counts in both
  directions.** Rounding is chosen per direction so it can never flip the rule: the price is truncated
  for "at or above" and rounded up for "at or below".
- A pointer that does not prove a touch **reverts**. A bad proof can never settle anything, YES or NO.
- **NO needs no proof.** Empty evidence settles NO once `block.timestamp >= T2 + 24 hours`, provided the
  feed reported at least one round at or after T2 (its latest round's `updatedAt >= T2`). That last
  condition stops a feed that went dark from settling markets NO by silence.

**Timing.** Lock at `lockTime`, close at T2. YES can settle as soon as the touch happens, through
`proveYes` (or through `settle` after close). The challenge period runs for 24 hours after T2; NO can
settle from its end. Deadline: T2 + 24 hours + 7 days.

**Evidence.** YES: `abi.encode(uint80 roundId)`. NO: empty.

**When it refuses to answer.** Empty evidence before T2 + 24 hours; empty evidence when the feed's latest
round is older than T2, or `latestRoundData()` reverts. A proof never returns `Unresolved`: it proves
YES or reverts.

**Who you trust.** Chainlink, as in template 2, and **one honest prover**: if a touching round exists,
at least one party submits it within the challenge period. Hunch's keeper watches every touch market
and submits proofs; so can anyone, from the same public data. The question is about the rounds
Chainlink writes, not about every trade on every exchange: a feed reports when the price moves past its
deviation threshold or its heartbeat passes, so a brief move that never makes it into a round is not a
touch.

**Evidence hash.**

- YES: `keccak256(abi.encode(address feed, uint80 roundId, uint256 updatedAt, int256 answer))`.
- NO: `keccak256(abi.encode(address feed, uint64 T2, uint256 T2 + 24 hours, uint80 latestRoundId,
  uint256 latestUpdatedAt))`, where the latest round is the one that shows the feed was alive.

## Template 4: Perpl funding spike

**Question.** "YES if any single funding event on Perpl (BTC Perp, perp 1) after block A and at or
before block B charges BTC longs more than $3 per BTC; NO if nobody proves one by block B + C, about 24
hours after the window."

**Parameters** (`PerplFundingSpikeParams`, the same fields as template 1):

| Field | Meaning |
|---|---|
| `perpId` | Perpl's id for the perpetual |
| `startBlock` | A: the lock. A counted event is strictly after A |
| `endBlock` | B: the close, and the last block a counted event can sit on |
| `threshold` | X, in raw funding-sum units for one event |
| `expectedScalingExp` | Perpl's `fundingSumScalingExp` for this perp at creation |

**Source.** Perpl's Exchange, `getFundingSumAtBlock(perpId, blockNumber)`, as in template 1.

**Rule.**

- **YES is proved by pointing at the event.** Event block e is accepted only if A < e <= B, e is
  final (`e < block.number`), Perpl reports e itself as the last event at or before e, and the last
  event strictly before e (read at e − 1) is exactly one funding interval earlier, at e − 8,571. Then
  F(e) − F(e − 8,571) is the increment of that single event. YES if the increment is **strictly above**
  X; equal is not a spike.
- A pointer that fails any of these checks **reverts**.
- **NO needs no proof.** Empty evidence settles NO once `block.number > B + C`, where C is the
  resolver's `challengeBlocks`, provided the source is intact (as below) and funding was live at the end
  of the window: the last event at or before B is at most two intervals older than B.
- C is fixed when the resolver is deployed, as the number of blocks in 24 hours at the block time
  measured then. The deploy script uses 288,000 blocks (24 hours at 300 ms). Monad measured about 302
  ms per block on both networks in October 2026, so the period is slightly longer than 24 hours. If
  blocks later get much faster, the period gets shorter in wall time, and a new resolver is needed.
- Checking the read at e − 1, not only the read at e − 8,571, also rules out an off-grid event between
  the two, so a proved increment always belongs to exactly one event.

**Timing.** Block clock. Lock A (in the future at creation), close B. B − A must be at least one
funding interval and at most 31 days of blocks (31 × C). YES can settle as soon as the event block is
final, through `proveYes`. NO can settle once block B + C has passed. Deadline: the estimated time of
block B + C (at 1,000 ms per block) plus 7 days.

**Evidence.** YES: `abi.encode(uint64 eventBlock)`. NO: empty.

**Creation checks.** The same as template 1, plus the 31-day limit.

**When it refuses to answer.** For a proof and for NO alike: Perpl's version changed (or cannot be
read), the perp's info cannot be read, its scaling exponent changed, its funding start block moved
after A, or the interval is unreadable or zero. For NO also: before block B + C, a failed read of F(B),
or a perp paused at the end of the window.

**Who you trust.** Perpl, as in template 1, and one honest prover, as in template 3. In the mainnet
windows our fork tests read in October 2026, a single BTC funding event moved the sum by at most 33 or
34 raw units ($3.30 to $3.40 per BTC), and many events sat at exactly plus or minus 33, which looks like
Perpl's per-market funding clamp. A threshold at or above that level can almost never be YES, so such a
market is not genuinely uncertain and should not be listed (PROTOCOL.md §6.3).

**Evidence hash.**

- YES: `keccak256(abi.encode(address exchange, uint256 perpId, uint64 e, int48 F(e),
  uint256 previousEventBlock, int48 F(previousEvent)))`.
- NO: `keccak256(abi.encode(address exchange, uint256 perpId, uint64 B, uint256 B + C,
  uint256 lastEventBlock, int48 F(lastEvent)))`.

## Template 5: price range

**Question.** "YES if Chainlink's BTC/USD feed puts BTC/USD at or above $80,000 and below $85,000 at
2026-10-04 12:00:00 UTC (unix time 1791115200); NO otherwise."

**Parameters** (`PriceRangeParams`): as template 2, with two bounds instead of a strike:

| Field | Meaning |
|---|---|
| `source`, `feed`, `pythId` | as template 2 |
| `lowerE8` | K1, in USD with 8 decimals, above zero; inclusive |
| `upperE8` | K2, above K1; exclusive |
| `lockTime`, `closeTime` | as template 2 |

**Source and reading.** Exactly template 2's: the same Chainlink bracketing round rule, the same Pyth
rule. The two templates share the code that reads the price at T
([`PriceAtTimeReader`](../contracts/src/resolvers/PriceAtTimeReader.sol)).

**Rule.** YES if K1 <= price at T < K2; NO otherwise. Because the lower bound is inclusive and the upper
bound exclusive, a set of ranges that share bounds (for example $80,000 to $85,000 and $85,000 to
$90,000) never has two YES answers. Truncating to 8 decimals is exact for both bounds.

**Timing, evidence, refusals, trust.** As template 2. The evidence hash has template 2's format, so a
range market and a price market settled from the same round commit to the same hash.

## Template 6: parlay

**Question.** "YES if all 3 of these Hunch Book markets settle YES: #12 (0x...), #15 (0x...), #20
(0x...); NO if any of them settles NO; if one voids while none has settled NO, this market voids at its
deadline."

**Parameters** (`ParlayParams`):

| Field | Meaning |
|---|---|
| `legs` | 2 to 5 markets of the resolver's factory, in strictly increasing address order |
| `lockTime` | unix seconds, in the future at creation, at or before every leg's lock |
| `closeTime` | unix seconds, at or after the lock: settlement opens |

**Source.** Each leg's `IMarket.outcome()` and `evidenceHash()`. A leg's outcome comes only from its own
resolver reading its own source, so the parlay inherits that guarantee.

**Rule.**

- NO as soon as any leg has settled NO, even while other legs are open.
- YES once every leg has settled YES.
- Otherwise `Unresolved`. A leg that voids while no leg has settled NO leaves the parlay without an
  answer for good, so the parlay voids at its deadline.

**Creation checks.**

- 2 to 5 legs, strictly increasing addresses: no leg twice, and one encoding per set of legs. The order
  of legs carries no meaning; `encodeParlayParams` in the shared package sorts them.
- Every leg is a market of the factory the resolver was deployed with, and none has settled or voided.
- **The parlay locks at or before every leg locks**, so nobody can stake on the parlay after any leg's
  observation has started. For a leg on a time clock this is a direct comparison. For a leg on a block
  clock (templates 1 and 4) the leg's lock block is turned into the earliest time it could arrive: now
  plus the remaining blocks at the resolver's `fastBlockTimeMs` each (200 ms in the deploy script, two
  thirds of Monad's measured block time). Blocks would have to come faster than that for the estimate to
  be late.

**Timing.** Lock and close as given. Deadline: 7 days after the later of `closeTime` and the latest leg
deadline. A leg can settle right up to its own deadline, and the parlay still has a full 7 days after
that. There is no early YES: the parlay settles through `settle` after its close.

**Evidence.** Empty.

**When it refuses to answer.** While no leg is NO and at least one is not YES (open, or voided).

**Who you trust.** Whoever each leg trusts (Perpl, Chainlink, Pyth), and the factory, which decides what
counts as a market. Nothing else: the parlay resolver only reads outcomes that are already final.

**Evidence hash.** `keccak256(abi.encode(address[] legs, uint8[] outcomes, bytes32[] legEvidenceHashes))`,
each leg's outcome and evidence hash as read.

## Template 7: snapshot

**Question.** "YES if Perpl's BTC open interest (perp 1) is above 10 BTC in the first snapshot taken from
2026-10-10 12:00:00 UTC to 2026-10-10 12:10:00 UTC; NO otherwise. If nobody takes a snapshot in that
window, the market voids." Or, on the mark price: "... Perpl's BTC mark price (perp 1) is at or above
$85,000 ...".

**Why a snapshot.** Some values exist onchain only as current state. Perpl's open interest and mark
price are fields of `getPerpetualInfoV2(perpId)`, which answers for the current block only, and no
contract can read a past block's state. So the resolver reads the value once, right after close, and
keeps what it read. Templates 1 to 6 read sources that keep their own history; this one keeps the
history itself.

**Parameters** (`SnapshotParams`):

| Field | Meaning |
|---|---|
| `sourceId` | Which value: an index into the resolver's source list, fixed at its deployment |
| `threshold` | X, in the source's raw units; the value shown is raw / 10^decimals, in the source's unit |
| `comparator` | 0 = above, 1 = at or above, 2 = below, 3 = at or below |
| `lockTime` | Unix seconds, in the future at creation |
| `closeTime` | T, at or after the lock: the snapshot window opens |
| `snapshotWindow` | W, in seconds, from 60 to 1,800 (600 by default in the shared package): the window is [T, T + W] |

**Sources.** A source is a view call fixed when the resolver is deployed (`SnapshotSource`): the
contract and call data, the 32-byte word of the return data that holds the value (counted from the
head of the returned tuple when the return is a struct with strings), whether the value is signed, and
the checks that it still means what it meant then:

- **pinned words**: words of the same return that must read exactly as they did at deployment;
- **a guard call**: another call whose whole answer must not change;
- **a maximum age**: where the source stamps its value with a time, a value older than this is refused
  (a stamp ahead of the block counts as fresh).

The deploy script ([`DeploySnapshotTemplate.s.sol`](../contracts/script/DeploySnapshotTemplate.s.sol))
lists two sources per Perpl perp, in the order BTC, ETH, SOL, MON: open interest (id 2i) and mark price
(id 2i + 1). Each calls `getPerpetualInfoV2(perpId)` on Perpl's Exchange.

| Source | Word | Unit | Max age |
|---|---|---|---|
| Open interest | 17, `longOpenInterestLNS` | the asset (BTC, ETH, SOL, MON), lot decimals | none (it has no timestamp) |
| Mark price | 11, `markPNS` | USD, price decimals | 120 seconds, from word 12, `markTimestamp` |

Both pin words 2 and 3 (the price and lot decimals: the units), 19 (the funding start block: it moves
if the id is removed and listed again) and 22 (the status: a paused perp's values stop moving), and
guard on `getContractVersion()`, Perpl's implementation version. Perpl reports long and short open
interest separately; every lot has a long and a short side, so they are equal, and the source reads the
long side. The fork tests check that equality on every perp on both networks. The mark's 120 seconds is
twice Perpl's own `refPriceMaxAgeSec`; sampled across the previous day on both networks in October 2026,
the mark was never more than 50 seconds old.

| Network | Perps (lot decimals, price decimals) |
|---|---|
| Mainnet | BTC 1 (5, 1), ETH 20 (3, 2), SOL 31 (3, 3), MON 10 (0, 6) |
| Testnet | BTC 16 (5, 1), ETH 32 (3, 2), SOL 48 (3, 2), MON 64 (0, 5) |

**Rule.** With v the value in the first snapshot: YES if v > X (above), v >= X (at or above), v < X
(below) or v <= X (at or below); NO otherwise. Equal counts only for the "at or" comparators.

**Taking the snapshot.**

- Anyone can take it, once per observation (source, T, W), at any block whose timestamp is in [T, T + W],
  both ends included: by calling `snapshot(sourceId, closeTime, snapshotWindow)` on the resolver, or by
  calling the market's `settle()`, which takes it when nobody has yet. A keeper that calls `settle()` with
  empty evidence at the first block after T takes the snapshot and settles the market in one
  transaction. For Hunch's keeper to do this it needs a template 7 settler, which is planned.
- The resolver makes the call itself (STATICCALL) and copies out only the words it needs. It stores
  (value, block, timestamp) only if the call succeeded, every word it needs was returned, an unsigned
  value fits in int256, the pinned words and the guard's answer are those of deployment, and the value
  is not older than its maximum age. Otherwise nothing is stored: `snapshot` reverts with the reason,
  `settle` reverts with `NotResolved`, and anyone can try again later in the window.
- The first snapshot is final. A second call reverts with `SnapshotExists`, and nothing can change or
  delete a stored snapshot. Every market on the same observation answers from it, whatever its threshold,
  comparator or lock time, so a ladder of thresholds on one value can never disagree with itself.
- The value is the source's state at the snapshot transaction's place in its block: transactions before
  it in that block count, later ones do not.
- Once a snapshot exists, settlement no longer depends on the source. A later upgrade or outage at Perpl
  cannot change or block the answer.

**Timing.** Lock and close as given. The window is [T, T + W]. Deadline: T + W + 7 days.

**Evidence.** Empty.

**Creation checks.** The one canonical encoding, a known source, a known comparator, a window from 60
to 1,800 seconds, the lock in the future, the close at or after the lock, and a source that answers now
with the pinned words and guard answer of deployment and a fresh value. A source that no longer passes
(Perpl upgraded, the perp was paused or relisted) takes no new markets; a new resolver is needed.

**When it refuses to answer.** Before T. Inside the window, while the source cannot be read or a check
fails (a later call can still take the snapshot). After T + W with no snapshot: for good, and the market
voids at its deadline.

**Who you trust.**

- **The source.** For Perpl, as in template 1: its administrators and its 3-of-7 upgrade multisig. The
  guard and pinned words make the resolver refuse a snapshot after an upgrade that changes Perpl's
  version, a relisted id, changed units or a pause. An upgrade that keeps the version number cannot be
  seen onchain.
- **The choice of block.** Whoever takes the snapshot first picks the block, anywhere in the window.
  While a keeper settles at the first block after T, anyone else can only take the snapshot at that block
  or earlier, not wait for a better one. If no keeper does, the first taker can wait for a better
  block anywhere in the window. That is why the window is at most 30 minutes, and 10 minutes by default.
- **Moves in the source.** Anyone who can move the value can try to move it at the snapshot block. Open
  interest moves when positions open or close, so a trader could open a large position just before the
  snapshot and close it after; the mark moves with trading and Perpl's price feed. That costs Perpl's
  fees and carries price risk, and per-market caps keep what it could win small, but a threshold close to
  the current value, on a thin perp, is exposed to it. Such a market is not a fair question and should
  not be listed (PROTOCOL.md §6.4, rule 3).
- **No challenge period.** Nobody submits a value: the resolver reads it itself, so there is nothing to
  challenge. The only freedom is the choice of block, bounded above.

**Evidence hash.** `keccak256(abi.encode(address target, bytes callData, uint16 valueWord, int256 value,
uint64 blockNumber, uint64 timestamp))`: the call made, the word read, the value, and the block and time
of the snapshot transaction.

**Checking a settlement.** `snapshotFor(params)` returns the snapshot's key and (value, block, timestamp);
`source(sourceId)` returns the call. Re-run the call at that block and read the same word
(`snapshotValueFromReturnData` and `snapshotEvidenceHash` in
[`packages/shared/src/settlement.ts`](../packages/shared/src/settlement.ts) do this in TypeScript). A
call re-run at a block reads the state at the end of the block; if a later transaction in the same block
moved the value, the two differ, and the snapshot transaction's trace shows the exact read.

## Tests

Each resolver has unit tests with mock sources for every branch, fuzz tests on the comparison edges and
window rules, an end-to-end test through the real factory and markets
([`TemplatesV2Integration.t.sol`](../contracts/test/resolvers/TemplatesV2Integration.t.sol),
[`SnapshotIntegration.t.sol`](../contracts/test/resolvers/SnapshotIntegration.t.sol)), and fork
tests against real Monad data in [`contracts/test/fork/`](../contracts/test/fork). Template 7 also has an
invariant suite ([`SnapshotInvariants.t.sol`](../contracts/test/resolvers/SnapshotInvariants.t.sol)):
random time steps, source moves and breakages, snapshots and settlements by random callers, checking
that no snapshot is ever replaced, every snapshot sits inside its window, and every call does exactly
what the source and the clock say it should. The fork tests:

- touch: the highest and lowest real rounds of a 30-minute window on BTC, ETH, MON and SOL prove a touch
  at their own price, one unit further does not, rounds just outside the window do not, and empty
  evidence settles NO once the challenge period is over;
- funding spike: the largest real single-interval BTC event on mainnet and testnet proves a spike one
  unit below it but not at it;
- range: real bracketing rounds sit inside [price, price + 1) and outside [price − 1, price), and
  template 2 commits to the same evidence hash;
- parlay: a local Hunch Book on a mainnet fork three hours behind the head creates price, range and
  touch legs and two parlays, then rolls to the head and settles all of them from the rounds Chainlink
  wrote in between;
- snapshot: every source the deploy script builds reads what Perpl's typed getter returns, on every perp
  on both networks; on real values, a threshold equal to the value is YES for "at or" comparators and NO
  for the others, and one unit either side flips exactly the right ones; and a local Hunch Book on a fork
  about 30 minutes behind the head (mainnet and testnet) creates markets, rolls to a real block inside
  the window where `settle` takes the snapshot from Perpl's state at that block, then rolls to the head,
  where a market on the same observation settles from the stored value and one whose window nobody used
  cannot settle.

Run them with `FOUNDRY_PROFILE=fork forge test` in `contracts/`.

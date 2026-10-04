// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// Parameter schemas for templates 3 to 6 (docs/TEMPLATES.md). A market's `params` is `abi.encode`
/// of one of these. Templates 1 and 2 are in ITemplates.sol, which is frozen. The app, keeper,
/// maker and indexer decode with the same structs.

/// Template 3, touch (docs/PROTOCOL.md §6.3): "Will `feed` report a price at or above (direction 0)
/// or at or below (direction 1) `strikeE8` in any round updated between `startTime` and `endTime`?"
/// YES is proved early by pointing at that round. NO needs no proof: it settles once a 24-hour
/// challenge period after `endTime` has passed with no proof.
struct ChainlinkTouchParams {
    address feed; // Chainlink proxy; must be on the resolver's allowlist
    int256 strikeE8; // strike in USD with 8 decimals; equal counts as a touch in both directions
    uint8 direction; // 0 = reaches at or above the strike, 1 = falls to at or below it
    uint64 lockTime; // unix seconds: staking stops (at or before startTime)
    uint64 startTime; // unix seconds: first moment a round counts
    uint64 endTime; // unix seconds: last moment a round counts; the market closes here
}

/// Template 4, single-interval funding spike: "Will any single funding event on Perpl perp `perpId`
/// after block `startBlock` and at or before block `endBlock` charge longs more than `threshold`?"
/// YES if one event e has F(e) − F(e − interval) > threshold, in Perpl's raw funding-sum units.
/// Equal is not a spike. NO settles after a challenge period of about 24 hours with no proof.
struct PerplFundingSpikeParams {
    uint256 perpId;
    uint64 startBlock; // lock: staking stops here; a counted event is strictly after it
    uint64 endBlock; // close: the last block a counted event can sit on
    int256 threshold; // raw Perpl units for one funding event
    uint8 expectedScalingExp; // fundingSumScalingExp at creation; a change voids the market
}

/// Template 5, price range: "Will `asset`/USD be at or above `lowerE8` and below `upperE8` at
/// `closeTime`?" Read exactly like template 2: Chainlink by default, Pyth only for assets with no
/// Chainlink feed. The lower bound is inclusive and the upper bound exclusive.
struct PriceRangeParams {
    uint8 source; // 0 = Chainlink aggregator proxy, 1 = Pyth
    address feed; // Chainlink proxy (source 0); must be on the resolver's allowlist
    bytes32 pythId; // Pyth price id (source 1); must be on the resolver's allowlist
    int256 lowerE8; // inclusive lower bound in USD with 8 decimals
    int256 upperE8; // exclusive upper bound in USD with 8 decimals, above lowerE8
    uint64 lockTime; // unix seconds: staking stops
    uint64 closeTime; // unix seconds: T, the observation time
}

/// Template 6, parlay: "Will every one of these Hunch Book markets settle YES?"
/// NO as soon as any leg settles NO; YES once every leg settles YES. A leg that voids while no leg
/// is NO leaves the parlay without an answer, so it voids at its own deadline.
struct ParlayParams {
    address[] legs; // 2 to 5 markets of the resolver's factory, in strictly increasing address order
    uint64 lockTime; // unix seconds: staking stops; at or before every leg's lock
    uint64 closeTime; // unix seconds: settlement opens
}

/// Never deployed. Exists so the parameter structs appear in an ABI that TypeScript can encode with.
interface ITemplateParamsCodecV2 {
    function chainlinkTouch(ChainlinkTouchParams calldata params) external pure;
    function perplFundingSpike(PerplFundingSpikeParams calldata params) external pure;
    function priceRange(PriceRangeParams calldata params) external pure;
    function parlay(ParlayParams calldata params) external pure;
}

/// Evidence formats passed to `IResolver.resolve`, `IMarket.settle` and `IMarket.proveYes`.
/// Template 3: YES proof abi.encode(uint80 roundId), a round updated in [startTime, endTime] whose
///             answer touches the strike. Empty evidence asks for NO, which needs the challenge
///             period to be over.
/// Template 4: YES proof abi.encode(uint64 eventBlock), a funding event block e with
///             startBlock < e <= endBlock whose single-interval increment is above the threshold.
///             Empty evidence asks for NO, which needs the challenge period to be over.
/// Template 5: the same as template 2. Chainlink: abi.encode(uint80 roundId), the round with
///             updatedAt(r) <= T < updatedAt(r + 1). Pyth: abi.encode(bytes[] updateData).
/// Template 6: empty (the resolver reads each leg's outcome itself).

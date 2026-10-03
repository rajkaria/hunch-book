// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// Parameter schemas for the v0 templates. A market's `params` is `abi.encode` of one of these.
/// The app, keeper, maker and indexer decode with the same structs.

/// Template S-1 (docs/PROTOCOL.md §6.1): "Will longs pay more than `threshold` in funding on Perpl
/// perp `perpId` between block `startBlock` and block `endBlock`?"
/// YES if F(endBlock) − F(startBlock) > threshold, in Perpl's raw funding-sum units. Equal is NO.
struct PerplFundingParams {
    uint256 perpId;
    uint64 startBlock; // lock: staking stops here
    uint64 endBlock; // close: settlement needs block.number > endBlock
    int256 threshold; // raw Perpl units; 0 means "longs pay shorts on net"
    uint8 expectedScalingExp; // fundingSumScalingExp at creation; a change voids the market
}

/// Template S-2 (docs/PROTOCOL.md §6.2): "Will `asset`/USD be at or above `strike` at `closeTime`?"
/// Chainlink by default; Pyth only for assets with no Chainlink feed.
struct PriceAtTimeParams {
    uint8 source; // 0 = Chainlink aggregator proxy, 1 = Pyth
    address feed; // Chainlink proxy (source 0); must be on the resolver's allowlist
    bytes32 pythId; // Pyth price id (source 1); must be on the resolver's allowlist
    int256 strikeE8; // strike in USD with 8 decimals
    uint64 lockTime; // unix seconds: staking stops
    uint64 closeTime; // unix seconds: T, the observation time
}

/// Never deployed. Exists so the parameter structs appear in an ABI that TypeScript can encode with.
interface ITemplateParamsCodec {
    function perplFunding(PerplFundingParams calldata params) external pure;
    function priceAtTime(PriceAtTimeParams calldata params) external pure;
}

/// Evidence formats passed to `IResolver.resolve` and `IMarket.settle`.
/// S-1: empty (the resolver reads Perpl at startBlock and endBlock itself).
/// S-2 Chainlink: abi.encode(uint80 roundId), the round with updatedAt(r) <= T < updatedAt(r + 1).
/// S-2 Pyth: abi.encode(bytes[] updateData), the first update published at or after T.

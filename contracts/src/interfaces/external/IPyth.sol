// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// The subset of Pyth's onchain contract that Hunch Book's resolvers use.
/// Struct layouts match pyth-sdk-solidity's PythStructs.
interface IPyth {
    struct Price {
        int64 price;
        uint64 conf;
        int32 expo; // the price is `price * 10^expo`
        uint256 publishTime;
    }

    struct PriceFeed {
        bytes32 id;
        Price price;
        Price emaPrice;
    }

    function getUpdateFee(bytes[] calldata updateData) external view returns (uint256 feeAmount);

    /// Verifies signed updates and returns, for each id in `priceIds` (same order), the first update
    /// published in [minPublishTime, maxPublishTime] whose previous update was published before
    /// `minPublishTime`. Reverts if any id has no such update. Requires msg.value >= getUpdateFee.
    function parsePriceFeedUpdatesUnique(
        bytes[] calldata updateData,
        bytes32[] calldata priceIds,
        uint64 minPublishTime,
        uint64 maxPublishTime
    ) external payable returns (PriceFeed[] memory priceFeeds);
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// The subset of a Chainlink price feed proxy (AggregatorV3Interface) that Hunch Book's resolvers read.
/// A proxy round id is `(phaseId << 64) | aggregatorRoundId`; rounds in an earlier phase stay readable.
interface IChainlinkAggregator {
    function decimals() external view returns (uint8);

    /// For example "BTC / USD".
    function description() external view returns (string memory);

    /// A round that does not exist yet in the current phase returns zeros (updatedAt == 0);
    /// a round in a phase that does not exist reverts.
    function getRoundData(uint80 roundId)
        external
        view
        returns (uint80 roundId_, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

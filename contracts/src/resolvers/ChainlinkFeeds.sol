// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IChainlinkAggregator} from "../interfaces/external/IChainlinkAggregator.sol";

// File-level errors, so each concrete resolver can declare the same errors as its own members and
// expose them as `Resolver.Error` (a contract's type does not list errors it inherits). Same
// signature, same selector.
error NotAContract(address account);
error DuplicateEntry();
error FeedNotAllowed(address feed);
error RoundNotFound(uint80 roundId);
error MalformedEvidence();
error NonPositivePrice(int256 price);

/// @title Chainlink feed allowlist and round reads shared by the price resolvers
/// @dev The allowlist is written once, from the inheriting resolver's constructor, and can never
///      change: a new feed ships as a new resolver (template). Nothing here decides an outcome.
abstract contract ChainlinkFeeds {
    mapping(address feed => bool) public isFeedAllowed;
    address[] internal _feeds;

    /// The allowlisted Chainlink proxies, in constructor order.
    function feeds() external view returns (address[] memory) {
        return _feeds;
    }

    /// Constructor-only. Reverting inside the loop is intended: one bad entry rejects the whole deployment.
    function _allowFeeds(address[] memory feeds_) internal {
        for (uint256 i = 0; i < feeds_.length; ++i) {
            address feed = feeds_[i];
            // forge-lint: disable-next-line(require-revert-in-loop)
            if (feed.code.length == 0) revert NotAContract(feed);
            // forge-lint: disable-next-line(require-revert-in-loop)
            if (isFeedAllowed[feed]) revert DuplicateEntry();
            isFeedAllowed[feed] = true;
            _feeds.push(feed);
        }
    }

    /// Reads round `roundId` through the proxy. `ok` is false if the read reverts or the proxy echoes
    /// another round id; the caller decides whether that means "not yet" or "bad pointer".
    function _round(IChainlinkAggregator feed, uint80 roundId)
        internal
        view
        returns (bool ok, int256 answer, uint256 updatedAt, uint80 answeredInRound)
    {
        try feed.getRoundData(roundId) returns (uint80 id, int256 a, uint256, uint256 u, uint80 air) {
            // A proxy echoes the full round id; anything else is not the round that was asked for.
            if (id != roundId) return (false, 0, 0, 0);
            return (true, a, u, air);
        } catch {
            return (false, 0, 0, 0);
        }
    }

    /// The decimals of the aggregator that wrote round `roundId`. The proxy's own `decimals()` is the
    /// current phase's; a round from an earlier phase is scaled with its own phase's decimals.
    function _roundDecimals(IChainlinkAggregator feed, uint80 roundId) internal view returns (uint8) {
        // Safe: a uint80 shifted right by 64 has 16 bits left.
        // forge-lint: disable-next-line(unsafe-typecast)
        address aggregator = feed.phaseAggregators(uint16(roundId >> 64));
        if (aggregator == address(0)) revert RoundNotFound(roundId);
        return IChainlinkAggregator(aggregator).decimals();
    }
}

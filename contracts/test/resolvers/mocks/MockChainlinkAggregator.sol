// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IChainlinkAggregator} from "../../../src/interfaces/external/IChainlinkAggregator.sol";

/// A Chainlink proxy stand-in. Unknown rounds return zeros, like a real proxy does for a round that
/// does not exist yet in the current phase; individual rounds can be made to revert. `latestRoundData`
/// answers with the round set by `setLatest` and can be made to revert.
contract MockChainlinkAggregator is IChainlinkAggregator {
    error NoDataPresent();

    struct Round {
        int256 answer;
        uint256 updatedAt;
    }

    uint8 public decimals;
    string public description;
    mapping(uint80 roundId => Round) public rounds;
    mapping(uint80 roundId => bool) public reverts;
    /// When set, getRoundData echoes a different round id than the one asked for.
    bool public echoWrongId;
    /// Phase aggregators; an unset phase answers with this contract itself.
    mapping(uint16 phaseId => address) internal _phaseAggregator;
    mapping(uint16 phaseId => bool) internal _phaseMissing;
    /// A round whose answeredInRound differs from its own id (a carried-over answer).
    mapping(uint80 roundId => uint80) internal _answeredIn;
    uint80 public latestRound;
    bool public latestReverts;

    constructor(uint8 decimals_, string memory description_) {
        decimals = decimals_;
        description = description_;
    }

    function setRound(uint80 roundId, int256 answer, uint256 updatedAt) external {
        rounds[roundId] = Round(answer, updatedAt);
    }

    function setReverts(uint80 roundId, bool v) external {
        reverts[roundId] = v;
    }

    function setEchoWrongId(bool v) external {
        echoWrongId = v;
    }

    function setDecimals(uint8 d) external {
        decimals = d;
    }

    function setAnsweredIn(uint80 roundId, uint80 answeredIn) external {
        _answeredIn[roundId] = answeredIn;
    }

    function setLatest(uint80 roundId) external {
        latestRound = roundId;
    }

    function setLatestReverts(bool v) external {
        latestReverts = v;
    }

    function setPhaseAggregator(uint16 phaseId, address aggregator, bool missing) external {
        _phaseAggregator[phaseId] = aggregator;
        _phaseMissing[phaseId] = missing;
    }

    function phaseAggregators(uint16 phaseId) external view returns (address) {
        if (_phaseMissing[phaseId]) return address(0);
        address a = _phaseAggregator[phaseId];
        return a == address(0) ? address(this) : a;
    }

    function getRoundData(uint80 roundId) external view returns (uint80, int256, uint256, uint256, uint80) {
        if (reverts[roundId]) revert NoDataPresent();
        Round memory r = rounds[roundId];
        uint80 id = echoWrongId ? roundId ^ 1 : roundId;
        uint80 answeredIn = _answeredIn[roundId] == 0 ? id : _answeredIn[roundId];
        return (id, r.answer, r.updatedAt, r.updatedAt, answeredIn);
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        if (latestReverts) revert NoDataPresent();
        Round memory r = rounds[latestRound];
        return (latestRound, r.answer, r.updatedAt, r.updatedAt, latestRound);
    }
}

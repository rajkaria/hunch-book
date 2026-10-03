// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IPerplExchange} from "../../../src/interfaces/external/IPerplExchange.sol";

/// A small stand-in for Perpl's Exchange: an existence bitmap, per-perp info, a funding-event history
/// with Perpl's "last event at or before the block" lookup, and switches to make each read fail.
contract MockPerplExchange is IPerplExchange {
    error ContractDoesNotExist(uint256 perpId);
    error Broken();

    struct FundingEvent {
        uint256 blockNumber;
        int48 sum;
    }

    uint256[4] internal _bitmap;
    mapping(uint256 perpId => PerpetualInfoV2) internal _info;
    mapping(uint256 perpId => FundingEvent[]) internal _events;

    uint256 public interval = 8571;
    uint256 public major = 7;
    uint256 public minor = 5;
    uint256 public patch = 0;

    bool public versionReverts;
    bool public infoReverts;
    bool public intervalReverts;
    bool public sumsRevert;
    mapping(uint256 blockNumber => bool) public sumRevertsAt;
    /// When set, getFundingSumAtBlock reports this event block instead of the real one.
    bool public lieAboutEventBlock;
    uint256 public liedEventBlock;

    // ------------------------------------------------------------ set-up

    function listPerp(
        uint256 perpId,
        string memory name,
        string memory symbol,
        uint256 priceDecimals,
        uint256 scalingExp,
        uint256 fundingStartBlock
    ) external {
        _bitmap[perpId >> 8] |= uint256(1) << (perpId & 0xff);
        PerpetualInfoV2 storage info = _info[perpId];
        info.name = name;
        info.symbol = symbol;
        info.priceDecimals = priceDecimals;
        info.fundingSumScalingExp = scalingExp;
        info.fundingStartBlock = fundingStartBlock;
        info.status = 4;
    }

    function delistPerp(uint256 perpId) external {
        _bitmap[perpId >> 8] &= ~(uint256(1) << (perpId & 0xff));
        delete _info[perpId];
        delete _events[perpId];
    }

    function setStatus(uint256 perpId, uint8 status) external {
        _info[perpId].status = status;
    }

    function setScalingExp(uint256 perpId, uint256 exp) external {
        _info[perpId].fundingSumScalingExp = exp;
    }

    function setFundingStartBlock(uint256 perpId, uint256 b) external {
        _info[perpId].fundingStartBlock = b;
    }

    /// Events must be pushed in increasing block order.
    function pushEvent(uint256 perpId, uint256 blockNumber, int48 sum) external {
        FundingEvent[] storage evs = _events[perpId];
        require(evs.length == 0 || evs[evs.length - 1].blockNumber < blockNumber, "order");
        evs.push(FundingEvent(blockNumber, sum));
    }

    function setVersion(uint256 major_, uint256 minor_, uint256 patch_) external {
        (major, minor, patch) = (major_, minor_, patch_);
    }

    function setInterval(uint256 interval_) external {
        interval = interval_;
    }

    function setVersionReverts(bool v) external {
        versionReverts = v;
    }

    function setInfoReverts(bool v) external {
        infoReverts = v;
    }

    function setIntervalReverts(bool v) external {
        intervalReverts = v;
    }

    function setSumsRevert(bool v) external {
        sumsRevert = v;
    }

    function setSumRevertsAt(uint256 blockNumber, bool v) external {
        sumRevertsAt[blockNumber] = v;
    }

    function setLie(bool on, uint256 eventBlock) external {
        lieAboutEventBlock = on;
        liedEventBlock = eventBlock;
    }

    // ------------------------------------------------------------ IPerplExchange

    function getPerpetualExistsBitmap() external view returns (uint256[4] memory) {
        return _bitmap;
    }

    function getPerpetualInfoV2(uint256 perpId) external view returns (PerpetualInfoV2 memory) {
        if (infoReverts) revert Broken();
        if (perpId > 1023 || (_bitmap[perpId >> 8] >> (perpId & 0xff)) & 1 == 0) revert ContractDoesNotExist(perpId);
        return _info[perpId];
    }

    function getFundingSumAtBlock(uint256 perpId, uint256 blockNumber)
        external
        view
        returns (int48 fundingSumPNS, uint256 fundingEventBlock)
    {
        if (sumsRevert || sumRevertsAt[blockNumber]) revert Broken();
        if (blockNumber == type(uint256).max) revert Broken();
        if (blockNumber < _info[perpId].fundingStartBlock) return (0, 0);
        FundingEvent[] storage evs = _events[perpId];
        for (uint256 i = evs.length; i > 0; --i) {
            if (evs[i - 1].blockNumber <= blockNumber) {
                return (evs[i - 1].sum, lieAboutEventBlock ? liedEventBlock : evs[i - 1].blockNumber);
            }
        }
        return (0, lieAboutEventBlock ? liedEventBlock : 0);
    }

    function getFundingInterval() external view returns (uint256) {
        if (intervalReverts) revert Broken();
        return interval;
    }

    function getContractVersion() external view returns (uint256, uint256, uint256) {
        if (versionReverts) revert Broken();
        return (major, minor, patch);
    }
}

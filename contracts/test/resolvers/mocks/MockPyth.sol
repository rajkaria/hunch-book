// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IPyth} from "../../../src/interfaces/external/IPyth.sol";

/// A Pyth stand-in. Each update is abi.encode(PriceFeed feed, uint64 prevPublishTime) and is "signed"
/// by construction. `parsePriceFeedUpdatesUnique` follows Pyth's rule: for each id, the update with
/// prevPublishTime < minPublishTime <= publishTime <= maxPublishTime. Misbehaviour switches let tests
/// reach the resolver's own defensive checks.
contract MockPyth is IPyth {
    error InsufficientFee();
    error PriceFeedNotFoundWithinRange();

    uint256 public feePerUpdate;
    bool public returnWrongId;
    bool public skipRangeCheck;
    bool public returnEmpty;

    constructor(uint256 feePerUpdate_) {
        feePerUpdate = feePerUpdate_;
    }

    function setMisbehaviour(bool wrongId, bool skipRange, bool empty) external {
        (returnWrongId, skipRangeCheck, returnEmpty) = (wrongId, skipRange, empty);
    }

    function getUpdateFee(bytes[] calldata updateData) external view returns (uint256) {
        return feePerUpdate * updateData.length;
    }

    function parsePriceFeedUpdatesUnique(
        bytes[] calldata updateData,
        bytes32[] calldata priceIds,
        uint64 minPublishTime,
        uint64 maxPublishTime
    ) external payable returns (PriceFeed[] memory feeds) {
        if (msg.value < feePerUpdate * updateData.length) revert InsufficientFee();
        if (returnEmpty) return new PriceFeed[](0);
        feeds = new PriceFeed[](priceIds.length);
        for (uint256 i = 0; i < priceIds.length; ++i) {
            bool found = false;
            for (uint256 j = 0; j < updateData.length; ++j) {
                (PriceFeed memory f, uint64 prev) = abi.decode(updateData[j], (PriceFeed, uint64));
                if (f.id != priceIds[i]) continue;
                bool inRange = prev < minPublishTime && minPublishTime <= f.price.publishTime
                    && f.price.publishTime <= maxPublishTime;
                if (inRange || skipRangeCheck) {
                    feeds[i] = f;
                    if (returnWrongId) feeds[i].id = bytes32(uint256(f.id) ^ 1);
                    found = true;
                    break;
                }
            }
            if (!found) revert PriceFeedNotFoundWithinRange();
        }
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Snapshot} from "../interfaces/ITemplatesV3.sol";

// File-level error, so the concrete resolver can declare the same error as its own member and expose
// it as `Resolver.Error` (a contract's type does not list errors it inherits). Same signature, same
// selector.
error SnapshotExists(bytes32 key);

/// @title Write-once storage for template 7's snapshots
/// @notice One snapshot per observation: a source, read in the window [closeTime, closeTime + window].
///         Every question about the same observation (other thresholds, other comparators, other lock
///         times) answers from the same snapshot, so a ladder of strikes can never disagree with itself.
///         A snapshot is written once and never changed or deleted: `_record` is the only writer, and
///         it reverts if the observation already has one.
/// @dev The value written is always one the inheriting resolver just read from an allowlisted source,
///      inside the observation's window. Nothing here decides what that value is.
abstract contract SnapshotStore {
    mapping(bytes32 key => Snapshot) internal _snapshots;

    /// A snapshot was stored. `caller` is the account that called the resolver: a market when the
    /// snapshot was taken inside `settle`, otherwise whoever called `snapshot`.
    event SnapshotTaken(
        bytes32 indexed key,
        uint16 indexed sourceId,
        address indexed caller,
        uint64 closeTime,
        uint32 snapshotWindow,
        int256 value,
        uint64 blockNumber,
        uint64 timestamp
    );

    /// The key an observation's snapshot is stored under.
    function snapshotKey(uint16 sourceId, uint64 closeTime, uint32 snapshotWindow) public pure returns (bytes32) {
        return keccak256(abi.encode(sourceId, closeTime, snapshotWindow));
    }

    /// The snapshot stored under `key`; all zero if none has been taken.
    function snapshotOf(bytes32 key) external view returns (Snapshot memory) {
        return _snapshots[key];
    }

    /// Stores `value` as read in this block. Reverts if the observation already has a snapshot.
    function _record(uint16 sourceId, uint64 closeTime, uint32 snapshotWindow, int256 value)
        internal
        returns (Snapshot memory s)
    {
        bytes32 key = snapshotKey(sourceId, closeTime, snapshotWindow);
        if (_snapshots[key].blockNumber != 0) revert SnapshotExists(key);
        // Safe: block numbers and timestamps stay far below 2^64.
        // forge-lint: disable-next-line(unsafe-typecast)
        s = Snapshot({value: value, blockNumber: uint64(block.number), timestamp: uint64(block.timestamp)});
        _snapshots[key] = s;
        // The only external calls before this are the resolver's STATICCALLs to its source, which
        // cannot change state or reenter.
        // forge-lint: disable-next-line(reentrancy-events)
        emit SnapshotTaken(key, sourceId, msg.sender, closeTime, snapshotWindow, value, s.blockNumber, s.timestamp);
    }
}

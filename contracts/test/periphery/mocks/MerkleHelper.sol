// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// Builds small Merkle trees in tests: sorted-pair hashing (the OpenZeppelin and solady convention),
/// and a node with no sibling moves up a level unchanged (so it adds nothing to the proof).
library MerkleHelper {
    function hashPair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    function root(bytes32[] memory leaves) internal pure returns (bytes32) {
        require(leaves.length != 0, "no leaves");
        bytes32[] memory level = leaves;
        while (level.length > 1) {
            level = _up(level);
        }
        return level[0];
    }

    function proof(bytes32[] memory leaves, uint256 index) internal pure returns (bytes32[] memory p) {
        require(index < leaves.length, "index");
        bytes32[] memory buf = new bytes32[](64);
        uint256 n;
        bytes32[] memory level = leaves;
        while (level.length > 1) {
            uint256 sibling = index ^ 1;
            if (sibling < level.length) buf[n++] = level[sibling];
            index /= 2;
            level = _up(level);
        }
        p = new bytes32[](n);
        for (uint256 i; i < n; ++i) {
            p[i] = buf[i];
        }
    }

    function _up(bytes32[] memory level) private pure returns (bytes32[] memory next) {
        next = new bytes32[]((level.length + 1) / 2);
        for (uint256 i; i < next.length; ++i) {
            next[i] = 2 * i + 1 < level.length ? hashPair(level[2 * i], level[2 * i + 1]) : level[2 * i];
        }
    }
}

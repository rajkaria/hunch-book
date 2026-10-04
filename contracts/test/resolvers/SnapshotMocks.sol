// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IPerplExchange} from "../../src/interfaces/external/IPerplExchange.sol";

/// A stand-in for the sources template 7 reads. It answers Perpl's two calls with Perpl's exact return
/// layout (`getPerpetualInfoV2` returns the real struct, strings included), plus plain one-word and
/// two-word getters, and switches that make a read revert, come back short, or come back huge.
contract MockSnapshotSource {
    error ContractDoesNotExist(uint256 perpId);
    error Broken();

    mapping(uint256 perpId => IPerplExchange.PerpetualInfoV2) internal _info;
    mapping(uint256 perpId => bool) public listed;

    uint256 public major = 7;
    uint256 public minor = 5;
    uint256 public patch = 0;

    uint256 public plainWord;
    int256 public signedWord;
    uint256 public stampedAt;

    bool public reverts;
    bool public versionReverts;
    /// When non-zero, every getter returns only this many bytes of its encoding.
    uint256 public truncateTo;
    /// When non-zero, `getContractVersion` answers with this many extra bytes.
    uint256 public versionPadding;

    // ------------------------------------------------------------ set-up

    function listPerp(uint256 perpId, string memory symbol, uint256 priceDecimals, uint256 lotDecimals) external {
        listed[perpId] = true;
        IPerplExchange.PerpetualInfoV2 storage info = _info[perpId];
        info.name = string.concat(symbol, " Perp");
        info.symbol = symbol;
        info.priceDecimals = priceDecimals;
        info.lotDecimals = lotDecimals;
        info.fundingStartBlock = 1000;
        info.status = 4;
        info.markTimestamp = block.timestamp;
        info.oracleTimestampSec = block.timestamp;
    }

    function delistPerp(uint256 perpId) external {
        listed[perpId] = false;
    }

    function setMark(uint256 perpId, uint256 markPNS, uint256 markTimestamp) external {
        _info[perpId].markPNS = markPNS;
        _info[perpId].markTimestamp = markTimestamp;
    }

    function setOpenInterest(uint256 perpId, uint256 lots) external {
        _info[perpId].longOpenInterestLNS = lots;
        _info[perpId].shortOpenInterestLNS = lots;
    }

    function setStatus(uint256 perpId, uint8 status) external {
        _info[perpId].status = status;
    }

    function setDecimals(uint256 perpId, uint256 priceDecimals, uint256 lotDecimals) external {
        _info[perpId].priceDecimals = priceDecimals;
        _info[perpId].lotDecimals = lotDecimals;
    }

    function setFundingStartBlock(uint256 perpId, uint256 b) external {
        _info[perpId].fundingStartBlock = b;
    }

    /// Fills every field with a distinct value (field index i holds 1000 + i), for layout tests.
    function setDistinctFields(uint256 perpId) external {
        IPerplExchange.PerpetualInfoV2 storage x = _info[perpId];
        x.name = "a long name that takes more than one word of return data to encode";
        x.symbol = "SYM";
        x.priceDecimals = 1002;
        x.lotDecimals = 1003;
        x.linkFeedId = bytes32(uint256(1004));
        x.priceTolPer100K = 1005;
        x.marginTol = 1006;
        x.marginTolDecimals = 1007;
        x.refPriceMaxAgeSec = 1008;
        x.positionBalanceCNS = 1009;
        x.insuranceBalanceCNS = 1010;
        x.markPNS = 1011;
        x.markTimestamp = 1012;
        x.lastPNS = 1013;
        x.lastTimestamp = 1014;
        x.oraclePNS = 1015;
        x.oracleTimestampSec = 1016;
        x.longOpenInterestLNS = 1017;
        x.shortOpenInterestLNS = 1018;
        x.fundingStartBlock = 1019;
        x.fundingRatePct100k = -1020;
        x.absFundingClampPctPer100K = 1021;
        x.status = 22;
        x.basePricePNS = 1023;
        x.maxBidPriceONS = 1024;
        x.minBidPriceONS = 1025;
        x.maxAskPriceONS = 1026;
        x.minAskPriceONS = 1027;
        x.numOrders = 1028;
        x.ignOracle = true;
        x.fundingSumScalingExp = 1030;
    }

    function setVersion(uint256 major_, uint256 minor_, uint256 patch_) external {
        (major, minor, patch) = (major_, minor_, patch_);
    }

    function setPlain(uint256 w) external {
        plainWord = w;
    }

    function setSigned(int256 v, uint256 at) external {
        signedWord = v;
        stampedAt = at;
    }

    function setReverts(bool v) external {
        reverts = v;
    }

    function setVersionReverts(bool v) external {
        versionReverts = v;
    }

    function setTruncateTo(uint256 n) external {
        truncateTo = n;
    }

    function setVersionPadding(uint256 n) external {
        versionPadding = n;
    }

    // ------------------------------------------------------------ Perpl's calls

    function getPerpetualInfoV2(uint256 perpId) external view returns (IPerplExchange.PerpetualInfoV2 memory) {
        if (reverts) revert Broken();
        if (!listed[perpId]) revert ContractDoesNotExist(perpId);
        _maybeTruncate(abi.encode(_info[perpId]));
        return _info[perpId];
    }

    function getContractVersion() external view returns (uint256, uint256, uint256) {
        if (versionReverts) revert Broken();
        if (versionPadding != 0) {
            bytes memory answer = bytes.concat(abi.encode(major, minor, patch), new bytes(versionPadding));
            assembly ("memory-safe") {
                return(add(answer, 0x20), mload(answer))
            }
        }
        return (major, minor, patch);
    }

    // ------------------------------------------------------------ other shapes

    /// One unsigned word.
    function plain() external view returns (uint256) {
        if (reverts) revert Broken();
        _maybeTruncate(abi.encode(plainWord));
        return plainWord;
    }

    /// A signed value and the time it was set: (int256 value, uint256 updatedAt).
    function stamped() external view returns (int256, uint256) {
        if (reverts) revert Broken();
        _maybeTruncate(abi.encode(signedWord, stampedAt));
        return (signedWord, stampedAt);
    }

    /// A one-word answer followed by `extraBytes` of zeros: a reader that copies the whole return pays
    /// for all of it.
    function padded(uint256 extraBytes) external view returns (uint256) {
        bytes memory out = bytes.concat(abi.encode(plainWord), new bytes(extraBytes));
        assembly ("memory-safe") {
            return(add(out, 0x20), mload(out))
        }
    }

    /// A tuple whose head offset points past the end of the return data.
    function badOffset() external pure returns (uint256) {
        assembly ("memory-safe") {
            mstore(0x00, 0x1000)
            mstore(0x20, 7)
            return(0x00, 0x40)
        }
    }

    function _maybeTruncate(bytes memory full) internal view {
        uint256 n = truncateTo;
        if (n == 0) return;
        if (n > full.length) n = full.length;
        assembly ("memory-safe") {
            return(add(full, 0x20), n)
        }
    }
}

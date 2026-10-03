// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// The subset of Perpl's Exchange (an ERC-1967/UUPS proxy) that Hunch Book's resolvers read.
/// Signatures follow Perpl's published ABI (PerplFoundation/dex-sdk, contract v1.7.5).
interface IPerplExchange {
    /// Field order and types must match Perpl's `PerpetualInfoV2` exactly, because the struct is
    /// ABI-decoded as a whole. Only `name`, `symbol`, `priceDecimals`, `fundingStartBlock`, `status`
    /// and `fundingSumScalingExp` are used.
    struct PerpetualInfoV2 {
        string name;
        string symbol;
        uint256 priceDecimals;
        uint256 lotDecimals;
        bytes32 linkFeedId;
        uint256 priceTolPer100K;
        uint256 marginTol;
        uint256 marginTolDecimals;
        uint256 refPriceMaxAgeSec;
        uint256 positionBalanceCNS;
        uint256 insuranceBalanceCNS;
        uint256 markPNS;
        uint256 markTimestamp;
        uint256 lastPNS;
        uint256 lastTimestamp;
        uint256 oraclePNS;
        uint256 oracleTimestampSec;
        uint256 longOpenInterestLNS;
        uint256 shortOpenInterestLNS;
        uint256 fundingStartBlock;
        int16 fundingRatePct100k;
        uint256 absFundingClampPctPer100K;
        uint8 status; // PerpStatusEnum; 0 = paused
        uint256 basePricePNS;
        uint256 maxBidPriceONS;
        uint256 minBidPriceONS;
        uint256 maxAskPriceONS;
        uint256 minAskPriceONS;
        uint256 numOrders;
        bool ignOracle;
        uint256 fundingSumScalingExp;
    }

    /// Bit (id % 256) of word (id / 256) is 1 if and only if perpetual `id` exists.
    function getPerpetualExistsBitmap() external view returns (uint256[4] memory bitmap);

    /// Reverts with `ContractDoesNotExist(perpId)` for an unknown id.
    function getPerpetualInfoV2(uint256 perpId) external view returns (PerpetualInfoV2 memory perpetualInfo);

    /// Cumulative funding as of the last funding event at or before `blockNumber`, and that event's
    /// block. Returns (0, 0) before the perp's funding start block. A rising sum means longs paid
    /// shorts. Undefined for a block at or after the next funding event that has not happened yet.
    function getFundingSumAtBlock(uint256 perpId, uint256 blockNumber)
        external
        view
        returns (int48 fundingSumPNS, uint256 fundingEventBlock);

    /// Blocks between funding events (8,571 on Monad). Declared `pure` by Perpl.
    function getFundingInterval() external view returns (uint256 fundingInterval);

    /// The implementation's version, v1.<major>.<minor>.<patch>. Perpl stamps it inside each upgrade
    /// transaction (event `ContractVersionSet`). This is the only implementation identity Perpl
    /// exposes to other contracts.
    function getContractVersion() external view returns (uint256 major, uint256 minor, uint256 patch);
}

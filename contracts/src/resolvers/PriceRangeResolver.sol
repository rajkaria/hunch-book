// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {LibString} from "solady/utils/LibString.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {IResolver} from "../interfaces/IResolver.sol";
import {Outcome, Window} from "../interfaces/IHunchBookTypes.sol";
import {PriceRangeParams} from "../interfaces/ITemplatesV2.sol";
import {IPyth} from "../interfaces/external/IPyth.sol";
import {PriceAtTimeReader} from "./PriceAtTimeReader.sol";
import {ResolverText} from "./ResolverText.sol";

/// @title Template 5: price range at a time
/// @notice "Will ASSET/USD be at or above K1 and below K2 at time T?" YES if the price at T is at or
///         above `lowerE8` and below `upperE8` (8 decimals), NO otherwise. The lower bound is inclusive
///         and the upper bound exclusive, so ranges that share a bound never both settle YES.
///         The price at T is read exactly as template 2 reads it (PriceAtTimeReader):
///         - Chainlink (source 0): the round r with updatedAt(r) <= T < updatedAt(r + 1), in one phase,
///           at most one hour before T, positive.
///         - Pyth (source 1): the first signed update published in [T, T + 60 s].
/// @dev A pure reader: no owner, no funds between calls. Allowlists are written once in the
///      constructor and can never change. Down-scaling truncates, which is exact for both bounds:
///      floor(x) >= K1 if and only if x >= K1, and floor(x) < K2 if and only if x < K2.
///
///      evidenceHash: the same format as template 2 (see PriceAtTimeReader).
contract PriceRangeResolver is IResolver, PriceAtTimeReader {
    // Every error this resolver can revert with. The shared readers revert with file-level errors of
    // the same signatures (so the same selectors); declaring them here lists them in this
    // contract's ABI and lets callers write `PriceRangeResolver.Error.selector`.
    error NotAContract(address account);
    error DuplicateEntry();
    error LengthMismatch();
    error EmptyLabel();
    error PythNotConfigured();
    error NonCanonicalParams();
    error UnknownSource(uint8 source);
    error FeedNotAllowed(address feed);
    error PythIdNotAllowed(bytes32 id);
    error UnusedFieldSet();
    error LowerNotPositive(int256 lowerE8);
    error EmptyRange(int256 lowerE8, int256 upperE8);
    error LockNotInFuture(uint64 lockTime, uint256 currentTime);
    error CloseBeforeLock(uint64 lockTime, uint64 closeTime);
    error DeadlineOverflow();
    error MalformedEvidence();
    error PhaseBoundary(uint80 roundId);
    error RoundNotFound(uint80 roundId);
    error RoundAfterTarget(uint80 roundId, uint256 updatedAt, uint256 target);
    error RoundNotLastBeforeTarget(uint80 roundId, uint256 nextUpdatedAt, uint256 target);
    error RoundTooStale(uint80 roundId, uint256 updatedAt, uint256 target);
    error NonPositivePrice(int256 price);
    error InsufficientFee(uint256 fee, uint256 sent);
    error PythFeedMismatch();
    error PythPublishTimeOutOfRange(uint256 publishTime, uint256 target);

    /// @param feeds_ Chainlink aggregator proxies this resolver accepts.
    /// @param pyth_ Pyth's contract, or zero on a network without Pyth (then `pythIds_` must be empty).
    /// @param pythIds_ Pyth price ids this resolver accepts.
    /// @param pythLabels_ the pair shown in `describe` for each Pyth id, for example "SOL/USD".
    constructor(address[] memory feeds_, IPyth pyth_, bytes32[] memory pythIds_, string[] memory pythLabels_)
        PriceAtTimeReader(feeds_, pyth_, pythIds_, pythLabels_)
    {}

    // ---------------------------------------------------------------- IResolver

    /// @inheritdoc IResolver
    function validate(bytes calldata params) external view returns (Window memory window) {
        PriceRangeParams memory p = abi.decode(params, (PriceRangeParams));
        // One encoding per question, so the factory's (template, params) key is unique per question.
        if (keccak256(abi.encode(p)) != keccak256(params)) revert NonCanonicalParams();
        _checkSource(p.source, p.feed, p.pythId);
        if (p.lowerE8 <= 0) revert LowerNotPositive(p.lowerE8);
        if (p.upperE8 <= p.lowerE8) revert EmptyRange(p.lowerE8, p.upperE8);
        window = _timeWindow(p.lockTime, p.closeTime);
    }

    /// @inheritdoc IResolver
    function describe(bytes calldata params) external view returns (string memory) {
        PriceRangeParams memory p = abi.decode(params, (PriceRangeParams));
        (string memory pair, string memory source) = _sourceText(p.source, p.feed, p.pythId);
        return string.concat(
            "YES if ",
            source,
            " puts ",
            pair,
            " at or above ",
            ResolverText.usd(p.lowerE8, 8),
            " and below ",
            ResolverText.usd(p.upperE8, 8),
            " at ",
            ResolverText.utc(p.closeTime),
            " (unix time ",
            LibString.toString(p.closeTime),
            "); NO otherwise."
        );
    }

    /// @inheritdoc IResolver
    /// @dev Chainlink: evidence = abi.encode(uint80 roundId). Pyth: evidence = abi.encode(bytes[] updateData)
    ///      and msg.value >= Pyth's update fee. Value not spent on the fee is returned to msg.sender.
    function resolve(bytes calldata params, bytes calldata evidence)
        external
        payable
        returns (Outcome outcome, bytes32 evidenceHash)
    {
        PriceRangeParams memory p = abi.decode(params, (PriceRangeParams));
        _checkSource(p.source, p.feed, p.pythId);
        PriceRead memory read = _priceAt(p.source, p.feed, p.pythId, p.closeTime, evidence);
        if (read.known) {
            bool inside = read.priceE8 >= p.lowerE8 && read.priceE8 < p.upperE8;
            outcome = inside ? Outcome.Yes : Outcome.No;
            evidenceHash = read.evidenceHash;
        }
        uint256 refund = msg.value - read.fee;
        if (refund != 0) SafeTransferLib.safeTransferETH(msg.sender, refund);
    }

    /// @inheritdoc IResolver
    function earlyYes() external pure returns (bool) {
        return false;
    }
}

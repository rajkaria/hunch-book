// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {LibString} from "solady/utils/LibString.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {IResolver} from "../interfaces/IResolver.sol";
import {Outcome, Window} from "../interfaces/IHunchBookTypes.sol";
import {PriceAtTimeParams} from "../interfaces/ITemplates.sol";
import {IPyth} from "../interfaces/external/IPyth.sol";
import {PriceAtTimeReader} from "./PriceAtTimeReader.sol";
import {ResolverText} from "./ResolverText.sol";

/// @title Template S-2: price at a time (docs/PROTOCOL.md §6.2)
/// @notice "Will ASSET/USD be at or above K at time T?" YES if the price at T is at or above
///         `strikeE8` (8 decimals), NO otherwise.
///         - Chainlink (source 0): the settler names round r. It is accepted only if r and r + 1 are in
///           the same phase, updatedAt(r) <= T < updatedAt(r + 1), T − updatedAt(r) <= 1 hour and the
///           answer is positive. Within a phase updatedAt never decreases, so at most one round can
///           satisfy this for a given T: nobody can pick a convenient price.
///         - Pyth (source 1): the settler passes signed updates. Pyth's `parsePriceFeedUpdatesUnique`
///           with [T, T + 60 s] returns only the first update published at or after T.
/// @dev A pure reader: no owner, no funds between calls. The feed and Pyth-id allowlists are written
///      once in the constructor and can never change; a new feed ships as a new resolver (template).
///      A failed read of round r + 1 only ever yields `Unresolved`; every other failure reverts.
///      A round is scaled with the decimals of the phase aggregator that wrote it. The reading code is
///      shared with template 5 (PriceRangeResolver) through PriceAtTimeReader.
///
///      evidenceHash, for the settlement verifier:
///      - Chainlink: keccak256(abi.encode(uint8 0, address feed, uint80 r, int256 answer,
///        uint256 updatedAt(r), uint256 updatedAt(r + 1), uint256 T))
///      - Pyth: keccak256(abi.encode(uint8 1, address pyth, bytes32 id,
///        (int64 price, uint64 conf, int32 expo, uint256 publishTime), uint64 T))
contract PriceAtTimeResolver is IResolver, PriceAtTimeReader {
    // Every error this resolver can revert with. The shared readers revert with file-level errors of
    // the same signatures (so the same selectors); declaring them here lists them in this
    // contract's ABI and lets callers write `PriceAtTimeResolver.Error.selector`.
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
    error StrikeNotPositive(int256 strikeE8);
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
        PriceAtTimeParams memory p = abi.decode(params, (PriceAtTimeParams));
        // One encoding per question, so the factory's (template, params) key is unique per question.
        if (keccak256(abi.encode(p)) != keccak256(params)) revert NonCanonicalParams();
        _checkSource(p.source, p.feed, p.pythId);
        if (p.strikeE8 <= 0) revert StrikeNotPositive(p.strikeE8);
        window = _timeWindow(p.lockTime, p.closeTime);
    }

    /// @inheritdoc IResolver
    function describe(bytes calldata params) external view returns (string memory) {
        PriceAtTimeParams memory p = abi.decode(params, (PriceAtTimeParams));
        (string memory pair, string memory source) = _sourceText(p.source, p.feed, p.pythId);
        return string.concat(
            "Will ",
            pair,
            " be at or above ",
            ResolverText.usd(p.strikeE8, 8),
            " at ",
            ResolverText.utc(p.closeTime),
            " (unix time ",
            LibString.toString(p.closeTime),
            "), per ",
            source,
            "?"
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
        PriceAtTimeParams memory p = abi.decode(params, (PriceAtTimeParams));
        _checkSource(p.source, p.feed, p.pythId);
        PriceRead memory read = _priceAt(p.source, p.feed, p.pythId, p.closeTime, evidence);
        if (read.known) {
            outcome = read.priceE8 >= p.strikeE8 ? Outcome.Yes : Outcome.No;
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

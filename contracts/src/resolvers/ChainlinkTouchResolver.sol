// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {LibString} from "solady/utils/LibString.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {IResolver} from "../interfaces/IResolver.sol";
import {Outcome, Window} from "../interfaces/IHunchBookTypes.sol";
import {ChainlinkTouchParams} from "../interfaces/ITemplatesV2.sol";
import {IChainlinkAggregator} from "../interfaces/external/IChainlinkAggregator.sol";
import {ChainlinkFeeds} from "./ChainlinkFeeds.sol";
import {PriceScale} from "./PriceScale.sol";
import {ResolverText} from "./ResolverText.sol";

/// The one extra Chainlink read this template needs: the feed's latest round, to check the feed was
/// still reporting when the window ended.
interface IChainlinkLatestRound {
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

/// @title Template 3: touch, proof by pointer (docs/PROTOCOL.md §6.3)
/// @notice "Will Chainlink's ASSET/USD feed report a price at or above K (or at or below K) in any round
///         updated between T1 and T2?"
///         - YES is proved by pointing at the round: evidence abi.encode(uint80 r). The round must be
///           readable through the proxy, answered in itself (answeredInRound == r), updated in
///           [T1, T2] (both ends included), positive, and touch the strike: at or above K for
///           direction 0, at or below K for direction 1 (equal counts in both directions). Anyone can
///           submit a proof, through `proveYes` before close or `settle` after it. A pointer that does
///           not prove a touch reverts, so a bad proof can never settle anything.
///         - NO needs no proof: empty evidence settles NO once a 24-hour challenge period after T2 has
///           passed, provided the feed reported at least one round at or after T2 (so a feed that went
///           dark cannot settle a market NO by silence). Before that, empty evidence is `Unresolved`.
///         The assumption, stated plainly: if a touching round exists, at least one honest party
///         (Hunch's keeper, or anyone) submits it within the challenge period.
/// @dev A pure reader: no owner, no funds between calls. The feed allowlist is written once in the
///      constructor and can never change. The price is compared in a direction-safe way: down-scaling
///      truncates for "at or above" and rounds up for "at or below" (PriceScale), so neither rule can
///      be flipped by rounding. A round is scaled with the decimals of the phase aggregator that wrote it.
///
///      evidenceHash, for the settlement verifier:
///      - YES: keccak256(abi.encode(address feed, uint80 roundId, uint256 updatedAt, int256 answer))
///      - NO: keccak256(abi.encode(address feed, uint64 endTime, uint256 challengeEnd,
///        uint80 latestRoundId, uint256 latestUpdatedAt)), the round that shows the feed was alive.
contract ChainlinkTouchResolver is IResolver, ChainlinkFeeds {
    /// Direction 0: YES if a round reports a price at or above the strike.
    uint8 public constant DIRECTION_AT_OR_ABOVE = 0;
    /// Direction 1: YES if a round reports a price at or below the strike.
    uint8 public constant DIRECTION_AT_OR_BELOW = 1;

    /// After the window ends, anyone has this long to prove YES before NO can settle.
    uint256 public constant CHALLENGE_PERIOD = 24 hours;

    /// Settlement stays open this long after the challenge period ends (docs/PROTOCOL.md §2).
    uint256 public constant SETTLEMENT_WINDOW = 7 days;

    /// The longest observation window a market can have.
    uint256 public constant MAX_DURATION = 31 days;

    // Every error this resolver can revert with. ChainlinkFeeds reverts with file-level errors of the
    // same signatures (so the same selectors); declaring them here lists them in this contract's ABI
    // and lets callers write `ChainlinkTouchResolver.Error.selector`.
    error NotAContract(address account);
    error DuplicateEntry();
    error NonCanonicalParams();
    error FeedNotAllowed(address feed);
    error StrikeNotPositive(int256 strikeE8);
    error UnknownDirection(uint8 direction);
    error LockNotInFuture(uint64 lockTime, uint256 currentTime);
    error StartBeforeLock(uint64 lockTime, uint64 startTime);
    error EmptyWindow(uint64 startTime, uint64 endTime);
    error WindowTooLong(uint64 startTime, uint64 endTime);
    error DeadlineOverflow();
    error MalformedEvidence();
    error RoundNotFound(uint80 roundId);
    error RoundCarriedOver(uint80 roundId, uint80 answeredInRound);
    error RoundOutsideWindow(uint80 roundId, uint256 updatedAt, uint64 startTime, uint64 endTime);
    error NonPositivePrice(int256 price);
    error NoTouch(uint80 roundId, int256 priceE8, int256 strikeE8);

    /// @param feeds_ Chainlink aggregator proxies this resolver accepts.
    constructor(address[] memory feeds_) {
        _allowFeeds(feeds_);
    }

    // ---------------------------------------------------------------- IResolver

    /// @inheritdoc IResolver
    function validate(bytes calldata params) external view returns (Window memory window) {
        ChainlinkTouchParams memory p = abi.decode(params, (ChainlinkTouchParams));
        // One encoding per question, so the factory's (template, params) key is unique per question.
        if (keccak256(abi.encode(p)) != keccak256(params)) revert NonCanonicalParams();
        if (!isFeedAllowed[p.feed]) revert FeedNotAllowed(p.feed);
        if (p.strikeE8 <= 0) revert StrikeNotPositive(p.strikeE8);
        if (p.direction > DIRECTION_AT_OR_BELOW) revert UnknownDirection(p.direction);
        // Touch markets run on unix time, like Chainlink's updatedAt.
        // forge-lint: disable-next-line(block-timestamp)
        if (p.lockTime <= block.timestamp) revert LockNotInFuture(p.lockTime, block.timestamp);
        // Staking stops before the first round that can count.
        if (p.startTime < p.lockTime) revert StartBeforeLock(p.lockTime, p.startTime);
        if (p.endTime <= p.startTime) revert EmptyWindow(p.startTime, p.endTime);
        if (p.endTime - p.startTime > MAX_DURATION) revert WindowTooLong(p.startTime, p.endTime);
        uint256 deadline = uint256(p.endTime) + CHALLENGE_PERIOD + SETTLEMENT_WINDOW;
        if (deadline > type(uint64).max) revert DeadlineOverflow();
        // Safe: bounded by type(uint64).max just above.
        // forge-lint: disable-next-line(unsafe-typecast)
        window = Window({blockClock: false, lock: p.lockTime, close: p.endTime, settleDeadline: uint64(deadline)});
    }

    /// @inheritdoc IResolver
    function describe(bytes calldata params) external view returns (string memory) {
        ChainlinkTouchParams memory p = abi.decode(params, (ChainlinkTouchParams));
        string memory pair;
        try IChainlinkAggregator(p.feed).description() returns (string memory d) {
            pair = ResolverText.compactPair(d);
        } catch {
            pair = LibString.toHexStringChecksummed(p.feed);
        }
        return string.concat(
            "YES if Chainlink's ",
            pair,
            " feed reports a price ",
            p.direction == DIRECTION_AT_OR_ABOVE ? "at or above " : "at or below ",
            ResolverText.usd(p.strikeE8, 8),
            " in any round updated from ",
            ResolverText.utc(p.startTime),
            " to ",
            ResolverText.utc(p.endTime),
            "; NO if nobody proves that by ",
            ResolverText.utc(uint256(p.endTime) + CHALLENGE_PERIOD),
            ", the end of a 24-hour challenge period."
        );
    }

    /// @inheritdoc IResolver
    /// @dev Proof: evidence = abi.encode(uint80 roundId). NO: empty evidence. Any ETH sent is returned.
    function resolve(bytes calldata params, bytes calldata evidence)
        external
        payable
        returns (Outcome outcome, bytes32 evidenceHash)
    {
        ChainlinkTouchParams memory p = abi.decode(params, (ChainlinkTouchParams));
        if (!isFeedAllowed[p.feed]) revert FeedNotAllowed(p.feed);
        (outcome, evidenceHash) = evidence.length == 0 ? _resolveNo(p) : _resolveProof(p, evidence);
        if (msg.value != 0) SafeTransferLib.safeTransferETH(msg.sender, msg.value);
    }

    /// @inheritdoc IResolver
    function earlyYes() external pure returns (bool) {
        return true;
    }

    // ---------------------------------------------------------------- internals

    /// YES if round `r` touched the strike inside the window; reverts otherwise.
    function _resolveProof(ChainlinkTouchParams memory p, bytes calldata evidence)
        internal
        view
        returns (Outcome, bytes32)
    {
        if (evidence.length != 32) revert MalformedEvidence();
        uint80 roundId = abi.decode(evidence, (uint80));
        IChainlinkAggregator feed = IChainlinkAggregator(p.feed);

        (bool ok, int256 answer, uint256 updatedAt, uint80 answeredInRound) = _round(feed, roundId);
        if (!ok || updatedAt == 0) revert RoundNotFound(roundId);
        // A round that carried an older answer forward is not a new observation.
        if (answeredInRound != roundId) revert RoundCarriedOver(roundId, answeredInRound);
        if (updatedAt < p.startTime || updatedAt > p.endTime) {
            revert RoundOutsideWindow(roundId, updatedAt, p.startTime, p.endTime);
        }
        if (answer <= 0) revert NonPositivePrice(answer);

        // Safe: a uint8 always fits in int256.
        // forge-lint: disable-next-line(unsafe-typecast)
        int256 exponent = -int256(uint256(_roundDecimals(feed, roundId)));
        int256 priceE8;
        bool touched;
        if (p.direction == DIRECTION_AT_OR_ABOVE) {
            priceE8 = PriceScale.toE8(answer, exponent);
            touched = priceE8 >= p.strikeE8;
        } else {
            priceE8 = PriceScale.toE8Ceil(answer, exponent);
            touched = priceE8 <= p.strikeE8;
        }
        if (!touched) revert NoTouch(roundId, priceE8, p.strikeE8);
        return (Outcome.Yes, keccak256(abi.encode(p.feed, roundId, updatedAt, answer)));
    }

    /// NO once the challenge period is over and the feed reported at or after the window's end.
    function _resolveNo(ChainlinkTouchParams memory p) internal view returns (Outcome, bytes32) {
        uint256 challengeEnd = uint256(p.endTime) + CHALLENGE_PERIOD;
        // A timestamp a few seconds off can only move NO by those seconds, inside a 24-hour period.
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < challengeEnd) return (Outcome.Unresolved, bytes32(0));
        try IChainlinkLatestRound(p.feed).latestRoundData() returns (
            uint80 latestId, int256, uint256, uint256 latestUpdatedAt, uint80
        ) {
            if (latestUpdatedAt < p.endTime) return (Outcome.Unresolved, bytes32(0));
            return (Outcome.No, keccak256(abi.encode(p.feed, p.endTime, challengeEnd, latestId, latestUpdatedAt)));
        } catch {
            return (Outcome.Unresolved, bytes32(0));
        }
    }
}

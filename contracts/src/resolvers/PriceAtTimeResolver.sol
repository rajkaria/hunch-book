// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {LibString} from "solady/utils/LibString.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {IResolver} from "../interfaces/IResolver.sol";
import {Outcome, Window} from "../interfaces/IHunchBookTypes.sol";
import {PriceAtTimeParams} from "../interfaces/ITemplates.sol";
import {IChainlinkAggregator} from "../interfaces/external/IChainlinkAggregator.sol";
import {IPyth} from "../interfaces/external/IPyth.sol";
import {PriceScale} from "./PriceScale.sol";
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
contract PriceAtTimeResolver is IResolver {
    uint8 public constant SOURCE_CHAINLINK = 0;
    uint8 public constant SOURCE_PYTH = 1;

    /// Settlement stays open this long after `closeTime` (docs/PROTOCOL.md §2).
    uint256 public constant SETTLEMENT_WINDOW = 7 days;

    /// The accepted Chainlink round must have been updated at most this long before T.
    uint256 public constant MAX_STALENESS = 1 hours;

    /// The accepted Pyth update must be published within this long after T.
    uint256 public constant PYTH_MAX_DELAY = 60;

    /// The Chainlink round named by the settler and its successor, as read.
    struct Bracket {
        uint80 roundId;
        int256 answer;
        uint256 updatedAt;
        uint256 nextUpdatedAt;
        uint256 target;
    }

    /// Pyth's contract on this network; zero where Pyth is not used.
    IPyth public immutable pyth;

    mapping(address feed => bool) public isFeedAllowed;
    mapping(bytes32 id => bool) public isPythIdAllowed;
    mapping(bytes32 id => string) internal _pythLabel;
    address[] internal _feeds;
    bytes32[] internal _pythIds;

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
    constructor(address[] memory feeds_, IPyth pyth_, bytes32[] memory pythIds_, string[] memory pythLabels_) {
        if (pythIds_.length != pythLabels_.length) revert LengthMismatch();
        if (pythIds_.length != 0 && address(pyth_).code.length == 0) revert NotAContract(address(pyth_));
        pyth = pyth_;

        // Reverting inside these loops is intended: one bad entry rejects the whole deployment.
        for (uint256 i = 0; i < feeds_.length; ++i) {
            address feed = feeds_[i];
            // forge-lint: disable-next-line(require-revert-in-loop)
            if (feed.code.length == 0) revert NotAContract(feed);
            // forge-lint: disable-next-line(require-revert-in-loop)
            if (isFeedAllowed[feed]) revert DuplicateEntry();
            isFeedAllowed[feed] = true;
            _feeds.push(feed);
        }
        for (uint256 i = 0; i < pythIds_.length; ++i) {
            bytes32 id = pythIds_[i];
            // forge-lint: disable-next-line(require-revert-in-loop)
            if (isPythIdAllowed[id]) revert DuplicateEntry();
            // forge-lint: disable-next-line(require-revert-in-loop)
            if (bytes(pythLabels_[i]).length == 0) revert EmptyLabel();
            isPythIdAllowed[id] = true;
            _pythLabel[id] = pythLabels_[i];
            _pythIds.push(id);
        }
    }

    // ---------------------------------------------------------------- IResolver

    /// @inheritdoc IResolver
    function validate(bytes calldata params) external view returns (Window memory window) {
        PriceAtTimeParams memory p = abi.decode(params, (PriceAtTimeParams));
        // One encoding per question, so the factory's (template, params) key is unique per question.
        if (keccak256(abi.encode(p)) != keccak256(params)) revert NonCanonicalParams();
        _checkSource(p);
        if (p.strikeE8 <= 0) revert StrikeNotPositive(p.strikeE8);
        // Price markets run on unix time by design (docs/PROTOCOL.md §6.2); Monad timestamps have
        // one-second resolution and cannot run ahead of real time by more than a few seconds.
        // forge-lint: disable-next-line(block-timestamp)
        if (p.lockTime <= block.timestamp) revert LockNotInFuture(p.lockTime, block.timestamp);
        if (p.closeTime < p.lockTime) revert CloseBeforeLock(p.lockTime, p.closeTime);
        uint256 deadline = uint256(p.closeTime) + SETTLEMENT_WINDOW;
        if (deadline > type(uint64).max) revert DeadlineOverflow();
        // Safe: bounded by type(uint64).max just above.
        // forge-lint: disable-next-line(unsafe-typecast)
        window = Window({blockClock: false, lock: p.lockTime, close: p.closeTime, settleDeadline: uint64(deadline)});
    }

    /// @inheritdoc IResolver
    function describe(bytes calldata params) external view returns (string memory) {
        PriceAtTimeParams memory p = abi.decode(params, (PriceAtTimeParams));
        string memory pair;
        string memory source;
        if (p.source == SOURCE_CHAINLINK) {
            try IChainlinkAggregator(p.feed).description() returns (string memory d) {
                pair = ResolverText.compactPair(d);
            } catch {
                pair = LibString.toHexStringChecksummed(p.feed);
            }
            source = string.concat("Chainlink's ", pair, " feed");
        } else if (p.source == SOURCE_PYTH) {
            pair = _pythLabel[p.pythId];
            if (bytes(pair).length == 0) pair = LibString.toHexString(uint256(p.pythId), 32);
            source = string.concat("Pyth's ", pair, " feed");
        } else {
            revert UnknownSource(p.source);
        }
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
        _checkSource(p);
        uint256 spent = 0;
        // The answer is only read after T. The round or update itself must bracket T, so a
        // timestamp a few seconds off can delay settlement but never change the answer.
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp > p.closeTime) {
            if (p.source == SOURCE_CHAINLINK) {
                (outcome, evidenceHash) = _resolveChainlink(p, evidence);
            } else {
                (outcome, evidenceHash, spent) = _resolvePyth(p, evidence);
            }
        }
        uint256 refund = msg.value - spent;
        if (refund != 0) SafeTransferLib.safeTransferETH(msg.sender, refund);
    }

    /// @inheritdoc IResolver
    function earlyYes() external pure returns (bool) {
        return false;
    }

    // ---------------------------------------------------------------- views

    function feeds() external view returns (address[] memory) {
        return _feeds;
    }

    function pythIds() external view returns (bytes32[] memory) {
        return _pythIds;
    }

    function pythLabel(bytes32 id) external view returns (string memory) {
        return _pythLabel[id];
    }

    // ---------------------------------------------------------------- internals

    function _checkSource(PriceAtTimeParams memory p) internal view {
        if (p.source == SOURCE_CHAINLINK) {
            if (!isFeedAllowed[p.feed]) revert FeedNotAllowed(p.feed);
            if (p.pythId != bytes32(0)) revert UnusedFieldSet();
        } else if (p.source == SOURCE_PYTH) {
            if (address(pyth) == address(0)) revert PythNotConfigured();
            if (!isPythIdAllowed[p.pythId]) revert PythIdNotAllowed(p.pythId);
            if (p.feed != address(0)) revert UnusedFieldSet();
        } else {
            revert UnknownSource(p.source);
        }
    }

    function _resolveChainlink(PriceAtTimeParams memory p, bytes calldata evidence)
        internal
        view
        returns (Outcome, bytes32)
    {
        if (evidence.length != 32) revert MalformedEvidence();
        Bracket memory b;
        b.roundId = abi.decode(evidence, (uint80));
        // r + 1 must be in r's phase: the low 64 bits are the round within the phase.
        // forge-lint: disable-next-line(unsafe-typecast)
        if (uint64(b.roundId) == type(uint64).max) revert PhaseBoundary(b.roundId);
        b.target = p.closeTime;
        IChainlinkAggregator feed = IChainlinkAggregator(p.feed);

        // No round after r yet: the answer is not known. (A caught failure only ever yields Unresolved.)
        bool ok;
        (ok,, b.nextUpdatedAt) = _round(feed, b.roundId + 1);
        if (!ok || b.nextUpdatedAt == 0) return (Outcome.Unresolved, bytes32(0));

        (ok, b.answer, b.updatedAt) = _round(feed, b.roundId);
        if (!ok || b.updatedAt == 0) revert RoundNotFound(b.roundId);
        if (b.updatedAt > b.target) revert RoundAfterTarget(b.roundId, b.updatedAt, b.target);
        if (b.nextUpdatedAt <= b.target) revert RoundNotLastBeforeTarget(b.roundId, b.nextUpdatedAt, b.target);
        if (b.target - b.updatedAt > MAX_STALENESS) revert RoundTooStale(b.roundId, b.updatedAt, b.target);
        if (b.answer <= 0) revert NonPositivePrice(b.answer);

        // Safe: a uint8 always fits in int256.
        // forge-lint: disable-next-line(unsafe-typecast)
        int256 priceE8 = PriceScale.toE8(b.answer, -int256(uint256(feed.decimals())));
        Outcome outcome = priceE8 >= p.strikeE8 ? Outcome.Yes : Outcome.No;
        bytes32 evidenceHash = keccak256(
            abi.encode(SOURCE_CHAINLINK, p.feed, b.roundId, b.answer, b.updatedAt, b.nextUpdatedAt, b.target)
        );
        return (outcome, evidenceHash);
    }

    function _resolvePyth(PriceAtTimeParams memory p, bytes calldata evidence)
        internal
        returns (Outcome, bytes32, uint256 fee)
    {
        IPyth.Price memory price;
        (price, fee) = _pythPriceAt(p.pythId, p.closeTime, abi.decode(evidence, (bytes[])));
        if (price.price <= 0) revert NonPositivePrice(price.price);

        int256 priceE8 = PriceScale.toE8(price.price, price.expo);
        Outcome outcome = priceE8 >= p.strikeE8 ? Outcome.Yes : Outcome.No;
        // abi.encode(uint8 1, pyth, id, (price, conf, expo, publishTime), uint64 T)
        bytes32 evidenceHash = keccak256(abi.encode(SOURCE_PYTH, address(pyth), p.pythId, price, p.closeTime));
        return (outcome, evidenceHash, fee);
    }

    /// The first update for `id` published in [target, target + 60 s], verified by Pyth. Pays the fee
    /// out of msg.value.
    function _pythPriceAt(bytes32 id, uint64 target, bytes[] memory updateData)
        internal
        returns (IPyth.Price memory price, uint256 fee)
    {
        fee = pyth.getUpdateFee(updateData);
        if (msg.value < fee) revert InsufficientFee(fee, msg.value);

        uint256 latest = uint256(target) + PYTH_MAX_DELAY;
        if (latest > type(uint64).max) revert DeadlineOverflow();
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = id;
        // Safe: bounded by type(uint64).max just above.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint64 maxPublishTime = uint64(latest);
        IPyth.PriceFeed[] memory out =
            pyth.parsePriceFeedUpdatesUnique{value: fee}(updateData, ids, target, maxPublishTime);

        // Pyth already enforces these; checking again costs little and keeps the rule local.
        if (out.length != 1 || out[0].id != id) revert PythFeedMismatch();
        price = out[0].price;
        if (price.publishTime < target || price.publishTime > latest) {
            revert PythPublishTimeOutOfRange(price.publishTime, target);
        }
    }

    function _round(IChainlinkAggregator feed, uint80 roundId)
        internal
        view
        returns (bool ok, int256 answer, uint256 updatedAt)
    {
        try feed.getRoundData(roundId) returns (uint80 id, int256 a, uint256, uint256 u, uint80) {
            // A proxy echoes the full round id; anything else is not the round that was asked for.
            if (id != roundId) return (false, 0, 0);
            return (true, a, u);
        } catch {
            return (false, 0, 0);
        }
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {LibString} from "solady/utils/LibString.sol";
import {Window} from "../interfaces/IHunchBookTypes.sol";
import {IChainlinkAggregator} from "../interfaces/external/IChainlinkAggregator.sol";
import {IPyth} from "../interfaces/external/IPyth.sol";
import {
    ChainlinkFeeds,
    DuplicateEntry,
    FeedNotAllowed,
    MalformedEvidence,
    NonPositivePrice,
    NotAContract,
    RoundNotFound
} from "./ChainlinkFeeds.sol";
import {PriceScale} from "./PriceScale.sol";
import {ResolverText} from "./ResolverText.sol";

// File-level errors; see ChainlinkFeeds.sol for why.
error LengthMismatch();
error EmptyLabel();
error PythNotConfigured();
error UnknownSource(uint8 source);
error PythIdNotAllowed(bytes32 id);
error UnusedFieldSet();
error LockNotInFuture(uint64 lockTime, uint256 currentTime);
error CloseBeforeLock(uint64 lockTime, uint64 closeTime);
error DeadlineOverflow();
error PhaseBoundary(uint80 roundId);
error RoundAfterTarget(uint80 roundId, uint256 updatedAt, uint256 target);
error RoundNotLastBeforeTarget(uint80 roundId, uint256 nextUpdatedAt, uint256 target);
error RoundTooStale(uint80 roundId, uint256 updatedAt, uint256 target);
error InsufficientFee(uint256 fee, uint256 sent);
error PythFeedMismatch();
error PythPublishTimeOutOfRange(uint256 publishTime, uint256 target);

/// @title The price at a time T, shared by templates 2 (price at a time) and 5 (price range)
/// @notice How the price at T is read (docs/PROTOCOL.md §6.2):
///         - Chainlink (source 0): the settler names round r. It is accepted only if r and r + 1 are in
///           the same phase, updatedAt(r) <= T < updatedAt(r + 1), T − updatedAt(r) <= 1 hour and the
///           answer is positive. Within a phase updatedAt never decreases, so at most one round can
///           satisfy this for a given T: nobody can pick a convenient price.
///         - Pyth (source 1): the settler passes signed updates. Pyth's `parsePriceFeedUpdatesUnique`
///           with [T, T + 60 s] returns only the first update published at or after T.
/// @dev The feed and Pyth-id allowlists are written once in the constructor and can never change.
///      A failed read of round r + 1 only ever yields "not known yet"; every other failure reverts.
///      A round is scaled with the decimals of the phase aggregator that wrote it.
///
///      evidenceHash, for the settlement verifier:
///      - Chainlink: keccak256(abi.encode(uint8 0, address feed, uint80 r, int256 answer,
///        uint256 updatedAt(r), uint256 updatedAt(r + 1), uint256 T))
///      - Pyth: keccak256(abi.encode(uint8 1, address pyth, bytes32 id,
///        (int64 price, uint64 conf, int32 expo, uint256 publishTime), uint64 T))
abstract contract PriceAtTimeReader is ChainlinkFeeds {
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

    /// The price at T, normalised to 8 decimals, and the evidence hash of the read.
    struct PriceRead {
        bool known; // false: T has not passed, or Chainlink has no round after T yet
        int256 priceE8;
        bytes32 evidenceHash;
        uint256 fee; // Pyth's update fee paid out of msg.value
    }

    /// Pyth's contract on this network; zero where Pyth is not used.
    IPyth public immutable pyth;

    mapping(bytes32 id => bool) public isPythIdAllowed;
    mapping(bytes32 id => string) internal _pythLabel;
    bytes32[] internal _pythIds;

    /// @param feeds_ Chainlink aggregator proxies this resolver accepts.
    /// @param pyth_ Pyth's contract, or zero on a network without Pyth (then `pythIds_` must be empty).
    /// @param pythIds_ Pyth price ids this resolver accepts.
    /// @param pythLabels_ the pair shown in `describe` for each Pyth id, for example "SOL/USD".
    constructor(address[] memory feeds_, IPyth pyth_, bytes32[] memory pythIds_, string[] memory pythLabels_) {
        if (pythIds_.length != pythLabels_.length) revert LengthMismatch();
        if (pythIds_.length != 0 && address(pyth_).code.length == 0) revert NotAContract(address(pyth_));
        pyth = pyth_;

        _allowFeeds(feeds_);
        // Reverting inside this loop is intended: one bad entry rejects the whole deployment.
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

    // ---------------------------------------------------------------- views

    function pythIds() external view returns (bytes32[] memory) {
        return _pythIds;
    }

    function pythLabel(bytes32 id) external view returns (string memory) {
        return _pythLabel[id];
    }

    // ---------------------------------------------------------------- internals

    function _checkSource(uint8 source, address feed, bytes32 pythId) internal view {
        if (source == SOURCE_CHAINLINK) {
            if (!isFeedAllowed[feed]) revert FeedNotAllowed(feed);
            if (pythId != bytes32(0)) revert UnusedFieldSet();
        } else if (source == SOURCE_PYTH) {
            if (address(pyth) == address(0)) revert PythNotConfigured();
            if (!isPythIdAllowed[pythId]) revert PythIdNotAllowed(pythId);
            if (feed != address(0)) revert UnusedFieldSet();
        } else {
            revert UnknownSource(source);
        }
    }

    /// Lock in the future, close at or after lock; settlement open for seven days after close.
    function _timeWindow(uint64 lockTime, uint64 closeTime) internal view returns (Window memory) {
        // Price markets run on unix time by design (docs/PROTOCOL.md §6.2); Monad timestamps have
        // one-second resolution and cannot run ahead of real time by more than a few seconds.
        // forge-lint: disable-next-line(block-timestamp)
        if (lockTime <= block.timestamp) revert LockNotInFuture(lockTime, block.timestamp);
        if (closeTime < lockTime) revert CloseBeforeLock(lockTime, closeTime);
        uint256 deadline = uint256(closeTime) + SETTLEMENT_WINDOW;
        if (deadline > type(uint64).max) revert DeadlineOverflow();
        // Safe: bounded by type(uint64).max just above.
        // forge-lint: disable-next-line(unsafe-typecast)
        return Window({blockClock: false, lock: lockTime, close: closeTime, settleDeadline: uint64(deadline)});
    }

    /// The pair ("BTC/USD") and the source ("Chainlink's BTC/USD feed") for `describe`.
    function _sourceText(uint8 source, address feed, bytes32 pythId)
        internal
        view
        returns (string memory pair, string memory sourceText)
    {
        if (source == SOURCE_CHAINLINK) {
            try IChainlinkAggregator(feed).description() returns (string memory d) {
                pair = ResolverText.compactPair(d);
            } catch {
                pair = LibString.toHexStringChecksummed(feed);
            }
            sourceText = string.concat("Chainlink's ", pair, " feed");
        } else if (source == SOURCE_PYTH) {
            pair = _pythLabel[pythId];
            if (bytes(pair).length == 0) pair = LibString.toHexString(uint256(pythId), 32);
            sourceText = string.concat("Pyth's ", pair, " feed");
        } else {
            revert UnknownSource(source);
        }
    }

    /// The price at `target`, read from the source the params name. Not known until after `target`.
    /// The caller must have run `_checkSource` and refunds `msg.value - read.fee` itself.
    function _priceAt(uint8 source, address feed, bytes32 pythId, uint64 target, bytes calldata evidence)
        internal
        returns (PriceRead memory read)
    {
        // The answer is only read after T. The round or update itself must bracket T, so a
        // timestamp a few seconds off can delay settlement but never change the answer.
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp <= target) return read;
        if (source == SOURCE_CHAINLINK) {
            (read.known, read.priceE8, read.evidenceHash) = _chainlinkAt(feed, target, evidence);
        } else {
            (read.priceE8, read.evidenceHash, read.fee) = _pythAt(pythId, target, evidence);
            read.known = true;
        }
    }

    function _chainlinkAt(address feedAddress, uint64 target, bytes calldata evidence)
        internal
        view
        returns (bool, int256, bytes32)
    {
        if (evidence.length != 32) revert MalformedEvidence();
        Bracket memory b;
        b.roundId = abi.decode(evidence, (uint80));
        // r + 1 must be in r's phase: the low 64 bits are the round within the phase.
        // forge-lint: disable-next-line(unsafe-typecast)
        if (uint64(b.roundId) == type(uint64).max) revert PhaseBoundary(b.roundId);
        b.target = target;
        IChainlinkAggregator feed = IChainlinkAggregator(feedAddress);

        // No round after r yet: the answer is not known. (A caught failure only ever yields "not known".)
        bool ok;
        (ok,, b.nextUpdatedAt,) = _round(feed, b.roundId + 1);
        if (!ok || b.nextUpdatedAt == 0) return (false, 0, bytes32(0));

        (ok, b.answer, b.updatedAt,) = _round(feed, b.roundId);
        if (!ok || b.updatedAt == 0) revert RoundNotFound(b.roundId);
        if (b.updatedAt > b.target) revert RoundAfterTarget(b.roundId, b.updatedAt, b.target);
        if (b.nextUpdatedAt <= b.target) revert RoundNotLastBeforeTarget(b.roundId, b.nextUpdatedAt, b.target);
        if (b.target - b.updatedAt > MAX_STALENESS) revert RoundTooStale(b.roundId, b.updatedAt, b.target);
        if (b.answer <= 0) revert NonPositivePrice(b.answer);

        // Safe: a uint8 always fits in int256.
        // forge-lint: disable-next-line(unsafe-typecast)
        int256 priceE8 = PriceScale.toE8(b.answer, -int256(uint256(_roundDecimals(feed, b.roundId))));
        bytes32 evidenceHash = keccak256(
            abi.encode(SOURCE_CHAINLINK, feedAddress, b.roundId, b.answer, b.updatedAt, b.nextUpdatedAt, b.target)
        );
        return (true, priceE8, evidenceHash);
    }

    function _pythAt(bytes32 pythId, uint64 target, bytes calldata evidence)
        internal
        returns (int256 priceE8, bytes32 evidenceHash, uint256 fee)
    {
        IPyth.Price memory price;
        (price, fee) = _pythPriceAt(pythId, target, abi.decode(evidence, (bytes[])));
        if (price.price <= 0) revert NonPositivePrice(price.price);
        priceE8 = PriceScale.toE8(price.price, price.expo);
        // abi.encode(uint8 1, pyth, id, (price, conf, expo, publishTime), uint64 T)
        evidenceHash = keccak256(abi.encode(SOURCE_PYTH, address(pyth), pythId, price, target));
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
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {LibString} from "solady/utils/LibString.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {IResolver} from "../interfaces/IResolver.sol";
import {Outcome, Window} from "../interfaces/IHunchBookTypes.sol";
import {Snapshot, SnapshotParams, SnapshotSource} from "../interfaces/ITemplatesV3.sol";
import {ResolverText} from "./ResolverText.sol";
import {SnapshotStore} from "./SnapshotStore.sol";

/// @title Template 7: a value read once, in a short window right after close (docs/TEMPLATES.md)
/// @notice "Will SOURCE read above (or at or above, below, at or below) X in the first snapshot taken
///         in [T, T + W]?" For values a contract exposes only as current state, such as Perpl's open
///         interest and mark price: no contract can read them for a past block, so the resolver reads
///         them at the time and keeps what it read.
///         - Sources are fixed at deployment. Each is a view call (target and call data), the word of
///           its return data that holds the value, and checks that the value still means what it
///           meant then: words that must read the same (for Perpl: the perp's units, funding start
///           block and status), an extra call whose answer must not change (Perpl's version), and a
///           maximum age where the source stamps its value (Perpl's mark price).
///         - Anyone takes the snapshot of an observation (source, T, W), once, at any block whose
///           timestamp is in [T, T + W]: through `snapshot`, or through a market's `settle`, which
///           takes it if nobody has yet. The resolver makes the call itself and stores (value, block,
///           timestamp). The first snapshot is final; nothing can replace it. Every market on the
///           same observation answers from it, whatever its threshold or comparator.
///         - `resolve`: with a snapshot, YES if the value meets the threshold under the comparator, NO
///           otherwise. Without one, `Unresolved`: before T, while the source cannot be read inside
///           the window, and for good once the window has passed (the market voids at its deadline).
///         The trust model, stated plainly: whoever snapshots first picks the block inside the window,
///         and anyone who can move the source can try to move it at that block. The window is short
///         (one to thirty minutes), and a keeper that settles at the first block after T takes the
///         snapshot there. docs/TEMPLATES.md describes the residual risk.
/// @dev No owner, no admin function, no funds between calls. The only storage written after
///      deployment is the snapshot store (SnapshotStore), write-once per observation, and only with a
///      value this contract has just read from an allowlisted source inside the observation's window.
///      Reads copy single words out of the return data, so a source that returns more than expected
///      costs nothing extra, and one that returns less fails the read instead of decoding garbage.
///      A failed or refused read never stores anything: `snapshot` reverts, `resolve` answers
///      `Unresolved`, and someone can try again later in the window.
///
///      evidenceHash, for the settlement verifier: keccak256(abi.encode(address target,
///      bytes callData, uint16 valueWord, int256 value, uint64 blockNumber, uint64 timestamp)): the
///      call made, the word read, the value, and the block and time of the snapshot transaction.
contract SnapshotResolver is IResolver, SnapshotStore {
    /// Comparator 0: YES if the value is above the threshold.
    uint8 public constant ABOVE = 0;
    /// Comparator 1: YES if the value is at or above the threshold.
    uint8 public constant AT_OR_ABOVE = 1;
    /// Comparator 2: YES if the value is below the threshold.
    uint8 public constant BELOW = 2;
    /// Comparator 3: YES if the value is at or below the threshold.
    uint8 public constant AT_OR_BELOW = 3;

    /// The shortest and longest snapshot windows a market can have. Short keeps the snapshot taker's
    /// choice of block small; at least a minute leaves room to retry a read that failed.
    uint32 public constant MIN_SNAPSHOT_WINDOW = 1 minutes;
    uint32 public constant MAX_SNAPSHOT_WINDOW = 30 minutes;

    /// Settlement stays open this long after the snapshot window closes (docs/PROTOCOL.md §2).
    uint256 public constant SETTLEMENT_WINDOW = 7 days;

    /// Word indexes must be below this, so a read copies at most a few words of any return.
    uint256 public constant MAX_WORDS = 64;
    /// At most this many pinned words per source.
    uint256 public constant MAX_PINNED_WORDS = 8;
    /// A guard call's answer is hashed whole; a longer answer fails the read.
    uint256 public constant MAX_GUARD_RETURN = 1024;

    /// Why a read could not be used. `Ok` means the value can be stored.
    enum ReadStatus {
        Ok,
        CallFailed, // the source call reverted
        ReturnTooShort, // a word asked for is not in the return data
        OutOfRange, // an unsigned value above type(int256).max
        Stale, // older than the source's maxAge
        GuardFailed, // the guard call reverted or answered with too much data
        Changed // a pinned word or the guard's answer differs from deployment
    }

    struct Read {
        ReadStatus status;
        int256 value;
        uint256 raw; // the value's word as returned
        uint256 updatedAt; // the source's own timestamp, when it has one
        bytes32 pin; // hash of the pinned words and the guard's answer
    }

    SnapshotSource[] internal _sources;
    /// For each source, the hash of its pinned words and guard answer as read at deployment.
    bytes32[] internal _pins;

    // Every error this resolver can revert with. SnapshotStore reverts with a file-level error of the
    // same signature (so the same selector); declaring it here lists it in this contract's ABI and lets
    // callers write `SnapshotResolver.SnapshotExists.selector`.
    error NotAContract(address account);
    error NoSources();
    error TooManySources(uint256 count);
    error EmptyLabel();
    error MissingSelector();
    error WordOutOfRange(uint256 word);
    error TooManyPinnedWords(uint256 count);
    error UnusedFieldSet();
    error DuplicateEntry();
    error NonCanonicalParams();
    error UnknownSource(uint16 sourceId);
    error UnknownComparator(uint8 comparator);
    error SnapshotWindowOutOfRange(uint32 snapshotWindow);
    error LockNotInFuture(uint64 lockTime, uint256 currentTime);
    error CloseBeforeLock(uint64 lockTime, uint64 closeTime);
    error DeadlineOverflow();
    error EvidenceNotEmpty();
    error OutsideSnapshotWindow(uint64 opensAt, uint256 closesAt, uint256 currentTime);
    error SnapshotExists(bytes32 key);
    error SourceCallFailed(uint16 sourceId);
    error SourceReturnTooShort(uint16 sourceId);
    error ValueOutOfRange(uint16 sourceId, uint256 raw);
    error ValueStale(uint16 sourceId, uint256 updatedAt, uint256 maxAge);
    error GuardCallFailed(uint16 sourceId);
    error SourceChanged(uint16 sourceId);

    /// @param sources_ the values markets can be about, ids in this order. Each is read once here: a
    ///        source that cannot be read now, or is stale now, rejects the whole deployment, and the
    ///        pinned words and guard answer read now are what later reads must match.
    constructor(SnapshotSource[] memory sources_) {
        if (sources_.length == 0) revert NoSources();
        if (sources_.length > uint256(type(uint16).max) + 1) revert TooManySources(sources_.length);
        bytes32[] memory identities = new bytes32[](sources_.length);
        for (uint256 i = 0; i < sources_.length; ++i) {
            SnapshotSource memory s = sources_[i];
            _checkConfig(s);
            identities[i] = keccak256(abi.encode(s.target, s.callData, s.tuple, s.valueWord));
            for (uint256 j = 0; j < i; ++j) {
                // forge-lint: disable-next-line(require-revert-in-loop)
                if (identities[j] == identities[i]) revert DuplicateEntry();
            }
            _sources.push(s);
            // Safe: the length check above keeps every index within uint16.
            // forge-lint: disable-next-line(unsafe-typecast)
            uint16 id = uint16(i);
            Read memory r = _read(id);
            if (r.status != ReadStatus.Ok) _revertFor(id, r);
            _pins.push(r.pin);
        }
    }

    // ---------------------------------------------------------------- IResolver

    /// @inheritdoc IResolver
    function validate(bytes calldata params) external view returns (Window memory window) {
        SnapshotParams memory p = _decode(params);
        // Snapshot markets run on unix time, like the window they are read in.
        // forge-lint: disable-next-line(block-timestamp)
        if (p.lockTime <= block.timestamp) revert LockNotInFuture(p.lockTime, block.timestamp);
        if (p.closeTime < p.lockTime) revert CloseBeforeLock(p.lockTime, p.closeTime);
        // A new market needs a source that answers now, with what it meant at deployment.
        _readChecked(p.sourceId);
        uint256 deadline = _windowEnd(p) + SETTLEMENT_WINDOW;
        if (deadline > type(uint64).max) revert DeadlineOverflow();
        // Safe: bounded by type(uint64).max just above.
        // forge-lint: disable-next-line(unsafe-typecast)
        window = Window({blockClock: false, lock: p.lockTime, close: p.closeTime, settleDeadline: uint64(deadline)});
    }

    /// @inheritdoc IResolver
    function describe(bytes calldata params) external view returns (string memory) {
        SnapshotParams memory p = abi.decode(params, (SnapshotParams));
        if (p.sourceId >= _sources.length) {
            return string.concat("Unknown snapshot source ", LibString.toString(p.sourceId), ".");
        }
        SnapshotSource storage s = _sources[p.sourceId];
        string memory threshold = keccak256(bytes(s.unit)) == keccak256("USD")
            ? ResolverText.usd(p.threshold, s.decimals)
            : string.concat(ResolverText.signedDecimal(p.threshold, s.decimals), " ", s.unit);
        return string.concat(
            "YES if ",
            s.label,
            " is ",
            _comparatorText(p.comparator),
            " ",
            threshold,
            " in the first snapshot taken from ",
            ResolverText.utc(p.closeTime),
            " to ",
            ResolverText.utc(_windowEnd(p)),
            "; NO otherwise. If nobody takes a snapshot in that window, the market voids."
        );
    }

    /// @inheritdoc IResolver
    /// @dev `evidence` must be empty. Without a snapshot, inside the window, this takes one first, so
    ///      a market's `settle` at the first block after close settles it in one transaction. Any ETH
    ///      sent is returned.
    function resolve(bytes calldata params, bytes calldata evidence)
        external
        payable
        returns (Outcome outcome, bytes32 evidenceHash)
    {
        if (evidence.length != 0) revert EvidenceNotEmpty();
        SnapshotParams memory p = _decode(params);
        Snapshot memory s = _snapshots[snapshotKey(p.sourceId, p.closeTime, p.snapshotWindow)];
        if (s.blockNumber == 0 && _inWindow(p.closeTime, p.snapshotWindow)) {
            Read memory r = _readPinned(p.sourceId);
            if (r.status == ReadStatus.Ok) s = _record(p.sourceId, p.closeTime, p.snapshotWindow, r.value);
        }
        if (s.blockNumber != 0) {
            outcome = _holds(s.value, p.threshold, p.comparator) ? Outcome.Yes : Outcome.No;
            evidenceHash = _evidenceHash(p.sourceId, s);
        }
        if (msg.value != 0) SafeTransferLib.safeTransferETH(msg.sender, msg.value);
    }

    /// @inheritdoc IResolver
    function earlyYes() external pure returns (bool) {
        return false;
    }

    // ---------------------------------------------------------------- snapshots

    /// Takes the snapshot of source `sourceId` for the window [closeTime, closeTime + snapshotWindow]:
    /// reads the source now and stores the value, for every market on that observation. Anyone, once,
    /// at a block whose timestamp is in the window. Reverts outside the window, if the snapshot exists,
    /// or if the source cannot be read or no longer means what it meant at deployment (nothing is
    /// stored; try again later in the window).
    function snapshot(uint16 sourceId, uint64 closeTime, uint32 snapshotWindow) external returns (int256 value) {
        _checkObservation(sourceId, snapshotWindow);
        bytes32 key = snapshotKey(sourceId, closeTime, snapshotWindow);
        if (_snapshots[key].blockNumber != 0) revert SnapshotExists(key);
        if (!_inWindow(closeTime, snapshotWindow)) {
            revert OutsideSnapshotWindow(closeTime, uint256(closeTime) + snapshotWindow, block.timestamp);
        }
        value = _readChecked(sourceId);
        _record(sourceId, closeTime, snapshotWindow, value);
    }

    // ---------------------------------------------------------------- views

    /// The snapshot a market with these params answers from, and its key; all zero if none yet.
    function snapshotFor(bytes calldata params) external view returns (bytes32 key, Snapshot memory) {
        SnapshotParams memory p = abi.decode(params, (SnapshotParams));
        key = snapshotKey(p.sourceId, p.closeTime, p.snapshotWindow);
        return (key, _snapshots[key]);
    }

    /// The number of sources; ids run from 0 to `sourceCount() - 1`.
    function sourceCount() external view returns (uint256) {
        return _sources.length;
    }

    /// Source `sourceId` as configured at deployment.
    function source(uint16 sourceId) external view returns (SnapshotSource memory) {
        if (sourceId >= _sources.length) revert UnknownSource(sourceId);
        return _sources[sourceId];
    }

    /// The hash of source `sourceId`'s pinned words and guard answer as read at deployment.
    function sourcePin(uint16 sourceId) external view returns (bytes32) {
        if (sourceId >= _sources.length) revert UnknownSource(sourceId);
        return _pins[sourceId];
    }

    /// What a snapshot of source `sourceId` would store now. Reverts for the same reasons `snapshot`
    /// would, apart from the window.
    function currentValue(uint16 sourceId) external view returns (int256) {
        if (sourceId >= _sources.length) revert UnknownSource(sourceId);
        return _readChecked(sourceId);
    }

    // ---------------------------------------------------------------- params

    /// Decodes params and applies every check that depends on neither the clock nor the source's state.
    function _decode(bytes calldata params) internal view returns (SnapshotParams memory p) {
        p = abi.decode(params, (SnapshotParams));
        // One encoding per question, so the factory's (template, params) key is unique per question.
        if (keccak256(abi.encode(p)) != keccak256(params)) revert NonCanonicalParams();
        _checkObservation(p.sourceId, p.snapshotWindow);
        if (p.comparator > AT_OR_BELOW) revert UnknownComparator(p.comparator);
    }

    function _checkObservation(uint16 sourceId, uint32 snapshotWindow) internal view {
        if (sourceId >= _sources.length) revert UnknownSource(sourceId);
        if (snapshotWindow < MIN_SNAPSHOT_WINDOW || snapshotWindow > MAX_SNAPSHOT_WINDOW) {
            revert SnapshotWindowOutOfRange(snapshotWindow);
        }
    }

    function _windowEnd(SnapshotParams memory p) internal pure returns (uint256) {
        return uint256(p.closeTime) + p.snapshotWindow;
    }

    /// True at a block whose timestamp is in [closeTime, closeTime + snapshotWindow], both ends included.
    function _inWindow(uint64 closeTime, uint32 snapshotWindow) internal view returns (bool) {
        // The window is defined in unix time; a validator's few seconds of drift only shift the block
        // that counts, inside a window of at least a minute.
        // forge-lint: disable-next-line(block-timestamp)
        return block.timestamp >= closeTime && block.timestamp <= uint256(closeTime) + snapshotWindow;
    }

    function _holds(int256 value, int256 threshold, uint8 comparator) internal pure returns (bool) {
        if (comparator == ABOVE) return value > threshold;
        if (comparator == AT_OR_ABOVE) return value >= threshold;
        if (comparator == BELOW) return value < threshold;
        return value <= threshold;
    }

    function _comparatorText(uint8 comparator) internal pure returns (string memory) {
        if (comparator == ABOVE) return "above";
        if (comparator == AT_OR_ABOVE) return "at or above";
        if (comparator == BELOW) return "below";
        if (comparator == AT_OR_BELOW) return "at or below";
        return string.concat("(comparator ", LibString.toString(comparator), ")");
    }

    function _evidenceHash(uint16 sourceId, Snapshot memory s) internal view returns (bytes32) {
        SnapshotSource storage src = _sources[sourceId];
        return keccak256(abi.encode(src.target, src.callData, src.valueWord, s.value, s.blockNumber, s.timestamp));
    }

    // ---------------------------------------------------------------- sources

    /// Constructor-only, once per source: one bad entry rejects the whole deployment. Rejects a source
    /// the reads below could misinterpret.
    // forge-lint: disable-next-item(require-revert-in-loop)
    function _checkConfig(SnapshotSource memory s) internal view {
        if (bytes(s.label).length == 0 || bytes(s.unit).length == 0) revert EmptyLabel();
        if (s.target.code.length == 0) revert NotAContract(s.target);
        if (s.callData.length < 4) revert MissingSelector();
        if (s.valueWord >= MAX_WORDS) revert WordOutOfRange(s.valueWord);
        if (s.maxAge == 0) {
            if (s.timestampWord != 0) revert UnusedFieldSet();
        } else if (s.timestampWord >= MAX_WORDS) {
            revert WordOutOfRange(s.timestampWord);
        }
        if (s.pinnedWords.length > MAX_PINNED_WORDS) revert TooManyPinnedWords(s.pinnedWords.length);
        for (uint256 i = 0; i < s.pinnedWords.length; ++i) {
            if (s.pinnedWords[i] >= MAX_WORDS) revert WordOutOfRange(s.pinnedWords[i]);
        }
        if (s.guardTarget == address(0)) {
            if (s.guardCallData.length != 0) revert UnusedFieldSet();
        } else {
            if (s.guardTarget.code.length == 0) revert NotAContract(s.guardTarget);
            if (s.guardCallData.length < 4) revert MissingSelector();
        }
    }

    /// A read that must be usable: reverts with the reason otherwise.
    function _readChecked(uint16 sourceId) internal view returns (int256) {
        Read memory r = _readPinned(sourceId);
        if (r.status != ReadStatus.Ok) _revertFor(sourceId, r);
        return r.value;
    }

    /// `_read`, plus the check that the pinned words and guard answer are those of deployment. A
    /// changed source is reported as changed even when its value is also stale or out of range.
    function _readPinned(uint16 sourceId) internal view returns (Read memory r) {
        r = _read(sourceId);
        bool pinRead = r.status == ReadStatus.Ok || r.status == ReadStatus.OutOfRange || r.status == ReadStatus.Stale;
        if (pinRead && r.pin != _pins[sourceId]) r.status = ReadStatus.Changed;
    }

    /// Makes source `sourceId`'s call and takes the words it needs out of the return data. Never
    /// reverts on the source's account: every failure is a status.
    function _read(uint16 sourceId) internal view returns (Read memory r) {
        SnapshotSource storage s = _sources[sourceId];
        (bool ok, uint256 size) = _staticcall(s.target, s.callData);
        if (!ok) return _fail(r, ReadStatus.CallFailed);

        // Every word comes from this call's return data, so all of them are copied out before the
        // guard call replaces it.
        uint256 base = 0;
        if (s.tuple) {
            (ok, base) = _returnWord(0, size);
            if (!ok) return _fail(r, ReadStatus.ReturnTooShort);
        }
        (ok, r.raw) = _returnWord(_at(base, s.valueWord), size);
        if (!ok) return _fail(r, ReadStatus.ReturnTooShort);
        if (s.maxAge != 0) {
            (ok, r.updatedAt) = _returnWord(_at(base, s.timestampWord), size);
            if (!ok) return _fail(r, ReadStatus.ReturnTooShort);
        }
        uint256 n = s.pinnedWords.length;
        uint256[] memory pinned = new uint256[](n);
        for (uint256 i = 0; i < n; ++i) {
            (ok, pinned[i]) = _returnWord(_at(base, s.pinnedWords[i]), size);
            if (!ok) return _fail(r, ReadStatus.ReturnTooShort);
        }

        bytes32 guardAnswer = bytes32(0);
        if (s.guardTarget != address(0)) {
            (ok, size) = _staticcall(s.guardTarget, s.guardCallData);
            if (!ok || size > MAX_GUARD_RETURN) return _fail(r, ReadStatus.GuardFailed);
            guardAnswer = _returnHash(size);
        }
        r.pin = keccak256(abi.encode(pinned, guardAnswer));

        // Safe: type(int256).max is positive.
        // forge-lint: disable-next-line(unsafe-typecast)
        if (!s.signed && r.raw > uint256(type(int256).max)) return _fail(r, ReadStatus.OutOfRange);
        // Safe: a signed value is the word's two's complement reading; an unsigned one is at most
        // type(int256).max here.
        // forge-lint: disable-next-line(unsafe-typecast)
        r.value = int256(r.raw);
        // A source timestamp ahead of the block counts as fresh.
        // forge-lint: disable-next-line(block-timestamp)
        if (s.maxAge != 0 && block.timestamp > r.updatedAt && block.timestamp - r.updatedAt > s.maxAge) {
            return _fail(r, ReadStatus.Stale);
        }
    }

    function _fail(Read memory r, ReadStatus status) internal pure returns (Read memory) {
        r.status = status;
        return r;
    }

    /// The byte offset of word `word` counted from `base`.
    function _at(uint256 base, uint256 word) internal pure returns (uint256) {
        return base + word * 32;
    }

    /// Always reverts, with the error for `r.status`. Also used once per source by the constructor,
    /// where one unreadable source is meant to reject the whole deployment.
    // forge-lint: disable-next-item(require-revert-in-loop)
    function _revertFor(uint16 sourceId, Read memory r) internal view {
        ReadStatus st = r.status;
        if (st == ReadStatus.CallFailed) revert SourceCallFailed(sourceId);
        if (st == ReadStatus.ReturnTooShort) revert SourceReturnTooShort(sourceId);
        if (st == ReadStatus.OutOfRange) revert ValueOutOfRange(sourceId, r.raw);
        if (st == ReadStatus.Stale) revert ValueStale(sourceId, r.updatedAt, _sources[sourceId].maxAge);
        if (st == ReadStatus.GuardFailed) revert GuardCallFailed(sourceId);
        revert SourceChanged(sourceId);
    }

    // ---------------------------------------------------------------- raw calls

    /// A STATICCALL that copies nothing back. Returns whether it succeeded and its return data size.
    function _staticcall(address target, bytes memory data) internal view returns (bool ok, uint256 size) {
        assembly ("memory-safe") {
            ok := staticcall(gas(), target, add(data, 0x20), mload(data), 0, 0)
            size := returndatasize()
        }
    }

    /// The 32-byte word at byte `offset` of the last call's return data, if all of it is there.
    function _returnWord(uint256 offset, uint256 size) internal pure returns (bool ok, uint256 word) {
        if (offset > size || size - offset < 32) return (false, 0);
        assembly ("memory-safe") {
            returndatacopy(0x00, offset, 0x20)
            word := mload(0x00)
        }
        return (true, word);
    }

    /// keccak256 of the last call's whole return data (`size` bytes, at most MAX_GUARD_RETURN).
    function _returnHash(uint256 size) internal pure returns (bytes32 h) {
        assembly ("memory-safe") {
            let ptr := mload(0x40)
            returndatacopy(ptr, 0, size)
            h := keccak256(ptr, size)
        }
    }
}

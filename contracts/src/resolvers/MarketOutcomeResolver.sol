// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {LibString} from "solady/utils/LibString.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {IHunchBookFactory} from "../interfaces/IHunchBookFactory.sol";
import {IMarket} from "../interfaces/IMarket.sol";
import {IResolver} from "../interfaces/IResolver.sol";
import {Outcome, Phase, Window} from "../interfaces/IHunchBookTypes.sol";
import {ParlayParams} from "../interfaces/ITemplatesV2.sol";

/// @title Template 6: parlay, a market on other Hunch Book markets' outcomes
/// @notice "Will every one of these Hunch Book markets settle YES?" The source is the legs' own
///         settled outcomes, read with `IMarket.outcome()`:
///         - NO if any leg has settled NO (even while others are still open);
///         - YES once every leg has settled YES;
///         - otherwise `Unresolved`. A leg that voids while no leg has settled NO leaves the parlay
///           without an answer for good, so it voids at its own deadline (pool stakes are refunded;
///           graduated tokens redeem at 0.50).
///         The parlay settles through `settle` after its close; it has no early YES.
/// @dev A pure reader: no storage, no owner, no funds. The factory is fixed in the constructor; every
///      leg must be a market that factory created, so every leg's outcome comes only from its own
///      resolver reading its own source. Nobody can set a leg's outcome, so nobody can set this one.
///
///      Creation rules (validate):
///      - 2 to 5 legs, in strictly increasing address order: no leg twice, and one encoding per set
///        of legs, so the factory's (template, params) key is unique per question.
///      - No leg has settled or voided.
///      - lockTime is at or before every leg's lock, so nobody can stake on the parlay after a leg's
///        observation has started. For a leg on a time clock that is a direct comparison. For a leg
///        on a block clock (Perpl templates) the leg's lock block is turned into the earliest unix
///        time it could arrive, assuming every block from now comes at `fastBlockTimeMs`, an
///        assumption faster than Monad's real block time, so the estimate is early, never late.
///      - The deadline is seven days after the later of closeTime and the latest leg deadline: a
///        leg can settle right up to its own deadline, and the parlay then still has its full
///        settlement window.
///
///      evidenceHash, for the settlement verifier: keccak256(abi.encode(address[] legs,
///      uint8[] outcomes, bytes32[] legEvidenceHashes)), each leg's outcome and evidence hash as read.
contract MarketOutcomeResolver is IResolver {
    uint256 public constant MIN_LEGS = 2;
    uint256 public constant MAX_LEGS = 5;

    /// Settlement stays open this long after the later of close and the last leg deadline.
    uint256 public constant SETTLEMENT_WINDOW = 7 days;

    /// Ceiling for `fastBlockTimeMs`: anything slower is not a "fast" assumption for Monad.
    uint256 public constant MAX_FAST_BLOCK_TIME_MS = 1000;

    /// The factory whose markets can be legs.
    IHunchBookFactory public immutable factory;

    /// Milliseconds per block assumed when estimating the earliest time a block-clock leg can lock.
    /// Set below Monad's real block time, so the estimate errs early.
    uint256 public immutable fastBlockTimeMs;

    error NotAContract(address account);
    error BlockTimeOutOfRange(uint256 fastBlockTimeMs, uint256 maximum);
    error NonCanonicalParams();
    error LegCount(uint256 count, uint256 minimum, uint256 maximum);
    error LegsNotSorted(address leg);
    error NotAHunchMarket(address leg);
    error LegFinished(address leg);
    error LockNotInFuture(uint64 lockTime, uint256 currentTime);
    error CloseBeforeLock(uint64 lockTime, uint64 closeTime);
    error LockAfterLeg(address leg, uint64 lockTime, uint256 legEarliestLock);
    error DeadlineOverflow();
    error EvidenceNotEmpty();

    /// @param factory_ the factory whose markets can be legs (the one this template is registered on).
    /// @param fastBlockTimeMs_ milliseconds per block for the early estimate of a block-clock leg's lock.
    constructor(IHunchBookFactory factory_, uint256 fastBlockTimeMs_) {
        if (address(factory_).code.length == 0) revert NotAContract(address(factory_));
        if (fastBlockTimeMs_ == 0 || fastBlockTimeMs_ > MAX_FAST_BLOCK_TIME_MS) {
            revert BlockTimeOutOfRange(fastBlockTimeMs_, MAX_FAST_BLOCK_TIME_MS);
        }
        factory = factory_;
        fastBlockTimeMs = fastBlockTimeMs_;
    }

    // ---------------------------------------------------------------- IResolver

    /// @inheritdoc IResolver
    function validate(bytes calldata params) external view returns (Window memory window) {
        ParlayParams memory p = abi.decode(params, (ParlayParams));
        // One encoding per question, so the factory's (template, params) key is unique per question.
        if (keccak256(abi.encode(p)) != keccak256(params)) revert NonCanonicalParams();
        uint256 n = p.legs.length;
        if (n < MIN_LEGS || n > MAX_LEGS) revert LegCount(n, MIN_LEGS, MAX_LEGS);
        // Parlays run on unix time; legs on a block clock are compared through an early estimate.
        // forge-lint: disable-next-line(block-timestamp)
        if (p.lockTime <= block.timestamp) revert LockNotInFuture(p.lockTime, block.timestamp);
        if (p.closeTime < p.lockTime) revert CloseBeforeLock(p.lockTime, p.closeTime);

        uint256 latest = p.closeTime;
        // Reverting inside this loop is intended: one bad leg rejects the whole market.
        for (uint256 i = 0; i < n; ++i) {
            address leg = p.legs[i];
            // forge-lint: disable-next-line(require-revert-in-loop)
            if (i != 0 && leg <= p.legs[i - 1]) revert LegsNotSorted(leg);
            uint256 legDeadline = _checkLeg(leg, p.lockTime);
            if (legDeadline > latest) latest = legDeadline;
        }

        uint256 deadline = latest + SETTLEMENT_WINDOW;
        if (deadline > type(uint64).max) revert DeadlineOverflow();
        // Safe: bounded by type(uint64).max just above.
        // forge-lint: disable-next-line(unsafe-typecast)
        window = Window({blockClock: false, lock: p.lockTime, close: p.closeTime, settleDeadline: uint64(deadline)});
    }

    /// @inheritdoc IResolver
    function describe(bytes calldata params) external view returns (string memory) {
        ParlayParams memory p = abi.decode(params, (ParlayParams));
        string memory list;
        for (uint256 i = 0; i < p.legs.length; ++i) {
            list = string.concat(list, i == 0 ? "" : ", ", _legLabel(p.legs[i]));
        }
        return string.concat(
            "YES if all ",
            LibString.toString(p.legs.length),
            " of these Hunch Book markets settle YES: ",
            list,
            "; NO if any of them settles NO; if one voids while none has settled NO, this market voids",
            " at its deadline."
        );
    }

    /// @inheritdoc IResolver
    /// @dev `evidence` must be empty: the resolver reads each leg itself. Any ETH sent is returned.
    ///      Two view calls per leg, at most five legs, each a market of the factory.
    // forge-lint: disable-next-item(calls-loop)
    function resolve(bytes calldata params, bytes calldata evidence)
        external
        payable
        returns (Outcome outcome, bytes32 evidenceHash)
    {
        if (evidence.length != 0) revert EvidenceNotEmpty();
        ParlayParams memory p = abi.decode(params, (ParlayParams));
        uint256 n = p.legs.length;
        uint8[] memory outcomes = new uint8[](n);
        bytes32[] memory hashes = new bytes32[](n);
        bool anyNo = false;
        bool allYes = n != 0;
        for (uint256 i = 0; i < n; ++i) {
            IMarket leg = IMarket(p.legs[i]);
            Outcome o = leg.outcome();
            outcomes[i] = uint8(o);
            hashes[i] = leg.evidenceHash();
            if (o == Outcome.No) anyNo = true;
            if (o != Outcome.Yes) allYes = false;
        }
        if (anyNo) outcome = Outcome.No;
        else if (allYes) outcome = Outcome.Yes;
        if (outcome != Outcome.Unresolved) evidenceHash = keccak256(abi.encode(p.legs, outcomes, hashes));
        if (msg.value != 0) SafeTransferLib.safeTransferETH(msg.sender, msg.value);
    }

    /// @inheritdoc IResolver
    function earlyYes() external pure returns (bool) {
        return false;
    }

    // ---------------------------------------------------------------- views

    /// The earliest unix time `leg`'s lock can arrive: its lock for a time-clock leg; for a block-clock
    /// leg, now plus the remaining blocks at `fastBlockTimeMs` each, rounded down (now if already
    /// reached).
    function earliestLockTime(Window memory w) public view returns (uint256) {
        if (!w.blockClock) return w.lock;
        if (w.lock <= block.number) return block.timestamp;
        return block.timestamp + (uint256(w.lock) - block.number) * fastBlockTimeMs / 1000;
    }

    // ---------------------------------------------------------------- internals

    /// Checks one leg and returns its settlement deadline. Called once per leg (at most five) from
    /// `validate`, where one bad leg is meant to reject the whole market.
    // forge-lint: disable-next-item(calls-loop, require-revert-in-loop)
    function _checkLeg(address leg, uint64 lockTime) internal view returns (uint256) {
        if (!factory.isMarket(leg)) revert NotAHunchMarket(leg);
        IMarket m = IMarket(leg);
        Phase phase = m.phase();
        if (phase == Phase.Settled || phase == Phase.Voided || m.outcome() != Outcome.Unresolved) {
            revert LegFinished(leg);
        }
        Window memory w = m.window();
        uint256 legLock = earliestLockTime(w);
        if (lockTime > legLock) revert LockAfterLeg(leg, lockTime, legLock);
        return w.settleDeadline;
    }

    /// "#12 (0xAbC...)", or the address alone if it is not a market. Called once per leg from `describe`.
    // forge-lint: disable-next-item(calls-loop)
    function _legLabel(address leg) internal view returns (string memory) {
        string memory addr = LibString.toHexStringChecksummed(leg);
        if (leg.code.length == 0) return addr;
        try IMarket(leg).marketId() returns (uint256 id) {
            return string.concat("#", LibString.toString(id), " (", addr, ")");
        } catch {
            return addr;
        }
    }
}

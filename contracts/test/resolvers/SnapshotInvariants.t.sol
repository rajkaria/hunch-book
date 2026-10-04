// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {Outcome} from "../../src/interfaces/IHunchBookTypes.sol";
import {Snapshot, SnapshotParams, SnapshotSource} from "../../src/interfaces/ITemplatesV3.sol";
import {IPerplExchange} from "../../src/interfaces/external/IPerplExchange.sol";
import {SnapshotResolver} from "../../src/resolvers/SnapshotResolver.sol";
import {PerplSnapshotSources} from "../../script/DeploySnapshotTemplate.s.sol";
import {MockSnapshotSource} from "./SnapshotMocks.sol";

/// Random time steps, source moves and breakages, snapshots and resolves (by random callers) over
/// twenty-four observations: three sources, four close times (two of them five minutes apart, so
/// their windows overlap), two window lengths. The handler predicts the result of every call from the
/// mock's state and the clock, and counts every surprise as a violation, so a call that succeeds when
/// it should not, or fails when it should not, is caught.
contract SnapshotHandler is Test {
    uint256 internal constant PERP = 1;
    uint16 internal constant OI = 0;
    uint16 internal constant PLAIN = 1;
    uint16 internal constant STAMPED = 2;
    uint256 internal constant STAMPED_MAX_AGE = 60;
    uint256 internal constant SOURCES = 3;
    uint256 internal constant CLOSES = 4;
    uint256 public constant OBSERVATIONS = SOURCES * CLOSES * 2;

    SnapshotResolver public resolver;
    MockSnapshotSource public src;

    uint64[CLOSES] internal closes;
    uint32[2] internal windows = [uint32(60), uint32(600)];

    /// The first snapshot the handler saw stored for each observation key.
    mapping(bytes32 key => Snapshot) internal _first;

    bool internal broken; // every source call reverts
    bool internal versionChanged; // Perpl's guard answer differs from deployment
    bool internal paused; // a pinned Perpl word differs from deployment

    uint256 public violations;
    uint256 public snapshotsTaken;
    uint256 public snapshotsRefused;
    uint256 public resolvesAnswered;

    constructor(uint256 start) {
        src = new MockSnapshotSource();
        src.listPerp(PERP, "BTC", 1, 5);
        src.setOpenInterest(PERP, 1000);
        src.setPlain(500);
        src.setSigned(-7, block.timestamp);

        SnapshotSource[] memory list = new SnapshotSource[](3);
        list[OI] = PerplSnapshotSources.openInterest(IPerplExchange(address(src)), PERP, "BTC");
        list[PLAIN].label = "plain";
        list[PLAIN].unit = "units";
        list[PLAIN].target = address(src);
        list[PLAIN].callData = abi.encodeCall(MockSnapshotSource.plain, ());
        list[STAMPED].label = "stamped";
        list[STAMPED].unit = "points";
        list[STAMPED].target = address(src);
        list[STAMPED].callData = abi.encodeCall(MockSnapshotSource.stamped, ());
        list[STAMPED].signed = true;
        list[STAMPED].timestampWord = 1;
        list[STAMPED].maxAge = uint32(STAMPED_MAX_AGE);
        resolver = new SnapshotResolver(list);

        closes = [
            uint64(start + 1 hours),
            uint64(start + 1 hours + 5 minutes),
            uint64(start + 2 hours),
            uint64(start + 3 hours)
        ];
    }

    // ---- observations ----

    struct Obs {
        uint16 sourceId;
        uint64 close;
        uint32 window;
        bytes32 key;
    }

    /// Seeds 0 to OBSERVATIONS - 1 name the observations.
    function _obs(uint256 seed) internal view returns (Obs memory o) {
        seed %= OBSERVATIONS;
        o.sourceId = uint16(seed % SOURCES);
        o.close = closes[(seed / SOURCES) % CLOSES];
        o.window = windows[seed / (SOURCES * CLOSES)];
        o.key = keccak256(abi.encode(o.sourceId, o.close, o.window)); // SnapshotStore.snapshotKey
    }

    /// Three times in four, an observation whose window is open now (if there is one), so the
    /// snapshot paths run often; otherwise any observation.
    function _pick(uint256 seed) internal view returns (Obs memory) {
        if (seed % 4 != 0) {
            uint256 start = seed / 4;
            for (uint256 i = 0; i < OBSERVATIONS; ++i) {
                Obs memory o = _obs(start + i);
                if (_inWindow(o)) return o;
            }
        }
        return _obs(seed / 4);
    }

    function _inWindow(Obs memory o) internal view returns (bool) {
        return block.timestamp >= o.close && block.timestamp <= uint256(o.close) + o.window;
    }

    /// Whether a read of `sourceId` should succeed right now, and the value it should return.
    function _expectedRead(uint16 sourceId) internal view returns (bool ok, int256 value) {
        if (broken) return (false, 0);
        if (sourceId == OI) {
            if (versionChanged || paused) return (false, 0);
            return (true, int256(PerplInfo.longOpenInterest(src, PERP)));
        }
        if (sourceId == PLAIN) {
            uint256 w = src.plainWord();
            return (w <= uint256(type(int256).max), int256(w));
        }
        uint256 at = src.stampedAt();
        bool fresh = block.timestamp <= at || block.timestamp - at <= STAMPED_MAX_AGE;
        return (fresh, src.signedWord());
    }

    function _holds(int256 v, int256 t, uint8 c) internal pure returns (bool) {
        if (c == 0) return v > t;
        if (c == 1) return v >= t;
        if (c == 2) return v < t;
        return v <= t;
    }

    /// Remembers the first snapshot of an observation. A second one is a violation, and the first one
    /// stays what the store is compared with.
    function _noteNew(Obs memory o, int256 value) internal {
        ++snapshotsTaken;
        if (_first[o.key].blockNumber != 0) {
            ++violations;
            return;
        }
        _first[o.key] = Snapshot({value: value, blockNumber: uint64(block.number), timestamp: uint64(block.timestamp)});
    }

    // ---- actions ----

    function step(uint256 dt) external {
        dt = bound(dt, 0, 15 minutes);
        _advance(vm.getBlockTimestamp() + dt);
    }

    /// Jumps to a moment around the next close time whose longest window has not ended (from a minute
    /// before it to fifteen minutes after), or stays put if that moment has passed: time only moves
    /// forward.
    function jumpNear(uint256 offset) external {
        for (uint256 c = 0; c < CLOSES; ++c) {
            if (block.timestamp > uint256(closes[c]) + windows[1]) continue;
            uint256 target = uint256(closes[c]) - 1 minutes + bound(offset, 0, 16 minutes);
            if (target > block.timestamp) _advance(target);
            return;
        }
    }

    function _advance(uint256 to) internal {
        uint256 dt = to - vm.getBlockTimestamp();
        vm.warp(to);
        vm.roll(block.number + 1 + dt * 3);
    }

    /// Moves every source: the plain word (one time in sixteen above type(int256).max, which no read
    /// may accept), the stamped value and its age (up to twice the max age), and open interest.
    function move(uint256 w, int256 v, uint256 age, uint256 lots) external {
        src.setPlain(w % 16 == 0 ? uint256(type(int256).max) + 1 + w % 1e9 : bound(w, 0, 1e30));
        src.setSigned(v, block.timestamp - bound(age, 0, 2 * STAMPED_MAX_AGE));
        src.setOpenInterest(PERP, bound(lots, 0, 1e18));
    }

    /// Sets the three breakages, each on one time in four: every call reverts; Perpl's version
    /// (the guard) changed; the perp is paused (a pinned word changed).
    function setBreakage(uint256 seed) external {
        broken = seed % 4 == 0;
        versionChanged = (seed / 4) % 4 == 0;
        paused = (seed / 16) % 4 == 0;
        src.setReverts(broken);
        if (versionChanged) src.setVersion(8, 0, 0);
        else src.setVersion(7, 5, 0);
        src.setStatus(PERP, paused ? 0 : 4);
    }

    function snapshot(uint256 seed, address caller) external {
        Obs memory o = _pick(seed);
        (bool readable, int256 expected) = _expectedRead(o.sourceId);
        bool shouldWork = _inWindow(o) && _first[o.key].blockNumber == 0 && readable;
        vm.prank(caller);
        try resolver.snapshot(o.sourceId, o.close, o.window) returns (int256 v) {
            if (!shouldWork || v != expected) ++violations;
            _noteNew(o, v);
        } catch {
            if (shouldWork) ++violations;
            ++snapshotsRefused;
        }
    }

    function resolve(uint256 seed, int256 threshold, uint8 comparator, address caller) external {
        Obs memory o = _pick(seed);
        comparator = uint8(bound(comparator, 0, 3));
        bytes memory params = abi.encode(
            SnapshotParams({
                sourceId: o.sourceId,
                threshold: threshold,
                comparator: comparator,
                lockTime: o.close - 30 minutes,
                closeTime: o.close,
                snapshotWindow: o.window
            })
        );
        (bool readable, int256 expected) = _expectedRead(o.sourceId);
        bool hadOne = _first[o.key].blockNumber != 0;
        bool takesOne = !hadOne && _inWindow(o) && readable;

        vm.prank(caller);
        try resolver.resolve(params, "") returns (Outcome out, bytes32) {
            if (takesOne) _noteNew(o, expected);
            if (hadOne || takesOne) {
                int256 v = _first[o.key].value;
                if (out != (_holds(v, threshold, comparator) ? Outcome.Yes : Outcome.No)) ++violations;
                ++resolvesAnswered;
            } else if (out != Outcome.Unresolved) {
                ++violations;
            }
        } catch {
            ++violations; // valid params and empty evidence never revert
        }
    }

    // ---- views for the invariants ----

    /// Over every observation: how many stored snapshots differ from the first one the handler saw
    /// stored (or exist where it saw none), and how many sit outside their own window.
    function badSnapshots() external view returns (uint256 changed, uint256 outside) {
        for (uint256 i = 0; i < OBSERVATIONS; ++i) {
            Obs memory o = _obs(i);
            Snapshot memory stored = resolver.snapshotOf(o.key);
            Snapshot memory seen = _first[o.key];
            if (
                stored.value != seen.value || stored.blockNumber != seen.blockNumber
                    || stored.timestamp != seen.timestamp
            ) ++changed;
            if (stored.blockNumber != 0 && (stored.timestamp < o.close || stored.timestamp > o.close + o.window)) {
                ++outside;
            }
        }
    }
}

/// Reads Perpl-shaped fields from the mock, outside the resolver's code path.
library PerplInfo {
    function longOpenInterest(MockSnapshotSource src, uint256 perpId) internal view returns (uint256) {
        return IPerplExchange(address(src)).getPerpetualInfoV2(perpId).longOpenInterestLNS;
    }
}

contract SnapshotInvariantsTest is Test {
    SnapshotHandler internal handler;

    function setUp() public {
        vm.warp(1_800_000_000);
        vm.roll(1_000_000);
        handler = new SnapshotHandler(block.timestamp);
        targetContract(address(handler));
    }

    /// For every observation: no snapshot is ever replaced (what is stored is what was first stored,
    /// and an observation the handler never saw snapshotted has nothing stored), and a stored snapshot
    /// was taken inside its own window.
    function invariant_snapshotsAreFinalAndInsideTheirWindow() public view {
        (uint256 changed, uint256 outside) = handler.badSnapshots();
        assertEq(changed, 0, "a snapshot changed, or appeared without a call that took it");
        assertEq(outside, 0, "a snapshot sits outside its window");
    }

    /// Every call did what the source, the clock and the store said it should.
    function invariant_noSurprises() public view {
        assertEq(handler.violations(), 0);
    }

    function afterInvariant() external view {
        console2.log("taken", handler.snapshotsTaken(), "refused", handler.snapshotsRefused());
        console2.log("answered", handler.resolvesAnswered());
    }
}

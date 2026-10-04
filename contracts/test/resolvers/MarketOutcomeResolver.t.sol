// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {LibString} from "solady/utils/LibString.sol";
import {BaseTest} from "../core/Base.t.sol";
import {Market} from "../../src/core/Market.sol";
import {IHunchBookFactory} from "../../src/interfaces/IHunchBookFactory.sol";
import {IResolver} from "../../src/interfaces/IResolver.sol";
import {Outcome, Phase, Side, Window} from "../../src/interfaces/IHunchBookTypes.sol";
import {ParlayParams} from "../../src/interfaces/ITemplatesV2.sol";
import {MarketOutcomeResolver} from "../../src/resolvers/MarketOutcomeResolver.sol";
import {MockLegFactory, MockLegMarket} from "./mocks/MockLegMarket.sol";

/// Template 6 against real markets of a real factory (legs on the mock template 1, whose answer each
/// test sets before settling a leg), plus mock legs for the fuzz tests.
contract MarketOutcomeResolverTest is BaseTest {
    uint32 internal constant PARLAY = 6;
    uint256 internal constant FAST_MS = 200;

    MarketOutcomeResolver internal parlay;

    function setUp() public override {
        super.setUp();
        parlay = new MarketOutcomeResolver(IHunchBookFactory(address(factory)), FAST_MS);
        vm.prank(guardian);
        factory.addTemplate(PARLAY, IResolver(address(parlay)), _rule());
    }

    // ------------------------------------------------------------ helpers

    function _params(address[] memory legs, uint64 lock, uint64 close) internal pure returns (bytes memory) {
        return abi.encode(ParlayParams({legs: legs, lockTime: lock, closeTime: close}));
    }

    /// Two legs in increasing address order.
    function _pair(address a, address b) internal pure returns (address[] memory legs) {
        legs = new address[](2);
        (legs[0], legs[1]) = a < b ? (a, b) : (b, a);
    }

    function _sort(address[] memory legs) internal pure returns (address[] memory) {
        for (uint256 i = 1; i < legs.length; ++i) {
            for (uint256 j = i; j > 0 && legs[j - 1] > legs[j]; --j) {
                (legs[j - 1], legs[j]) = (legs[j], legs[j - 1]);
            }
        }
        return legs;
    }

    function _twoLegs() internal returns (Market a, Market b, address[] memory legs, uint64 lock, uint64 close) {
        a = _createDefault();
        b = _createDefault();
        legs = _pair(address(a), address(b));
        lock = a.window().lock < b.window().lock ? a.window().lock : b.window().lock;
        close = a.window().close > b.window().close ? a.window().close : b.window().close;
    }

    function _settleLeg(Market m, Outcome o) internal {
        if (vm.getBlockTimestamp() < m.window().close) vm.warp(m.window().close);
        resolver.setAnswer(o);
        m.settle("");
    }

    function _resolve(bytes memory params) internal returns (Outcome o) {
        (o,) = parlay.resolve(params, "");
    }

    // ------------------------------------------------------------ constructor

    function test_constructor() public {
        assertEq(address(parlay.factory()), address(factory));
        assertEq(parlay.fastBlockTimeMs(), FAST_MS);
        assertFalse(parlay.earlyYes());
        vm.expectRevert(abi.encodeWithSelector(MarketOutcomeResolver.NotAContract.selector, address(0xBEEF)));
        new MarketOutcomeResolver(IHunchBookFactory(address(0xBEEF)), FAST_MS);
        vm.expectRevert(abi.encodeWithSelector(MarketOutcomeResolver.BlockTimeOutOfRange.selector, 0, 1000));
        new MarketOutcomeResolver(IHunchBookFactory(address(factory)), 0);
        vm.expectRevert(abi.encodeWithSelector(MarketOutcomeResolver.BlockTimeOutOfRange.selector, 1001, 1000));
        new MarketOutcomeResolver(IHunchBookFactory(address(factory)), 1001);
        new MarketOutcomeResolver(IHunchBookFactory(address(factory)), 1000);
    }

    // ------------------------------------------------------------ validate

    function test_validate_window() public {
        (Market a, Market b, address[] memory legs, uint64 lock, uint64 close) = _twoLegs();
        Window memory w = parlay.validate(_params(legs, lock, close));
        assertFalse(w.blockClock);
        assertEq(w.lock, lock);
        assertEq(w.close, close);
        // Seven days after the later of close and every leg's deadline.
        uint256 latest = a.window().settleDeadline > b.window().settleDeadline
            ? a.window().settleDeadline
            : b.window().settleDeadline;
        assertEq(w.settleDeadline, latest + 7 days);
        // A close after every leg deadline moves the deadline with it.
        w = parlay.validate(_params(legs, lock, uint64(latest + 30 days)));
        assertEq(w.settleDeadline, latest + 37 days);
    }

    function test_validate_legCount() public {
        Market a = _createDefault();
        (uint64 lock, uint64 close) = (a.window().lock, a.window().close);
        address[] memory one = new address[](1);
        one[0] = address(a);
        vm.expectRevert(abi.encodeWithSelector(MarketOutcomeResolver.LegCount.selector, 1, 2, 5));
        parlay.validate(_params(one, lock, close));

        address[] memory six = new address[](6);
        for (uint256 i = 0; i < 6; ++i) {
            six[i] = address(_createDefault());
        }
        _sort(six);
        vm.expectRevert(abi.encodeWithSelector(MarketOutcomeResolver.LegCount.selector, 6, 2, 5));
        parlay.validate(_params(six, lock, close));

        address[] memory five = new address[](5);
        for (uint256 i = 0; i < 5; ++i) {
            five[i] = six[i];
        }
        parlay.validate(_params(five, lock, close));
    }

    function test_validate_legsSortedAndDistinct() public {
        (,, address[] memory legs, uint64 lock, uint64 close) = _twoLegs();
        address[] memory reversed = new address[](2);
        (reversed[0], reversed[1]) = (legs[1], legs[0]);
        vm.expectRevert(abi.encodeWithSelector(MarketOutcomeResolver.LegsNotSorted.selector, legs[0]));
        parlay.validate(_params(reversed, lock, close));
        address[] memory twice = new address[](2);
        (twice[0], twice[1]) = (legs[0], legs[0]);
        vm.expectRevert(abi.encodeWithSelector(MarketOutcomeResolver.LegsNotSorted.selector, legs[0]));
        parlay.validate(_params(twice, lock, close));
    }

    function test_validate_legsMustBeMarketsOfThisFactory() public {
        Market a = _createDefault();
        (uint64 lock, uint64 close) = (a.window().lock, a.window().close);
        address[] memory legs = _pair(address(a), address(usdc));
        vm.expectRevert(abi.encodeWithSelector(MarketOutcomeResolver.NotAHunchMarket.selector, address(usdc)));
        parlay.validate(_params(legs, lock, close));
        legs = _pair(address(a), address(0xBEEF));
        vm.expectRevert(abi.encodeWithSelector(MarketOutcomeResolver.NotAHunchMarket.selector, address(0xBEEF)));
        parlay.validate(_params(legs, lock, close));
    }

    function test_validate_rejectsFinishedLegs() public {
        // A leg settled early (graduated, proved YES before its lock).
        Market done = _graduated();
        resolver.setEarly(true);
        resolver.setAnswer(Outcome.Yes);
        done.proveYes("");
        resolver.setEarly(false);
        assertEq(uint8(done.phase()), uint8(Phase.Settled));
        Market open = _createDefault();
        uint64 openClose = open.window().close;
        address[] memory legs = _pair(address(done), address(open));
        vm.expectRevert(abi.encodeWithSelector(MarketOutcomeResolver.LegFinished.selector, address(done)));
        parlay.validate(_params(legs, uint64(block.timestamp + 1), openClose));

        // A voided leg.
        Market gone = _createDefault();
        vm.warp(gone.window().settleDeadline + 1);
        gone.voidIfExpired();
        Market later = _create(_timeWindow(), Side.Yes, CREATOR_MIN);
        uint64 laterClose = later.window().close;
        legs = _pair(address(gone), address(later));
        vm.expectRevert(abi.encodeWithSelector(MarketOutcomeResolver.LegFinished.selector, address(gone)));
        parlay.validate(_params(legs, uint64(block.timestamp + 1), laterClose));
    }

    function test_validate_lockAtOrBeforeEveryTimeLeg() public {
        (Market a, Market b, address[] memory legs,, uint64 close) = _twoLegs();
        uint64 first = a.window().lock < b.window().lock ? a.window().lock : b.window().lock;
        address firstLeg = a.window().lock < b.window().lock ? address(a) : address(b);
        parlay.validate(_params(legs, first, close)); // equal is allowed
        vm.expectRevert(
            abi.encodeWithSelector(MarketOutcomeResolver.LockAfterLeg.selector, firstLeg, first + 1, uint256(first))
        );
        parlay.validate(_params(legs, first + 1, close));
    }

    /// A block-clock leg's lock is compared through the earliest time it could arrive: every block from
    /// now at 200 ms.
    function test_validate_blockClockLeg() public {
        Market t = _createDefault();
        Market b = _create(_blockWindow(), Side.Yes, CREATOR_MIN);
        Window memory bw = b.window();
        assertTrue(bw.blockClock);
        uint256 earliest = block.timestamp + (uint256(bw.lock) - block.number) * FAST_MS / 1000;
        assertEq(parlay.earliestLockTime(bw), earliest);
        address[] memory legs = _pair(address(t), address(b));
        uint64 close = t.window().close;
        parlay.validate(_params(legs, uint64(earliest), close));
        vm.expectRevert(
            abi.encodeWithSelector(
                MarketOutcomeResolver.LockAfterLeg.selector, address(b), uint64(earliest + 1), earliest
            )
        );
        parlay.validate(_params(legs, uint64(earliest + 1), close));
        // The leg's own deadline (an estimate in unix time) counts toward the parlay's.
        Window memory w = parlay.validate(_params(legs, uint64(earliest), close));
        uint256 latest = bw.settleDeadline > t.window().settleDeadline ? bw.settleDeadline : t.window().settleDeadline;
        assertEq(w.settleDeadline, (latest > close ? latest : close) + 7 days);
    }

    function test_validate_rejectsBadTimes() public {
        (,, address[] memory legs, uint64 lock, uint64 close) = _twoLegs();
        vm.expectRevert(
            abi.encodeWithSelector(
                MarketOutcomeResolver.LockNotInFuture.selector, uint64(block.timestamp), block.timestamp
            )
        );
        parlay.validate(_params(legs, uint64(block.timestamp), close));
        vm.expectRevert(abi.encodeWithSelector(MarketOutcomeResolver.CloseBeforeLock.selector, lock, lock - 1));
        parlay.validate(_params(legs, lock, lock - 1));
        vm.expectRevert(MarketOutcomeResolver.DeadlineOverflow.selector);
        parlay.validate(_params(legs, lock, type(uint64).max));
        vm.expectRevert(MarketOutcomeResolver.NonCanonicalParams.selector);
        parlay.validate(bytes.concat(_params(legs, lock, close), bytes1(0)));
    }

    // ------------------------------------------------------------ describe

    function test_describe() public {
        (Market a, Market b, address[] memory legs, uint64 lock, uint64 close) = _twoLegs();
        Market first = legs[0] == address(a) ? a : b;
        Market second = legs[0] == address(a) ? b : a;
        assertEq(
            parlay.describe(_params(legs, lock, close)),
            string.concat(
                "YES if all 2 of these Hunch Book markets settle YES: #",
                LibString.toString(first.marketId()),
                " (",
                LibString.toHexStringChecksummed(address(first)),
                "), #",
                LibString.toString(second.marketId()),
                " (",
                LibString.toHexStringChecksummed(address(second)),
                "); NO if any of them settles NO; if one voids while none has settled NO, this market voids at its deadline."
            )
        );
    }

    function test_describe_fallsBackToAddresses() public view {
        address[] memory legs = _pair(address(0xBEEF), address(usdc));
        assertEq(
            parlay.describe(_params(legs, 1, 2)),
            string.concat(
                "YES if all 2 of these Hunch Book markets settle YES: ",
                LibString.toHexStringChecksummed(legs[0]),
                ", ",
                LibString.toHexStringChecksummed(legs[1]),
                "; NO if any of them settles NO; if one voids while none has settled NO, this market voids at its deadline."
            )
        );
    }

    // ------------------------------------------------------------ resolve

    function test_resolve_noAsSoonAsOneLegIsNo() public {
        (Market a, Market b, address[] memory legs, uint64 lock, uint64 close) = _twoLegs();
        bytes memory params = _params(legs, lock, close);
        assertEq(uint8(_resolve(params)), uint8(Outcome.Unresolved));
        _settleLeg(a, Outcome.No);
        assertEq(uint8(b.phase()), uint8(Phase.PoolLocked)); // b is still open
        (Outcome o, bytes32 h) = parlay.resolve(params, "");
        assertEq(uint8(o), uint8(Outcome.No));
        uint8[] memory outcomes = new uint8[](2);
        bytes32[] memory hashes = new bytes32[](2);
        uint256 ia = legs[0] == address(a) ? 0 : 1;
        outcomes[ia] = uint8(Outcome.No);
        hashes[ia] = a.evidenceHash();
        assertEq(h, keccak256(abi.encode(legs, outcomes, hashes)));
    }

    function test_resolve_yesOnlyWhenEveryLegIsYes() public {
        (Market a, Market b, address[] memory legs, uint64 lock, uint64 close) = _twoLegs();
        bytes memory params = _params(legs, lock, close);
        _settleLeg(a, Outcome.Yes);
        assertEq(uint8(_resolve(params)), uint8(Outcome.Unresolved));
        _settleLeg(b, Outcome.Yes);
        (Outcome o, bytes32 h) = parlay.resolve(params, "");
        assertEq(uint8(o), uint8(Outcome.Yes));
        uint8[] memory outcomes = new uint8[](2);
        (outcomes[0], outcomes[1]) = (uint8(Outcome.Yes), uint8(Outcome.Yes));
        bytes32[] memory hashes = new bytes32[](2);
        (hashes[0], hashes[1]) = (Market(payable(legs[0])).evidenceHash(), Market(payable(legs[1])).evidenceHash());
        assertEq(h, keccak256(abi.encode(legs, outcomes, hashes)));
    }

    function test_resolve_voidedLeg() public {
        (Market a, Market b, address[] memory legs, uint64 lock, uint64 close) = _twoLegs();
        bytes memory params = _params(legs, lock, close);
        _settleLeg(a, Outcome.Yes);
        vm.warp(b.window().settleDeadline + 1);
        b.voidIfExpired();
        // YES + void can never answer.
        assertEq(uint8(_resolve(params)), uint8(Outcome.Unresolved));

        (Market c, Market d, address[] memory legs2, uint64 lock2, uint64 close2) = _twoLegs();
        _settleLeg(c, Outcome.No);
        vm.warp(d.window().settleDeadline + 1);
        d.voidIfExpired();
        // NO + void is still NO.
        assertEq(uint8(_resolve(_params(legs2, lock2, close2))), uint8(Outcome.No));
    }

    function test_resolve_rejectsEvidenceAndRefunds() public {
        (,, address[] memory legs, uint64 lock, uint64 close) = _twoLegs();
        vm.expectRevert(MarketOutcomeResolver.EvidenceNotEmpty.selector);
        parlay.resolve(_params(legs, lock, close), hex"00");
        address payer = makeAddr("payer");
        vm.deal(payer, 1 ether);
        vm.prank(payer);
        parlay.resolve{value: 1 ether}(_params(legs, lock, close), "");
        assertEq(payer.balance, 1 ether);
        assertEq(address(parlay).balance, 0);
    }

    // ------------------------------------------------------------ fuzz (mock legs)

    function _mockSetup(uint256 n, uint256 seed)
        internal
        returns (MarketOutcomeResolver r, MockLegMarket[] memory legs, address[] memory addrs)
    {
        MockLegFactory f = new MockLegFactory();
        r = new MarketOutcomeResolver(IHunchBookFactory(address(f)), FAST_MS);
        legs = new MockLegMarket[](n);
        addrs = new address[](n);
        for (uint256 i = 0; i < n; ++i) {
            Window memory w = Window({
                blockClock: false,
                lock: uint64(block.timestamp + 1 days),
                close: uint64(block.timestamp + 2 days),
                settleDeadline: uint64(block.timestamp + 9 days + (uint256(keccak256(abi.encode(seed, i))) % 30 days))
            });
            legs[i] = new MockLegMarket(i + 1, w);
            f.add(address(legs[i]));
            addrs[i] = address(legs[i]);
        }
        _sort(addrs);
    }

    /// The truth table: NO if any leg is NO, YES if every leg is YES, otherwise Unresolved.
    function testFuzz_truthTable(uint8 n, uint256 seed) public {
        n = uint8(bound(n, 2, 5));
        (MarketOutcomeResolver r, MockLegMarket[] memory legs, address[] memory addrs) = _mockSetup(n, seed);
        bool anyNo = false;
        bool allYes = true;
        for (uint256 i = 0; i < n; ++i) {
            Outcome o = Outcome(uint256(keccak256(abi.encode(seed, "o", i))) % 3);
            Phase p = o == Outcome.Unresolved
                ? (uint256(keccak256(abi.encode(seed, "v", i))) % 2 == 0 ? Phase.Voided : Phase.Closed)
                : Phase.Settled;
            legs[i].set(p, o, keccak256(abi.encode(i)));
            if (o == Outcome.No) anyNo = true;
            if (o != Outcome.Yes) allYes = false;
        }
        (Outcome got, bytes32 h) = r.resolve(_params(addrs, 1, 2), "");
        Outcome want = anyNo ? Outcome.No : (allYes ? Outcome.Yes : Outcome.Unresolved);
        assertEq(uint8(got), uint8(want));
        assertEq(h == bytes32(0), want == Outcome.Unresolved);
    }

    /// The deadline is seven days after the later of close and every leg's deadline.
    function testFuzz_deadline(uint8 n, uint256 seed, uint64 closeOffset) public {
        n = uint8(bound(n, 2, 5));
        (MarketOutcomeResolver r, MockLegMarket[] memory legs, address[] memory addrs) = _mockSetup(n, seed);
        uint64 close = uint64(block.timestamp + 1 days + bound(closeOffset, 0, 60 days));
        uint256 latest = close;
        for (uint256 i = 0; i < n; ++i) {
            uint256 d = legs[i].window().settleDeadline;
            if (d > latest) latest = d;
        }
        Window memory w = r.validate(_params(addrs, uint64(block.timestamp + 1 days), close));
        assertEq(w.settleDeadline, latest + 7 days);
        assertGe(w.settleDeadline, uint256(close) + 7 days);
    }

    /// A block-clock leg: accepted exactly when lockTime is at or before now + blocks × 200 ms.
    function testFuzz_blockLegLockRule(uint256 blocksAhead, uint256 lockOffset) public {
        blocksAhead = bound(blocksAhead, 0, 10_000_000);
        lockOffset = bound(lockOffset, 1, 30 days);
        (MarketOutcomeResolver r, MockLegMarket[] memory legs, address[] memory addrs) = _mockSetup(2, 1);
        Window memory w = Window({
            blockClock: true,
            lock: uint64(block.number + blocksAhead),
            close: uint64(block.number + blocksAhead + 100_000),
            settleDeadline: uint64(block.timestamp + 40 days)
        });
        legs[0].setWindow(w);
        uint64 lockTime = uint64(block.timestamp + lockOffset);
        uint256 earliest = block.timestamp + blocksAhead * FAST_MS / 1000;
        bool ok = lockTime <= earliest && lockTime <= block.timestamp + 1 days; // the other leg locks in a day
        try r.validate(_params(addrs, lockTime, lockTime)) returns (Window memory) {
            assertTrue(ok, "accepted a lock after a leg's lock");
        } catch {
            assertFalse(ok, "rejected a lock before every leg's lock");
        }
    }
}

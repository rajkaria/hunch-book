// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {Outcome, Window} from "../../src/interfaces/IHunchBookTypes.sol";
import {PerplFundingSpikeParams} from "../../src/interfaces/ITemplatesV2.sol";
import {IPerplExchange} from "../../src/interfaces/external/IPerplExchange.sol";
import {PerplFundingSpikeResolver} from "../../src/resolvers/PerplFundingSpikeResolver.sol";
import {MockPerplExchange} from "./mocks/MockPerplExchange.sol";

contract PerplFundingSpikeResolverTest is Test {
    uint256 internal constant NOW_BLOCK = 1_000_000;
    uint256 internal constant NOW_TS = 1_800_000_000;
    uint256 internal constant INTERVAL = 8571;
    uint256 internal constant DAY = 288_000; // blocks per day at 300 ms
    uint256 internal constant BTC = 1;
    uint256 internal constant MON = 10;

    uint64 internal constant START = 1_000_100;
    uint64 internal constant END = 1_024_284; // a funding event block: the window's last counted event
    uint64 internal constant E1 = 1_007_142; // +20
    uint64 internal constant E2 = 1_015_713; // −5
    uint64 internal constant E3 = 1_024_284; // +35

    MockPerplExchange internal ex;
    PerplFundingSpikeResolver internal resolver;

    receive() external payable {}

    function setUp() public {
        vm.roll(NOW_BLOCK);
        vm.warp(NOW_TS);
        ex = new MockPerplExchange();
        ex.listPerp(BTC, "BTC Perp", "BTC", 1, 0, 500_000);
        ex.listPerp(MON, "MON Perp", "MON", 6, 2, 500_000);
        resolver = new PerplFundingSpikeResolver(ex, 1000, DAY);

        // A funding grid every 8,571 blocks from block 990,000.
        ex.pushEvent(BTC, 990_000, 100);
        ex.pushEvent(BTC, 998_571, 110);
        ex.pushEvent(BTC, E1, 130);
        ex.pushEvent(BTC, E2, 125);
        ex.pushEvent(BTC, E3, 160);
        ex.pushEvent(BTC, 1_032_855, 170); // after the window
    }

    // ------------------------------------------------------------ helpers

    function _p(uint256 perpId, uint64 start, uint64 end, int256 threshold, uint8 exp)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encode(
            PerplFundingSpikeParams({
                perpId: perpId, startBlock: start, endBlock: end, threshold: threshold, expectedScalingExp: exp
            })
        );
    }

    function _btc(int256 threshold) internal pure returns (bytes memory) {
        return _p(BTC, START, END, threshold, 0);
    }

    function _prove(bytes memory params, uint64 e) internal returns (Outcome o) {
        (o,) = resolver.resolve(params, abi.encode(e));
    }

    function _settleNo(bytes memory params) internal returns (Outcome o) {
        (o,) = resolver.resolve(params, "");
    }

    /// A fresh exchange with one perp whose events are the given (block, sum) pairs.
    function _exchangeWith(uint256[] memory blocks, int48[] memory sums)
        internal
        returns (MockPerplExchange e, PerplFundingSpikeResolver r)
    {
        e = new MockPerplExchange();
        e.listPerp(BTC, "BTC Perp", "BTC", 1, 0, 1);
        for (uint256 i = 0; i < blocks.length; ++i) {
            e.pushEvent(BTC, blocks[i], sums[i]);
        }
        r = new PerplFundingSpikeResolver(e, 1000, DAY);
    }

    // ------------------------------------------------------------ constructor

    function test_constructor() public view {
        assertEq(address(resolver.exchange()), address(ex));
        assertEq(resolver.blockTimeMs(), 1000);
        assertEq(resolver.challengeBlocks(), DAY);
        assertEq(resolver.versionMinor(), 5);
        assertTrue(resolver.earlyYes());
    }

    function test_constructor_rejects() public {
        vm.expectRevert(abi.encodeWithSelector(PerplFundingSpikeResolver.BlocksPerDayTooLow.selector, 86_399, 86_400));
        new PerplFundingSpikeResolver(ex, 1000, 86_399);
        new PerplFundingSpikeResolver(ex, 1000, 86_400); // the floor itself is accepted
        vm.expectRevert(abi.encodeWithSelector(PerplFundingSpikeResolver.BlockTimeTooLow.selector, 799, 800));
        new PerplFundingSpikeResolver(ex, 799, DAY);
        vm.expectRevert(abi.encodeWithSelector(PerplFundingSpikeResolver.NotAContract.selector, address(0xBEEF)));
        new PerplFundingSpikeResolver(IPerplExchange(address(0xBEEF)), 1000, DAY);
    }

    // ------------------------------------------------------------ validate

    function test_validate_window() public view {
        Window memory w = resolver.validate(_btc(30));
        assertTrue(w.blockClock);
        assertEq(w.lock, START);
        assertEq(w.close, END);
        // (END + one day of blocks − NOW_BLOCK) at 1 s each, plus 7 days: the deadline counts from the
        // end of the challenge period.
        assertEq(w.settleDeadline, NOW_TS + (END + DAY - NOW_BLOCK) + 7 days);
    }

    function test_validate_sharedChecks() public {
        vm.expectRevert(PerplFundingSpikeResolver.NonCanonicalParams.selector);
        resolver.validate(bytes.concat(_btc(0), bytes1(0)));

        vm.expectRevert(
            abi.encodeWithSelector(
                PerplFundingSpikeResolver.StartBlockNotInFuture.selector, uint64(NOW_BLOCK), NOW_BLOCK
            )
        );
        resolver.validate(_p(BTC, uint64(NOW_BLOCK), END, 0, 0));

        vm.expectRevert(abi.encodeWithSelector(PerplFundingSpikeResolver.PerpNotListed.selector, 2));
        resolver.validate(_p(2, START, END, 0, 0));

        vm.expectRevert(abi.encodeWithSelector(PerplFundingSpikeResolver.ScalingExpMismatch.selector, 1, 0));
        resolver.validate(_p(BTC, START, END, 0, 1));
        resolver.validate(_p(MON, START, END, 0, 2));

        uint64 shortEnd = START + uint64(INTERVAL) - 1;
        vm.expectRevert(
            abi.encodeWithSelector(PerplFundingSpikeResolver.WindowTooShort.selector, START, shortEnd, INTERVAL)
        );
        resolver.validate(_p(BTC, START, shortEnd, 0, 0));

        ex.setFundingStartBlock(BTC, START + 1);
        vm.expectRevert(
            abi.encodeWithSelector(PerplFundingSpikeResolver.FundingNotStarted.selector, BTC, START + 1, START)
        );
        resolver.validate(_btc(0));
        ex.setFundingStartBlock(BTC, 500_000);

        ex.setStatus(BTC, 0);
        vm.expectRevert(abi.encodeWithSelector(PerplFundingSpikeResolver.PerpPaused.selector, BTC));
        resolver.validate(_btc(0));
        ex.setStatus(BTC, 4);

        ex.setVersion(7, 6, 0);
        vm.expectRevert(abi.encodeWithSelector(PerplFundingSpikeResolver.ExchangeVersionChanged.selector, 7, 6, 0));
        resolver.validate(_btc(0));
    }

    function test_validate_windowTooLong() public {
        uint64 longest = START + uint64(31 * DAY);
        resolver.validate(_p(BTC, START, longest, 0, 0));
        vm.expectRevert(
            abi.encodeWithSelector(PerplFundingSpikeResolver.WindowTooLong.selector, START, longest + 1, 31 * DAY)
        );
        resolver.validate(_p(BTC, START, longest + 1, 0, 0));
    }

    // ------------------------------------------------------------ describe

    function test_describe() public view {
        assertEq(
            resolver.describe(_btc(30)),
            "YES if any single funding event on Perpl (BTC Perp, perp 1) after block 1000100 and at or before block 1024284 charges BTC longs more than $3 per BTC; NO if nobody proves one by block 1312284, about 24 hours after the window."
        );
        // MON: priceDecimals 6 + scaling exp 2 = 8 decimals.
        assertEq(
            resolver.describe(_p(MON, START, END, 1_250_000, 2)),
            "YES if any single funding event on Perpl (MON Perp, perp 10) after block 1000100 and at or before block 1024284 charges MON longs more than $0.0125 per MON; NO if nobody proves one by block 1312284, about 24 hours after the window."
        );
    }

    function test_describe_fallsBackWhenInfoUnavailable() public view {
        assertEq(
            resolver.describe(_p(3, START, END, 7, 0)),
            "YES if any single funding event on Perpl perp 3 after block 1000100 and at or before block 1024284 charges longs more than 7 raw funding units; NO if nobody proves one by block 1312284, about 24 hours after the window."
        );
    }

    // ------------------------------------------------------------ proof (YES)

    function test_proof_spike() public {
        vm.roll(E3 + 1); // the earliest block at which the event at E3 is final; before close + 1
        (Outcome o, bytes32 h) = resolver.resolve(_btc(30), abi.encode(E3));
        assertEq(uint8(o), uint8(Outcome.Yes));
        assertEq(h, keccak256(abi.encode(address(ex), BTC, E3, int48(160), uint256(E2), int48(125))));
    }

    function test_proof_equalIsNotASpike() public {
        vm.roll(END + 10);
        assertEq(uint8(_prove(_btc(34), E3)), uint8(Outcome.Yes));
        vm.expectRevert(
            abi.encodeWithSelector(PerplFundingSpikeResolver.NotASpike.selector, E3, int256(35), int256(35))
        );
        _prove(_btc(35), E3);
        vm.expectRevert(
            abi.encodeWithSelector(PerplFundingSpikeResolver.NotASpike.selector, E1, int256(20), int256(35))
        );
        _prove(_btc(35), E1);
    }

    function test_proof_negativeThreshold() public {
        vm.roll(END + 10);
        // E2 moved the sum by −5: more than −10, not more than −5.
        assertEq(uint8(_prove(_btc(-10), E2)), uint8(Outcome.Yes));
        vm.expectRevert(
            abi.encodeWithSelector(PerplFundingSpikeResolver.NotASpike.selector, E2, int256(-5), int256(-5))
        );
        _prove(_btc(-5), E2);
    }

    function test_proof_windowEdges() public {
        vm.roll(1_040_000);
        // The window's last block counts; the event after it does not.
        assertEq(uint8(_prove(_btc(30), END)), uint8(Outcome.Yes));
        vm.expectRevert(
            abi.encodeWithSelector(PerplFundingSpikeResolver.EventOutsideWindow.selector, uint64(1_032_855), START, END)
        );
        _prove(_btc(0), 1_032_855);
        // The start block itself does not count (a counted event is strictly after the lock).
        bytes memory fromE1 = _p(BTC, E1, END, 0, 0);
        vm.expectRevert(abi.encodeWithSelector(PerplFundingSpikeResolver.EventOutsideWindow.selector, E1, E1, END));
        _prove(fromE1, E1);
        assertEq(uint8(_prove(_p(BTC, E1 - 1, END, 10, 0), E1)), uint8(Outcome.Yes));
    }

    function test_proof_eventMustBeFinal() public {
        vm.roll(E3);
        vm.expectRevert(abi.encodeWithSelector(PerplFundingSpikeResolver.EventNotFinal.selector, E3, uint256(E3)));
        _prove(_btc(30), E3);
        vm.roll(E3 + 1);
        assertEq(uint8(_prove(_btc(30), E3)), uint8(Outcome.Yes));
    }

    function test_proof_pointerMustBeAnEventBlock() public {
        vm.roll(END + 10);
        vm.expectRevert(
            abi.encodeWithSelector(PerplFundingSpikeResolver.NotAFundingEvent.selector, E3 - 1, uint256(E2))
        );
        _prove(_btc(0), E3 - 1);
        ex.setLie(true, E3 + 1);
        vm.expectRevert(
            abi.encodeWithSelector(PerplFundingSpikeResolver.NotAFundingEvent.selector, E3, uint256(E3 + 1))
        );
        _prove(_btc(0), E3);
    }

    /// An increment that spans a skipped event (the perp was paused) is not a single interval.
    function test_proof_rejectsMoreThanOneInterval() public {
        uint256[] memory blocks = new uint256[](3);
        int48[] memory sums = new int48[](3);
        (blocks[0], blocks[1], blocks[2]) = (990_000, 998_571, 998_571 + 2 * INTERVAL);
        (sums[0], sums[1], sums[2]) = (0, 10, 500);
        (, PerplFundingSpikeResolver r) = _exchangeWith(blocks, sums);
        uint64 e = uint64(blocks[2]);
        vm.roll(e + 1);
        vm.expectRevert(
            abi.encodeWithSelector(PerplFundingSpikeResolver.NotOneInterval.selector, e, uint256(998_571), INTERVAL)
        );
        r.resolve(_p(BTC, START, e, 0, 0), abi.encode(e));
    }

    /// An off-grid event between e − interval and e means the event at e is not a full single interval.
    function test_proof_rejectsAnEventInBetween() public {
        uint256[] memory blocks = new uint256[](4);
        int48[] memory sums = new int48[](4);
        (blocks[0], blocks[1], blocks[2], blocks[3]) = (990_000, 998_571, 1_000_200, 998_571 + INTERVAL);
        (sums[0], sums[1], sums[2], sums[3]) = (0, 10, 400, 500);
        (, PerplFundingSpikeResolver r) = _exchangeWith(blocks, sums);
        uint64 e = uint64(blocks[3]);
        vm.roll(e + 1);
        vm.expectRevert(
            abi.encodeWithSelector(PerplFundingSpikeResolver.NotOneInterval.selector, e, uint256(1_000_200), INTERVAL)
        );
        r.resolve(_p(BTC, START, e, 0, 0), abi.encode(e));
    }

    function test_proof_readFailuresRevert() public {
        vm.roll(END + 10);
        ex.setSumRevertsAt(E3, true);
        vm.expectRevert(abi.encodeWithSelector(PerplFundingSpikeResolver.FundingReadFailed.selector, uint256(E3)));
        _prove(_btc(0), E3);
        ex.setSumRevertsAt(E3, false);
        ex.setSumRevertsAt(E3 - 1, true);
        vm.expectRevert(abi.encodeWithSelector(PerplFundingSpikeResolver.FundingReadFailed.selector, uint256(E3 - 1)));
        _prove(_btc(0), E3);
    }

    function test_proof_malformedEvidenceReverts() public {
        vm.roll(END + 10);
        vm.expectRevert(PerplFundingSpikeResolver.MalformedEvidence.selector);
        resolver.resolve(_btc(0), abi.encode(E3, E3));
        vm.expectRevert(PerplFundingSpikeResolver.MalformedEvidence.selector);
        resolver.resolve(_btc(0), hex"01");
        vm.expectRevert(); // a word wider than uint64 does not decode
        resolver.resolve(_btc(0), abi.encode(uint256(type(uint64).max) + 1));
    }

    /// A proof against a source that changed since creation cannot be vouched for: Unresolved.
    function test_proof_unresolvedWhenSourceChanged() public {
        vm.roll(END + 10);
        ex.setVersion(8, 0, 0);
        assertEq(uint8(_prove(_btc(0), E3)), uint8(Outcome.Unresolved));
        ex.setVersion(7, 5, 0);
        ex.setScalingExp(BTC, 1);
        assertEq(uint8(_prove(_btc(0), E3)), uint8(Outcome.Unresolved));
        ex.setScalingExp(BTC, 0);
        ex.setFundingStartBlock(BTC, START + 1); // the id was listed again during the window
        assertEq(uint8(_prove(_btc(0), E3)), uint8(Outcome.Unresolved));
        ex.setFundingStartBlock(BTC, 500_000);
        ex.setInterval(0);
        assertEq(uint8(_prove(_btc(0), E3)), uint8(Outcome.Unresolved));
        ex.setInterval(INTERVAL);
        ex.setInfoReverts(true);
        assertEq(uint8(_prove(_btc(0), E3)), uint8(Outcome.Unresolved));
        ex.setInfoReverts(false);
        ex.setIntervalReverts(true);
        assertEq(uint8(_prove(_btc(0), E3)), uint8(Outcome.Unresolved));
        ex.setIntervalReverts(false);
        assertEq(uint8(_prove(_btc(0), E3)), uint8(Outcome.Yes));
    }

    // ------------------------------------------------------------ NO after the challenge period

    function test_no_afterChallengeBlocks() public {
        vm.roll(END + DAY);
        (Outcome o, bytes32 h) = resolver.resolve(_btc(100), "");
        assertEq(uint8(o), uint8(Outcome.Unresolved));
        assertEq(h, bytes32(0));
        vm.roll(END + DAY + 1);
        (o, h) = resolver.resolve(_btc(100), "");
        assertEq(uint8(o), uint8(Outcome.No));
        assertEq(h, keccak256(abi.encode(address(ex), BTC, END, uint256(END) + DAY, uint256(E3), int48(160))));
    }

    function test_no_refusesWhenSourceChangedOrPaused() public {
        vm.roll(END + DAY + 1);
        ex.setVersionReverts(true);
        assertEq(uint8(_settleNo(_btc(100))), uint8(Outcome.Unresolved));
        ex.setVersionReverts(false);
        ex.setSumRevertsAt(END, true);
        assertEq(uint8(_settleNo(_btc(100))), uint8(Outcome.Unresolved));
        ex.setSumRevertsAt(END, false);
        ex.setLie(true, END + 1);
        assertEq(uint8(_settleNo(_btc(100))), uint8(Outcome.Unresolved));
        ex.setLie(false, 0);
        ex.delistPerp(BTC);
        assertEq(uint8(_settleNo(_btc(100))), uint8(Outcome.Unresolved));
    }

    function test_no_refusesWhenFundingStoppedBeforeTheEnd() public {
        // The last event at or before end2 is 1_032_855; end2 is just past two intervals after it.
        uint64 end2 = uint64(1_032_855 + 2 * INTERVAL + 1);
        vm.roll(end2 + DAY + 1);
        assertEq(uint8(_settleNo(_p(BTC, START, end2, 100, 0))), uint8(Outcome.Unresolved));
        assertEq(uint8(_settleNo(_p(BTC, START, end2 - 1, 100, 0))), uint8(Outcome.No));
    }

    function test_resolve_refundsValue() public {
        vm.deal(address(this), 2 ether);
        vm.roll(END + 10);
        resolver.resolve{value: 1 ether}(_btc(0), abi.encode(E3));
        vm.roll(END + DAY + 1);
        resolver.resolve{value: 1 ether}(_btc(100), "");
        assertEq(address(this).balance, 2 ether);
        assertEq(address(resolver).balance, 0);
    }

    // ------------------------------------------------------------ fuzz

    /// The rule at every threshold: a proof succeeds exactly when the increment is above it.
    function testFuzz_spikeEdge(int48 before, int48 increment, int256 threshold) public {
        increment = int48(bound(increment, -1e12, 1e12));
        before = int48(bound(before, -1e13, 1e13));
        uint64 e = START + uint64(INTERVAL);
        uint256[] memory blocks = new uint256[](2);
        int48[] memory sums = new int48[](2);
        (blocks[0], blocks[1]) = (e - INTERVAL, e);
        (sums[0], sums[1]) = (before, before + increment);
        (, PerplFundingSpikeResolver r) = _exchangeWith(blocks, sums);
        vm.roll(e + 1);
        bytes memory params = _p(BTC, START, e, threshold, 0);
        if (int256(increment) > threshold) {
            (Outcome o,) = r.resolve(params, abi.encode(e));
            assertEq(uint8(o), uint8(Outcome.Yes));
        } else {
            vm.expectRevert(
                abi.encodeWithSelector(PerplFundingSpikeResolver.NotASpike.selector, e, int256(increment), threshold)
            );
            r.resolve(params, abi.encode(e));
        }
    }

    /// Only an event block inside (start, end] that is final can ever prove YES; every other pointer
    /// reverts.
    function testFuzz_onlyGridEventsInTheWindow(uint64 e, uint256 current) public {
        e = uint64(bound(e, 990_000, 1_040_000));
        current = bound(current, NOW_BLOCK, 1_050_000);
        vm.roll(current);
        bool isEvent = e == E1 || e == E2 || e == E3 || e == 998_571 || e == 990_000 || e == 1_032_855;
        bool ok = isEvent && e > START && e <= END && e < current && e != E2; // E2 went down: −5 < 0
        try resolver.resolve(_btc(0), abi.encode(e)) returns (Outcome o, bytes32) {
            assertTrue(ok, "accepted a pointer that proves nothing");
            assertEq(uint8(o), uint8(Outcome.Yes));
        } catch {
            assertFalse(ok, "rejected a valid proof");
        }
    }

    /// Empty evidence answers NO exactly after endBlock + challengeBlocks, never before.
    function testFuzz_noTiming(uint256 current) public {
        current = bound(current, NOW_BLOCK, uint256(END) + 2 * DAY);
        vm.roll(current);
        Outcome o = _settleNo(_btc(100));
        assertEq(uint8(o), uint8(current > uint256(END) + DAY ? Outcome.No : Outcome.Unresolved));
    }

    /// validate accepts exactly the windows with interval <= length <= 31 days of blocks.
    function testFuzz_validateWindowLength(uint64 end) public view {
        end = uint64(bound(end, START, START + 32 * DAY));
        uint256 length = end - START;
        bool ok = length >= INTERVAL && length <= 31 * DAY;
        try resolver.validate(_p(BTC, START, end, 0, 0)) returns (Window memory w) {
            assertTrue(ok, "accepted a bad window");
            assertEq(w.close, end);
        } catch {
            assertFalse(ok, "rejected a good window");
        }
    }
}

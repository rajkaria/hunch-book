// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {Outcome, Window} from "../../src/interfaces/IHunchBookTypes.sol";
import {PerplFundingParams} from "../../src/interfaces/ITemplates.sol";
import {IPerplExchange} from "../../src/interfaces/external/IPerplExchange.sol";
import {PerplFundingResolver} from "../../src/resolvers/PerplFundingResolver.sol";
import {MockPerplExchange} from "./mocks/MockPerplExchange.sol";

/// Calls `resolve` with value from a contract that cannot receive ETH.
contract NoReceiveCaller {
    function call(PerplFundingResolver r, bytes memory params) external payable returns (Outcome o) {
        (o,) = r.resolve{value: msg.value}(params, "");
    }
}

contract PerplFundingResolverTest is Test {
    uint256 internal constant NOW_BLOCK = 1_000_000;
    uint256 internal constant NOW_TS = 1_800_000_000;
    uint256 internal constant INTERVAL = 8571;
    uint256 internal constant BTC = 1;
    uint256 internal constant MON = 10;

    uint64 internal constant START = 1_000_100;
    uint64 internal constant END = START + uint64(3 * INTERVAL); // 1_025_813

    MockPerplExchange internal ex;
    PerplFundingResolver internal resolver;

    receive() external payable {}

    function setUp() public {
        vm.roll(NOW_BLOCK);
        vm.warp(NOW_TS);
        ex = new MockPerplExchange();
        ex.listPerp(BTC, "BTC Perp", "BTC", 1, 0, 500_000);
        ex.listPerp(MON, "MON Perp", "MON", 6, 2, 500_000);
        resolver = new PerplFundingResolver(ex, 1000);

        // A funding grid every 8,571 blocks from block 990,000.
        ex.pushEvent(BTC, 990_000, 100);
        ex.pushEvent(BTC, 998_571, 110); // last event at or before START
        ex.pushEvent(BTC, 1_007_142, 130);
        ex.pushEvent(BTC, 1_015_713, 125);
        ex.pushEvent(BTC, 1_024_284, 160); // last event at or before END
        ex.pushEvent(BTC, 1_032_855, 170);
    }

    // ------------------------------------------------------------ helpers

    function _p(uint256 perpId, uint64 start, uint64 end, int256 threshold, uint8 exp)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encode(
            PerplFundingParams({
                perpId: perpId, startBlock: start, endBlock: end, threshold: threshold, expectedScalingExp: exp
            })
        );
    }

    function _btc(int256 threshold) internal pure returns (bytes memory) {
        return _p(BTC, START, END, threshold, 0);
    }

    function _resolve(bytes memory params) internal returns (Outcome o) {
        (o,) = resolver.resolve(params, "");
    }

    // ------------------------------------------------------------ constructor

    function test_constructor_pinsVersion() public view {
        assertEq(address(resolver.exchange()), address(ex));
        assertEq(resolver.blockTimeMs(), 1000);
        assertEq(resolver.versionMajor(), 7);
        assertEq(resolver.versionMinor(), 5);
        assertEq(resolver.versionPatch(), 0);
        assertTrue(resolver.versionUnchanged());
        assertFalse(resolver.earlyYes());
    }

    function test_constructor_revertsOnEoaExchange() public {
        vm.expectRevert(abi.encodeWithSelector(PerplFundingResolver.NotAContract.selector, address(0xBEEF)));
        new PerplFundingResolver(IPerplExchange(address(0xBEEF)), 1000);
    }

    function test_constructor_revertsOnLowBlockTime() public {
        vm.expectRevert(abi.encodeWithSelector(PerplFundingResolver.BlockTimeTooLow.selector, 799, 800));
        new PerplFundingResolver(ex, 799);
        new PerplFundingResolver(ex, 800); // the floor itself is accepted
    }

    // ------------------------------------------------------------ validate

    function test_validate_window() public view {
        Window memory w = resolver.validate(_btc(0));
        assertTrue(w.blockClock);
        assertEq(w.lock, START);
        assertEq(w.close, END);
        // (END − NOW_BLOCK) blocks at 1 s each, plus 7 days.
        assertEq(w.settleDeadline, NOW_TS + (END - NOW_BLOCK) + 7 days);
    }

    function test_validate_deadlineRoundsUp() public {
        PerplFundingResolver r = new PerplFundingResolver(ex, 801);
        Window memory w = r.validate(_btc(0));
        uint256 ms = uint256(END - NOW_BLOCK) * 801; // 25,813 blocks × 801 ms = 20,676,213 ms
        assertEq(w.settleDeadline, NOW_TS + (ms + 999) / 1000 + 7 days);
        assertEq(w.settleDeadline, NOW_TS + 20_677 + 7 days);
    }

    function test_validate_acceptsMinimumWindow() public view {
        resolver.validate(_p(BTC, START, START + uint64(INTERVAL), 0, 0));
    }

    function test_validate_revertsOnNonCanonicalParams() public {
        vm.expectRevert(PerplFundingResolver.NonCanonicalParams.selector);
        resolver.validate(bytes.concat(_btc(0), bytes1(0)));
    }

    function test_validate_revertsOnShortParams() public {
        vm.expectRevert();
        resolver.validate(hex"0001");
    }

    function test_validate_revertsWhenVersionChanged() public {
        ex.setVersion(7, 6, 0);
        vm.expectRevert(abi.encodeWithSelector(PerplFundingResolver.ExchangeVersionChanged.selector, 7, 6, 0));
        resolver.validate(_btc(0));
    }

    function test_validate_revertsWhenStartNotInFuture() public {
        vm.expectRevert(
            abi.encodeWithSelector(PerplFundingResolver.StartBlockNotInFuture.selector, uint64(NOW_BLOCK), NOW_BLOCK)
        );
        resolver.validate(_p(BTC, uint64(NOW_BLOCK), END, 0, 0));
        vm.expectRevert(
            abi.encodeWithSelector(
                PerplFundingResolver.StartBlockNotInFuture.selector, uint64(NOW_BLOCK - 1), NOW_BLOCK
            )
        );
        resolver.validate(_p(BTC, uint64(NOW_BLOCK - 1), END, 0, 0));
    }

    function test_validate_revertsOnUnlistedPerp() public {
        vm.expectRevert(abi.encodeWithSelector(PerplFundingResolver.PerpNotListed.selector, 2));
        resolver.validate(_p(2, START, END, 0, 0));
        vm.expectRevert(abi.encodeWithSelector(PerplFundingResolver.PerpNotListed.selector, 1024));
        resolver.validate(_p(1024, START, END, 0, 0));
    }

    function test_validate_readsUpperBitmapWords() public {
        ex.listPerp(700, "ZEC Perp", "ZEC", 2, 0, 500_000);
        assertTrue(resolver.isListed(700));
        assertFalse(resolver.isListed(699));
        assertFalse(resolver.isListed(2000));
        resolver.validate(_p(700, START, END, 0, 0));
    }

    function test_validate_revertsOnPausedPerp() public {
        ex.setStatus(BTC, 0);
        vm.expectRevert(abi.encodeWithSelector(PerplFundingResolver.PerpPaused.selector, BTC));
        resolver.validate(_btc(0));
    }

    function test_validate_revertsOnScalingExpMismatch() public {
        vm.expectRevert(abi.encodeWithSelector(PerplFundingResolver.ScalingExpMismatch.selector, 1, 0));
        resolver.validate(_p(BTC, START, END, 0, 1));
        resolver.validate(_p(MON, START, END, 0, 2));
    }

    function test_validate_revertsWhenFundingNotStarted() public {
        ex.setFundingStartBlock(BTC, START + 1);
        vm.expectRevert(abi.encodeWithSelector(PerplFundingResolver.FundingNotStarted.selector, BTC, START + 1, START));
        resolver.validate(_btc(0));
        ex.setFundingStartBlock(BTC, 0);
        vm.expectRevert(abi.encodeWithSelector(PerplFundingResolver.FundingNotStarted.selector, BTC, 0, START));
        resolver.validate(_btc(0));
        ex.setFundingStartBlock(BTC, START);
        resolver.validate(_btc(0));
    }

    function test_validate_revertsOnShortWindow() public {
        uint64 shortEnd = START + uint64(INTERVAL) - 1;
        vm.expectRevert(abi.encodeWithSelector(PerplFundingResolver.WindowTooShort.selector, START, shortEnd, INTERVAL));
        resolver.validate(_p(BTC, START, shortEnd, 0, 0));
        vm.expectRevert(abi.encodeWithSelector(PerplFundingResolver.WindowTooShort.selector, START, START, INTERVAL));
        resolver.validate(_p(BTC, START, START, 0, 0));
        vm.expectRevert(
            abi.encodeWithSelector(PerplFundingResolver.WindowTooShort.selector, START, START - 1, INTERVAL)
        );
        resolver.validate(_p(BTC, START, START - 1, 0, 0));
    }

    function test_validate_revertsOnDeadlineOverflow() public {
        vm.expectRevert(PerplFundingResolver.DeadlineOverflow.selector);
        resolver.validate(_p(BTC, START, type(uint64).max, 0, 0));
    }

    // ------------------------------------------------------------ resolve: timing

    function test_resolve_unresolvedUntilBlockAfterEnd() public {
        vm.roll(START);
        assertEq(uint8(_resolve(_btc(0))), uint8(Outcome.Unresolved));
        vm.roll(END);
        (Outcome o, bytes32 h) = resolver.resolve(_btc(0), "");
        assertEq(uint8(o), uint8(Outcome.Unresolved));
        assertEq(h, bytes32(0));
        vm.roll(END + 1);
        assertEq(uint8(_resolve(_btc(0))), uint8(Outcome.Yes));
    }

    function test_resolve_answerIsStableAfterLaterEvents() public {
        vm.roll(END + 1);
        (Outcome o1, bytes32 h1) = resolver.resolve(_btc(49), "");
        ex.pushEvent(BTC, 1_041_426, -500);
        vm.roll(END + 100_000);
        (Outcome o2, bytes32 h2) = resolver.resolve(_btc(49), "");
        assertEq(uint8(o1), uint8(Outcome.Yes));
        assertEq(uint8(o2), uint8(o1));
        assertEq(h2, h1);
    }

    // ------------------------------------------------------------ resolve: the rule

    function test_resolve_rule() public {
        vm.roll(END + 1);
        // ΔF = F(END) − F(START) = 160 − 110 = 50.
        assertEq(uint8(_resolve(_btc(0))), uint8(Outcome.Yes));
        assertEq(uint8(_resolve(_btc(49))), uint8(Outcome.Yes));
        assertEq(uint8(_resolve(_btc(50))), uint8(Outcome.No)); // equal is NO
        assertEq(uint8(_resolve(_btc(51))), uint8(Outcome.No));
        assertEq(uint8(_resolve(_btc(-1000))), uint8(Outcome.Yes));
    }

    function test_resolve_negativeFunding() public {
        // A window where shorts paid: F(1_015_713) − F(1_007_142) = 125 − 130 = −5.
        bytes memory params = _p(BTC, 1_007_142, 1_015_713 + 10, 0, 0);
        vm.roll(1_015_713 + 11);
        assertEq(uint8(_resolve(params)), uint8(Outcome.No));
        params = _p(BTC, 1_007_142, 1_015_713 + 10, -6, 0);
        assertEq(uint8(_resolve(params)), uint8(Outcome.Yes));
        params = _p(BTC, 1_007_142, 1_015_713 + 10, -5, 0);
        assertEq(uint8(_resolve(params)), uint8(Outcome.No));
    }

    function test_resolve_evidenceHash() public {
        vm.roll(END + 1);
        (, bytes32 h) = resolver.resolve(_btc(0), "");
        bytes32 expected = keccak256(
            abi.encode(address(ex), BTC, START, END, int48(110), int48(160), uint256(998_571), uint256(1_024_284))
        );
        assertEq(h, expected);
    }

    function test_resolve_revertsOnNonEmptyEvidence() public {
        vm.roll(END + 1);
        vm.expectRevert(PerplFundingResolver.EvidenceNotEmpty.selector);
        resolver.resolve(_btc(0), hex"00");
    }

    function test_resolve_refundsValue() public {
        vm.roll(END + 1);
        vm.deal(address(this), 1 ether);
        resolver.resolve{value: 1 ether}(_btc(0), "");
        assertEq(address(this).balance, 1 ether);
        assertEq(address(resolver).balance, 0);
    }

    function test_resolve_refundToNonReceiverReverts() public {
        vm.roll(END + 1);
        NoReceiveCaller c = new NoReceiveCaller();
        vm.deal(address(this), 1 ether);
        vm.expectRevert();
        c.call{value: 1}(resolver, _btc(0));
        // Without value it works.
        assertEq(uint8(c.call(resolver, _btc(0))), uint8(Outcome.Yes));
    }

    // ------------------------------------------------------------ resolve: refusals

    function test_resolve_unresolvedWhenVersionChanged() public {
        vm.roll(END + 1);
        ex.setVersion(8, 0, 0);
        assertFalse(resolver.versionUnchanged());
        assertEq(uint8(_resolve(_btc(0))), uint8(Outcome.Unresolved));
    }

    function test_resolve_unresolvedWhenVersionReadReverts() public {
        vm.roll(END + 1);
        ex.setVersionReverts(true);
        assertEq(uint8(_resolve(_btc(0))), uint8(Outcome.Unresolved));
    }

    function test_resolve_unresolvedWhenPerpRemoved() public {
        vm.roll(END + 1);
        ex.delistPerp(BTC);
        assertEq(uint8(_resolve(_btc(0))), uint8(Outcome.Unresolved));
    }

    function test_resolve_unresolvedWhenInfoReverts() public {
        vm.roll(END + 1);
        ex.setInfoReverts(true);
        assertEq(uint8(_resolve(_btc(0))), uint8(Outcome.Unresolved));
    }

    function test_resolve_unresolvedWhenScalingExpChanged() public {
        vm.roll(END + 1);
        ex.setScalingExp(BTC, 1);
        assertEq(uint8(_resolve(_btc(0))), uint8(Outcome.Unresolved));
    }

    function test_resolve_unresolvedWhenIdRelistedDuringWindow() public {
        vm.roll(END + 1);
        ex.setFundingStartBlock(BTC, START + 1);
        assertEq(uint8(_resolve(_btc(0))), uint8(Outcome.Unresolved));
        ex.setFundingStartBlock(BTC, 0);
        assertEq(uint8(_resolve(_btc(0))), uint8(Outcome.Unresolved));
    }

    function test_resolve_unresolvedWhenIntervalReadFails() public {
        vm.roll(END + 1);
        ex.setIntervalReverts(true);
        assertEq(uint8(_resolve(_btc(0))), uint8(Outcome.Unresolved));
        ex.setIntervalReverts(false);
        ex.setInterval(0);
        assertEq(uint8(_resolve(_btc(0))), uint8(Outcome.Unresolved));
    }

    function test_resolve_unresolvedWhenStartReadReverts() public {
        vm.roll(END + 1);
        ex.setSumRevertsAt(START, true);
        assertEq(uint8(_resolve(_btc(0))), uint8(Outcome.Unresolved));
    }

    function test_resolve_unresolvedWhenEndReadReverts() public {
        vm.roll(END + 1);
        ex.setSumRevertsAt(END, true);
        assertEq(uint8(_resolve(_btc(0))), uint8(Outcome.Unresolved));
    }

    function test_resolve_unresolvedWhenGetterLiesAboutEventBlock() public {
        vm.roll(END + 1);
        ex.setLie(true, END + 1); // an "event" after the block asked for
        assertEq(uint8(_resolve(_btc(0))), uint8(Outcome.Unresolved));
        ex.setLie(true, START + 1); // after START for the start read, before END for the end read
        assertEq(uint8(_resolve(_btc(0))), uint8(Outcome.Unresolved));
    }

    function test_resolve_unresolvedWhenGetterReportsNoEvent() public {
        MockPerplExchange ex2 = new MockPerplExchange();
        ex2.listPerp(BTC, "BTC Perp", "BTC", 1, 0, 1);
        PerplFundingResolver r2 = new PerplFundingResolver(ex2, 1000);
        ex2.pushEvent(BTC, START, 10);
        ex2.setLie(true, 0); // reports event block 0 for every read
        vm.roll(END + 1);
        (Outcome o,) = r2.resolve(_btc(0), "");
        // eventEnd (0) is more than two intervals before END: refused.
        assertEq(uint8(o), uint8(Outcome.Unresolved));
    }

    function test_resolve_unresolvedWhenPerpPausedAtEnd() public {
        // Last event at or before END2 is 1_032_855; END2 is just past two intervals after it.
        uint64 end2 = uint64(1_032_855 + 2 * INTERVAL + 1);
        bytes memory params = _p(BTC, START, end2, 0, 0);
        vm.roll(end2 + 1);
        assertEq(uint8(_resolve(params)), uint8(Outcome.Unresolved));
        // Exactly two intervals is still accepted.
        params = _p(BTC, START, end2 - 1, 0, 0);
        assertEq(uint8(_resolve(params)), uint8(Outcome.Yes));
    }

    function test_resolve_unresolvedWithNoEventsAtAll() public {
        MockPerplExchange ex2 = new MockPerplExchange();
        ex2.listPerp(BTC, "BTC Perp", "BTC", 1, 0, 1);
        PerplFundingResolver r2 = new PerplFundingResolver(ex2, 1000);
        vm.roll(END + 1);
        (Outcome o,) = r2.resolve(_btc(-1), "");
        assertEq(uint8(o), uint8(Outcome.Unresolved));
    }

    // ------------------------------------------------------------ describe

    function test_describe_netFunding() public view {
        assertEq(
            resolver.describe(_btc(0)),
            "Will BTC longs pay shorts on net in funding on Perpl (BTC Perp, perp 1) between block 1000100 and block 1025813?"
        );
    }

    function test_describe_threshold() public view {
        assertEq(
            resolver.describe(_btc(5)),
            "Will BTC longs pay more than $0.5 per BTC in funding on Perpl (BTC Perp, perp 1) between block 1000100 and block 1025813?"
        );
        assertEq(
            resolver.describe(_btc(-12_345)),
            "Will BTC longs pay more than -$1,234.5 per BTC in funding on Perpl (BTC Perp, perp 1) between block 1000100 and block 1025813?"
        );
        // MON: priceDecimals 6 + scaling exp 2 = 8 decimals.
        assertEq(
            resolver.describe(_p(MON, START, END, 1_250_000, 2)),
            "Will MON longs pay more than $0.0125 per MON in funding on Perpl (MON Perp, perp 10) between block 1000100 and block 1025813?"
        );
    }

    function test_describe_fallsBackWhenInfoUnavailable() public view {
        assertEq(
            resolver.describe(_p(3, START, END, -7, 0)),
            "Will longs on Perpl perp 3 pay more than -7 raw funding units between block 1000100 and block 1025813?"
        );
    }

    // ------------------------------------------------------------ fuzz

    /// The rule at every threshold: YES exactly when ΔF > X. Equal is NO.
    function testFuzz_thresholdEdge(int48 sumStart, int48 sumEnd, int256 threshold) public {
        MockPerplExchange ex2 = new MockPerplExchange();
        ex2.listPerp(BTC, "BTC Perp", "BTC", 1, 0, 1);
        ex2.pushEvent(BTC, START - 5, sumStart);
        ex2.pushEvent(BTC, END - 5, sumEnd);
        PerplFundingResolver r2 = new PerplFundingResolver(ex2, 1000);
        vm.roll(END + 1);

        int256 delta = int256(sumEnd) - int256(sumStart);
        (Outcome o,) = r2.resolve(_p(BTC, START, END, threshold, 0), "");
        assertEq(uint8(o), uint8(delta > threshold ? Outcome.Yes : Outcome.No));

        (Outcome atEdge,) = r2.resolve(_p(BTC, START, END, delta, 0), "");
        assertEq(uint8(atEdge), uint8(Outcome.No), "equal must be NO");
        (Outcome below,) = r2.resolve(_p(BTC, START, END, delta - 1, 0), "");
        assertEq(uint8(below), uint8(Outcome.Yes), "one unit below must be YES");
    }

    /// Never an answer at or before endBlock, whatever the data says.
    function testFuzz_unresolvedThroughEndBlock(uint256 current) public {
        current = bound(current, 0, END);
        vm.roll(current);
        assertEq(uint8(_resolve(_btc(0))), uint8(Outcome.Unresolved));
    }

    /// Staleness: the end event may lag endBlock by at most two intervals.
    function testFuzz_stalenessBoundary(uint256 lag) public {
        lag = bound(lag, 0, 5 * INTERVAL);
        uint64 end2 = uint64(1_032_855 + lag);
        vm.roll(end2 + 1);
        Outcome o = _resolve(_p(BTC, START, end2, 0, 0));
        if (lag > 2 * INTERVAL) assertEq(uint8(o), uint8(Outcome.Unresolved));
        else assertEq(uint8(o), uint8(Outcome.Yes));
    }

    /// The deadline estimate never lands before endBlock when real blocks are at most half as slow as
    /// the configured figure, and it is always at least seven days after that.
    function testFuzz_deadlineAfterEnd(uint64 end, uint256 blockTimeMs, uint256 realBlockMs) public {
        blockTimeMs = bound(blockTimeMs, 800, 10_000);
        realBlockMs = bound(realBlockMs, 1, blockTimeMs / 2);
        end = uint64(bound(end, START + INTERVAL, 1e12));
        PerplFundingResolver r2 = new PerplFundingResolver(ex, blockTimeMs);
        Window memory w = r2.validate(_p(BTC, START, end, 0, 0));
        uint256 realEndTime = NOW_TS + (uint256(end) - NOW_BLOCK) * realBlockMs / 1000;
        assertGe(w.settleDeadline, realEndTime + 7 days);
    }
}

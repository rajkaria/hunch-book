// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {LibString} from "solady/utils/LibString.sol";
import {Outcome, Window} from "../../src/interfaces/IHunchBookTypes.sol";
import {ChainlinkTouchParams} from "../../src/interfaces/ITemplatesV2.sol";
import {ChainlinkTouchResolver} from "../../src/resolvers/ChainlinkTouchResolver.sol";
import {MockChainlinkAggregator} from "./mocks/MockChainlinkAggregator.sol";

/// Calls `resolve` with value from a contract that cannot receive ETH.
contract TouchNoReceiveCaller {
    function call(ChainlinkTouchResolver r, bytes memory params, bytes memory evidence) external payable {
        r.resolve{value: msg.value}(params, evidence);
    }
}

contract ChainlinkTouchResolverTest is Test {
    uint256 internal constant NOW = 1_791_000_000;
    uint64 internal constant START = 1_791_288_000; // 2026-10-06 12:00:00 UTC
    uint64 internal constant END = 1_791_892_800; // 2026-10-13 12:00:00 UTC
    uint64 internal constant LOCK = START;
    uint256 internal constant CHALLENGE_END = END + 24 hours; // 2026-10-14 12:00:00 UTC
    uint80 internal constant PHASE1 = uint80(1) << 64;
    int256 internal constant K = 70_000e8;

    MockChainlinkAggregator internal btc; // 8 decimals
    MockChainlinkAggregator internal eth18; // 18 decimals
    MockChainlinkAggregator internal mon6; // 6 decimals
    ChainlinkTouchResolver internal resolver;

    receive() external payable {}

    function setUp() public {
        vm.warp(NOW);
        btc = new MockChainlinkAggregator(8, "BTC / USD");
        eth18 = new MockChainlinkAggregator(18, "ETH / USD");
        mon6 = new MockChainlinkAggregator(6, "MON / USD");
        address[] memory feeds = new address[](3);
        feeds[0] = address(btc);
        feeds[1] = address(eth18);
        feeds[2] = address(mon6);
        resolver = new ChainlinkTouchResolver(feeds);

        // BTC rounds: before the window, inside it (one touches 70,000), after it.
        btc.setRound(PHASE1 + 1, 69_500e8, START - 1);
        btc.setRound(PHASE1 + 2, 69_000e8, START);
        btc.setRound(PHASE1 + 3, 70_000e8, START + 2 days); // exactly the strike
        btc.setRound(PHASE1 + 4, 71_250e8, START + 3 days);
        btc.setRound(PHASE1 + 5, 65_000e8, END);
        btc.setRound(PHASE1 + 6, 72_000e8, END + 1);
        btc.setLatest(PHASE1 + 6);
    }

    // ------------------------------------------------------------ helpers

    function _p(address feed, int256 strike, uint8 direction, uint64 lock, uint64 start, uint64 end)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encode(
            ChainlinkTouchParams({
                feed: feed, strikeE8: strike, direction: direction, lockTime: lock, startTime: start, endTime: end
            })
        );
    }

    function _up(int256 strike) internal view returns (bytes memory) {
        return _p(address(btc), strike, 0, LOCK, START, END);
    }

    function _down(int256 strike) internal view returns (bytes memory) {
        return _p(address(btc), strike, 1, LOCK, START, END);
    }

    function _round(uint80 r) internal pure returns (bytes memory) {
        return abi.encode(r);
    }

    function _prove(bytes memory params, uint80 r) internal returns (Outcome o) {
        (o,) = resolver.resolve(params, _round(r));
    }

    function _settleNo(bytes memory params) internal returns (Outcome o) {
        (o,) = resolver.resolve(params, "");
    }

    function _resolverFor(address feed) internal returns (ChainlinkTouchResolver) {
        address[] memory feeds = new address[](1);
        feeds[0] = feed;
        return new ChainlinkTouchResolver(feeds);
    }

    // ------------------------------------------------------------ constructor

    function test_constructor_allowlist() public view {
        assertTrue(resolver.isFeedAllowed(address(btc)));
        assertFalse(resolver.isFeedAllowed(address(0xBEEF)));
        assertEq(resolver.feeds().length, 3);
        assertEq(resolver.feeds()[1], address(eth18));
        assertTrue(resolver.earlyYes());
        assertEq(resolver.CHALLENGE_PERIOD(), 24 hours);
    }

    function test_constructor_rejectsBadLists() public {
        address[] memory feeds = new address[](2);
        feeds[0] = address(btc);
        feeds[1] = address(btc);
        vm.expectRevert(ChainlinkTouchResolver.DuplicateEntry.selector);
        new ChainlinkTouchResolver(feeds);
        feeds[1] = address(0xBEEF);
        vm.expectRevert(abi.encodeWithSelector(ChainlinkTouchResolver.NotAContract.selector, address(0xBEEF)));
        new ChainlinkTouchResolver(feeds);
    }

    // ------------------------------------------------------------ validate

    function test_validate_window() public view {
        Window memory w = resolver.validate(_up(K));
        assertFalse(w.blockClock);
        assertEq(w.lock, LOCK);
        assertEq(w.close, END);
        assertEq(w.settleDeadline, END + 24 hours + 7 days);
        w = resolver.validate(_p(address(btc), K, 1, LOCK - 1 days, START, END));
        assertEq(w.lock, LOCK - 1 days);
    }

    function test_validate_acceptsLongestWindow() public view {
        resolver.validate(_p(address(btc), K, 0, LOCK, START, START + 31 days));
        resolver.validate(_p(address(btc), K, 0, LOCK, START, START + 1));
    }

    function test_validate_rejects() public {
        vm.expectRevert(ChainlinkTouchResolver.NonCanonicalParams.selector);
        resolver.validate(bytes.concat(_up(K), bytes1(0x01)));

        vm.expectRevert(abi.encodeWithSelector(ChainlinkTouchResolver.FeedNotAllowed.selector, address(0xBEEF)));
        resolver.validate(_p(address(0xBEEF), K, 0, LOCK, START, END));

        vm.expectRevert(abi.encodeWithSelector(ChainlinkTouchResolver.StrikeNotPositive.selector, int256(0)));
        resolver.validate(_up(0));
        vm.expectRevert(abi.encodeWithSelector(ChainlinkTouchResolver.StrikeNotPositive.selector, int256(-1)));
        resolver.validate(_down(-1));

        vm.expectRevert(abi.encodeWithSelector(ChainlinkTouchResolver.UnknownDirection.selector, uint8(2)));
        resolver.validate(_p(address(btc), K, 2, LOCK, START, END));
    }

    function test_validate_rejectsBadTimes() public {
        vm.expectRevert(abi.encodeWithSelector(ChainlinkTouchResolver.LockNotInFuture.selector, uint64(NOW), NOW));
        resolver.validate(_p(address(btc), K, 0, uint64(NOW), START, END));

        vm.expectRevert(abi.encodeWithSelector(ChainlinkTouchResolver.StartBeforeLock.selector, LOCK, START - 1));
        resolver.validate(_p(address(btc), K, 0, LOCK, START - 1, END));

        vm.expectRevert(abi.encodeWithSelector(ChainlinkTouchResolver.EmptyWindow.selector, START, START));
        resolver.validate(_p(address(btc), K, 0, LOCK, START, START));

        uint64 tooLong = START + 31 days + 1;
        vm.expectRevert(abi.encodeWithSelector(ChainlinkTouchResolver.WindowTooLong.selector, START, tooLong));
        resolver.validate(_p(address(btc), K, 0, LOCK, START, tooLong));

        uint64 late = type(uint64).max - 1 days;
        vm.expectRevert(ChainlinkTouchResolver.DeadlineOverflow.selector);
        resolver.validate(_p(address(btc), K, 0, late, late, late + 1));
    }

    // ------------------------------------------------------------ describe

    function test_describe() public view {
        assertEq(
            resolver.describe(_up(K)),
            "YES if Chainlink's BTC/USD feed reports a price at or above $70,000 in any round updated from 2026-10-06 12:00:00 UTC to 2026-10-13 12:00:00 UTC; NO if nobody proves that by 2026-10-14 12:00:00 UTC, the end of a 24-hour challenge period."
        );
        assertEq(
            resolver.describe(_p(address(mon6), 0.025e8, 1, LOCK, START, END)),
            "YES if Chainlink's MON/USD feed reports a price at or below $0.025 in any round updated from 2026-10-06 12:00:00 UTC to 2026-10-13 12:00:00 UTC; NO if nobody proves that by 2026-10-14 12:00:00 UTC, the end of a 24-hour challenge period."
        );
    }

    function test_describe_fallsBackToTheAddress() public view {
        string memory a = LibString.toHexStringChecksummed(address(this));
        assertEq(
            resolver.describe(_p(address(this), K, 0, LOCK, START, END)),
            string.concat(
                "YES if Chainlink's ",
                a,
                " feed reports a price at or above $70,000 in any round updated from 2026-10-06 12:00:00 UTC to 2026-10-13 12:00:00 UTC; NO if nobody proves that by 2026-10-14 12:00:00 UTC, the end of a 24-hour challenge period."
            )
        );
    }

    // ------------------------------------------------------------ proof (YES)

    function test_proof_touchAtOrAbove() public {
        vm.warp(START + 4 days); // before close: an early proof
        (Outcome o, bytes32 h) = resolver.resolve(_up(K), _round(PHASE1 + 4));
        assertEq(uint8(o), uint8(Outcome.Yes));
        assertEq(h, keccak256(abi.encode(address(btc), PHASE1 + 4, uint256(START + 3 days), int256(71_250e8))));
    }

    function test_proof_equalCountsInBothDirections() public {
        vm.warp(END + 1 hours);
        assertEq(uint8(_prove(_up(K), PHASE1 + 3)), uint8(Outcome.Yes));
        assertEq(uint8(_prove(_down(K), PHASE1 + 3)), uint8(Outcome.Yes));
        vm.expectRevert(
            abi.encodeWithSelector(ChainlinkTouchResolver.NoTouch.selector, PHASE1 + 3, int256(70_000e8), K + 1)
        );
        _prove(_up(K + 1), PHASE1 + 3);
        vm.expectRevert(
            abi.encodeWithSelector(ChainlinkTouchResolver.NoTouch.selector, PHASE1 + 3, int256(70_000e8), K - 1)
        );
        _prove(_down(K - 1), PHASE1 + 3);
    }

    function test_proof_touchAtOrBelow() public {
        vm.warp(END + 1 hours);
        assertEq(uint8(_prove(_down(66_000e8), PHASE1 + 5)), uint8(Outcome.Yes));
        // A round above the strike proves nothing for "at or below".
        vm.expectRevert(
            abi.encodeWithSelector(ChainlinkTouchResolver.NoTouch.selector, PHASE1 + 4, int256(71_250e8), 66_000e8)
        );
        _prove(_down(66_000e8), PHASE1 + 4);
    }

    function test_proof_windowEdgesIncluded() public {
        vm.warp(CHALLENGE_END + 1 days); // proofs stay valid after the challenge period too
        // updatedAt == START and == END both count.
        assertEq(uint8(_prove(_down(69_000e8), PHASE1 + 2)), uint8(Outcome.Yes));
        assertEq(uint8(_prove(_down(65_000e8), PHASE1 + 5)), uint8(Outcome.Yes));
        // One second outside either end does not.
        vm.expectRevert(
            abi.encodeWithSelector(
                ChainlinkTouchResolver.RoundOutsideWindow.selector, PHASE1 + 1, uint256(START - 1), START, END
            )
        );
        _prove(_down(70_000e8), PHASE1 + 1);
        vm.expectRevert(
            abi.encodeWithSelector(
                ChainlinkTouchResolver.RoundOutsideWindow.selector, PHASE1 + 6, uint256(END + 1), START, END
            )
        );
        _prove(_up(K), PHASE1 + 6);
    }

    function test_proof_badPointersRevert() public {
        vm.warp(END + 1 hours);
        // A round that does not exist (zeros), reverts, or echoes another id.
        vm.expectRevert(abi.encodeWithSelector(ChainlinkTouchResolver.RoundNotFound.selector, PHASE1 + 99));
        _prove(_up(K), PHASE1 + 99);
        btc.setReverts(PHASE1 + 4, true);
        vm.expectRevert(abi.encodeWithSelector(ChainlinkTouchResolver.RoundNotFound.selector, PHASE1 + 4));
        _prove(_up(K), PHASE1 + 4);
        btc.setReverts(PHASE1 + 4, false);
        btc.setEchoWrongId(true);
        vm.expectRevert(abi.encodeWithSelector(ChainlinkTouchResolver.RoundNotFound.selector, PHASE1 + 4));
        _prove(_up(K), PHASE1 + 4);
        btc.setEchoWrongId(false);

        // A carried-over answer is not a new observation.
        btc.setAnsweredIn(PHASE1 + 4, PHASE1 + 3);
        vm.expectRevert(
            abi.encodeWithSelector(ChainlinkTouchResolver.RoundCarriedOver.selector, PHASE1 + 4, PHASE1 + 3)
        );
        _prove(_up(K), PHASE1 + 4);
        btc.setAnsweredIn(PHASE1 + 4, 0);

        // A round whose phase aggregator is gone cannot be scaled.
        btc.setPhaseAggregator(1, address(0), true);
        vm.expectRevert(abi.encodeWithSelector(ChainlinkTouchResolver.RoundNotFound.selector, PHASE1 + 4));
        _prove(_up(K), PHASE1 + 4);
    }

    function test_proof_nonPositiveAnswerReverts() public {
        btc.setRound(PHASE1 + 7, 0, START + 1 hours);
        btc.setRound(PHASE1 + 8, -1, START + 2 hours);
        vm.warp(END);
        vm.expectRevert(abi.encodeWithSelector(ChainlinkTouchResolver.NonPositivePrice.selector, int256(0)));
        _prove(_down(K), PHASE1 + 7);
        vm.expectRevert(abi.encodeWithSelector(ChainlinkTouchResolver.NonPositivePrice.selector, int256(-1)));
        _prove(_down(K), PHASE1 + 8);
    }

    function test_proof_malformedEvidenceReverts() public {
        vm.warp(END);
        vm.expectRevert(ChainlinkTouchResolver.MalformedEvidence.selector);
        resolver.resolve(_up(K), abi.encode(uint80(1), uint80(2)));
        vm.expectRevert(ChainlinkTouchResolver.MalformedEvidence.selector);
        resolver.resolve(_up(K), hex"01");
        vm.expectRevert(); // a word wider than uint80 does not decode
        resolver.resolve(_up(K), abi.encode(uint256(type(uint80).max) + 1));
    }

    function test_resolve_rejectsFeedNotAllowed() public {
        vm.warp(END);
        MockChainlinkAggregator other = new MockChainlinkAggregator(8, "X / USD");
        vm.expectRevert(abi.encodeWithSelector(ChainlinkTouchResolver.FeedNotAllowed.selector, address(other)));
        resolver.resolve(_p(address(other), K, 0, LOCK, START, END), _round(PHASE1 + 4));
        vm.expectRevert(abi.encodeWithSelector(ChainlinkTouchResolver.FeedNotAllowed.selector, address(other)));
        resolver.resolve(_p(address(other), K, 0, LOCK, START, END), "");
    }

    /// 18 decimals: 70,000.000000001 is above 70,000, so it touches "at or above" but not "at or below",
    /// even though it truncates to exactly 70,000 at 8 decimals.
    function test_proof_directionSafeRounding() public {
        eth18.setRound(PHASE1 + 1, 70_000_000_000_001_000_000_000, START + 1);
        eth18.setRound(PHASE1 + 2, 69_999_999_999_999_000_000_000, START + 2);
        vm.warp(END);
        bytes memory up = _p(address(eth18), K, 0, LOCK, START, END);
        bytes memory down = _p(address(eth18), K, 1, LOCK, START, END);
        assertEq(uint8(_prove(up, PHASE1 + 1)), uint8(Outcome.Yes));
        vm.expectRevert(
            abi.encodeWithSelector(ChainlinkTouchResolver.NoTouch.selector, PHASE1 + 1, int256(70_000e8 + 1), K)
        );
        _prove(down, PHASE1 + 1);
        // 69,999.999999999: below 70,000, so "at or below" holds and "at or above" does not.
        assertEq(uint8(_prove(down, PHASE1 + 2)), uint8(Outcome.Yes));
        vm.expectRevert(
            abi.encodeWithSelector(ChainlinkTouchResolver.NoTouch.selector, PHASE1 + 2, int256(70_000e8 - 1), K)
        );
        _prove(up, PHASE1 + 2);
    }

    function test_proof_sixDecimals() public {
        mon6.setRound(PHASE1 + 1, 25_000, START + 1); // 0.025 USD
        vm.warp(END);
        assertEq(uint8(_prove(_p(address(mon6), 0.025e8, 1, LOCK, START, END), PHASE1 + 1)), uint8(Outcome.Yes));
        assertEq(uint8(_prove(_p(address(mon6), 0.025e8, 0, LOCK, START, END), PHASE1 + 1)), uint8(Outcome.Yes));
        vm.expectRevert(
            abi.encodeWithSelector(ChainlinkTouchResolver.NoTouch.selector, PHASE1 + 1, int256(0.025e8), 0.025e8 + 1)
        );
        _prove(_p(address(mon6), 0.025e8 + 1, 0, LOCK, START, END), PHASE1 + 1);
    }

    /// A round from an earlier phase is scaled with that phase's aggregator's decimals.
    function test_proof_usesTheRoundsOwnPhaseDecimals() public {
        MockChainlinkAggregator f = new MockChainlinkAggregator(8, "TEST / USD");
        MockChainlinkAggregator old18 = new MockChainlinkAggregator(18, "old");
        f.setPhaseAggregator(1, address(old18), false);
        f.setRound(PHASE1 + 1, 2e18, START + 10); // 2 USD in 18 decimals
        ChainlinkTouchResolver r = _resolverFor(address(f));
        vm.warp(END);
        (Outcome o,) = r.resolve(_p(address(f), 2e8, 0, LOCK, START, END), _round(PHASE1 + 1));
        assertEq(uint8(o), uint8(Outcome.Yes));
        vm.expectRevert(
            abi.encodeWithSelector(ChainlinkTouchResolver.NoTouch.selector, PHASE1 + 1, int256(2e8), 2e8 + 1)
        );
        r.resolve(_p(address(f), 2e8 + 1, 0, LOCK, START, END), _round(PHASE1 + 1));
    }

    // ------------------------------------------------------------ NO after the challenge period

    function test_no_unresolvedUntilChallengeEnds() public {
        vm.warp(END);
        assertEq(uint8(_settleNo(_up(80_000e8))), uint8(Outcome.Unresolved));
        vm.warp(CHALLENGE_END - 1);
        (Outcome o, bytes32 h) = resolver.resolve(_up(80_000e8), "");
        assertEq(uint8(o), uint8(Outcome.Unresolved));
        assertEq(h, bytes32(0));
        vm.warp(CHALLENGE_END);
        (o, h) = resolver.resolve(_up(80_000e8), "");
        assertEq(uint8(o), uint8(Outcome.No));
        assertEq(h, keccak256(abi.encode(address(btc), END, CHALLENGE_END, PHASE1 + 6, uint256(END + 1))));
    }

    function test_no_needsTheFeedAliveAtTheEnd() public {
        vm.warp(CHALLENGE_END + 1 hours);
        // Latest round before the window's end: the feed went dark, so silence proves nothing.
        btc.setLatest(PHASE1 + 4);
        assertEq(uint8(_settleNo(_up(80_000e8))), uint8(Outcome.Unresolved));
        // A round exactly at the end is enough.
        btc.setLatest(PHASE1 + 5);
        assertEq(uint8(_settleNo(_up(80_000e8))), uint8(Outcome.No));
        // A feed that cannot answer: no NO.
        btc.setLatestReverts(true);
        assertEq(uint8(_settleNo(_up(80_000e8))), uint8(Outcome.Unresolved));
    }

    function test_no_isNotAProof() public {
        // Even when a touch happened, empty evidence never says YES: someone has to point at it.
        vm.warp(CHALLENGE_END);
        assertEq(uint8(_settleNo(_up(K))), uint8(Outcome.No));
        assertEq(uint8(_prove(_up(K), PHASE1 + 3)), uint8(Outcome.Yes));
    }

    function test_resolve_refundsValue() public {
        vm.deal(address(this), 2 ether);
        vm.warp(END);
        resolver.resolve{value: 1 ether}(_up(K), _round(PHASE1 + 3));
        vm.warp(CHALLENGE_END);
        resolver.resolve{value: 1 ether}(_up(K), "");
        assertEq(address(this).balance, 2 ether);
        assertEq(address(resolver).balance, 0);

        TouchNoReceiveCaller c = new TouchNoReceiveCaller();
        vm.deal(address(c), 1 ether);
        vm.expectRevert();
        c.call{value: 1}(resolver, _up(K), "");
    }

    // ------------------------------------------------------------ fuzz

    /// Strike edge at any decimals and in both directions: a proof succeeds exactly when the real
    /// price (answer / 10^d) touches the strike (strike / 10^8); otherwise it reverts.
    function testFuzz_touchEdge(uint256 answer, uint256 strike, uint8 decimals, bool down) public {
        decimals = uint8(bound(decimals, 0, 30));
        answer = bound(answer, 1, 1e30);
        strike = bound(strike, 1, 1e30);
        MockChainlinkAggregator f = new MockChainlinkAggregator(decimals, "X / USD");
        f.setRound(PHASE1 + 1, int256(answer), START + 1);
        ChainlinkTouchResolver r = _resolverFor(address(f));
        vm.warp(END);
        bytes memory params = _p(address(f), int256(strike), down ? 1 : 0, LOCK, START, END);
        // Compare answer × 10^8 with strike × 10^d exactly.
        uint256 lhs = answer * 1e8;
        uint256 rhs = strike * 10 ** decimals;
        bool touched = down ? lhs <= rhs : lhs >= rhs;
        if (!touched) vm.expectPartialRevert(ChainlinkTouchResolver.NoTouch.selector);
        (Outcome o,) = r.resolve(params, _round(PHASE1 + 1));
        if (touched) assertEq(uint8(o), uint8(Outcome.Yes));
    }

    /// A round counts exactly when start <= updatedAt <= end.
    function testFuzz_windowMembership(uint64 updatedAt) public {
        updatedAt = uint64(bound(updatedAt, 1, END + 30 days));
        MockChainlinkAggregator f = new MockChainlinkAggregator(8, "X / USD");
        f.setRound(PHASE1 + 1, 1e8, updatedAt);
        ChainlinkTouchResolver r = _resolverFor(address(f));
        vm.warp(END + 31 days);
        bool inside = updatedAt >= START && updatedAt <= END;
        if (!inside) vm.expectPartialRevert(ChainlinkTouchResolver.RoundOutsideWindow.selector);
        (Outcome o,) = r.resolve(_p(address(f), 1e8, 0, LOCK, START, END), _round(PHASE1 + 1));
        if (inside) assertEq(uint8(o), uint8(Outcome.Yes));
    }

    /// validate accepts exactly: lock in the future, lock <= start < end, end − start <= 31 days.
    function testFuzz_validateTimes(uint64 lock, uint64 start, uint64 end) public view {
        lock = uint64(bound(lock, NOW - 10, NOW + 400 days));
        start = uint64(bound(start, NOW - 10, NOW + 400 days));
        end = uint64(bound(end, NOW - 10, NOW + 400 days));
        bool ok = lock > NOW && start >= lock && end > start && end - start <= 31 days;
        try resolver.validate(_p(address(btc), K, 0, lock, start, end)) returns (Window memory w) {
            assertTrue(ok, "accepted a bad window");
            assertEq(w.close, end);
            assertEq(w.settleDeadline, uint256(end) + 24 hours + 7 days);
        } catch {
            assertFalse(ok, "rejected a good window");
        }
    }

    /// Empty evidence says NO exactly from the end of the challenge period, and never before.
    function testFuzz_noTiming(uint256 t) public {
        t = bound(t, END, CHALLENGE_END + 30 days);
        vm.warp(t);
        Outcome o = _settleNo(_up(80_000e8));
        assertEq(uint8(o), uint8(t >= CHALLENGE_END ? Outcome.No : Outcome.Unresolved));
    }
}

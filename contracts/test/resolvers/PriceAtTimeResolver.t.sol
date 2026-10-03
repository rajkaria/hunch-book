// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {LibString} from "solady/utils/LibString.sol";
import {Outcome, Window} from "../../src/interfaces/IHunchBookTypes.sol";
import {PriceAtTimeParams} from "../../src/interfaces/ITemplates.sol";
import {IPyth} from "../../src/interfaces/external/IPyth.sol";
import {PriceAtTimeResolver} from "../../src/resolvers/PriceAtTimeResolver.sol";
import {MockChainlinkAggregator} from "./mocks/MockChainlinkAggregator.sol";
import {MockPyth} from "./mocks/MockPyth.sol";

contract PriceAtTimeResolverTest is Test {
    uint256 internal constant NOW = 1_791_000_000;
    uint64 internal constant T = 1_791_115_200; // 2026-10-04 12:00:00 UTC
    uint64 internal constant LOCK = T - 1 hours;
    uint80 internal constant PHASE1 = uint80(1) << 64;
    bytes32 internal constant SOL = keccak256("SOL/USD");
    uint256 internal constant FEE = 7;

    MockChainlinkAggregator internal btc; // 8 decimals
    MockChainlinkAggregator internal eth18; // 18 decimals
    MockChainlinkAggregator internal mon6; // 6 decimals
    MockPyth internal pyth;
    PriceAtTimeResolver internal resolver;

    receive() external payable {}

    function setUp() public {
        vm.warp(NOW);
        btc = new MockChainlinkAggregator(8, "BTC / USD");
        eth18 = new MockChainlinkAggregator(18, "ETH / USD");
        mon6 = new MockChainlinkAggregator(6, "MON / USD");
        pyth = new MockPyth(FEE);
        resolver = _deploy(address(pyth));

        // BTC rounds around T: r2 brackets T.
        btc.setRound(PHASE1 + 1, 80_000e8, T - 3 hours);
        btc.setRound(PHASE1 + 2, 84_000e8, T - 30 minutes);
        btc.setRound(PHASE1 + 3, 86_000e8, T + 10 minutes);
        btc.setRound(PHASE1 + 4, 87_000e8, T + 2 hours);
    }

    // ------------------------------------------------------------ helpers

    function _deploy(address pyth_) internal returns (PriceAtTimeResolver) {
        address[] memory feeds = new address[](3);
        feeds[0] = address(btc);
        feeds[1] = address(eth18);
        feeds[2] = address(mon6);
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = SOL;
        string[] memory labels = new string[](1);
        labels[0] = "SOL/USD";
        if (pyth_ == address(0)) {
            ids = new bytes32[](0);
            labels = new string[](0);
        }
        return new PriceAtTimeResolver(feeds, IPyth(pyth_), ids, labels);
    }

    function _cl(address feed, int256 strike) internal pure returns (bytes memory) {
        return abi.encode(
            PriceAtTimeParams({
                source: 0, feed: feed, pythId: bytes32(0), strikeE8: strike, lockTime: LOCK, closeTime: T
            })
        );
    }

    function _py(bytes32 id, int256 strike) internal pure returns (bytes memory) {
        return abi.encode(
            PriceAtTimeParams({source: 1, feed: address(0), pythId: id, strikeE8: strike, lockTime: LOCK, closeTime: T})
        );
    }

    function _round(uint80 r) internal pure returns (bytes memory) {
        return abi.encode(r);
    }

    function _resolveCl(int256 strike, uint80 r) internal returns (Outcome o) {
        (o,) = resolver.resolve(_cl(address(btc), strike), _round(r));
    }

    /// Same encoding as MockPyth.encodeUpdate, built locally so it is not an external call.
    function _update(bytes32 id, int64 price, int32 expo, uint64 publishTime, uint64 prev)
        internal
        pure
        returns (bytes memory)
    {
        IPyth.Price memory p = IPyth.Price({price: price, conf: 10, expo: expo, publishTime: publishTime});
        return abi.encode(IPyth.PriceFeed({id: id, price: p, emaPrice: p}), prev);
    }

    function _pythEvidence(int64 price, int32 expo, uint64 publishTime, uint64 prev)
        internal
        pure
        returns (bytes memory)
    {
        bytes[] memory updates = new bytes[](1);
        updates[0] = _update(SOL, price, expo, publishTime, prev);
        return abi.encode(updates);
    }

    // ------------------------------------------------------------ constructor

    function test_constructor_allowlists() public view {
        assertTrue(resolver.isFeedAllowed(address(btc)));
        assertFalse(resolver.isFeedAllowed(address(0xBEEF)));
        assertTrue(resolver.isPythIdAllowed(SOL));
        assertEq(resolver.feeds().length, 3);
        assertEq(resolver.pythIds()[0], SOL);
        assertEq(resolver.pythLabel(SOL), "SOL/USD");
        assertEq(address(resolver.pyth()), address(pyth));
        assertFalse(resolver.earlyYes());
    }

    function test_constructor_rejectsBadLists() public {
        address[] memory feeds = new address[](2);
        feeds[0] = address(btc);
        feeds[1] = address(btc);
        vm.expectRevert(PriceAtTimeResolver.DuplicateEntry.selector);
        new PriceAtTimeResolver(feeds, IPyth(address(0)), new bytes32[](0), new string[](0));

        feeds[1] = address(0xBEEF);
        vm.expectRevert(abi.encodeWithSelector(PriceAtTimeResolver.NotAContract.selector, address(0xBEEF)));
        new PriceAtTimeResolver(feeds, IPyth(address(0)), new bytes32[](0), new string[](0));

        address[] memory none = new address[](0);
        bytes32[] memory ids = new bytes32[](2);
        ids[0] = SOL;
        ids[1] = SOL;
        string[] memory labels = new string[](2);
        labels[0] = "SOL/USD";
        labels[1] = "SOL/USD";
        vm.expectRevert(PriceAtTimeResolver.DuplicateEntry.selector);
        new PriceAtTimeResolver(none, pyth, ids, labels);

        vm.expectRevert(abi.encodeWithSelector(PriceAtTimeResolver.NotAContract.selector, address(0)));
        new PriceAtTimeResolver(none, IPyth(address(0)), ids, labels);

        vm.expectRevert(PriceAtTimeResolver.LengthMismatch.selector);
        new PriceAtTimeResolver(none, pyth, ids, new string[](1));

        ids[1] = keccak256("other");
        labels[1] = "";
        vm.expectRevert(PriceAtTimeResolver.EmptyLabel.selector);
        new PriceAtTimeResolver(none, pyth, ids, labels);
    }

    // ------------------------------------------------------------ validate

    function test_validate_windows() public view {
        Window memory w = resolver.validate(_cl(address(btc), 85_000e8));
        assertFalse(w.blockClock);
        assertEq(w.lock, LOCK);
        assertEq(w.close, T);
        assertEq(w.settleDeadline, T + 7 days);
        w = resolver.validate(_py(SOL, 150e8));
        assertEq(w.close, T);
        assertEq(w.settleDeadline, T + 7 days);
    }

    function test_validate_closeMayEqualLock() public view {
        bytes memory p = abi.encode(
            PriceAtTimeParams({
                source: 0, feed: address(btc), pythId: bytes32(0), strikeE8: 1, lockTime: T, closeTime: T
            })
        );
        resolver.validate(p);
    }

    function test_validate_rejects() public {
        vm.expectRevert(PriceAtTimeResolver.NonCanonicalParams.selector);
        resolver.validate(bytes.concat(_cl(address(btc), 1), bytes1(0x01)));

        vm.expectRevert(abi.encodeWithSelector(PriceAtTimeResolver.FeedNotAllowed.selector, address(0xBEEF)));
        resolver.validate(_cl(address(0xBEEF), 1));

        vm.expectRevert(abi.encodeWithSelector(PriceAtTimeResolver.PythIdNotAllowed.selector, bytes32(uint256(1))));
        resolver.validate(_py(bytes32(uint256(1)), 1));

        vm.expectRevert(abi.encodeWithSelector(PriceAtTimeResolver.StrikeNotPositive.selector, int256(0)));
        resolver.validate(_cl(address(btc), 0));
        vm.expectRevert(abi.encodeWithSelector(PriceAtTimeResolver.StrikeNotPositive.selector, int256(-1)));
        resolver.validate(_cl(address(btc), -1));
    }

    function test_validate_rejectsUnusedFieldsAndUnknownSource() public {
        PriceAtTimeParams memory p =
            PriceAtTimeParams({source: 0, feed: address(btc), pythId: SOL, strikeE8: 1, lockTime: LOCK, closeTime: T});
        vm.expectRevert(PriceAtTimeResolver.UnusedFieldSet.selector);
        resolver.validate(abi.encode(p));

        p.source = 1;
        vm.expectRevert(PriceAtTimeResolver.UnusedFieldSet.selector);
        resolver.validate(abi.encode(p));

        p.source = 2;
        vm.expectRevert(abi.encodeWithSelector(PriceAtTimeResolver.UnknownSource.selector, uint8(2)));
        resolver.validate(abi.encode(p));
    }

    function test_validate_rejectsPythWithoutPyth() public {
        PriceAtTimeResolver noPyth = _deploy(address(0));
        vm.expectRevert(PriceAtTimeResolver.PythNotConfigured.selector);
        noPyth.validate(_py(SOL, 1));
    }

    function test_validate_rejectsBadTimes() public {
        PriceAtTimeParams memory p = PriceAtTimeParams({
            source: 0, feed: address(btc), pythId: bytes32(0), strikeE8: 1, lockTime: uint64(NOW), closeTime: T
        });
        vm.expectRevert(abi.encodeWithSelector(PriceAtTimeResolver.LockNotInFuture.selector, uint64(NOW), NOW));
        resolver.validate(abi.encode(p));

        p.lockTime = T;
        p.closeTime = T - 1;
        vm.expectRevert(abi.encodeWithSelector(PriceAtTimeResolver.CloseBeforeLock.selector, T, T - 1));
        resolver.validate(abi.encode(p));

        p.closeTime = type(uint64).max;
        vm.expectRevert(PriceAtTimeResolver.DeadlineOverflow.selector);
        resolver.validate(abi.encode(p));
    }

    // ------------------------------------------------------------ describe

    function test_describe() public view {
        assertEq(
            resolver.describe(_cl(address(btc), 85_000e8)),
            "Will BTC/USD be at or above $85,000 at 2026-10-04 12:00:00 UTC (unix time 1791115200), per Chainlink's BTC/USD feed?"
        );
        assertEq(
            resolver.describe(_py(SOL, 150.25e8)),
            "Will SOL/USD be at or above $150.25 at 2026-10-04 12:00:00 UTC (unix time 1791115200), per Pyth's SOL/USD feed?"
        );
    }

    function test_describe_fallbacks() public {
        bytes32 unknown = bytes32(uint256(0xabc));
        string memory d = resolver.describe(_py(unknown, 1e8));
        assertEq(
            d,
            "Will 0x0000000000000000000000000000000000000000000000000000000000000abc be at or above $1 at 2026-10-04 12:00:00 UTC (unix time 1791115200), per Pyth's 0x0000000000000000000000000000000000000000000000000000000000000abc feed?"
        );
        // A feed without description(): falls back to its address.
        d = resolver.describe(_cl(address(this), 1e8));
        string memory a = LibString.toHexStringChecksummed(address(this));
        assertEq(
            d,
            string.concat(
                "Will ",
                a,
                " be at or above $1 at 2026-10-04 12:00:00 UTC (unix time 1791115200), per Chainlink's ",
                a,
                " feed?"
            )
        );
        PriceAtTimeParams memory p = PriceAtTimeParams({
            source: 9, feed: address(0), pythId: bytes32(0), strikeE8: 1, lockTime: LOCK, closeTime: T
        });
        vm.expectRevert(abi.encodeWithSelector(PriceAtTimeResolver.UnknownSource.selector, uint8(9)));
        resolver.describe(abi.encode(p));
    }

    // ------------------------------------------------------------ resolve: Chainlink

    function test_cl_unresolvedUntilAfterT() public {
        vm.warp(T);
        (Outcome o, bytes32 h) = resolver.resolve(_cl(address(btc), 1), _round(PHASE1 + 2));
        assertEq(uint8(o), uint8(Outcome.Unresolved));
        assertEq(h, bytes32(0));
        vm.warp(T + 1);
        assertEq(uint8(_resolveCl(1, PHASE1 + 2)), uint8(Outcome.Yes));
    }

    function test_cl_rule() public {
        vm.warp(T + 1 hours);
        assertEq(uint8(_resolveCl(84_000e8, PHASE1 + 2)), uint8(Outcome.Yes)); // equal is YES
        assertEq(uint8(_resolveCl(84_000e8 - 1, PHASE1 + 2)), uint8(Outcome.Yes));
        assertEq(uint8(_resolveCl(84_000e8 + 1, PHASE1 + 2)), uint8(Outcome.No));
    }

    function test_cl_onlyTheBracketingRound() public {
        vm.warp(T + 1 days);
        vm.expectRevert(
            abi.encodeWithSelector(
                PriceAtTimeResolver.RoundNotLastBeforeTarget.selector, PHASE1 + 1, uint256(T - 30 minutes), T
            )
        );
        _resolveCl(1, PHASE1 + 1);
        vm.expectRevert(
            abi.encodeWithSelector(
                PriceAtTimeResolver.RoundAfterTarget.selector, PHASE1 + 3, uint256(T + 10 minutes), T
            )
        );
        _resolveCl(1, PHASE1 + 3);
        assertEq(uint8(_resolveCl(1, PHASE1 + 2)), uint8(Outcome.Yes));
    }

    function test_cl_unresolvedWhenNextRoundMissing() public {
        // Only r1 exists after T − 3h: r2 does not exist yet.
        MockChainlinkAggregator f = _freshFeed();
        f.setRound(PHASE1 + 1, 1e8, T - 10 minutes);
        PriceAtTimeResolver r = _resolverFor(address(f));
        vm.warp(T + 5 minutes);
        (Outcome o,) = r.resolve(_cl(address(f), 1), _round(PHASE1 + 1));
        assertEq(uint8(o), uint8(Outcome.Unresolved));
        // Next round reverts instead of returning zeros: still Unresolved.
        f.setReverts(PHASE1 + 2, true);
        (o,) = r.resolve(_cl(address(f), 1), _round(PHASE1 + 1));
        assertEq(uint8(o), uint8(Outcome.Unresolved));
        // The round arrives: settles.
        f.setReverts(PHASE1 + 2, false);
        f.setRound(PHASE1 + 2, 2e8, T + 1 minutes);
        (o,) = r.resolve(_cl(address(f), 1), _round(PHASE1 + 1));
        assertEq(uint8(o), uint8(Outcome.Yes));
    }

    function test_cl_unresolvedWhenNextRoundEchoesWrongId() public {
        vm.warp(T + 1 hours);
        btc.setEchoWrongId(true);
        assertEq(uint8(_resolveCl(1, PHASE1 + 2)), uint8(Outcome.Unresolved));
    }

    function test_cl_revertsWhenRoundMissing() public {
        vm.warp(T + 1 hours);
        // r = PHASE1 + 0 does not exist, r + 1 does.
        vm.expectRevert(abi.encodeWithSelector(PriceAtTimeResolver.RoundNotFound.selector, PHASE1));
        _resolveCl(1, PHASE1);
        btc.setReverts(PHASE1 + 2, true);
        vm.expectRevert(abi.encodeWithSelector(PriceAtTimeResolver.RoundNotFound.selector, PHASE1 + 2));
        _resolveCl(1, PHASE1 + 2);
    }

    function test_cl_revertsAcrossPhaseBoundary() public {
        vm.warp(T + 1 hours);
        uint80 last = PHASE1 + type(uint64).max;
        vm.expectRevert(abi.encodeWithSelector(PriceAtTimeResolver.PhaseBoundary.selector, last));
        _resolveCl(1, last);
        vm.expectRevert(abi.encodeWithSelector(PriceAtTimeResolver.PhaseBoundary.selector, type(uint80).max));
        _resolveCl(1, type(uint80).max);
    }

    function test_cl_staleness() public {
        MockChainlinkAggregator f = _freshFeed();
        f.setRound(PHASE1 + 1, 1e8, T - 1 hours); // exactly one hour: accepted
        f.setRound(PHASE1 + 2, 1e8, T + 1);
        f.setRound(PHASE1 + 5, 1e8, T - 1 hours - 1); // one second more: rejected
        f.setRound(PHASE1 + 6, 1e8, T + 1);
        PriceAtTimeResolver r = _resolverFor(address(f));
        vm.warp(T + 1 hours);
        (Outcome o,) = r.resolve(_cl(address(f), 1), _round(PHASE1 + 1));
        assertEq(uint8(o), uint8(Outcome.Yes));
        vm.expectRevert(
            abi.encodeWithSelector(PriceAtTimeResolver.RoundTooStale.selector, PHASE1 + 5, uint256(T - 1 hours - 1), T)
        );
        r.resolve(_cl(address(f), 1), _round(PHASE1 + 5));
    }

    function test_cl_boundaryTimes() public {
        MockChainlinkAggregator f = _freshFeed();
        f.setRound(PHASE1 + 1, 1e8, T - 100);
        f.setRound(PHASE1 + 2, 2e8, T); // updated exactly at T: this round brackets T
        f.setRound(PHASE1 + 3, 3e8, T + 100);
        PriceAtTimeResolver r = _resolverFor(address(f));
        vm.warp(T + 1 hours);
        vm.expectRevert(
            abi.encodeWithSelector(PriceAtTimeResolver.RoundNotLastBeforeTarget.selector, PHASE1 + 1, uint256(T), T)
        );
        r.resolve(_cl(address(f), 1), _round(PHASE1 + 1));
        (Outcome o,) = r.resolve(_cl(address(f), 2e8), _round(PHASE1 + 2));
        assertEq(uint8(o), uint8(Outcome.Yes));
        (o,) = r.resolve(_cl(address(f), 2e8 + 1), _round(PHASE1 + 2));
        assertEq(uint8(o), uint8(Outcome.No));
    }

    function test_cl_revertsOnNonPositiveAnswer() public {
        MockChainlinkAggregator f = _freshFeed();
        f.setRound(PHASE1 + 1, 0, T - 10);
        f.setRound(PHASE1 + 2, 1, T + 10);
        f.setRound(PHASE1 + 3, -5, T + 20);
        f.setRound(PHASE1 + 4, 1, T + 30);
        PriceAtTimeResolver r = _resolverFor(address(f));
        vm.warp(T + 1 hours);
        vm.expectRevert(abi.encodeWithSelector(PriceAtTimeResolver.NonPositivePrice.selector, int256(0)));
        r.resolve(_cl(address(f), 1), _round(PHASE1 + 1));
    }

    function test_cl_revertsOnMalformedEvidence() public {
        vm.warp(T + 1 hours);
        vm.expectRevert(PriceAtTimeResolver.MalformedEvidence.selector);
        resolver.resolve(_cl(address(btc), 1), "");
        vm.expectRevert(PriceAtTimeResolver.MalformedEvidence.selector);
        resolver.resolve(_cl(address(btc), 1), abi.encode(uint80(1), uint80(2)));
        // A word wider than uint80 does not decode.
        vm.expectRevert();
        resolver.resolve(_cl(address(btc), 1), abi.encode(uint256(type(uint80).max) + 1));
    }

    function test_cl_revertsOnFeedNotAllowed() public {
        vm.warp(T + 1 hours);
        MockChainlinkAggregator f = _freshFeed();
        vm.expectRevert(abi.encodeWithSelector(PriceAtTimeResolver.FeedNotAllowed.selector, address(f)));
        resolver.resolve(_cl(address(f), 1), _round(PHASE1 + 2));
    }

    function test_cl_normalisesDecimals() public {
        // 18 decimals: 2,684.866294790000000001 USD
        eth18.setRound(PHASE1 + 1, 2_684_866_294_790_000_000_001, T - 1);
        eth18.setRound(PHASE1 + 2, 1, T + 1);
        // 6 decimals: 0.031240 USD
        mon6.setRound(PHASE1 + 1, 31_240, T - 1);
        mon6.setRound(PHASE1 + 2, 1, T + 1);
        vm.warp(T + 1 hours);

        (Outcome o,) = resolver.resolve(_cl(address(eth18), 268_486_629_479), _round(PHASE1 + 1));
        assertEq(uint8(o), uint8(Outcome.Yes));
        (o,) = resolver.resolve(_cl(address(eth18), 268_486_629_480), _round(PHASE1 + 1));
        assertEq(uint8(o), uint8(Outcome.No));
        (o,) = resolver.resolve(_cl(address(mon6), 3_124_000), _round(PHASE1 + 1));
        assertEq(uint8(o), uint8(Outcome.Yes));
        (o,) = resolver.resolve(_cl(address(mon6), 3_124_001), _round(PHASE1 + 1));
        assertEq(uint8(o), uint8(Outcome.No));
    }

    /// A round from an earlier phase is scaled with that phase's aggregator's decimals, not the
    /// proxy's current ones.
    function test_cl_usesTheRoundsOwnPhaseDecimals() public {
        MockChainlinkAggregator f = _freshFeed(); // current decimals: 8
        MockChainlinkAggregator old18 = new MockChainlinkAggregator(18, "old");
        f.setPhaseAggregator(1, address(old18), false);
        f.setRound(PHASE1 + 1, 2e18, T - 10); // 2 USD in 18 decimals
        f.setRound(PHASE1 + 2, 3e18, T + 10);
        PriceAtTimeResolver r = _resolverFor(address(f));
        vm.warp(T + 1 hours);
        (Outcome o,) = r.resolve(_cl(address(f), 2e8), _round(PHASE1 + 1));
        assertEq(uint8(o), uint8(Outcome.Yes));
        (o,) = r.resolve(_cl(address(f), 2e8 + 1), _round(PHASE1 + 1));
        assertEq(uint8(o), uint8(Outcome.No));

        f.setPhaseAggregator(1, address(0), true);
        vm.expectRevert(abi.encodeWithSelector(PriceAtTimeResolver.RoundNotFound.selector, PHASE1 + 1));
        r.resolve(_cl(address(f), 2e8), _round(PHASE1 + 1));
    }

    function test_cl_evidenceHashAndRefund() public {
        vm.warp(T + 1 hours);
        vm.deal(address(this), 1 ether);
        (, bytes32 h) = resolver.resolve{value: 1 ether}(_cl(address(btc), 1), _round(PHASE1 + 2));
        bytes32 expected = keccak256(
            abi.encode(
                uint8(0),
                address(btc),
                PHASE1 + 2,
                int256(84_000e8),
                uint256(T - 30 minutes),
                uint256(T + 10 minutes),
                uint256(T)
            )
        );
        assertEq(h, expected);
        assertEq(address(this).balance, 1 ether);
        assertEq(address(resolver).balance, 0);
    }

    // ------------------------------------------------------------ resolve: Pyth

    function test_pyth_rule() public {
        vm.warp(T + 5 minutes);
        bytes memory ev = _pythEvidence(15_025_000_000, -8, T + 1, T - 1);
        (Outcome o,) = resolver.resolve{value: FEE}(_py(SOL, 150.25e8), ev);
        assertEq(uint8(o), uint8(Outcome.Yes)); // equal is YES
        (o,) = resolver.resolve{value: FEE}(_py(SOL, 150.25e8 + 1), ev);
        assertEq(uint8(o), uint8(Outcome.No));
    }

    function test_pyth_unresolvedBeforeTRefundsAll() public {
        vm.warp(T);
        vm.deal(address(this), 1 ether);
        (Outcome o,) = resolver.resolve{value: 1 ether}(_py(SOL, 1), _pythEvidence(1, -8, T, T - 1));
        assertEq(uint8(o), uint8(Outcome.Unresolved));
        assertEq(address(this).balance, 1 ether);
    }

    function test_pyth_feeAndRefund() public {
        vm.warp(T + 5 minutes);
        vm.deal(address(this), 1 ether);
        (, bytes32 h) = resolver.resolve{value: 1 ether}(_py(SOL, 1), _pythEvidence(150e8, -8, T + 3, T - 1));
        assertEq(address(pyth).balance, FEE);
        assertEq(address(this).balance, 1 ether - FEE);
        assertEq(address(resolver).balance, 0);
        IPyth.Price memory price = IPyth.Price({price: 150e8, conf: 10, expo: -8, publishTime: T + 3});
        assertEq(h, keccak256(abi.encode(uint8(1), address(pyth), SOL, price, T)));
    }

    function test_pyth_revertsOnInsufficientFee() public {
        vm.warp(T + 5 minutes);
        vm.expectRevert(abi.encodeWithSelector(PriceAtTimeResolver.InsufficientFee.selector, FEE, FEE - 1));
        resolver.resolve{value: FEE - 1}(_py(SOL, 1), _pythEvidence(150e8, -8, T + 3, T - 1));
    }

    function test_pyth_onlyFirstUpdateAtOrAfterT() public {
        vm.warp(T + 5 minutes);
        // Published at T and T + 60: accepted.
        resolver.resolve{value: FEE}(_py(SOL, 1), _pythEvidence(1e8, -8, T, T - 1));
        resolver.resolve{value: FEE}(_py(SOL, 1), _pythEvidence(1e8, -8, T + 60, T - 1));
        // Published before T, or after T + 60: rejected by Pyth.
        vm.expectRevert(MockPyth.PriceFeedNotFoundWithinRange.selector);
        resolver.resolve{value: FEE}(_py(SOL, 1), _pythEvidence(1e8, -8, T - 1, T - 2));
        vm.expectRevert(MockPyth.PriceFeedNotFoundWithinRange.selector);
        resolver.resolve{value: FEE}(_py(SOL, 1), _pythEvidence(1e8, -8, T + 61, T - 1));
        // Not the first update at or after T (its predecessor was already at T): rejected.
        vm.expectRevert(MockPyth.PriceFeedNotFoundWithinRange.selector);
        resolver.resolve{value: FEE}(_py(SOL, 1), _pythEvidence(1e8, -8, T + 5, T));
    }

    function test_pyth_rejectsWrongFeedAndBadPrices() public {
        vm.warp(T + 5 minutes);
        // An update for another id does not answer for SOL.
        bytes[] memory updates = new bytes[](1);
        updates[0] = _update(keccak256("BTC/USD"), 1e8, -8, T + 1, T - 1);
        vm.expectRevert(MockPyth.PriceFeedNotFoundWithinRange.selector);
        resolver.resolve{value: FEE}(_py(SOL, 1), abi.encode(updates));

        vm.expectRevert(abi.encodeWithSelector(PriceAtTimeResolver.NonPositivePrice.selector, int256(0)));
        resolver.resolve{value: FEE}(_py(SOL, 1), _pythEvidence(0, -8, T + 1, T - 1));
        vm.expectRevert(abi.encodeWithSelector(PriceAtTimeResolver.NonPositivePrice.selector, int256(-1)));
        resolver.resolve{value: FEE}(_py(SOL, 1), _pythEvidence(-1, -8, T + 1, T - 1));

        vm.expectRevert();
        resolver.resolve{value: FEE}(_py(SOL, 1), hex"1234");
    }

    function test_pyth_defensiveChecksAgainstAMisbehavingPyth() public {
        vm.warp(T + 5 minutes);
        pyth.setMisbehaviour(true, false, false);
        vm.expectRevert(PriceAtTimeResolver.PythFeedMismatch.selector);
        resolver.resolve{value: FEE}(_py(SOL, 1), _pythEvidence(1e8, -8, T + 1, T - 1));

        pyth.setMisbehaviour(false, false, true);
        vm.expectRevert(PriceAtTimeResolver.PythFeedMismatch.selector);
        resolver.resolve{value: FEE}(_py(SOL, 1), _pythEvidence(1e8, -8, T + 1, T - 1));

        pyth.setMisbehaviour(false, true, false);
        vm.expectRevert(abi.encodeWithSelector(PriceAtTimeResolver.PythPublishTimeOutOfRange.selector, T - 1, T));
        resolver.resolve{value: FEE}(_py(SOL, 1), _pythEvidence(1e8, -8, T - 1, T - 2));
        vm.expectRevert(abi.encodeWithSelector(PriceAtTimeResolver.PythPublishTimeOutOfRange.selector, T + 61, T));
        resolver.resolve{value: FEE}(_py(SOL, 1), _pythEvidence(1e8, -8, T + 61, T - 2));
    }

    function test_pyth_rejectsUnlistedIdAndMissingPyth() public {
        vm.warp(T + 5 minutes);
        vm.expectRevert(abi.encodeWithSelector(PriceAtTimeResolver.PythIdNotAllowed.selector, bytes32(uint256(5))));
        resolver.resolve{value: FEE}(_py(bytes32(uint256(5)), 1), _pythEvidence(1e8, -8, T + 1, T - 1));
        PriceAtTimeResolver noPyth = _deploy(address(0));
        vm.expectRevert(PriceAtTimeResolver.PythNotConfigured.selector);
        noPyth.resolve(_py(SOL, 1), _pythEvidence(1e8, -8, T + 1, T - 1));
    }

    function test_pyth_normalisesExpo() public {
        vm.warp(T + 5 minutes);
        // expo −5: 150.12345 USD → 150.12345000 (E8)
        (Outcome o,) = resolver.resolve{value: FEE}(_py(SOL, 15_012_345_000), _pythEvidence(15_012_345, -5, T, T - 1));
        assertEq(uint8(o), uint8(Outcome.Yes));
        (o,) = resolver.resolve{value: FEE}(_py(SOL, 15_012_345_001), _pythEvidence(15_012_345, -5, T, T - 1));
        assertEq(uint8(o), uint8(Outcome.No));
        // expo −10: 150.1234567891 USD → 150.12345678 (truncated)
        (o,) = resolver.resolve{value: FEE}(_py(SOL, 15_012_345_678), _pythEvidence(1_501_234_567_891, -10, T, T - 1));
        assertEq(uint8(o), uint8(Outcome.Yes));
        (o,) = resolver.resolve{value: FEE}(_py(SOL, 15_012_345_679), _pythEvidence(1_501_234_567_891, -10, T, T - 1));
        assertEq(uint8(o), uint8(Outcome.No));
    }

    // ------------------------------------------------------------ fuzz

    /// For any T and any non-decreasing round history, at most one round is accepted, and it is
    /// exactly the last round at or before T, when it has a successor and is at most an hour old.
    function testFuzz_bracketingAcceptsExactlyOneRound(uint256 seed, uint8 n, uint256 offset) public {
        n = uint8(bound(n, 1, 12));
        MockChainlinkAggregator f = _freshFeed();
        uint256 t0 = T - 6 hours;
        uint256 ts = t0;
        uint256[] memory times = new uint256[](n + 1);
        for (uint256 i = 1; i <= n; ++i) {
            ts += uint256(keccak256(abi.encode(seed, i))) % 2 hours; // gaps of 0 to 2 hours, ties allowed
            times[i] = ts;
            f.setRound(PHASE1 + uint80(i), int256(1e8 + i), ts);
        }
        uint64 target = uint64(t0 + bound(offset, 0, 12 hours));
        PriceAtTimeResolver r = _resolverFor(address(f));
        vm.warp(uint256(target) + 1);

        // The expected round: the last one updated at or before the target.
        uint256 best = 0;
        for (uint256 i = 1; i <= n; ++i) {
            if (times[i] <= target) best = i;
        }
        bool expectAnswer = best != 0 && best < n && target - times[best] <= 1 hours;

        bytes memory params = _clAt(address(f), target);
        uint256 accepted = 0;
        for (uint256 i = 0; i <= n + 1; ++i) {
            uint8 result = _tryRound(r, params, PHASE1 + uint80(i));
            if (result == 1) {
                ++accepted;
                assertEq(i, best, "accepted a round other than the bracketing one");
            } else if (result == 0) {
                // Unresolved only when the round has no successor yet.
                assertGe(i, n, "unresolved although the next round exists");
            }
        }
        assertEq(accepted, expectAnswer ? 1 : 0);
    }

    /// 0 = Unresolved, 1 = answered, 2 = reverted.
    function _tryRound(PriceAtTimeResolver r, bytes memory params, uint80 roundId) internal returns (uint8) {
        try r.resolve(params, _round(roundId)) returns (Outcome o, bytes32) {
            return o == Outcome.Unresolved ? 0 : 1;
        } catch {
            return 2;
        }
    }

    function _clAt(address feed, uint64 target) internal pure returns (bytes memory) {
        return abi.encode(
            PriceAtTimeParams({
                source: 0, feed: feed, pythId: bytes32(0), strikeE8: 1, lockTime: target - 1, closeTime: target
            })
        );
    }

    /// Chainlink strike edge at any decimals: YES exactly when answer / 10^d >= strike / 10^8.
    function testFuzz_clStrikeEdge(uint256 answer, uint256 strike, uint8 decimals) public {
        decimals = uint8(bound(decimals, 0, 30));
        answer = bound(answer, 1, 1e30);
        strike = bound(strike, 1, 1e30);
        MockChainlinkAggregator f = new MockChainlinkAggregator(decimals, "X / USD");
        f.setRound(PHASE1 + 1, int256(answer), T - 1);
        f.setRound(PHASE1 + 2, 1, T + 1);
        PriceAtTimeResolver r = _resolverFor(address(f));
        vm.warp(T + 1);
        (Outcome o,) = r.resolve(_cl(address(f), int256(strike)), _round(PHASE1 + 1));
        bool yes = answer * 1e8 >= strike * 10 ** decimals;
        assertEq(uint8(o), uint8(yes ? Outcome.Yes : Outcome.No));

        // At the exact normalised price the answer is YES; one unit above it is NO.
        (o,) = r.resolve(_cl(address(f), int256(_floorE8(answer, decimals)) + 1), _round(PHASE1 + 1));
        assertEq(uint8(o), uint8(Outcome.No));
        if (_floorE8(answer, decimals) > 0) {
            (o,) = r.resolve(_cl(address(f), int256(_floorE8(answer, decimals))), _round(PHASE1 + 1));
            assertEq(uint8(o), uint8(Outcome.Yes));
        }
    }

    /// Pyth strike edge at any exponent: YES exactly when price × 10^expo >= strike / 10^8.
    function testFuzz_pythStrikeEdge(int64 price, uint256 strike, int32 expo) public {
        price = int64(bound(price, 1, type(int64).max));
        strike = bound(strike, 1, 1e30);
        expo = int32(bound(expo, -20, 6));
        vm.warp(T + 5 minutes);
        (Outcome o,) = resolver.resolve{value: FEE}(_py(SOL, int256(strike)), _pythEvidence(price, expo, T + 1, T - 1));
        uint256 p = uint256(uint64(price));
        int256 shift = int256(expo) + 8;
        bool yes = shift >= 0 ? p * 10 ** uint256(shift) >= strike : p >= strike * 10 ** uint256(-shift);
        assertEq(uint8(o), uint8(yes ? Outcome.Yes : Outcome.No));
    }

    // ------------------------------------------------------------ internals

    function _floorE8(uint256 answer, uint8 decimals) internal pure returns (uint256) {
        return decimals >= 8 ? answer / 10 ** (decimals - 8) : answer * 10 ** (8 - decimals);
    }

    function _freshFeed() internal returns (MockChainlinkAggregator) {
        return new MockChainlinkAggregator(8, "TEST / USD");
    }

    function _resolverFor(address feed) internal returns (PriceAtTimeResolver) {
        address[] memory feeds = new address[](1);
        feeds[0] = feed;
        return new PriceAtTimeResolver(feeds, IPyth(address(0)), new bytes32[](0), new string[](0));
    }
}

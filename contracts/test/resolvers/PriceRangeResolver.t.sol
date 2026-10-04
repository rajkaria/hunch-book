// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {LibString} from "solady/utils/LibString.sol";
import {Outcome, Window} from "../../src/interfaces/IHunchBookTypes.sol";
import {PriceRangeParams} from "../../src/interfaces/ITemplatesV2.sol";
import {IPyth} from "../../src/interfaces/external/IPyth.sol";
import {PriceRangeResolver} from "../../src/resolvers/PriceRangeResolver.sol";
import {MockChainlinkAggregator} from "./mocks/MockChainlinkAggregator.sol";
import {MockPyth} from "./mocks/MockPyth.sol";

contract PriceRangeResolverTest is Test {
    uint256 internal constant NOW = 1_791_000_000;
    uint64 internal constant T = 1_791_115_200; // 2026-10-04 12:00:00 UTC
    uint64 internal constant LOCK = T - 1 hours;
    uint80 internal constant PHASE1 = uint80(1) << 64;
    bytes32 internal constant SOL = keccak256("SOL/USD");
    uint256 internal constant FEE = 7;
    int256 internal constant LOW = 80_000e8;
    int256 internal constant HIGH = 85_000e8;

    MockChainlinkAggregator internal btc; // 8 decimals
    MockChainlinkAggregator internal eth18; // 18 decimals
    MockPyth internal pyth;
    PriceRangeResolver internal resolver;

    receive() external payable {}

    function setUp() public {
        vm.warp(NOW);
        btc = new MockChainlinkAggregator(8, "BTC / USD");
        eth18 = new MockChainlinkAggregator(18, "ETH / USD");
        pyth = new MockPyth(FEE);
        address[] memory feeds = new address[](2);
        feeds[0] = address(btc);
        feeds[1] = address(eth18);
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = SOL;
        string[] memory labels = new string[](1);
        labels[0] = "SOL/USD";
        resolver = new PriceRangeResolver(feeds, pyth, ids, labels);

        // BTC rounds around T: r2 brackets T at 84,000.
        btc.setRound(PHASE1 + 1, 80_000e8, T - 3 hours);
        btc.setRound(PHASE1 + 2, 84_000e8, T - 30 minutes);
        btc.setRound(PHASE1 + 3, 86_000e8, T + 10 minutes);
    }

    // ------------------------------------------------------------ helpers

    function _cl(address feed, int256 lower, int256 upper) internal pure returns (bytes memory) {
        return abi.encode(
            PriceRangeParams({
                source: 0, feed: feed, pythId: bytes32(0), lowerE8: lower, upperE8: upper, lockTime: LOCK, closeTime: T
            })
        );
    }

    function _py(bytes32 id, int256 lower, int256 upper) internal pure returns (bytes memory) {
        return abi.encode(
            PriceRangeParams({
                source: 1, feed: address(0), pythId: id, lowerE8: lower, upperE8: upper, lockTime: LOCK, closeTime: T
            })
        );
    }

    function _btcRange(int256 lower, int256 upper) internal returns (Outcome o) {
        (o,) = resolver.resolve(_cl(address(btc), lower, upper), abi.encode(PHASE1 + 2));
    }

    function _pythEvidence(int64 price, int32 expo, uint64 publishTime, uint64 prev)
        internal
        pure
        returns (bytes memory)
    {
        IPyth.Price memory p = IPyth.Price({price: price, conf: 10, expo: expo, publishTime: publishTime});
        bytes[] memory updates = new bytes[](1);
        updates[0] = abi.encode(IPyth.PriceFeed({id: SOL, price: p, emaPrice: p}), prev);
        return abi.encode(updates);
    }

    function _resolverFor(address feed) internal returns (PriceRangeResolver) {
        address[] memory feeds = new address[](1);
        feeds[0] = feed;
        return new PriceRangeResolver(feeds, IPyth(address(0)), new bytes32[](0), new string[](0));
    }

    // ------------------------------------------------------------ constructor

    function test_constructor() public view {
        assertTrue(resolver.isFeedAllowed(address(btc)));
        assertTrue(resolver.isPythIdAllowed(SOL));
        assertEq(resolver.pythLabel(SOL), "SOL/USD");
        assertEq(resolver.feeds().length, 2);
        assertEq(resolver.pythIds().length, 1);
        assertFalse(resolver.earlyYes());
    }

    function test_constructor_rejectsBadLists() public {
        address[] memory feeds = new address[](2);
        feeds[0] = address(btc);
        feeds[1] = address(btc);
        vm.expectRevert(PriceRangeResolver.DuplicateEntry.selector);
        new PriceRangeResolver(feeds, IPyth(address(0)), new bytes32[](0), new string[](0));
        vm.expectRevert(PriceRangeResolver.LengthMismatch.selector);
        new PriceRangeResolver(new address[](0), pyth, new bytes32[](1), new string[](0));
    }

    // ------------------------------------------------------------ validate

    function test_validate_window() public view {
        Window memory w = resolver.validate(_cl(address(btc), LOW, HIGH));
        assertFalse(w.blockClock);
        assertEq(w.lock, LOCK);
        assertEq(w.close, T);
        assertEq(w.settleDeadline, T + 7 days);
        resolver.validate(_py(SOL, 1, 2));
    }

    function test_validate_rejects() public {
        vm.expectRevert(PriceRangeResolver.NonCanonicalParams.selector);
        resolver.validate(bytes.concat(_cl(address(btc), LOW, HIGH), bytes1(0x01)));

        vm.expectRevert(abi.encodeWithSelector(PriceRangeResolver.FeedNotAllowed.selector, address(0xBEEF)));
        resolver.validate(_cl(address(0xBEEF), LOW, HIGH));

        vm.expectRevert(abi.encodeWithSelector(PriceRangeResolver.PythIdNotAllowed.selector, bytes32(uint256(1))));
        resolver.validate(_py(bytes32(uint256(1)), LOW, HIGH));

        vm.expectRevert(abi.encodeWithSelector(PriceRangeResolver.LowerNotPositive.selector, int256(0)));
        resolver.validate(_cl(address(btc), 0, HIGH));

        vm.expectRevert(abi.encodeWithSelector(PriceRangeResolver.EmptyRange.selector, LOW, LOW));
        resolver.validate(_cl(address(btc), LOW, LOW));
        vm.expectRevert(abi.encodeWithSelector(PriceRangeResolver.EmptyRange.selector, HIGH, LOW));
        resolver.validate(_cl(address(btc), HIGH, LOW));

        PriceRangeParams memory p = PriceRangeParams({
            source: 0,
            feed: address(btc),
            pythId: bytes32(0),
            lowerE8: LOW,
            upperE8: HIGH,
            lockTime: uint64(NOW),
            closeTime: T
        });
        vm.expectRevert(abi.encodeWithSelector(PriceRangeResolver.LockNotInFuture.selector, uint64(NOW), NOW));
        resolver.validate(abi.encode(p));
        p.lockTime = T;
        p.closeTime = T - 1;
        vm.expectRevert(abi.encodeWithSelector(PriceRangeResolver.CloseBeforeLock.selector, T, T - 1));
        resolver.validate(abi.encode(p));

        p.closeTime = T;
        p.pythId = SOL;
        vm.expectRevert(PriceRangeResolver.UnusedFieldSet.selector);
        resolver.validate(abi.encode(p));
        p.source = 3;
        vm.expectRevert(abi.encodeWithSelector(PriceRangeResolver.UnknownSource.selector, uint8(3)));
        resolver.validate(abi.encode(p));
    }

    // ------------------------------------------------------------ describe

    function test_describe() public view {
        assertEq(
            resolver.describe(_cl(address(btc), LOW, HIGH)),
            "YES if Chainlink's BTC/USD feed puts BTC/USD at or above $80,000 and below $85,000 at 2026-10-04 12:00:00 UTC (unix time 1791115200); NO otherwise."
        );
        assertEq(
            resolver.describe(_py(SOL, 140e8, 150.5e8)),
            "YES if Pyth's SOL/USD feed puts SOL/USD at or above $140 and below $150.5 at 2026-10-04 12:00:00 UTC (unix time 1791115200); NO otherwise."
        );
    }

    function test_describe_fallsBackToTheAddress() public view {
        string memory a = LibString.toHexStringChecksummed(address(this));
        assertEq(
            resolver.describe(_cl(address(this), LOW, HIGH)),
            string.concat(
                "YES if Chainlink's ",
                a,
                " feed puts ",
                a,
                " at or above $80,000 and below $85,000 at 2026-10-04 12:00:00 UTC (unix time 1791115200); NO otherwise."
            )
        );
    }

    // ------------------------------------------------------------ resolve: Chainlink

    function test_cl_rule() public {
        vm.warp(T + 1 hours);
        assertEq(uint8(_btcRange(LOW, HIGH)), uint8(Outcome.Yes)); // 84,000 in [80,000, 85,000)
        assertEq(uint8(_btcRange(84_000e8, HIGH)), uint8(Outcome.Yes)); // lower bound inclusive
        assertEq(uint8(_btcRange(LOW, 84_000e8)), uint8(Outcome.No)); // upper bound exclusive
        assertEq(uint8(_btcRange(LOW, 84_000e8 + 1)), uint8(Outcome.Yes));
        assertEq(uint8(_btcRange(84_000e8 + 1, HIGH)), uint8(Outcome.No)); // below the range
        assertEq(uint8(_btcRange(1, 2)), uint8(Outcome.No)); // above the range
    }

    function test_cl_adjacentRangesNeverBothYes() public {
        vm.warp(T + 1 hours);
        assertEq(uint8(_btcRange(80_000e8, 84_000e8)), uint8(Outcome.No));
        assertEq(uint8(_btcRange(84_000e8, 88_000e8)), uint8(Outcome.Yes));
    }

    function test_cl_timingAndEvidence() public {
        vm.warp(T);
        (Outcome o, bytes32 h) = resolver.resolve(_cl(address(btc), LOW, HIGH), abi.encode(PHASE1 + 2));
        assertEq(uint8(o), uint8(Outcome.Unresolved));
        assertEq(h, bytes32(0));
        vm.warp(T + 1);
        vm.deal(address(this), 1 ether);
        (o, h) = resolver.resolve{value: 1 ether}(_cl(address(btc), LOW, HIGH), abi.encode(PHASE1 + 2));
        assertEq(uint8(o), uint8(Outcome.Yes));
        // The same evidence format as template 2.
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
    }

    function test_cl_onlyTheBracketingRound() public {
        vm.warp(T + 1 hours);
        vm.expectRevert(
            abi.encodeWithSelector(
                PriceRangeResolver.RoundNotLastBeforeTarget.selector, PHASE1 + 1, uint256(T - 30 minutes), T
            )
        );
        resolver.resolve(_cl(address(btc), LOW, HIGH), abi.encode(PHASE1 + 1));
        // A round with no successor yet: not known, whatever it says.
        (Outcome o,) = resolver.resolve(_cl(address(btc), LOW, HIGH), abi.encode(PHASE1 + 3));
        assertEq(uint8(o), uint8(Outcome.Unresolved));
        btc.setRound(PHASE1 + 4, 87_000e8, T + 2 hours);
        vm.expectRevert(
            abi.encodeWithSelector(PriceRangeResolver.RoundAfterTarget.selector, PHASE1 + 3, uint256(T + 10 minutes), T)
        );
        resolver.resolve(_cl(address(btc), LOW, HIGH), abi.encode(PHASE1 + 3));
        vm.expectRevert(PriceRangeResolver.MalformedEvidence.selector);
        resolver.resolve(_cl(address(btc), LOW, HIGH), "");
    }

    function test_cl_normalisesDecimals() public {
        // 18 decimals: 2,684.866294790000000001 USD truncates to 2,684.86629479 at 8 decimals.
        eth18.setRound(PHASE1 + 1, 2_684_866_294_790_000_000_001, T - 1);
        eth18.setRound(PHASE1 + 2, 1, T + 1);
        vm.warp(T + 1 hours);
        bytes memory ev = abi.encode(PHASE1 + 1);
        // Lower bound at the truncated value: inside. Upper bound at it: outside (the real price is above).
        (Outcome o,) = resolver.resolve(_cl(address(eth18), 268_486_629_479, 300_000e8), ev);
        assertEq(uint8(o), uint8(Outcome.Yes));
        (o,) = resolver.resolve(_cl(address(eth18), 1, 268_486_629_479), ev);
        assertEq(uint8(o), uint8(Outcome.No));
        (o,) = resolver.resolve(_cl(address(eth18), 1, 268_486_629_480), ev);
        assertEq(uint8(o), uint8(Outcome.Yes));
    }

    // ------------------------------------------------------------ resolve: Pyth

    function test_pyth_ruleAndFee() public {
        vm.warp(T + 5 minutes);
        vm.deal(address(this), 1 ether);
        bytes memory ev = _pythEvidence(15_025_000_000, -8, T + 1, T - 1); // 150.25
        (Outcome o, bytes32 h) = resolver.resolve{value: 1 ether}(_py(SOL, 150.25e8, 151e8), ev);
        assertEq(uint8(o), uint8(Outcome.Yes));
        assertEq(address(pyth).balance, FEE);
        assertEq(address(this).balance, 1 ether - FEE);
        IPyth.Price memory price = IPyth.Price({price: 15_025_000_000, conf: 10, expo: -8, publishTime: T + 1});
        assertEq(h, keccak256(abi.encode(uint8(1), address(pyth), SOL, price, T)));
        (o,) = resolver.resolve{value: FEE}(_py(SOL, 140e8, 150.25e8), ev);
        assertEq(uint8(o), uint8(Outcome.No));
        vm.expectRevert(abi.encodeWithSelector(PriceRangeResolver.InsufficientFee.selector, FEE, FEE - 1));
        resolver.resolve{value: FEE - 1}(_py(SOL, 140e8, 151e8), ev);
    }

    // ------------------------------------------------------------ fuzz

    /// At any decimals: YES exactly when lower <= answer / 10^d < upper, compared exactly.
    function testFuzz_rangeEdge(uint256 answer, uint256 lower, uint256 width, uint8 decimals) public {
        decimals = uint8(bound(decimals, 0, 30));
        answer = bound(answer, 1, 1e30);
        lower = bound(lower, 1, 1e30);
        width = bound(width, 1, 1e30);
        uint256 upper = lower + width;
        MockChainlinkAggregator f = new MockChainlinkAggregator(decimals, "X / USD");
        f.setRound(PHASE1 + 1, int256(answer), T - 1);
        f.setRound(PHASE1 + 2, 1, T + 1);
        PriceRangeResolver r = _resolverFor(address(f));
        vm.warp(T + 1);
        (Outcome o,) = r.resolve(_cl(address(f), int256(lower), int256(upper)), abi.encode(PHASE1 + 1));
        uint256 scaled = answer * 1e8; // compare answer × 10^8 with bound × 10^d
        bool inside = scaled >= lower * 10 ** decimals && scaled < upper * 10 ** decimals;
        assertEq(uint8(o), uint8(inside ? Outcome.Yes : Outcome.No));
    }

    /// validate accepts exactly 0 < lower < upper.
    function testFuzz_validateBounds(int256 lower, int256 upper) public view {
        bool ok = lower > 0 && upper > lower;
        try resolver.validate(_cl(address(btc), lower, upper)) returns (Window memory) {
            assertTrue(ok);
        } catch {
            assertFalse(ok);
        }
    }
}

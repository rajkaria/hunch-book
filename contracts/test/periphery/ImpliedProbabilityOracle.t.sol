// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Market} from "../../src/core/Market.sol";
import {IHunchBookFactory} from "../../src/interfaces/IHunchBookFactory.sol";
import {Outcome, Phase, Side} from "../../src/interfaces/IHunchBookTypes.sol";
import {ImpliedProbabilityOracle} from "../../src/periphery/ImpliedProbabilityOracle.sol";
import {IImpliedProbabilityOracle} from "../../src/periphery/interfaces/IImpliedProbabilityOracle.sol";
import {PeripheryBase} from "./PeripheryBase.sol";
import {PeripheryBook} from "./mocks/PeripheryBook.sol";

contract ImpliedProbabilityOracleTest is PeripheryBase {
    ImpliedProbabilityOracle internal oracle;
    Market internal m;
    PeripheryBook internal book;

    uint256 internal constant ONE = 1e6;
    /// Opening price of the shared market: 305 / 545.
    uint256 internal constant OPENING = 559_633;

    function setUp() public override {
        super.setUp();
        oracle = new ImpliedProbabilityOracle(IHunchBookFactory(address(factory)), 1);
        (m, book) = _graduatedWithBook();
    }

    // ---------------------------------------------------------------- helpers

    /// Sets the book's best bid and ask around `mid` (E6) with `spread` (E6).
    function _setBook(uint256 mid, uint256 spread) internal {
        uint256 bid = mid - spread / 2;
        book.setBestBidAsk(bid * 1e12, (bid + spread) * 1e12);
    }

    function _next(uint256 secs) internal {
        vm.warp(block.timestamp + secs);
        vm.roll(block.number + 1);
    }

    function _chance() internal view returns (uint256 c, bool stale) {
        return oracle.chanceE6(address(m));
    }

    // ---------------------------------------------------------------- construction

    function test_constructor() public {
        assertEq(oracle.factory(), address(factory));
        assertEq(oracle.CAPACITY(), 256);
        assertEq(oracle.MIN_SPACING(), 30);
        assertEq(oracle.maxWindow(), 255 * 30);
        vm.expectRevert(IImpliedProbabilityOracle.ZeroAddress.selector);
        new ImpliedProbabilityOracle(IHunchBookFactory(address(0)), 1);
    }

    function test_unknownMarket() public {
        vm.expectRevert(IImpliedProbabilityOracle.UnknownMarket.selector);
        oracle.chanceE6(address(0xBEEF));
        vm.expectRevert(IImpliedProbabilityOracle.UnknownMarket.selector);
        oracle.quote(address(0xBEEF));
        vm.expectRevert(IImpliedProbabilityOracle.UnknownMarket.selector);
        oracle.poke(address(0xBEEF));
        address[] memory ms = new address[](2);
        ms[0] = address(m);
        ms[1] = address(0xBEEF);
        vm.expectRevert(IImpliedProbabilityOracle.UnknownMarket.selector);
        oracle.pokeMany(ms);
    }

    // ---------------------------------------------------------------- spot by phase

    function test_pool_isTheStakeSplit() public {
        Market pool = _create(_timeWindow(), Side.Yes, 5e6);
        (uint256 c, bool stale) = oracle.chanceE6(address(pool));
        assertEq(c, ONE, "only YES staked");
        assertFalse(stale);
        _stake(pool, users[0], Side.No, 15e6);
        (c,) = oracle.chanceE6(address(pool));
        assertEq(c, 250_000, "5 of 20");
        IImpliedProbabilityOracle.Quote memory q = oracle.quote(address(pool));
        assertEq(uint8(q.phase), uint8(Phase.Pool));
        assertEq(q.spreadE6, ONE, "no book yet");

        vm.warp(pool.window().lock);
        q = oracle.quote(address(pool));
        assertEq(uint8(q.phase), uint8(Phase.PoolLocked));
        assertEq(q.chanceE6, 250_000);
    }

    function test_graduated_midOfTheBook() public {
        _ask(m, book, 420_000, 10e6);
        _bid(book, 380_000, 10e6);
        IImpliedProbabilityOracle.Quote memory q = oracle.quote(address(m));
        assertEq(uint8(q.phase), uint8(Phase.Graduated));
        assertEq(q.chanceE6, 400_000);
        assertEq(q.spreadE6, 40_000);
        assertFalse(q.stale);
        assertTrue(q.hasBid && q.hasAsk);
        assertEq(q.bidE6, 380_000);
        assertEq(q.askE6, 420_000);
    }

    function test_graduated_oneSidedBookReadsThatSide() public {
        _bid(book, 380_000, 10e6);
        (uint256 c, bool stale) = _chance();
        assertEq(c, 380_000);
        assertFalse(stale);
        assertEq(oracle.quote(address(m)).spreadE6, ONE);

        book.setBestBidAsk(type(uint256).max, 610_000 * 1e12);
        (c, stale) = _chance();
        assertEq(c, 610_000);
        assertFalse(stale);
    }

    function test_graduated_emptyBookIsStale() public {
        (uint256 c, bool stale) = _chance();
        assertEq(c, OPENING, "no observation yet: the opening price");
        assertTrue(stale);

        _setBook(700_000, 0);
        oracle.poke(address(m));
        book.setBestBidAsk(type(uint256).max, 0);
        (c, stale) = _chance();
        assertEq(c, 700_000, "the last observation");
        assertTrue(stale);

        book.setBestReverts(true);
        (c, stale) = _chance();
        assertEq(c, 700_000, "a broken book reads as empty");
        assertTrue(stale);
    }

    function test_graduated_pricesAreCappedAtOne() public {
        book.setBestBidAsk(1_200_000 * 1e12, 1_500_000 * 1e12);
        IImpliedProbabilityOracle.Quote memory q = oracle.quote(address(m));
        assertEq(q.chanceE6, ONE);
        assertEq(q.spreadE6, 0);
        assertEq(q.bidE6, 1_200_000, "raw prices are reported uncapped");
        // A crossed book (bid above ask) has no negative spread.
        book.setBestBidAsk(500_000 * 1e12, 400_000 * 1e12);
        q = oracle.quote(address(m));
        assertEq(q.chanceE6, 450_000);
        assertEq(q.spreadE6, 0);
    }

    function test_closed_stillReadsTheBook() public {
        _setBook(300_000, 20_000);
        _toClose(m);
        IImpliedProbabilityOracle.Quote memory q = oracle.quote(address(m));
        assertEq(uint8(q.phase), uint8(Phase.Closed));
        assertEq(q.chanceE6, 300_000);
    }

    function test_settledAndVoided() public {
        _settle(m, Outcome.Yes);
        IImpliedProbabilityOracle.Quote memory q = oracle.quote(address(m));
        assertEq(q.chanceE6, ONE);
        assertEq(q.spreadE6, 0);

        (Market m2,) = _graduatedWithBook();
        _settle(m2, Outcome.No);
        (uint256 c,) = oracle.chanceE6(address(m2));
        assertEq(c, 0);

        (Market m3,) = _graduatedWithBook();
        vm.warp(m3.window().settleDeadline + 1);
        m3.voidIfExpired();
        (c,) = oracle.chanceE6(address(m3));
        assertEq(c, ONE / 2);
    }

    // ---------------------------------------------------------------- poke

    function test_poke_recordsOncePerBlock() public {
        _setBook(400_000, 20_000);
        vm.expectEmit(address(oracle));
        emit IImpliedProbabilityOracle.Poked(address(m), 400_000, 20_000, false, true);
        assertTrue(oracle.poke(address(m)));
        IImpliedProbabilityOracle.Observation memory h = oracle.latest(address(m));
        assertEq(h.timestamp, block.timestamp);
        assertEq(h.chanceE6, 400_000);
        assertEq(h.spreadE6, 20_000);
        assertEq(h.chanceCumulative, 0);
        assertEq(oracle.checkpointCount(address(m)), 1);

        _setBook(900_000, 0);
        assertFalse(oracle.poke(address(m)), "same block: no-op");
        assertEq(oracle.latest(address(m)).chanceE6, 400_000);

        _next(10);
        assertTrue(oracle.poke(address(m)));
        h = oracle.latest(address(m));
        assertEq(h.chanceE6, 900_000);
        assertEq(h.chanceCumulative, 400_000 * 10);
        assertEq(h.spreadCumulative, 20_000 * 10);
        assertEq(oracle.checkpointCount(address(m)), 1, "10 s after the last checkpoint: head only");
    }

    function test_poke_sameTimestampNewBlock() public {
        // Monad makes several blocks per second: a later block in the same second rewrites the head.
        _setBook(400_000, 0);
        oracle.poke(address(m));
        vm.roll(block.number + 1);
        _setBook(600_000, 0);
        assertTrue(oracle.poke(address(m)));
        IImpliedProbabilityOracle.Observation memory h = oracle.latest(address(m));
        assertEq(h.chanceE6, 600_000);
        assertEq(h.chanceCumulative, 0, "the first value held for zero seconds");
    }

    function test_pokeMany_skipsMarketsAlreadyPoked() public {
        (Market m2,) = _graduatedWithBook();
        oracle.poke(address(m));
        address[] memory ms = new address[](3);
        ms[0] = address(m);
        ms[1] = address(m2);
        ms[2] = address(m2);
        assertEq(oracle.pokeMany(ms), 1);
    }

    // ---------------------------------------------------------------- consult

    function test_consult_errors() public {
        vm.expectRevert(IImpliedProbabilityOracle.ZeroPeriod.selector);
        oracle.consult(address(m), 0);
        vm.expectRevert(IImpliedProbabilityOracle.NoObservations.selector);
        oracle.consult(address(m), 60);

        oracle.poke(address(m));
        uint256 first = block.timestamp;
        _next(100);
        assertEq(oracle.consult(address(m), 100), OPENING, "exactly back to the first poke");
        vm.expectRevert(abi.encodeWithSelector(IImpliedProbabilityOracle.InsufficientHistory.selector, first));
        oracle.consult(address(m), 101);
        vm.expectRevert(abi.encodeWithSelector(IImpliedProbabilityOracle.InsufficientHistory.selector, first));
        oracle.consult(address(m), block.timestamp + 1);
    }

    function test_consult_timeWeighted() public {
        _setBook(200_000, 10_000);
        oracle.poke(address(m));
        _next(100);
        _setBook(800_000, 30_000);
        oracle.poke(address(m));
        _next(50);
        _setBook(500_000, 0); // not poked: consult never reads the book
        (uint256 c, uint256 s, uint256 updatedAt) = oracle.consultFull(address(m), 150);
        assertEq(c, (200_000 * 100 + 800_000 * 50) / 150);
        assertEq(s, uint256(10_000 * 100 + 30_000 * 50) / 150);
        assertEq(updatedAt, block.timestamp - 50);
        assertEq(oracle.consult(address(m), 50), 800_000);
        assertEq(oracle.consult(address(m), 120), (200_000 * 70 + 800_000 * 50) / 120);
    }

    /// A value pushed onto the book and poked in one block counts only until the next poke.
    function test_consult_manipulationLastsOneInterval() public {
        _setBook(400_000, 0);
        oracle.poke(address(m));
        _next(1800);
        _setBook(990_000, 0); // pushed up for one block
        oracle.poke(address(m));
        _next(1);
        _setBook(400_000, 0);
        oracle.poke(address(m));
        _next(599);
        uint256 twap = oracle.consult(address(m), 1800);
        assertEq(twap, uint256(400_000 * 1799 + 990_000 * 1) / 1800);
        assertLt(twap - 400_000, 400);
    }

    function test_checkpoints_spacedAndRingWraps() public {
        _setBook(500_000, 0);
        for (uint256 i; i < 40; ++i) {
            oracle.poke(address(m));
            _next(10);
        }
        // 40 pokes 10 s apart over 390 s: a checkpoint every 30 s.
        assertEq(oracle.checkpointCount(address(m)), 14);
        IImpliedProbabilityOracle.Observation memory a = oracle.checkpointAt(address(m), 0);
        IImpliedProbabilityOracle.Observation memory b = oracle.checkpointAt(address(m), 1);
        assertEq(b.timestamp - a.timestamp, 30);
        vm.expectRevert(IImpliedProbabilityOracle.NoObservations.selector);
        oracle.checkpointAt(address(m), 14);

        // Fill the ring well past CAPACITY.
        for (uint256 i; i < 300; ++i) {
            oracle.poke(address(m));
            _next(30);
        }
        assertEq(oracle.checkpointCount(address(m)), 256);
        IImpliedProbabilityOracle.Observation memory oldest = oracle.checkpointAt(address(m), 0);
        IImpliedProbabilityOracle.Observation memory newest = oracle.checkpointAt(address(m), 255);
        assertEq(newest.timestamp - oldest.timestamp, 255 * 30);
        assertEq(oracle.consult(address(m), oracle.maxWindow()), 500_000, "the whole guaranteed window");
        vm.expectRevert(
            abi.encodeWithSelector(IImpliedProbabilityOracle.InsufficientHistory.selector, oldest.timestamp)
        );
        oracle.consult(address(m), block.timestamp - oldest.timestamp + 1);
    }

    function test_consult_betweenCheckpointsInterpolates() public {
        // Pokes 10 s apart: checkpoints at 0, 30, 60; intermediate pokes only move the head.
        uint256[7] memory values = [uint256(100_000), 200_000, 300_000, 400_000, 500_000, 600_000, 700_000];
        for (uint256 i; i < 7; ++i) {
            _setBook(values[i], 0);
            oracle.poke(address(m));
            _next(10);
        }
        // Exact at checkpoints: back 70 s is the first poke, back 40 s is the 30 s checkpoint.
        assertEq(
            oracle.consult(address(m), 70),
            (100_000 + 200_000 + 300_000 + 400_000 + 500_000 + 600_000 + 700_000) * 10 / 70
        );
        assertEq(oracle.consult(address(m), 40), (400_000 + 500_000 + 600_000 + 700_000) * 10 / 40);
        // Back 55 s falls between the 0 s and 30 s checkpoints: the cumulative there is linear.
        uint256 c0 = 0;
        uint256 c30 = (100_000 + 200_000 + 300_000) * 10;
        uint256 interpolated = c0 + (c30 - c0) * 15 / 30;
        uint256 cNow = (100_000 + 200_000 + 300_000 + 400_000 + 500_000 + 600_000 + 700_000) * 10;
        assertEq(oracle.consult(address(m), 55), (cNow - interpolated) / 55);
    }

    // ---------------------------------------------------------------- fuzz

    /// Pokes at least MIN_SPACING apart are all checkpoints, so every average is exact: it matches a
    /// reference sum of value x seconds over the window.
    function testFuzz_consult_matchesReference(uint256 seed, uint256 count, uint256 back) public {
        count = bound(count, 1, 30);
        uint256[] memory times = new uint256[](count);
        uint256[] memory values = new uint256[](count);
        for (uint256 i; i < count; ++i) {
            values[i] = uint256(keccak256(abi.encode(seed, i))) % (ONE + 1);
            book.setBestBidAsk(values[i] * 1e12, values[i] * 1e12);
            times[i] = block.timestamp;
            oracle.poke(address(m));
            _next(30 + uint256(keccak256(abi.encode(seed, i, "dt"))) % 600);
        }
        uint256 span = block.timestamp - times[0];
        back = bound(back, 1, span);
        uint256 from = block.timestamp - back;

        uint256 sum;
        for (uint256 i; i < count; ++i) {
            uint256 start = times[i];
            uint256 end = i + 1 < count ? times[i + 1] : block.timestamp;
            if (end <= from) continue;
            if (start < from) start = from;
            sum += values[i] * (end - start);
        }
        assertApproxEqAbs(oracle.consult(address(m), back), sum / back, 1);
    }

    /// Spot chance is always within [0, 1] and equals the mid for any two-sided book.
    function testFuzz_spotMid(uint256 bid, uint256 ask) public {
        bid = bound(bid, 1, 2e6);
        ask = bound(ask, 1, 2e6);
        book.setBestBidAsk(bid * 1e12, ask * 1e12);
        (uint256 c, bool stale) = _chance();
        uint256 b = bid > ONE ? ONE : bid;
        uint256 a = ask > ONE ? ONE : ask;
        assertEq(c, (a + b) / 2);
        assertLe(c, ONE);
        assertFalse(stale);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {FixedPointMathLib} from "solady/utils/FixedPointMathLib.sol";
import {Market} from "../../src/core/Market.sol";
import {ICollateralVault} from "../../src/interfaces/ICollateralVault.sol";
import {IHunchBookFactory} from "../../src/interfaces/IHunchBookFactory.sol";
import {Outcome, Side, Window} from "../../src/interfaces/IHunchBookTypes.sol";
import {ImpliedProbabilityOracle} from "../../src/periphery/ImpliedProbabilityOracle.sol";
import {OutcomeTokenPriceAdapter} from "../../src/periphery/OutcomeTokenPriceAdapter.sol";
import {OutcomeTokenPriceAdapterFactory} from "../../src/periphery/OutcomeTokenPriceAdapterFactory.sol";
import {IImpliedProbabilityOracle} from "../../src/periphery/interfaces/IImpliedProbabilityOracle.sol";
import {IOutcomeTokenPriceAdapter} from "../../src/periphery/interfaces/IOutcomeTokenPriceAdapter.sol";
import {IOutcomeTokenPriceAdapterFactory} from "../../src/periphery/interfaces/IOutcomeTokenPriceAdapterFactory.sol";
import {PeripheryBase} from "./PeripheryBase.sol";
import {PeripheryBook} from "./mocks/PeripheryBook.sol";

contract OutcomeTokenPriceAdapterTest is PeripheryBase {
    uint256 internal constant ONE = 1e6;
    uint32 internal constant WINDOW = 1800;
    uint32 internal constant RAMP = 3 days;

    ImpliedProbabilityOracle internal oracle;
    OutcomeTokenPriceAdapterFactory internal adapters;
    Market internal m;
    PeripheryBook internal book;
    OutcomeTokenPriceAdapter internal yesFeed;
    OutcomeTokenPriceAdapter internal noFeed;

    function setUp() public override {
        super.setUp();
        oracle = new ImpliedProbabilityOracle(IHunchBookFactory(address(factory)), 1);
        adapters = new OutcomeTokenPriceAdapterFactory(oracle, _params());
        (m, book) = _graduatedWithBook(_longWindow());
        yesFeed = OutcomeTokenPriceAdapter(adapters.createAdapter(address(m), Side.Yes));
        noFeed = OutcomeTokenPriceAdapter(adapters.createAdapter(address(m), Side.No));
    }

    // ---------------------------------------------------------------- helpers

    function _params() internal pure returns (IOutcomeTokenPriceAdapterFactory.AdapterParams memory) {
        return IOutcomeTokenPriceAdapterFactory.AdapterParams({
            twapWindow: WINDOW,
            baseHaircutBps: 1000,
            closeHaircutBps: 10_000,
            rampSeconds: RAMP,
            spreadMultiplierBps: 10_000,
            maxSpreadHaircutBps: 2000,
            blockTimeMs: 400
        });
    }

    /// Lock in one day, close in 30 days: far from close until the last 3 days.
    function _longWindow() internal returns (Window memory w) {
        ++nonce;
        w.lock = uint64(block.timestamp + 1 days + nonce);
        w.close = uint64(block.timestamp + 30 days + nonce);
        w.settleDeadline = w.close + 7 days;
    }

    function _setBook(uint256 mid, uint256 spread) internal {
        uint256 bid = mid - spread / 2;
        book.setBestBidAsk(bid * 1e12, (bid + spread) * 1e12);
    }

    /// Pokes now with the book at (mid, spread), then waits a full window and pokes again, so the
    /// average over the window is exactly that book.
    function _steady(uint256 mid, uint256 spread) internal {
        _setBook(mid, spread);
        vm.roll(block.number + 1);
        oracle.poke(address(m));
        vm.warp(block.timestamp + WINDOW);
        vm.roll(block.number + 1);
        oracle.poke(address(m));
    }

    function _answer(OutcomeTokenPriceAdapter feed) internal view returns (int256 answer) {
        (, answer,,,) = feed.latestRoundData();
    }

    /// Redemption fee per token if `side` wins, rounded up: φ · losing / T.
    function _winFee(Side side) internal view returns (uint256) {
        (uint256 y, uint256 n,) = m.poolTotals();
        return FixedPointMathLib.mulDivUp(ONE, 200 * (side == Side.Yes ? n : y), 10_000 * (y + n));
    }

    // ---------------------------------------------------------------- factory

    function test_factory_parametersAndAddresses() public view {
        IOutcomeTokenPriceAdapterFactory.AdapterParams memory p = adapters.params();
        assertEq(p.twapWindow, WINDOW);
        assertEq(p.closeHaircutBps, 10_000);
        assertEq(adapters.oracle(), address(oracle));
        assertEq(adapters.vault(), address(vault));
        assertEq(adapters.hunchFactory(), address(factory));
        assertEq(adapters.adapterOf(address(m), Side.Yes), address(yesFeed));
        assertEq(adapters.adapterOf(address(m), Side.No), address(noFeed));
        assertEq(adapters.predictAdapter(address(m), Side.Yes), address(yesFeed));
        assertEq(adapters.predictAdapter(address(m), Side.No), address(noFeed));
    }

    function test_factory_createAdapter() public {
        (Market m2,) = _graduatedWithBook();
        address predicted = adapters.predictAdapter(address(m2), Side.Yes);
        vm.expectEmit(address(adapters));
        emit IOutcomeTokenPriceAdapterFactory.AdapterCreated(address(m2), Side.Yes, predicted);
        address a = adapters.createAdapter(address(m2), Side.Yes);
        assertEq(a, predicted);
        vm.expectRevert(abi.encodeWithSelector(IOutcomeTokenPriceAdapterFactory.AdapterExists.selector, a));
        adapters.createAdapter(address(m2), Side.Yes);
        vm.expectRevert(IOutcomeTokenPriceAdapterFactory.UnknownMarket.selector);
        adapters.createAdapter(address(0xBEEF), Side.Yes);
    }

    function test_factory_rejectsBadParams() public {
        IOutcomeTokenPriceAdapterFactory.AdapterParams memory p = _params();
        p.twapWindow = 0;
        _expectBad(p);
        p = _params();
        p.twapWindow = uint32(oracle.maxWindow() + 1);
        _expectBad(p);
        p = _params();
        p.baseHaircutBps = 5000;
        p.closeHaircutBps = 4999;
        _expectBad(p);
        p = _params();
        p.closeHaircutBps = 10_001;
        _expectBad(p);
        p = _params();
        p.maxSpreadHaircutBps = 10_001;
        _expectBad(p);
        p = _params();
        p.rampSeconds = 0;
        _expectBad(p);
        p = _params();
        p.blockTimeMs = 0;
        _expectBad(p);
        vm.expectRevert(IOutcomeTokenPriceAdapterFactory.ZeroAddress.selector);
        new OutcomeTokenPriceAdapterFactory(ImpliedProbabilityOracle(address(0)), _params());
        p = _params();
        p.twapWindow = uint32(oracle.maxWindow());
        new OutcomeTokenPriceAdapterFactory(oracle, p);
    }

    function _expectBad(IOutcomeTokenPriceAdapterFactory.AdapterParams memory p) internal {
        vm.expectRevert(IOutcomeTokenPriceAdapterFactory.BadParams.selector);
        new OutcomeTokenPriceAdapterFactory(oracle, p);
    }

    // ---------------------------------------------------------------- metadata

    function test_metadata() public view {
        assertEq(yesFeed.decimals(), 8);
        assertEq(yesFeed.version(), 1);
        assertEq(yesFeed.description(), string.concat("HB", vm.toString(m.marketId()), "-YES / USD"));
        assertEq(noFeed.description(), string.concat("HB", vm.toString(m.marketId()), "-NO / USD"));
        assertEq(yesFeed.market(), address(m));
        assertEq(uint8(noFeed.side()), uint8(Side.No));
        assertEq(yesFeed.token(), address(_yes(m)));
        assertEq(noFeed.token(), address(_no(m)));
        assertEq(yesFeed.oracle(), address(oracle));
        assertEq(yesFeed.vault(), address(vault));
        assertEq(yesFeed.twapWindow(), WINDOW);
        assertEq(yesFeed.baseHaircutBps(), 1000);
        assertEq(yesFeed.closeHaircutBps(), 10_000);
        assertEq(yesFeed.rampSeconds(), RAMP);
        assertEq(yesFeed.spreadMultiplierBps(), 10_000);
        assertEq(yesFeed.maxSpreadHaircutBps(), 2000);
        assertEq(yesFeed.blockTimeMs(), 400);
    }

    // ---------------------------------------------------------------- live prices

    function test_live_noHistoryReverts() public {
        vm.expectRevert(IImpliedProbabilityOracle.NoObservations.selector);
        yesFeed.latestRoundData();
        oracle.poke(address(m));
        vm.warp(block.timestamp + WINDOW - 1);
        vm.expectRevert(); // InsufficientHistory: less than one window recorded
        yesFeed.latestRoundData();
    }

    function test_live_twapTimesHaircut() public {
        _steady(600_000, 20_000);
        uint256 pokedAt = block.timestamp;
        // Far from close: 10% base + 2% spread (0.02 x 1) = 12%.
        assertEq(yesFeed.haircutBps(), 1200);
        assertEq(noFeed.haircutBps(), 1200);
        (uint256 v, uint256 updatedAt) = yesFeed.valueE6();
        assertEq(v, 528_000, "0.60 x 0.88");
        assertEq(updatedAt, pokedAt);
        (v,) = noFeed.valueE6();
        assertEq(v, 352_000, "0.40 x 0.88");

        (uint80 roundId, int256 answer, uint256 startedAt, uint256 upd, uint80 answeredInRound) =
            yesFeed.latestRoundData();
        assertEq(answer, 52_800_000, "8 decimals");
        assertEq(roundId, uint80(pokedAt));
        assertEq(answeredInRound, roundId);
        assertEq(startedAt, pokedAt);
        assertEq(upd, pokedAt);
        assertEq(yesFeed.latestAnswer(), 52_800_000);
        assertEq(yesFeed.latestTimestamp(), pokedAt);
        assertEq(yesFeed.latestRound(), pokedAt);

        (uint80 r2, int256 a2,,,) = yesFeed.getRoundData(roundId);
        assertEq(r2, roundId);
        assertEq(a2, answer);
        vm.expectRevert(abi.encodeWithSelector(IOutcomeTokenPriceAdapter.RoundNotAvailable.selector, roundId - 1));
        yesFeed.getRoundData(roundId - 1);
    }

    function test_live_spreadPartIsCapped() public {
        // An empty book records a 100% spread: the spread part is its cap, 20%.
        book.setBestBidAsk(type(uint256).max, 0);
        _steady(0, 0);
        assertEq(yesFeed.haircutBps(), 1000 + 2000);
        (uint256 v,) = yesFeed.valueE6();
        assertEq(v, OPENING_E6 * 7000 / 10_000, "stale: the opening price, 30% off");
    }

    uint256 internal constant OPENING_E6 = 559_633;

    function test_live_haircutRampsToFullAtClose() public {
        _steady(800_000, 0);
        Window memory w = m.window();
        uint256 last = type(uint256).max;
        uint256[5] memory before = [uint256(4 days), 3 days, 2 days, 1 days, 0];
        for (uint256 i; i < 5; ++i) {
            vm.warp(w.close - before[i]);
            uint256 h = yesFeed.haircutBps();
            uint256 expected = before[i] >= RAMP ? 1000 : 10_000 - 9000 * before[i] / RAMP;
            assertEq(h, expected);
            (uint256 v,) = yesFeed.valueE6();
            assertLe(v, last, "never rises as close approaches");
            last = v;
        }
        assertEq(last, 0, "100% haircut at close");
        vm.warp(w.close + 1 days);
        assertEq(yesFeed.haircutBps(), 10_000);
    }

    function test_live_neverAboveOneMinusFee() public {
        IOutcomeTokenPriceAdapterFactory.AdapterParams memory p = _params();
        p.baseHaircutBps = 0;
        p.closeHaircutBps = 0;
        p.spreadMultiplierBps = 0;
        OutcomeTokenPriceAdapterFactory noHaircut = new OutcomeTokenPriceAdapterFactory(oracle, p);
        OutcomeTokenPriceAdapter y = OutcomeTokenPriceAdapter(noHaircut.createAdapter(address(m), Side.Yes));
        OutcomeTokenPriceAdapter n = OutcomeTokenPriceAdapter(noHaircut.createAdapter(address(m), Side.No));

        _steady(1e6, 0);
        (uint256 v,) = y.valueE6();
        assertEq(v, ONE - _winFee(Side.Yes), "capped at 1 - f_YES");
        assertEq(v, 991_192);
        _steady(1, 0); // YES at one base unit (a zero price reads as an empty book)
        (v,) = n.valueE6();
        assertEq(v, ONE - _winFee(Side.No), "capped at 1 - f_NO");
    }

    function test_live_blockClockMarketEstimatesTimeLeft() public {
        Window memory w = _blockWindow(); // close 40_000+ blocks away
        Market bm = _create(w, Side.Yes, CREATOR_MIN);
        PeripheryBook bb = _newBook(bm);
        graduator.registerBook(address(bm), address(bb));
        _fillToRule(bm);
        bm.graduate();
        OutcomeTokenPriceAdapter feed = OutcomeTokenPriceAdapter(adapters.createAdapter(address(bm), Side.Yes));
        bb.setBestBidAsk(500_000 * 1e12, 500_000 * 1e12);
        oracle.poke(address(bm));
        vm.warp(block.timestamp + WINDOW);
        vm.roll(block.number + 1);
        oracle.poke(address(bm));

        // Blocks left x 0.4 s, well inside the 3-day ramp.
        uint256 secondsLeft = (uint256(w.close) - block.number) * 400 / 1000;
        assertLt(secondsLeft, RAMP);
        assertEq(feed.haircutBps(), 10_000 - 9000 * secondsLeft / RAMP);
        vm.roll(w.close);
        assertEq(feed.haircutBps(), 10_000);
    }

    function test_poolMarket_assumesTheFullFee() public {
        Market pool = _create(_longWindow(), Side.Yes, 5e6);
        _stake(pool, users[0], Side.No, 5e6);
        IOutcomeTokenPriceAdapterFactory.AdapterParams memory p = _params();
        p.baseHaircutBps = 0;
        p.closeHaircutBps = 0;
        p.maxSpreadHaircutBps = 0;
        OutcomeTokenPriceAdapterFactory noHaircut = new OutcomeTokenPriceAdapterFactory(oracle, p);
        OutcomeTokenPriceAdapter feed = OutcomeTokenPriceAdapter(noHaircut.createAdapter(address(pool), Side.Yes));
        oracle.poke(address(pool));
        vm.warp(block.timestamp + WINDOW);
        (uint256 v,) = feed.valueE6();
        assertEq(v, 500_000, "half the pool, no haircut");

        _stake(pool, users[1], Side.Yes, 1000e6);
        vm.roll(block.number + 1);
        oracle.poke(address(pool));
        vm.warp(block.timestamp + WINDOW);
        (v,) = feed.valueE6();
        assertEq(v, ONE - 20_000, "capped at 1 - 2% before graduation");
    }

    // ---------------------------------------------------------------- final values

    function test_settled_exactRedemptionValue() public {
        _settle(m, Outcome.Yes);
        (uint256 v, uint256 updatedAt) = yesFeed.valueE6();
        assertEq(updatedAt, block.timestamp);
        assertEq(yesFeed.haircutBps(), 0);
        // Equal to what redeeming one whole token pays.
        address holder = users[0];
        uint256 before = usdc.balanceOf(holder);
        vm.prank(holder);
        vault.redeem(address(m), Side.Yes, ONE, holder);
        assertEq(v, usdc.balanceOf(holder) - before);
        assertEq(v, ONE - _winFee(Side.Yes));
        assertEq(_answer(yesFeed), int256(v * 100));
        assertEq(_answer(noFeed), 0, "the losing side is worth nothing");
    }

    function test_settledNo_andVoided() public {
        _settle(m, Outcome.No);
        assertEq(_answer(yesFeed), 0);
        (uint256 v,) = noFeed.valueE6();
        assertEq(v, ONE - _winFee(Side.No));

        (Market m2,) = _graduatedWithBook();
        OutcomeTokenPriceAdapter feed = OutcomeTokenPriceAdapter(adapters.createAdapter(address(m2), Side.No));
        vm.warp(m2.window().settleDeadline + 1);
        m2.voidIfExpired();
        assertEq(_answer(feed), 50_000_000);
        assertEq(feed.haircutBps(), 0);
        ICollateralVault.Ledger memory l = vault.ledger(address(m2));
        assertEq(uint8(l.status), uint8(ICollateralVault.Status.Voided));
    }

    // ---------------------------------------------------------------- fuzz

    /// For any book and any time: 0 <= value <= 1 - fee, on both sides.
    function testFuzz_bounds(uint256 mid, uint256 spread, uint256 elapsed) public {
        mid = bound(mid, 0, ONE);
        spread = bound(spread, 0, 2 * (mid < ONE - mid ? mid : ONE - mid));
        _steady(mid, spread);
        elapsed = bound(elapsed, 0, 40 days);
        vm.warp(block.timestamp + elapsed);
        (uint256 y,) = yesFeed.valueE6();
        (uint256 n,) = noFeed.valueE6();
        assertLe(y, ONE - _winFee(Side.Yes));
        assertLe(n, ONE - _winFee(Side.No));
        assertGe(_answer(yesFeed), 0);
        assertGe(_answer(noFeed), 0);
        assertLe(yesFeed.haircutBps(), 10_000);
    }

    /// With a steady book, the value never rises as close approaches.
    function testFuzz_monotoneInTime(uint256 mid, uint256 t1, uint256 t2) public {
        mid = bound(mid, 0, ONE);
        _steady(mid, 0);
        uint256 close = m.window().close;
        t1 = bound(t1, block.timestamp, close + 1 days);
        t2 = bound(t2, t1, close + 1 days);
        vm.warp(t1);
        (uint256 v1,) = yesFeed.valueE6();
        vm.warp(t2);
        (uint256 v2,) = yesFeed.valueE6();
        assertLe(v2, v1);
    }
}

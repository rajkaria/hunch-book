// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Market} from "../../src/core/Market.sol";
import {IHunchBookFactory} from "../../src/interfaces/IHunchBookFactory.sol";
import {Outcome, Side, Window} from "../../src/interfaces/IHunchBookTypes.sol";
import {ImpliedProbabilityOracle} from "../../src/periphery/ImpliedProbabilityOracle.sol";
import {OutcomeTokenPriceAdapter} from "../../src/periphery/OutcomeTokenPriceAdapter.sol";
import {OutcomeTokenPriceAdapterFactory} from "../../src/periphery/OutcomeTokenPriceAdapterFactory.sol";
import {IImpliedProbabilityOracle} from "../../src/periphery/interfaces/IImpliedProbabilityOracle.sol";
import {DeployPeriphery} from "../../script/DeployPeriphery.s.sol";
import {PeripheryBase} from "./PeripheryBase.sol";
import {V2BestBidAsk} from "./BookPriceV2.t.sol";

/// The feeds Kuru's WithdrawalLimiter prices YES and NO with: OutcomeTokenPriceAdapters built with
/// DeployPeriphery.kuruFeedParams (fair value, no haircut), on a v2 stack. They must answer from the
/// moment a market is created (Kuru sets them up while the pool fills), track the book after graduation,
/// pay out exactly after settlement, and report the time of the last poke so staleness is visible.
contract KuruFeedTest is PeripheryBase {
    uint256 internal constant WINDOW = 30 minutes;

    ImpliedProbabilityOracle internal oracle;
    OutcomeTokenPriceAdapterFactory internal feeds;
    V2BestBidAsk internal book;

    function setUp() public override {
        super.setUp();
        oracle = new ImpliedProbabilityOracle(IHunchBookFactory(address(factory)), 2);
        feeds = new OutcomeTokenPriceAdapterFactory(oracle, new DeployPeriphery().kuruFeedParams());
        book = new V2BestBidAsk();
    }

    function _longWindow() internal returns (Window memory w) {
        ++nonce;
        w.lock = uint64(block.timestamp + 1 days + nonce);
        w.close = uint64(block.timestamp + 30 days + nonce);
        w.settleDeadline = w.close + 7 days;
    }

    function _pokeAfter(Market m, uint256 secs) internal {
        vm.warp(block.timestamp + secs);
        vm.roll(block.number + 1);
        oracle.poke(address(m));
    }

    function _answer(address feed) internal view returns (int256 answer, uint256 updatedAt) {
        (, answer,, updatedAt,) = OutcomeTokenPriceAdapter(feed).latestRoundData();
    }

    /// Created at market creation, poked through the pool phase: the feed answers pool odds, unhaircut.
    function test_answersFromCreationWithPoolOdds() public {
        Market m = _create(_longWindow(), Side.Yes, CREATOR_MIN);
        address yesFeed = feeds.createAdapter(address(m), Side.Yes);
        address noFeed = feeds.createAdapter(address(m), Side.No);
        _fillToRule(m); // 305 YES / 240 NO
        _pokeAfter(m, 1);
        _pokeAfter(m, WINDOW);

        (int256 y, uint256 t) = _answer(yesFeed);
        (int256 n,) = _answer(noFeed);
        assertEq(y, int256(uint256(305e6) * 1e6 / 545e6) * 100);
        assertEq(n, int256(1e6 - uint256(305e6) * 1e6 / 545e6) * 100);
        assertEq(t, block.timestamp, "updatedAt is the last poke");
        assertEq(OutcomeTokenPriceAdapter(yesFeed).decimals(), 8);
    }

    /// After graduation the feed follows the v2 book's mid, with no haircut even close to close.
    function test_tracksTheBookWithoutHaircut() public {
        Market m = _create(_longWindow(), Side.Yes, CREATOR_MIN);
        address yesFeed = feeds.createAdapter(address(m), Side.Yes);
        graduator.registerBook(address(m), address(book));
        _fillToRule(m);
        m.graduate();
        book.set(600_000, 620_000);
        _pokeAfter(m, 1);
        _pokeAfter(m, WINDOW);
        (int256 y,) = _answer(yesFeed);
        assertEq(y, 61_000_000);

        // A day before close the lending adapters would haircut heavily; this one does not.
        vm.warp(m.window().close - 1 days);
        vm.roll(block.number + 1);
        oracle.poke(address(m));
        _pokeAfter(m, WINDOW);
        (y,) = _answer(yesFeed);
        assertEq(y, 61_000_000);
    }

    /// Settled: the winning side answers its payout (1 minus the fee), the losing side 0.
    function test_exactPayoutAfterSettlement() public {
        Market m = _create(_longWindow(), Side.Yes, CREATOR_MIN);
        address yesFeed = feeds.createAdapter(address(m), Side.Yes);
        address noFeed = feeds.createAdapter(address(m), Side.No);
        graduator.registerBook(address(m), address(book));
        _fillToRule(m);
        m.graduate();
        _settle(m, Outcome.Yes);
        (int256 y, uint256 t) = _answer(yesFeed);
        (int256 n,) = _answer(noFeed);
        assertEq(n, 0);
        assertGt(y, 97_000_000);
        assertLe(y, 100_000_000);
        assertEq(t, block.timestamp);
    }

    /// Before any poke there is no history: the feed reverts rather than inventing a price.
    function test_revertsBeforeTheFirstPoke() public {
        Market m = _create(_longWindow(), Side.Yes, CREATOR_MIN);
        address yesFeed = feeds.createAdapter(address(m), Side.Yes);
        vm.expectRevert(IImpliedProbabilityOracle.NoObservations.selector);
        OutcomeTokenPriceAdapter(yesFeed).latestRoundData();
    }
}

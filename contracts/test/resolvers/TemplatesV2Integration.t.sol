// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {BaseTest} from "../core/Base.t.sol";
import {Market} from "../../src/core/Market.sol";
import {ICollateralVault} from "../../src/interfaces/ICollateralVault.sol";
import {IHunchBookFactory} from "../../src/interfaces/IHunchBookFactory.sol";
import {IMarket} from "../../src/interfaces/IMarket.sol";
import {IResolver} from "../../src/interfaces/IResolver.sol";
import {Outcome, Phase, Side, Window} from "../../src/interfaces/IHunchBookTypes.sol";
import {
    ChainlinkTouchParams,
    ParlayParams,
    PerplFundingSpikeParams,
    PriceRangeParams
} from "../../src/interfaces/ITemplatesV2.sol";
import {IPyth} from "../../src/interfaces/external/IPyth.sol";
import {ChainlinkTouchResolver} from "../../src/resolvers/ChainlinkTouchResolver.sol";
import {MarketOutcomeResolver} from "../../src/resolvers/MarketOutcomeResolver.sol";
import {PerplFundingSpikeResolver} from "../../src/resolvers/PerplFundingSpikeResolver.sol";
import {PriceRangeResolver} from "../../src/resolvers/PriceRangeResolver.sol";
import {MockChainlinkAggregator} from "./mocks/MockChainlinkAggregator.sol";
import {MockPerplExchange} from "./mocks/MockPerplExchange.sol";

/// Templates 3 to 6 registered on a real HunchBookFactory with `addTemplate`, driven end to end
/// through real markets: create, stake, graduate, prove YES or settle, then redeem or claim. The
/// sources are mocks (Chainlink, Perpl); the fork suites cover the real ones.
contract TemplatesV2IntegrationTest is BaseTest {
    uint32 internal constant TOUCH = 3;
    uint32 internal constant SPIKE = 4;
    uint32 internal constant RANGE = 5;
    uint32 internal constant PARLAY = 6;
    uint80 internal constant PHASE1 = uint80(1) << 64;
    uint256 internal constant INTERVAL = 8571;
    uint256 internal constant DAY_BLOCKS = 288_000;
    uint256 internal constant PERP = 1;

    MockChainlinkAggregator internal btc;
    MockPerplExchange internal perpl;
    ChainlinkTouchResolver internal touch;
    PerplFundingSpikeResolver internal spike;
    PriceRangeResolver internal range;
    MarketOutcomeResolver internal parlay;

    uint64 internal start;
    uint64 internal end;
    uint256 internal gridStart;

    function setUp() public override {
        super.setUp();
        btc = new MockChainlinkAggregator(8, "BTC / USD");
        perpl = new MockPerplExchange();
        perpl.listPerp(PERP, "BTC Perp", "BTC", 1, 0, 1);

        address[] memory feeds = new address[](1);
        feeds[0] = address(btc);
        touch = new ChainlinkTouchResolver(feeds);
        spike = new PerplFundingSpikeResolver(perpl, 1000, DAY_BLOCKS);
        range = new PriceRangeResolver(feeds, IPyth(address(0)), new bytes32[](0), new string[](0));
        parlay = new MarketOutcomeResolver(IHunchBookFactory(address(factory)), 200);

        vm.startPrank(guardian);
        factory.addTemplate(TOUCH, IResolver(address(touch)), _rule());
        factory.addTemplate(SPIKE, IResolver(address(spike)), _rule());
        factory.addTemplate(RANGE, IResolver(address(range)), _rule());
        factory.addTemplate(PARLAY, IResolver(address(parlay)), _rule());
        vm.stopPrank();

        start = uint64(block.timestamp + 1 days);
        end = start + 7 days;

        // Perpl funding events every interval from just before now. Increments are 10 each, except the
        // event at gridStart + 4 intervals, which jumps by 50.
        gridStart = block.number - 5000;
        int48[8] memory sums = [int48(0), 10, 20, 30, 80, 90, 100, 110];
        for (uint256 i = 0; i < sums.length; ++i) {
            perpl.pushEvent(PERP, gridStart + i * INTERVAL, sums[i]);
        }
    }

    // ------------------------------------------------------------ helpers

    function _touchParams(int256 strike, uint8 direction) internal view returns (bytes memory) {
        return abi.encode(
            ChainlinkTouchParams({
                feed: address(btc),
                strikeE8: strike,
                direction: direction,
                lockTime: start,
                startTime: start,
                endTime: end
            })
        );
    }

    function _rangeParams(int256 lower, int256 upper, uint64 lock, uint64 close) internal view returns (bytes memory) {
        return abi.encode(
            PriceRangeParams({
                source: 0,
                feed: address(btc),
                pythId: bytes32(0),
                lowerE8: lower,
                upperE8: upper,
                lockTime: lock,
                closeTime: close
            })
        );
    }

    function _createWith(uint32 templateId, bytes memory params) internal returns (Market m) {
        vm.prank(creator);
        m = Market(payable(factory.createMarket(templateId, params, Side.Yes, CREATOR_MIN)));
    }

    /// The redemption fee on `tokens` winning tokens: 2% of the losing pool share, rounded up
    /// (PROTOCOL.md §5.3).
    function _fee(Market m, uint256 tokens, Side winner) internal view returns (uint256) {
        (uint256 y, uint256 n,) = m.poolTotals();
        uint256 losing = winner == Side.Yes ? n : y;
        return (tokens * 200 * losing + 10_000 * (y + n) - 1) / (10_000 * (y + n));
    }

    function _redeemAll(Market m, address user, Side side) internal returns (uint256 tokens, uint256 paid) {
        vm.startPrank(user);
        m.claimTokens();
        tokens = side == Side.Yes ? _yes(m).balanceOf(user) : _no(m).balanceOf(user);
        paid = vault.redeem(address(m), side, tokens, user);
        vm.stopPrank();
    }

    // ------------------------------------------------------------ template 3: touch

    function test_touch_graduatedMarketProvesYesBeforeCloseAndRedeems() public {
        Market m = _createWith(TOUCH, _touchParams(70_000e8, 0));
        assertEq(m.window().close, end);
        assertEq(m.window().settleDeadline, end + 24 hours + 7 days);
        assertEq(address(m.resolver()), address(touch));
        _fillToRule(m);
        m.graduate();
        assertEq(uint8(m.phase()), uint8(Phase.Graduated));

        // A round that touches 70,000 two days into the window.
        btc.setRound(PHASE1 + 1, 69_000e8, start + 1 days);
        btc.setRound(PHASE1 + 2, 70_100e8, start + 2 days);
        vm.warp(start + 2 days + 5 minutes);

        // A pointer that proves nothing reverts and settles nothing.
        vm.expectRevert(
            abi.encodeWithSelector(ChainlinkTouchResolver.NoTouch.selector, PHASE1 + 1, int256(69_000e8), 70_000e8)
        );
        m.proveYes(abi.encode(PHASE1 + 1));
        // NO cannot be asked for before close.
        vm.expectRevert(IMarket.NotClosed.selector);
        m.settle("");

        address prover = makeAddr("prover");
        vm.prank(prover);
        m.proveYes(abi.encode(PHASE1 + 2));
        assertEq(uint8(m.phase()), uint8(Phase.Settled));
        assertEq(uint8(m.outcome()), uint8(Outcome.Yes));
        assertLt(block.timestamp, end, "settled before close");
        assertEq(
            m.evidenceHash(), keccak256(abi.encode(address(btc), PHASE1 + 2, uint256(start + 2 days), int256(70_100e8)))
        );

        // YES redeems for 1 − fee; NO is worthless.
        (uint256 tokens, uint256 paid) = _redeemAll(m, users[0], Side.Yes);
        assertGt(tokens, 0);
        assertEq(paid, tokens - _fee(m, tokens, Side.Yes));
        vm.startPrank(users[6]);
        m.claimTokens();
        uint256 noTokens = _no(m).balanceOf(users[6]);
        vm.expectRevert(ICollateralVault.LosingSide.selector);
        vault.redeem(address(m), Side.No, noTokens, users[6]);
        vm.stopPrank();
        _assertSolvent();
    }

    function test_touch_graduatedMarketSettlesNoAfterTheChallenge() public {
        Market m = _createWith(TOUCH, _touchParams(90_000e8, 0));
        _fillToRule(m);
        m.graduate();
        btc.setRound(PHASE1 + 1, 80_000e8, start + 1 days);
        btc.setRound(PHASE1 + 2, 81_000e8, end + 1 hours);
        btc.setLatest(PHASE1 + 2);

        vm.warp(end);
        assertEq(uint8(m.phase()), uint8(Phase.Closed));
        vm.expectRevert(IMarket.NotResolved.selector); // the challenge period is still running
        m.settle("");
        vm.warp(end + 24 hours);
        // Empty evidence answers NO now, which a YES-only proof path refuses.
        vm.expectRevert(IMarket.NotResolved.selector);
        m.proveYes("");
        m.settle("");
        assertEq(uint8(m.outcome()), uint8(Outcome.No));

        (uint256 tokens, uint256 paid) = _redeemAll(m, users[6], Side.No);
        assertEq(paid, tokens - _fee(m, tokens, Side.No));
        _assertSolvent();
    }

    function test_touch_poolMarketProvesYesOnceLocked() public {
        Market m = _createWith(TOUCH, _touchParams(60_000e8, 1)); // falls to 60,000 or below
        _stake(m, users[0], Side.Yes, 100e6);
        _stake(m, users[1], Side.No, 200e6);
        btc.setRound(PHASE1 + 1, 59_999e8, start + 3 days);
        // Still a pool before the lock: proofs wait for staking to stop.
        vm.expectRevert(abi.encodeWithSelector(IMarket.WrongPhase.selector, Phase.Pool));
        m.proveYes(abi.encode(PHASE1 + 1));
        vm.warp(start + 3 days);
        assertEq(uint8(m.phase()), uint8(Phase.PoolLocked));
        m.proveYes(abi.encode(PHASE1 + 1));
        assertEq(uint8(m.outcome()), uint8(Outcome.Yes));

        uint256 before = usdc.balanceOf(users[0]);
        vm.prank(users[0]);
        m.claimPool();
        assertGt(usdc.balanceOf(users[0]), before + 100e6);
        _assertSolvent();
    }

    // ------------------------------------------------------------ template 4: funding spike

    /// A spike market whose window holds five grid events (see setUp).
    function _spikeMarket(int256 threshold) internal returns (Market m, uint64 e) {
        e = uint64(gridStart + 5 * INTERVAL);
        bytes memory params = abi.encode(
            PerplFundingSpikeParams({
                perpId: PERP,
                startBlock: uint64(vm.getBlockNumber() + 100),
                endBlock: e,
                threshold: threshold,
                expectedScalingExp: 0
            })
        );
        m = _createWith(SPIKE, params);
    }

    function test_spike_provesYesAndPaysThePool() public {
        (Market m, uint64 e) = _spikeMarket(30);
        Window memory w = m.window();
        assertTrue(w.blockClock);
        assertEq(w.close, e);
        _stake(m, users[0], Side.Yes, 100e6);
        _stake(m, users[1], Side.No, 100e6);

        uint64 spikeBlock = uint64(gridStart + 4 * INTERVAL);
        vm.roll(spikeBlock + 1);
        // An ordinary event is not a spike.
        vm.expectRevert(
            abi.encodeWithSelector(
                PerplFundingSpikeResolver.NotASpike.selector, spikeBlock - uint64(INTERVAL), int256(10), int256(30)
            )
        );
        m.proveYes(abi.encode(spikeBlock - uint64(INTERVAL)));
        m.proveYes(abi.encode(spikeBlock));
        assertEq(uint8(m.outcome()), uint8(Outcome.Yes));
        assertLt(block.number, e, "settled before close");

        vm.prank(users[0]);
        m.claimPool();
        _assertSolvent();
    }

    function test_spike_settlesNoAfterTheChallengeBlocks() public {
        (Market m, uint64 e) = _spikeMarket(100);
        _stake(m, users[1], Side.No, 100e6);
        vm.roll(e);
        vm.expectRevert(IMarket.NotResolved.selector);
        m.settle("");
        vm.roll(e + DAY_BLOCKS);
        vm.expectRevert(IMarket.NotResolved.selector);
        m.settle("");
        vm.roll(e + DAY_BLOCKS + 1);
        m.settle("");
        assertEq(uint8(m.outcome()), uint8(Outcome.No));
        vm.prank(users[1]);
        m.claimPool();
        _assertSolvent();
    }

    // ------------------------------------------------------------ template 5: price range

    function test_range_settlesFromTheBracketingRound() public {
        uint64 lock = uint64(block.timestamp + 1 days);
        uint64 close = lock + 1 days;
        Market inside = _createWith(RANGE, _rangeParams(80_000e8, 85_000e8, lock, close));
        Market above = _createWith(RANGE, _rangeParams(70_000e8, 84_000e8, lock, close));
        _stake(inside, users[0], Side.Yes, 50e6);
        _stake(inside, users[1], Side.No, 50e6);
        btc.setRound(PHASE1 + 1, 84_000e8, close - 10 minutes);
        btc.setRound(PHASE1 + 2, 86_000e8, close + 10 minutes);

        vm.warp(close + 1 hours);
        inside.settle(abi.encode(PHASE1 + 1));
        above.settle(abi.encode(PHASE1 + 1));
        assertEq(uint8(inside.outcome()), uint8(Outcome.Yes));
        assertEq(uint8(above.outcome()), uint8(Outcome.No)); // the upper bound is exclusive
        vm.prank(users[0]);
        inside.claimPool();
        _assertSolvent();
    }

    // ------------------------------------------------------------ template 6: parlay

    function test_parlay_yesWhenEveryLegIsYes() public {
        Market t = _createWith(TOUCH, _touchParams(70_000e8, 0));
        uint64 rangeClose = end - 1 days;
        Market r = _createWith(RANGE, _rangeParams(80_000e8, 85_000e8, start, rangeClose));
        address[] memory legs = new address[](2);
        (legs[0], legs[1]) = address(t) < address(r) ? (address(t), address(r)) : (address(r), address(t));
        Market p = _createWith(PARLAY, abi.encode(ParlayParams({legs: legs, lockTime: start, closeTime: end})));
        assertEq(p.window().settleDeadline, uint256(t.window().settleDeadline) + 7 days);
        _stake(p, users[0], Side.Yes, 40e6);
        _stake(p, users[1], Side.No, 60e6);

        // Leg 1: the touch is proved early. Leg 2: the range settles at its close.
        btc.setRound(PHASE1 + 1, 71_000e8, start + 1 days);
        btc.setRound(PHASE1 + 2, 84_500e8, rangeClose - 5 minutes);
        btc.setRound(PHASE1 + 3, 84_600e8, rangeClose + 5 minutes);
        vm.warp(start + 1 days);
        t.proveYes(abi.encode(PHASE1 + 1));
        vm.warp(rangeClose + 1);
        r.settle(abi.encode(PHASE1 + 2));

        // The parlay's own close has not come yet.
        vm.expectRevert(IMarket.NotClosed.selector);
        p.settle("");
        vm.warp(end);
        p.settle("");
        assertEq(uint8(p.outcome()), uint8(Outcome.Yes));
        vm.prank(users[0]);
        p.claimPool();
        _assertSolvent();
    }

    function test_parlay_noAsSoonAsOneLegIsNo() public {
        Market t = _createWith(TOUCH, _touchParams(70_000e8, 0));
        uint64 rangeClose = start + 1 days;
        Market r = _createWith(RANGE, _rangeParams(80_000e8, 85_000e8, start, rangeClose));
        address[] memory legs = new address[](2);
        (legs[0], legs[1]) = address(t) < address(r) ? (address(t), address(r)) : (address(r), address(t));
        Market p = _createWith(PARLAY, abi.encode(ParlayParams({legs: legs, lockTime: start, closeTime: rangeClose})));
        _stake(p, users[1], Side.No, 60e6);

        btc.setRound(PHASE1 + 1, 90_000e8, rangeClose - 5 minutes); // outside the range
        btc.setRound(PHASE1 + 2, 90_100e8, rangeClose + 5 minutes);
        vm.warp(rangeClose + 1 hours);
        r.settle(abi.encode(PHASE1 + 1));
        assertEq(uint8(r.outcome()), uint8(Outcome.No));
        // The touch leg is still open, but one NO decides the parlay.
        assertEq(uint8(t.outcome()), uint8(Outcome.Unresolved));
        p.settle("");
        assertEq(uint8(p.outcome()), uint8(Outcome.No));
        vm.prank(users[1]);
        p.claimPool();
        _assertSolvent();
    }

    function test_parlay_rejectsALockAfterALeg() public {
        Market t = _createWith(TOUCH, _touchParams(70_000e8, 0));
        Market r = _createWith(RANGE, _rangeParams(80_000e8, 85_000e8, start, start + 1 days));
        address[] memory legs = new address[](2);
        (legs[0], legs[1]) = address(t) < address(r) ? (address(t), address(r)) : (address(r), address(t));
        bytes memory params = abi.encode(ParlayParams({legs: legs, lockTime: start + 1, closeTime: end}));
        vm.prank(creator);
        vm.expectRevert(
            abi.encodeWithSelector(MarketOutcomeResolver.LockAfterLeg.selector, legs[0], start + 1, uint256(start))
        );
        factory.createMarket(PARLAY, params, Side.Yes, CREATOR_MIN);
    }
}

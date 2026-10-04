// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {HunchBookFactory} from "../../src/core/HunchBookFactory.sol";
import {Market} from "../../src/core/Market.sol";
import {TestUSDC} from "../../src/mocks/TestUSDC.sol";
import {IHunchBookFactory} from "../../src/interfaces/IHunchBookFactory.sol";
import {IMarket} from "../../src/interfaces/IMarket.sol";
import {IResolver} from "../../src/interfaces/IResolver.sol";
import {GraduationRule, MarketCaps, Outcome, Side} from "../../src/interfaces/IHunchBookTypes.sol";
import {PriceAtTimeParams} from "../../src/interfaces/ITemplates.sol";
import {ChainlinkTouchParams, ParlayParams, PriceRangeParams} from "../../src/interfaces/ITemplatesV2.sol";
import {IChainlinkAggregator} from "../../src/interfaces/external/IChainlinkAggregator.sol";
import {IPyth} from "../../src/interfaces/external/IPyth.sol";
import {ChainlinkTouchResolver, IChainlinkLatestRound} from "../../src/resolvers/ChainlinkTouchResolver.sol";
import {MarketOutcomeResolver} from "../../src/resolvers/MarketOutcomeResolver.sol";
import {PriceAtTimeResolver} from "../../src/resolvers/PriceAtTimeResolver.sol";
import {PriceRangeResolver} from "../../src/resolvers/PriceRangeResolver.sol";

/// Template 6 replayed on Monad mainnet with real Chainlink data. A local Hunch Book (factory, vault,
/// templates 2, 3, 5 and 6) is deployed on a fork three hours behind the head, where the legs' times
/// are still in the future. The fork is then rolled to the head, keeping the local contracts, and the
/// legs settle from the rounds Chainlink wrote in between; the parlays settle from the legs.
/// Run with: FOUNDRY_PROFILE=fork forge test --match-path test/fork/MarketOutcomeResolver.fork.t.sol
contract MarketOutcomeResolverForkTest is Test {
    /// About three hours of blocks at 0.3 s.
    uint256 internal constant BLOCKS_BACK = 36_000;

    TestUSDC internal usdc;
    HunchBookFactory internal factory;
    address internal btc;
    address internal eth;
    address internal mon;
    address internal sol;
    address internal creator = makeAddr("creator");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    function _deploy() internal {
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/../deployments/monad-mainnet.json"));
        btc = vm.parseJsonAddress(json, ".external.chainlink['BTC/USD']");
        eth = vm.parseJsonAddress(json, ".external.chainlink['ETH/USD']");
        mon = vm.parseJsonAddress(json, ".external.chainlink['MON/USD']");
        sol = vm.parseJsonAddress(json, ".external.chainlink['SOL/USD']");
        address[] memory feeds = new address[](4);
        (feeds[0], feeds[1], feeds[2], feeds[3]) = (btc, eth, mon, sol);

        usdc = new TestUSDC();
        Market impl = new Market();
        factory = new HunchBookFactory(
            address(usdc),
            address(impl),
            address(this),
            address(this),
            MarketCaps({poolCap: 5000e6, walletCap: 1000e6, minStake: 1e6, creatorMinStake: 5e6}),
            50_000e6
        );
        GraduationRule memory rule =
            GraduationRule({minPool: 500e6, minStakers: 10, minChanceBps: 300, maxChanceBps: 9700});
        IResolver atTime = new PriceAtTimeResolver(feeds, IPyth(address(0)), new bytes32[](0), new string[](0));
        IResolver touch = new ChainlinkTouchResolver(feeds);
        IResolver range = new PriceRangeResolver(feeds, IPyth(address(0)), new bytes32[](0), new string[](0));
        IResolver parlay = new MarketOutcomeResolver(IHunchBookFactory(address(factory)), 200);
        factory.addTemplate(2, atTime, rule);
        factory.addTemplate(3, touch, rule);
        factory.addTemplate(5, range, rule);
        factory.addTemplate(6, parlay, rule);

        address[] memory keep = new address[](8);
        (keep[0], keep[1], keep[2], keep[3]) = (address(usdc), address(impl), address(factory), factory.vault());
        (keep[4], keep[5], keep[6], keep[7]) = (address(atTime), address(touch), address(range), address(parlay));
        vm.makePersistent(keep);

        address vault = factory.vault();
        address[3] memory people = [creator, alice, bob];
        for (uint256 i = 0; i < people.length; ++i) {
            usdc.mint(people[i], 1000e6);
            vm.prank(people[i]);
            usdc.approve(vault, type(uint256).max);
        }
    }

    function _create(uint32 templateId, bytes memory params) internal returns (Market m) {
        vm.prank(creator);
        m = Market(payable(factory.createMarket(templateId, params, Side.Yes, 5e6)));
        (address yes, address no) = m.tokens();
        vm.makePersistent(address(m), yes, no);
    }

    function _atTime(address feed, int256 strike, uint64 lock, uint64 t) internal pure returns (bytes memory) {
        return abi.encode(
            PriceAtTimeParams({
                source: 0, feed: feed, pythId: bytes32(0), strikeE8: strike, lockTime: lock, closeTime: t
            })
        );
    }

    function _sorted(Market[] memory ms) internal pure returns (address[] memory legs) {
        legs = new address[](ms.length);
        for (uint256 i = 0; i < ms.length; ++i) {
            legs[i] = address(ms[i]);
        }
        for (uint256 i = 1; i < legs.length; ++i) {
            for (uint256 j = i; j > 0 && legs[j - 1] > legs[j]; --j) {
                (legs[j - 1], legs[j]) = (legs[j], legs[j - 1]);
            }
        }
    }

    function _updatedAt(address feed, uint80 r) internal view returns (uint256 u) {
        (,,, u,) = IChainlinkAggregator(feed).getRoundData(r);
    }

    /// The last round of the current phase updated at or before `t`, by binary search.
    function _roundAtOrBefore(address feed, uint256 t) internal view returns (uint80) {
        (uint80 latest,,,,) = IChainlinkLatestRound(feed).latestRoundData();
        uint80 lo = (latest >> 64) << 64 | 1;
        uint80 hi = latest;
        while (lo < hi) {
            uint80 mid = lo + (hi - lo + 1) / 2;
            if (_updatedAt(feed, mid) <= t) lo = mid;
            else hi = mid - 1;
        }
        return lo;
    }

    struct Legs {
        Market btcAbove; // template 2: BTC at or above $1,000 at T (YES on any real day)
        Market ethInRange; // template 5: ETH in [$100, $1,000,000) at T (YES)
        Market monTouch; // template 3: MON at or above $0.000001 in any round in the window (YES)
        Market solAbove; // template 2: SOL at or above $1,000,000 at T (NO)
        Market yesParlay; // btcAbove, ethInRange, monTouch
        Market noParlay; // btcAbove, solAbove
    }

    function test_mainnet_parlayReplayOnRealRounds() public {
        vm.createSelectFork(vm.envOr("MONAD_MAINNET_RPC", string("https://rpc.monad.xyz")));
        uint256 head = vm.getBlockNumber();
        vm.rollFork(head - BLOCKS_BACK);
        uint64 t0 = uint64(vm.getBlockTimestamp());
        console2.log("replay from block", vm.getBlockNumber(), "time", t0);
        _deploy();

        Legs memory l;
        uint64 lock = t0 + 30 minutes;
        uint64 t = t0 + 1 hours;
        l.btcAbove = _create(2, _atTime(btc, 1000e8, lock, t));
        l.ethInRange = _create(
            5,
            abi.encode(
                PriceRangeParams({
                    source: 0,
                    feed: eth,
                    pythId: bytes32(0),
                    lowerE8: 100e8,
                    upperE8: 1_000_000e8,
                    lockTime: lock,
                    closeTime: t
                })
            )
        );
        l.monTouch = _create(
            3,
            abi.encode(
                ChainlinkTouchParams({
                    feed: mon, strikeE8: 100, direction: 0, lockTime: lock, startTime: lock, endTime: t
                })
            )
        );
        l.solAbove = _create(2, _atTime(sol, 1_000_000e8, lock, t));

        Market[] memory three = new Market[](3);
        (three[0], three[1], three[2]) = (l.btcAbove, l.ethInRange, l.monTouch);
        l.yesParlay = _create(6, abi.encode(ParlayParams({legs: _sorted(three), lockTime: lock, closeTime: t})));
        Market[] memory two = new Market[](2);
        (two[0], two[1]) = (l.btcAbove, l.solAbove);
        l.noParlay = _create(6, abi.encode(ParlayParams({legs: _sorted(two), lockTime: lock, closeTime: t})));
        console2.log(l.yesParlay.resolver().describe(l.yesParlay.params()));

        vm.prank(alice);
        l.yesParlay.stake(Side.Yes, 100e6);
        vm.prank(bob);
        l.yesParlay.stake(Side.No, 50e6);
        vm.prank(bob);
        l.noParlay.stake(Side.No, 100e6);

        // Three hours later, at the real head: Chainlink has written the rounds the legs need.
        vm.rollFork(head);
        assertGt(block.timestamp, uint256(t) + 1 hours);
        assertEq(factory.marketCount(), 6, "local contracts kept across the roll");

        l.btcAbove.settle(abi.encode(_roundAtOrBefore(btc, t)));
        l.ethInRange.settle(abi.encode(_roundAtOrBefore(eth, t)));
        l.solAbove.settle(abi.encode(_roundAtOrBefore(sol, t)));
        l.monTouch.settle(abi.encode(_roundAtOrBefore(mon, lock - 1) + 1)); // the first round in the window
        assertEq(uint8(l.btcAbove.outcome()), uint8(Outcome.Yes));
        assertEq(uint8(l.ethInRange.outcome()), uint8(Outcome.Yes));
        assertEq(uint8(l.monTouch.outcome()), uint8(Outcome.Yes));
        assertEq(uint8(l.solAbove.outcome()), uint8(Outcome.No));

        l.yesParlay.settle("");
        l.noParlay.settle("");
        assertEq(uint8(l.yesParlay.outcome()), uint8(Outcome.Yes));
        assertEq(uint8(l.noParlay.outcome()), uint8(Outcome.No));
        console2.log("yes parlay evidence");
        console2.logBytes32(l.yesParlay.evidenceHash());

        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice);
        l.yesParlay.claimPool();
        assertGt(usdc.balanceOf(alice), before + 100e6);
        vm.prank(bob);
        l.noParlay.claimPool();
        vm.prank(bob);
        vm.expectRevert(IMarket.NothingToClaim.selector);
        l.yesParlay.claimPool();
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {Outcome, Window} from "../../src/interfaces/IHunchBookTypes.sol";
import {ChainlinkTouchParams} from "../../src/interfaces/ITemplatesV2.sol";
import {IChainlinkAggregator} from "../../src/interfaces/external/IChainlinkAggregator.sol";
import {ChainlinkTouchResolver, IChainlinkLatestRound} from "../../src/resolvers/ChainlinkTouchResolver.sol";

/// Template 3 against live Chainlink feeds on Monad. Windows are picked relative to the fork head;
/// Chainlink keeps every round in storage, so reading old rounds at the head is enough.
/// Run with: FOUNDRY_PROFILE=fork forge test --match-path test/fork/ChainlinkTouchResolver.fork.t.sol
contract ChainlinkTouchResolverForkTest is Test {
    string internal json;
    ChainlinkTouchResolver internal touch;
    address[4] internal feeds;

    /// The highest and lowest answers among the rounds updated in a window, and where they are.
    struct Extremes {
        uint80 first; // first round updated at or after the window's start
        uint80 last; // last round updated at or before the window's end
        uint80 maxRound;
        int256 maxAnswer;
        uint80 minRound;
        int256 minAnswer;
    }

    function _forkMainnet() internal {
        json = vm.readFile(string.concat(vm.projectRoot(), "/../deployments/monad-mainnet.json"));
        vm.createSelectFork(vm.envOr("MONAD_MAINNET_RPC", string("https://rpc.monad.xyz")));
        string[4] memory pairs = ["BTC/USD", "ETH/USD", "MON/USD", "SOL/USD"];
        address[] memory list = new address[](4);
        for (uint256 i = 0; i < 4; ++i) {
            feeds[i] = vm.parseJsonAddress(json, string.concat(".external.chainlink['", pairs[i], "']"));
            list[i] = feeds[i];
        }
        touch = new ChainlinkTouchResolver(list);
    }

    function _p(address feed, int256 strike, uint8 direction, uint64 start, uint64 end)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encode(
            ChainlinkTouchParams({
                feed: feed, strikeE8: strike, direction: direction, lockTime: start, startTime: start, endTime: end
            })
        );
    }

    function _updatedAt(address feed, uint80 r) internal view returns (uint256 u) {
        (,,, u,) = IChainlinkAggregator(feed).getRoundData(r);
    }

    function _answer(address feed, uint80 r) internal view returns (int256 a) {
        (, a,,,) = IChainlinkAggregator(feed).getRoundData(r);
    }

    /// The last round of the current phase updated at or before `t`, by binary search.
    function _roundAtOrBefore(address feed, uint256 t) internal view returns (uint80) {
        (uint80 latest,,,,) = IChainlinkLatestRound(feed).latestRoundData();
        uint80 lo = (latest >> 64) << 64 | 1;
        uint80 hi = latest;
        require(_updatedAt(feed, lo) <= t, "window before the phase");
        while (lo < hi) {
            uint80 mid = lo + (hi - lo + 1) / 2;
            if (_updatedAt(feed, mid) <= t) lo = mid;
            else hi = mid - 1;
        }
        return lo;
    }

    /// Walks every round updated in [start, end].
    function _extremes(address feed, uint64 start, uint64 end) internal view returns (Extremes memory x) {
        x.first = _roundAtOrBefore(feed, start - 1) + 1;
        x.last = _roundAtOrBefore(feed, end);
        require(x.last >= x.first, "no round in the window");
        x.maxAnswer = type(int256).min;
        x.minAnswer = type(int256).max;
        for (uint80 r = x.first; r <= x.last; ++r) {
            int256 a = _answer(feed, r);
            if (a > x.maxAnswer) (x.maxAnswer, x.maxRound) = (a, r);
            if (a < x.minAnswer) (x.minAnswer, x.minRound) = (a, r);
        }
    }

    // ------------------------------------------------------------ mainnet

    /// For BTC, ETH, MON and SOL, over a real 30-minute window that ended 25 hours ago: the highest
    /// round proves "at or above its own price" (equal counts) and nothing proves one unit higher;
    /// the lowest round proves "at or below its own price" and nothing proves one unit lower; rounds
    /// just outside the window prove nothing; and with the challenge period over and the feed still
    /// reporting, empty evidence settles the untouched strikes NO.
    function test_mainnet_touchEdgesOnRealRounds() public {
        _forkMainnet();
        uint64 end = uint64(block.timestamp - 25 hours);
        uint64 start = end - 30 minutes;
        console2.log("window start", start, "end", end);
        for (uint256 i = 0; i < feeds.length; ++i) {
            _checkFeed(feeds[i], start, end);
        }
    }

    function _checkFeed(address feed, uint64 start, uint64 end) internal {
        Extremes memory x = _extremes(feed, start, end);
        console2.log(IChainlinkAggregator(feed).description());
        console2.log("  rounds in window", uint256(x.last - x.first + 1));
        console2.log("  max round", x.maxRound);
        console2.log("  max answer", x.maxAnswer);
        console2.log("  min round", x.minRound);
        console2.log("  min answer", x.minAnswer);
        assertEq(IChainlinkAggregator(feed).decimals(), 8);

        // Up: the strike equal to the highest price is touched; one unit above is not.
        (Outcome o, bytes32 h) = touch.resolve(_p(feed, x.maxAnswer, 0, start, end), abi.encode(x.maxRound));
        assertEq(uint8(o), uint8(Outcome.Yes));
        assertEq(h, keccak256(abi.encode(feed, x.maxRound, _updatedAt(feed, x.maxRound), x.maxAnswer)));
        vm.expectRevert(
            abi.encodeWithSelector(ChainlinkTouchResolver.NoTouch.selector, x.maxRound, x.maxAnswer, x.maxAnswer + 1)
        );
        touch.resolve(_p(feed, x.maxAnswer + 1, 0, start, end), abi.encode(x.maxRound));

        // Down: the strike equal to the lowest price is touched; one unit below is not.
        (o,) = touch.resolve(_p(feed, x.minAnswer, 1, start, end), abi.encode(x.minRound));
        assertEq(uint8(o), uint8(Outcome.Yes));
        vm.expectRevert(
            abi.encodeWithSelector(ChainlinkTouchResolver.NoTouch.selector, x.minRound, x.minAnswer, x.minAnswer - 1)
        );
        touch.resolve(_p(feed, x.minAnswer - 1, 1, start, end), abi.encode(x.minRound));

        // The rounds on either side of the window do not count, whatever their price.
        uint80 before = x.first - 1;
        vm.expectRevert(
            abi.encodeWithSelector(
                ChainlinkTouchResolver.RoundOutsideWindow.selector, before, _updatedAt(feed, before), start, end
            )
        );
        touch.resolve(_p(feed, 1, 0, start, end), abi.encode(before));
        uint80 afterEnd = x.last + 1;
        vm.expectRevert(
            abi.encodeWithSelector(
                ChainlinkTouchResolver.RoundOutsideWindow.selector, afterEnd, _updatedAt(feed, afterEnd), start, end
            )
        );
        touch.resolve(_p(feed, 1, 0, start, end), abi.encode(afterEnd));

        // The challenge period ended an hour ago and the feed is live: untouched strikes settle NO.
        (o, h) = touch.resolve(_p(feed, x.maxAnswer + 1, 0, start, end), "");
        assertEq(uint8(o), uint8(Outcome.No));
        (uint80 latest,,, uint256 latestAt,) = IChainlinkLatestRound(feed).latestRoundData();
        assertEq(h, keccak256(abi.encode(feed, end, uint256(end) + 24 hours, latest, latestAt)));
        (o,) = touch.resolve(_p(feed, x.minAnswer - 1, 1, start, end), "");
        assertEq(uint8(o), uint8(Outcome.No));
    }

    /// A window that ended an hour ago is still inside its challenge period: empty evidence waits,
    /// while a real proof settles at once.
    function test_mainnet_noWaitsForTheChallenge() public {
        _forkMainnet();
        address btc = feeds[0];
        uint64 end = uint64(block.timestamp - 1 hours);
        uint64 start = end - 1 hours;
        Extremes memory x = _extremes(btc, start, end);
        (Outcome o, bytes32 h) = touch.resolve(_p(btc, x.maxAnswer + 1, 0, start, end), "");
        assertEq(uint8(o), uint8(Outcome.Unresolved));
        assertEq(h, bytes32(0));
        (o,) = touch.resolve(_p(btc, x.maxAnswer, 0, start, end), abi.encode(x.maxRound));
        assertEq(uint8(o), uint8(Outcome.Yes));
    }

    function test_mainnet_validateAndDescribe() public {
        _forkMainnet();
        uint64 start = uint64(block.timestamp + 1 days);
        bytes memory params = _p(feeds[0], 70_000e8, 0, start, start + 7 days);
        Window memory w = touch.validate(params);
        assertEq(w.lock, start);
        assertEq(w.close, start + 7 days);
        assertEq(w.settleDeadline, start + 7 days + 24 hours + 7 days);
        string memory d = touch.describe(params);
        console2.log(d);
        assertEq(vm.indexOf(d, "YES if Chainlink's BTC/USD feed reports a price at or above $70,000 in any round"), 0);
        assertTrue(touch.earlyYes());
    }

    // ------------------------------------------------------------ testnet

    /// Testnet feeds update about once a day: the latest round proves a touch at its own price inside
    /// a window that covers it.
    function test_testnet_touchOnTheLatestRound() public {
        string memory tj = vm.readFile(string.concat(vm.projectRoot(), "/../deployments/monad-testnet.json"));
        vm.createSelectFork(vm.envOr("MONAD_TESTNET_RPC", string("https://testnet-rpc.monad.xyz")));
        address feed = vm.parseJsonAddress(tj, ".external.chainlink['BTC/USD']");
        address[] memory list = new address[](1);
        list[0] = feed;
        ChainlinkTouchResolver r = new ChainlinkTouchResolver(list);
        (uint80 latest, int256 answer,, uint256 at,) = IChainlinkLatestRound(feed).latestRoundData();
        console2.log("testnet BTC/USD latest round", latest);
        console2.log("  answer", answer);
        console2.log("  updated seconds ago", block.timestamp - at);
        uint64 start = uint64(at - 1 hours);
        uint64 end = uint64(at + 1 hours);
        (Outcome o,) = r.resolve(_p(feed, answer, 0, start, end), abi.encode(latest));
        assertEq(uint8(o), uint8(Outcome.Yes));
        (o,) = r.resolve(_p(feed, answer, 1, start, end), abi.encode(latest));
        assertEq(uint8(o), uint8(Outcome.Yes));
    }
}

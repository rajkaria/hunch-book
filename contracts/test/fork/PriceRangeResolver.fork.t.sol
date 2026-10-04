// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {Outcome, Window} from "../../src/interfaces/IHunchBookTypes.sol";
import {PriceAtTimeParams} from "../../src/interfaces/ITemplates.sol";
import {PriceRangeParams} from "../../src/interfaces/ITemplatesV2.sol";
import {IChainlinkAggregator} from "../../src/interfaces/external/IChainlinkAggregator.sol";
import {IPyth} from "../../src/interfaces/external/IPyth.sol";
import {PriceAtTimeResolver} from "../../src/resolvers/PriceAtTimeResolver.sol";
import {PriceRangeResolver} from "../../src/resolvers/PriceRangeResolver.sol";

interface IChainlinkLatestForRange {
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}

/// Template 5 against live Chainlink feeds on Monad mainnet, side by side with template 2 on the same
/// rounds: both read the price at T the same way.
/// Run with: FOUNDRY_PROFILE=fork forge test --match-path test/fork/PriceRangeResolver.fork.t.sol
contract PriceRangeResolverForkTest is Test {
    string internal json;
    PriceRangeResolver internal range;
    PriceAtTimeResolver internal atTime;
    address[4] internal feeds;

    function _forkMainnet() internal {
        json = vm.readFile(string.concat(vm.projectRoot(), "/../deployments/monad-mainnet.json"));
        vm.createSelectFork(vm.envOr("MONAD_MAINNET_RPC", string("https://rpc.monad.xyz")));
        string[4] memory pairs = ["BTC/USD", "ETH/USD", "MON/USD", "SOL/USD"];
        address[] memory list = new address[](4);
        for (uint256 i = 0; i < 4; ++i) {
            feeds[i] = vm.parseJsonAddress(json, string.concat(".external.chainlink['", pairs[i], "']"));
            list[i] = feeds[i];
        }
        range = new PriceRangeResolver(list, IPyth(address(0)), new bytes32[](0), new string[](0));
        atTime = new PriceAtTimeResolver(list, IPyth(address(0)), new bytes32[](0), new string[](0));
    }

    function _range(address feed, int256 lower, int256 upper, uint64 t) internal pure returns (bytes memory) {
        return abi.encode(
            PriceRangeParams({
                source: 0, feed: feed, pythId: bytes32(0), lowerE8: lower, upperE8: upper, lockTime: t - 1, closeTime: t
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
    function _bracketingRound(address feed, uint256 t) internal view returns (uint80) {
        (uint80 latest,,,,) = IChainlinkLatestForRange(feed).latestRoundData();
        uint80 lo = (latest >> 64) << 64 | 1;
        uint80 hi = latest;
        while (lo < hi) {
            uint80 mid = lo + (hi - lo + 1) / 2;
            if (_updatedAt(feed, mid) <= t) lo = mid;
            else hi = mid - 1;
        }
        return lo;
    }

    /// For BTC, ETH, MON and SOL at a time three hours before the head: the bracketing round's price
    /// is inside [price, price + 1), outside [price − 1, price) (the upper bound is exclusive) and
    /// outside [price + 1, price + 2); template 2 agrees at the same strike, with the same evidence.
    function test_mainnet_boundsOnRealRounds() public {
        _forkMainnet();
        uint64 t = uint64(block.timestamp - 3 hours);
        console2.log("target T", t);
        for (uint256 i = 0; i < feeds.length; ++i) {
            _checkFeed(feeds[i], t);
        }
    }

    function _checkFeed(address feed, uint64 t) internal {
        uint80 r = _bracketingRound(feed, t);
        int256 a = _answer(feed, r);
        console2.log(IChainlinkAggregator(feed).description(), "round", r);
        console2.log("  answer", a);
        bytes memory ev = abi.encode(r);

        (Outcome o, bytes32 h) = range.resolve(_range(feed, a, a + 1, t), ev);
        assertEq(uint8(o), uint8(Outcome.Yes));
        (o,) = range.resolve(_range(feed, a - 1, a, t), ev);
        assertEq(uint8(o), uint8(Outcome.No));
        (o,) = range.resolve(_range(feed, a + 1, a + 2, t), ev);
        assertEq(uint8(o), uint8(Outcome.No));

        bytes memory atParams = abi.encode(
            PriceAtTimeParams({source: 0, feed: feed, pythId: bytes32(0), strikeE8: a, lockTime: t - 1, closeTime: t})
        );
        (Outcome o2, bytes32 h2) = atTime.resolve(atParams, ev);
        assertEq(uint8(o2), uint8(Outcome.Yes));
        assertEq(h2, h, "templates 2 and 5 commit to the same read");

        uint256 rAt = _updatedAt(feed, r);
        vm.expectRevert(
            abi.encodeWithSelector(PriceRangeResolver.RoundNotLastBeforeTarget.selector, r - 1, rAt, uint256(t))
        );
        range.resolve(_range(feed, a, a + 1, t), abi.encode(r - 1));
    }

    function test_mainnet_validateAndDescribe() public {
        _forkMainnet();
        uint64 t = uint64(block.timestamp + 1 days);
        bytes memory params = _range(feeds[0], 80_000e8, 90_000e8, t);
        Window memory w = range.validate(params);
        assertEq(w.close, t);
        assertEq(w.settleDeadline, t + 7 days);
        string memory d = range.describe(params);
        console2.log(d);
        assertEq(
            vm.indexOf(d, "YES if Chainlink's BTC/USD feed puts BTC/USD at or above $80,000 and below $90,000 at 20"), 0
        );
    }
}

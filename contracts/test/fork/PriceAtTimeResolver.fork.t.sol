// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {Outcome, Window} from "../../src/interfaces/IHunchBookTypes.sol";
import {PriceAtTimeParams} from "../../src/interfaces/ITemplates.sol";
import {IChainlinkAggregator} from "../../src/interfaces/external/IChainlinkAggregator.sol";
import {IPyth} from "../../src/interfaces/external/IPyth.sol";
import {PriceAtTimeResolver} from "../../src/resolvers/PriceAtTimeResolver.sol";

interface IChainlinkLatest {
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}

/// Template S-2 against live Chainlink feeds and Pyth on Monad. Times are picked relative to the fork
/// head; Chainlink keeps every round in storage, so reading old rounds at the head is enough.
/// Run with: FOUNDRY_PROFILE=fork forge test --match-path test/fork/PriceAtTimeResolver.fork.t.sol
contract PriceAtTimeResolverForkTest is Test {
    /// GMON / MON exchange rate on mainnet: 18 decimals, about one round a day. Used only to reach the
    /// one-hour staleness edge with real rounds; it is not a market feed.
    address internal constant MAINNET_SLOW_FEED = 0xf97dfEd6Aa4cc387aBC5d47F0062A91CB4E4A755;

    /// Chainlink BTC/USD on Monad testnet, from Chainlink's reference data directory
    /// (feeds-monad-testnet.json, marked hidden). Used when deployments/monad-testnet.json has none.
    address internal constant TESTNET_BTC_USD = 0x12C0F44368a02081ce58a936d1C1F606BB301715;

    /// A real Pyth BTC/USD update from Monad mainnet (tx 0x8951d8c9...68b0, block 110178734), cut down
    /// to the BTC message and its Merkle proof. price 8480475150000, expo -8, publishTime 1791030045,
    /// prevPublishTime 1791030044. Still valid while the guardian set that signed it is current.
    bytes internal constant PYTH_BTC_UPDATE =
        hex"504e4155010000000124010000000103018f80932eaf75623d691e68c6e0374de15b05bbc30c4462870b2bbe70c0cd733d2f42ce9b730872336704ec179b51a1ef9434c843878926eafee556bd6530c35a0102a992029bddac34a7f8862d37443d62295beb0b9520f8615a7f45da2db51df6502e0958e3f938d0c993ba65ebfa175b70bd8f3094eb2eff6aa642c0dc5205a79f01040fbacb42754bf300697e27cd78938971533b642c679416c30c2da30366877cee4690882402f6af5351e60d5abc2b0032f66c325724ab794911a8d6239db2360b006ac0f31d00000000001a507974686e6574507974686e6574507974686e6574507974686e657450797468000000085712fe44004155575600000000085712fe440000000064f733a979028599e5a4819adeb7969b3a69028601005500e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43000007b683b576b00000000030e603e0fffffff8000000006ac0f31d000000006ac0f31c000007b2ca587d500000000041e9bdbe0c60b99a509485863c35bd7f678325857e7d9884e383f8ca3d611cf35153ffe72aa2138401f2ad5d95d3e1dac9a845b5677ab711baef090debbc9d0ac7de18b6e132de400c027ee361a5c0542331ebc458706fed7eb2451e7dba6006fa5e9da16fa86a30ca2bd28b838c695a15667c426bf96ab5b8a28154df2285e826ae74486e8336a11864400822ed8f9a401e9a5a7ab2c8f9a9dda7c99cacceb762a703e8d4d1e867b0e6f0aadd49692245f6af9053345f1675a6827ed6578f931a2d9ef1b5a9966e604fb24e86e0819423b3c2d85810d4e7c05d84cae4d0178ddf026a45dbd1662c59d3c548a0af54c16bdc4f5d8f";
    uint64 internal constant PYTH_PUBLISH_TIME = 1_791_030_045;
    int64 internal constant PYTH_PRICE = 8_480_475_150_000;

    string internal json;
    PriceAtTimeResolver internal resolver;
    address internal btc;
    IPyth internal pyth;
    bytes32 internal btcId;

    // ------------------------------------------------------------ set-up

    function _forkMainnet() internal {
        json = vm.readFile(string.concat(vm.projectRoot(), "/../deployments/monad-mainnet.json"));
        vm.createSelectFork(vm.envOr("MONAD_MAINNET_RPC", string("https://rpc.monad.xyz")));
        btc = vm.parseJsonAddress(json, ".external.chainlink['BTC/USD']");
        address[] memory feeds = new address[](3);
        feeds[0] = btc;
        feeds[1] = vm.parseJsonAddress(json, ".external.chainlink['ETH/USD']");
        feeds[2] = vm.parseJsonAddress(json, ".external.chainlink['MON/USD']");

        pyth = IPyth(vm.parseJsonAddress(json, ".external.pyth.contract"));
        string[4] memory pairs = ["BTC/USD", "ETH/USD", "SOL/USD", "MON/USD"];
        bytes32[] memory ids = new bytes32[](4);
        string[] memory labels = new string[](4);
        for (uint256 i = 0; i < 4; ++i) {
            ids[i] = vm.parseJsonBytes32(json, string.concat(".external.pyth.ids['", pairs[i], "']"));
            labels[i] = pairs[i];
        }
        btcId = ids[0];
        resolver = new PriceAtTimeResolver(feeds, pyth, ids, labels);
    }

    function _cl(address feed, int256 strike, uint64 t) internal pure returns (bytes memory) {
        return abi.encode(
            PriceAtTimeParams({
                source: 0, feed: feed, pythId: bytes32(0), strikeE8: strike, lockTime: t - 1, closeTime: t
            })
        );
    }

    function _py(bytes32 id, int256 strike, uint64 t) internal pure returns (bytes memory) {
        return abi.encode(
            PriceAtTimeParams({
                source: 1, feed: address(0), pythId: id, strikeE8: strike, lockTime: t - 1, closeTime: t
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
        (uint80 latest,,,,) = IChainlinkLatest(feed).latestRoundData();
        uint80 lo = (latest >> 64) << 64 | 1;
        uint80 hi = latest;
        require(_updatedAt(feed, lo) <= t, "target before the phase");
        while (lo < hi) {
            uint80 mid = lo + (hi - lo + 1) / 2;
            if (_updatedAt(feed, mid) <= t) lo = mid;
            else hi = mid - 1;
        }
        return lo;
    }

    // ------------------------------------------------------------ mainnet: Chainlink

    /// For BTC, ETH and MON: the round that brackets a time three hours before the head settles,
    /// at the strike edge, and its neighbours are both rejected.
    function test_mainnet_bracketingRoundOnly() public {
        _forkMainnet();
        address[3] memory feeds = [
            btc,
            vm.parseJsonAddress(json, ".external.chainlink['ETH/USD']"),
            vm.parseJsonAddress(json, ".external.chainlink['MON/USD']")
        ];
        uint64 t = uint64(block.timestamp - 3 hours);
        console2.log("fork head time", block.timestamp, "target T", t);
        for (uint256 i = 0; i < feeds.length; ++i) {
            _checkBracket(feeds[i], t);
        }
    }

    function _checkBracket(address feed, uint64 t) internal {
        uint80 r = _bracketingRound(feed, t);
        int256 answer = _answer(feed, r);
        uint256 at = _updatedAt(feed, r);
        uint256 nextAt = _updatedAt(feed, r + 1);
        console2.log(IChainlinkAggregator(feed).description());
        console2.log("  round", r);
        console2.log("  answer", answer);
        console2.log("  updatedAt", at, "next updatedAt", nextAt);
        assertLe(at, t);
        assertGt(nextAt, t);

        // Strike equal to the price: YES. One unit above: NO. (These feeds have 8 decimals.)
        assertEq(IChainlinkAggregator(feed).decimals(), 8);
        (Outcome o,) = resolver.resolve(_cl(feed, answer, t), abi.encode(r));
        assertEq(uint8(o), uint8(Outcome.Yes));
        (o,) = resolver.resolve(_cl(feed, answer + 1, t), abi.encode(r));
        assertEq(uint8(o), uint8(Outcome.No));

        vm.expectRevert(
            abi.encodeWithSelector(PriceAtTimeResolver.RoundNotLastBeforeTarget.selector, r - 1, at, uint256(t))
        );
        resolver.resolve(_cl(feed, answer, t), abi.encode(r - 1));
        vm.expectRevert(
            abi.encodeWithSelector(PriceAtTimeResolver.RoundAfterTarget.selector, r + 1, nextAt, uint256(t))
        );
        resolver.resolve(_cl(feed, answer, t), abi.encode(r + 1));
    }

    /// No round after T yet: Unresolved. T not reached yet: Unresolved.
    function test_mainnet_waitsForTheNextRound() public {
        _forkMainnet();
        (uint80 latest,,, uint256 latestAt,) = IChainlinkLatest(btc).latestRoundData();
        vm.warp(latestAt + 10);
        uint64 t = uint64(latestAt + 5);
        (Outcome o,) = resolver.resolve(_cl(btc, 1, t), abi.encode(latest));
        assertEq(uint8(o), uint8(Outcome.Unresolved));
        (o,) = resolver.resolve(_cl(btc, 1, uint64(block.timestamp)), abi.encode(latest));
        assertEq(uint8(o), uint8(Outcome.Unresolved));
    }

    /// Phase edges: the last id of a phase is rejected; a round in a phase that does not exist yet
    /// has no successor, so it is Unresolved rather than an answer.
    function test_mainnet_phaseEdges() public {
        _forkMainnet();
        (uint80 latest,,,,) = IChainlinkLatest(btc).latestRoundData();
        uint80 phase = latest >> 64;
        uint80 last = (phase << 64) | type(uint64).max;
        uint64 t = uint64(block.timestamp - 1 hours);
        vm.expectRevert(abi.encodeWithSelector(PriceAtTimeResolver.PhaseBoundary.selector, last));
        resolver.resolve(_cl(btc, 1, t), abi.encode(last));
        (Outcome o,) = resolver.resolve(_cl(btc, 1, t), abi.encode(((phase + 1) << 64) | 1));
        assertEq(uint8(o), uint8(Outcome.Unresolved));
    }

    /// The one-hour staleness edge on real rounds, using a feed that updates about once a day.
    /// Also exercises 18-decimal normalisation on a live feed.
    function test_mainnet_stalenessEdgeOnASlowFeed() public {
        _forkMainnet();
        address[] memory feeds = new address[](1);
        feeds[0] = MAINNET_SLOW_FEED;
        PriceAtTimeResolver slow = new PriceAtTimeResolver(feeds, IPyth(address(0)), new bytes32[](0), new string[](0));

        (uint80 r,,,,) = IChainlinkLatest(MAINNET_SLOW_FEED).latestRoundData();
        // Step back to a round followed by a gap longer than an hour.
        do {
            --r;
        } while (_updatedAt(MAINNET_SLOW_FEED, r + 1) - _updatedAt(MAINNET_SLOW_FEED, r) <= 1 hours + 1);
        uint256 at = _updatedAt(MAINNET_SLOW_FEED, r);
        int256 answer = _answer(MAINNET_SLOW_FEED, r);
        int256 e8 = answer / 1e10;
        console2.log("slow feed round", r, "updatedAt", at);
        console2.log("  answer (18 dec)", answer);
        console2.log("  answer (E8)", e8);
        console2.log("  next updatedAt", _updatedAt(MAINNET_SLOW_FEED, r + 1));

        uint64 edge = uint64(at + 1 hours);
        (Outcome o,) = slow.resolve(_cl(MAINNET_SLOW_FEED, e8, edge), abi.encode(r));
        assertEq(uint8(o), uint8(Outcome.Yes));
        (o,) = slow.resolve(_cl(MAINNET_SLOW_FEED, e8 + 1, edge), abi.encode(r));
        assertEq(uint8(o), uint8(Outcome.No));

        vm.expectRevert(abi.encodeWithSelector(PriceAtTimeResolver.RoundTooStale.selector, r, at, uint256(edge) + 1));
        slow.resolve(_cl(MAINNET_SLOW_FEED, e8, edge + 1), abi.encode(r));
    }

    function test_mainnet_validateAndDescribe() public {
        _forkMainnet();
        uint64 t = uint64(block.timestamp + 1 days);
        Window memory w = resolver.validate(_cl(btc, 85_000e8, t));
        assertEq(w.close, t);
        assertEq(w.settleDeadline, t + 7 days);
        string memory d = resolver.describe(_cl(btc, 85_000e8, t));
        console2.log(d);
        // The pair comes from the live feed's description(); the UTC format is covered by unit tests.
        assertEq(vm.indexOf(d, "Will BTC/USD be at or above $85,000 at 20"), 0);
        string memory tail = string.concat(" UTC (unix time ", vm.toString(t), "), per Chainlink's BTC/USD feed?");
        assertEq(vm.indexOf(d, tail), bytes(d).length - bytes(tail).length);
    }

    // ------------------------------------------------------------ mainnet: Pyth

    /// A real signed BTC/USD update: accepted only for the T at which it is the first update.
    function test_mainnet_pythRealUpdate() public {
        _forkMainnet();
        assertGt(block.timestamp, PYTH_PUBLISH_TIME);
        bytes[] memory updates = new bytes[](1);
        updates[0] = PYTH_BTC_UPDATE;
        bytes memory evidence = abi.encode(updates);
        uint256 fee = pyth.getUpdateFee(updates);
        console2.log("pyth update fee (wei)", fee);
        vm.deal(address(this), 1 ether);

        uint256 before = address(this).balance;
        (Outcome o, bytes32 h) = resolver.resolve{value: 1 ether}(_py(btcId, PYTH_PRICE, PYTH_PUBLISH_TIME), evidence);
        assertEq(uint8(o), uint8(Outcome.Yes)); // strike equal to the price
        assertEq(address(this).balance, before - fee); // only the fee was kept
        IPyth.Price memory p =
            IPyth.Price({price: PYTH_PRICE, conf: 820_380_640, expo: -8, publishTime: PYTH_PUBLISH_TIME});
        assertEq(h, keccak256(abi.encode(uint8(1), address(pyth), btcId, p, PYTH_PUBLISH_TIME)));

        (o,) = resolver.resolve{value: fee}(_py(btcId, PYTH_PRICE + 1, PYTH_PUBLISH_TIME), evidence);
        assertEq(uint8(o), uint8(Outcome.No));

        // One second later: the update was published before T.
        vm.expectRevert();
        resolver.resolve{value: fee}(_py(btcId, 1, PYTH_PUBLISH_TIME + 1), evidence);
        // One second earlier: its predecessor (publishTime − 1) was already at T, so it is not first.
        vm.expectRevert();
        resolver.resolve{value: fee}(_py(btcId, 1, PYTH_PUBLISH_TIME - 1), evidence);
        // Another feed's id: the update does not answer it.
        bytes32 ethId = vm.parseJsonBytes32(json, ".external.pyth.ids['ETH/USD']");
        vm.expectRevert();
        resolver.resolve{value: fee}(_py(ethId, 1, PYTH_PUBLISH_TIME), evidence);
        // Too little fee.
        if (fee > 0) {
            vm.expectRevert(abi.encodeWithSelector(PriceAtTimeResolver.InsufficientFee.selector, fee, fee - 1));
            resolver.resolve{value: fee - 1}(_py(btcId, 1, PYTH_PUBLISH_TIME), evidence);
        }
    }

    receive() external payable {}

    // ------------------------------------------------------------ testnet

    /// Chainlink feeds on Monad testnet: present and updating, but on a 0.5% / 24 h schedule, so the
    /// one-hour staleness rule rejects many times.
    function test_testnet_chainlinkFeeds() public {
        string memory tj = vm.readFile(string.concat(vm.projectRoot(), "/../deployments/monad-testnet.json"));
        vm.createSelectFork(vm.envOr("MONAD_TESTNET_RPC", string("https://testnet-rpc.monad.xyz")));
        address feed = vm.keyExistsJson(tj, ".external.chainlink['BTC/USD']")
            ? vm.parseJsonAddress(tj, ".external.chainlink['BTC/USD']")
            : TESTNET_BTC_USD;
        assertGt(feed.code.length, 0);
        assertEq(IChainlinkAggregator(feed).decimals(), 8);
        assertEq(IChainlinkAggregator(feed).description(), "BTC / USD");
        (uint80 latest, int256 answer,, uint256 latestAt,) = IChainlinkLatest(feed).latestRoundData();
        console2.log("testnet BTC/USD latest round", latest);
        console2.log("  answer", answer);
        console2.log("  updated seconds ago", block.timestamp - latestAt);
        assertLe(block.timestamp - latestAt, 2 days, "testnet feed stopped");

        address[] memory feeds = new address[](1);
        feeds[0] = feed;
        PriceAtTimeResolver r = new PriceAtTimeResolver(feeds, IPyth(address(0)), new bytes32[](0), new string[](0));
        uint80 prev = latest - 1;
        uint256 prevAt = _updatedAt(feed, prev);
        console2.log("  gap between the last two rounds (s)", latestAt - prevAt);

        // Ten seconds after a round: settles.
        (Outcome o,) = r.resolve(_cl(feed, 1, uint64(prevAt + 10)), abi.encode(prev));
        assertEq(uint8(o), uint8(Outcome.Yes));
        // More than an hour after it, before the next round: refused as stale.
        if (latestAt > prevAt + 1 hours + 1) {
            vm.expectRevert(
                abi.encodeWithSelector(PriceAtTimeResolver.RoundTooStale.selector, prev, prevAt, prevAt + 1 hours + 1)
            );
            r.resolve(_cl(feed, 1, uint64(prevAt + 1 hours + 1)), abi.encode(prev));
        }
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {HunchBookFactory} from "../src/core/HunchBookFactory.sol";
import {TestUSDC} from "../src/mocks/TestUSDC.sol";
import {IMarket} from "../src/interfaces/IMarket.sol";
import {Side} from "../src/interfaces/IHunchBookTypes.sol";
import {ChainlinkTouchParams, ParlayParams} from "../src/interfaces/ITemplatesV2.sol";
import {SnapshotParams, SnapshotSource} from "../src/interfaces/ITemplatesV3.sol";
import {SnapshotResolver} from "../src/resolvers/SnapshotResolver.sol";

interface IChainlinkLatestDemo {
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
    function decimals() external view returns (uint8);
}

/// Opens one market on each of the newer templates on Monad testnet, so each is visible working:
///   - template 7 (snapshot): "Will Perpl's MON mark price be at or above its current value two hours
///     from now?", settled by the keeper's snapshot right after close;
///   - template 3 (touch): "Will Chainlink's BTC/USD feed report 1% above today's price within three
///     days?";
///   - template 6 (parlay): the touch market above and one more open market (PARLAY_LEG), if given.
/// These markets are ours: the deployer creates them and makes each first stake of 5 test USDC.
///
///   DEPLOYER_PRIVATE_KEY=... [PARLAY_LEG=0x...] forge script script/DemoMarkets.s.sol \
///     --rpc-url "$MONAD_TESTNET_RPC" --broadcast --slow
contract DemoMarkets is Script {
    uint32 internal constant TOUCH = 3;
    uint32 internal constant PARLAY = 6;
    uint32 internal constant SNAPSHOT = 7;
    uint256 internal constant FIRST_STAKE = 5e6;

    HunchBookFactory internal factory;
    TestUSDC internal usdc;
    SnapshotResolver internal snap;
    address internal btcFeed;
    uint256 internal pk;

    function run() external {
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/../deployments/monad-testnet.json"));
        require(block.chainid == 10_143, "testnet only");
        factory = HunchBookFactory(vm.parseJsonAddress(json, ".hunchBook.factory"));
        usdc = TestUSDC(vm.parseJsonAddress(json, ".hunchBook.usdc"));
        snap = SnapshotResolver(vm.parseJsonAddress(json, ".hunchBook.resolvers.snapshot"));
        btcFeed = vm.parseJsonAddress(json, ".external.chainlink['BTC/USD']");
        pk = vm.envUint("DEPLOYER_PRIVATE_KEY");

        SnapshotParams memory s = _snapshotParams();
        ChainlinkTouchParams memory t = _touchParams();

        vm.startBroadcast(pk);
        usdc.mint(vm.addr(pk), 3 * FIRST_STAKE);
        usdc.approve(factory.vault(), type(uint256).max);
        address snapMarket = factory.createMarket(SNAPSHOT, abi.encode(s), Side.Yes, FIRST_STAKE);
        address touchMarket = factory.createMarket(TOUCH, abi.encode(t), Side.No, FIRST_STAKE);
        address parlayMarket = _parlay(touchMarket);
        vm.stopBroadcast();

        console2.log("snapshot market (template 7):", snapMarket);
        console2.log("  rule:", IMarket(snapMarket).resolver().describe(abi.encode(s)));
        console2.log("touch market (template 3):", touchMarket);
        console2.log("  rule:", IMarket(touchMarket).resolver().describe(abi.encode(t)));
        if (parlayMarket != address(0)) console2.log("parlay market (template 6):", parlayMarket);
    }

    /// Template 7: the MON mark price source, threshold at today's value, so it is close to a coin flip.
    function _snapshotParams() internal view returns (SnapshotParams memory) {
        uint16 sourceId = _sourceByLabel(snap, "MON", "mark");
        return SnapshotParams({
            sourceId: sourceId,
            threshold: snap.currentValue(sourceId),
            comparator: 1,
            lockTime: uint64(block.timestamp + 30 minutes),
            closeTime: uint64(block.timestamp + 2 hours),
            snapshotWindow: 600
        });
    }

    /// Template 3: BTC reaches 1% above the latest round, rounded up to 100 USD, within three days.
    function _touchParams() internal view returns (ChainlinkTouchParams memory) {
        (, int256 answer,,,) = IChainlinkLatestDemo(btcFeed).latestRoundData();
        uint8 dec = IChainlinkLatestDemo(btcFeed).decimals();
        int256 priceE8 = dec >= 8 ? answer / int256(10 ** (dec - 8)) : answer * int256(10 ** (8 - dec));
        uint64 lock = uint64(block.timestamp + 30 minutes);
        return ChainlinkTouchParams({
            feed: btcFeed,
            strikeE8: ((priceE8 * 101 / 100) / 100e8 + 1) * 100e8,
            direction: 0,
            lockTime: lock,
            startTime: lock,
            endTime: uint64(block.timestamp + 3 days)
        });
    }

    /// Template 6: the touch market and PARLAY_LEG, when given.
    function _parlay(address touchMarket) internal returns (address) {
        address leg = vm.envOr("PARLAY_LEG", address(0));
        if (leg == address(0)) return address(0);
        address[] memory legs = new address[](2);
        (legs[0], legs[1]) = touchMarket < leg ? (touchMarket, leg) : (leg, touchMarket);
        ParlayParams memory p = ParlayParams({
            legs: legs, lockTime: uint64(block.timestamp + 25 minutes), closeTime: uint64(block.timestamp + 8 days)
        });
        return factory.createMarket(PARLAY, abi.encode(p), Side.No, FIRST_STAKE);
    }

    /// The source whose label names `asset` and `kind` (for example "MON" and "mark").
    function _sourceByLabel(SnapshotResolver snap, string memory asset, string memory kind)
        internal
        view
        returns (uint16)
    {
        uint256 n = snap.sourceCount();
        for (uint256 i; i < n; ++i) {
            // forge-lint: disable-next-line(unsafe-typecast)
            SnapshotSource memory src = snap.source(uint16(i));
            if (_contains(src.label, asset) && _contains(src.label, kind)) {
                // forge-lint: disable-next-line(unsafe-typecast)
                return uint16(i);
            }
        }
        revert("no such snapshot source");
    }

    function _contains(string memory hay, string memory needle) internal pure returns (bool) {
        bytes memory h = bytes(hay);
        bytes memory n = bytes(needle);
        if (n.length > h.length) return false;
        for (uint256 i; i + n.length <= h.length; ++i) {
            bool ok = true;
            for (uint256 j; j < n.length; ++j) {
                if (h[i + j] != n[j]) {
                    ok = false;
                    break;
                }
            }
            if (ok) return true;
        }
        return false;
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {HunchBookFactory} from "../../src/core/HunchBookFactory.sol";
import {Market} from "../../src/core/Market.sol";
import {TestUSDC} from "../../src/mocks/TestUSDC.sol";
import {IMarket} from "../../src/interfaces/IMarket.sol";
import {IResolver} from "../../src/interfaces/IResolver.sol";
import {GraduationRule, MarketCaps, Outcome, Side, Window} from "../../src/interfaces/IHunchBookTypes.sol";
import {Snapshot, SnapshotParams, SnapshotSource} from "../../src/interfaces/ITemplatesV3.sol";
import {IPerplExchange} from "../../src/interfaces/external/IPerplExchange.sol";
import {SnapshotResolver} from "../../src/resolvers/SnapshotResolver.sol";
import {DeploySnapshotTemplate} from "../../script/DeploySnapshotTemplate.s.sol";

/// Template 7 against Perpl's live Exchange, with the exact sources the deploy script builds: every
/// source reads what Perpl's typed getter returns, the threshold edges hold on real values, and a local
/// Hunch Book replays a market over real blocks (created twenty minutes before the snapshot, settled at
/// the block the snapshot is taken, and settled again from the stored value at the head).
/// Run with: FOUNDRY_PROFILE=fork forge test --match-path test/fork/SnapshotResolver.fork.t.sol
contract SnapshotResolverForkTest is Test {
    uint32 internal constant WINDOW = 10 minutes;

    string internal json;
    IPerplExchange internal exchange;
    SnapshotResolver internal resolver;
    string[] internal assets;
    uint256[] internal perpIds;

    function _fork(string memory network, string memory rpcVar, string memory fallbackRpc) internal {
        json = vm.readFile(string.concat(vm.projectRoot(), "/../deployments/", network, ".json"));
        vm.createSelectFork(vm.envOr(rpcVar, fallbackRpc));
        exchange = IPerplExchange(vm.parseJsonAddress(json, ".external.perpl.exchange"));
        string[4] memory order = ["BTC", "ETH", "SOL", "MON"];
        for (uint256 i = 0; i < order.length; ++i) {
            assets.push(order[i]);
            perpIds.push(vm.parseJsonUint(json, string.concat(".external.perpl.perps.", order[i])));
        }
    }

    function _forkMainnet() internal {
        _fork("monad-mainnet", "MONAD_MAINNET_RPC", "https://rpc.monad.xyz");
    }

    function _forkTestnet() internal {
        _fork("monad-testnet", "MONAD_TESTNET_RPC", "https://testnet-rpc.monad.xyz");
    }

    /// The deploy script's sources for the forked network, and a resolver built from them.
    function _deployResolver() internal returns (SnapshotResolver r) {
        DeploySnapshotTemplate script = new DeploySnapshotTemplate();
        SnapshotSource[] memory sources = script.perplSources(json);
        r = new SnapshotResolver(sources);
    }

    function _params(uint16 sourceId, int256 threshold, uint8 comparator, uint64 lock, uint64 close)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encode(
            SnapshotParams({
                sourceId: sourceId,
                threshold: threshold,
                comparator: comparator,
                lockTime: lock,
                closeTime: close,
                snapshotWindow: WINDOW
            })
        );
    }

    // ------------------------------------------------------------ live reads

    /// Every source the deploy script builds reads exactly what Perpl's typed getter returns. Open
    /// interest is the same on both sides (the reason one side is read), the mark is fresh, and the
    /// units match the perp's decimals.
    function _checkLiveSources() internal {
        resolver = _deployResolver();
        assertEq(resolver.sourceCount(), 2 * assets.length);
        for (uint256 i = 0; i < assets.length; ++i) {
            IPerplExchange.PerpetualInfoV2 memory info = exchange.getPerpetualInfoV2(perpIds[i]);
            // forge-lint: disable-next-line(unsafe-typecast)
            uint16 oi = uint16(2 * i);
            uint16 mark = oi + 1;

            assertEq(info.longOpenInterestLNS, info.shortOpenInterestLNS, "long and short open interest differ");
            assertEq(resolver.currentValue(oi), int256(info.longOpenInterestLNS), "open interest");
            assertEq(resolver.currentValue(mark), int256(info.markPNS), "mark price");
            assertLe(block.timestamp - info.markTimestamp, 120, "mark older than the max age");
            assertGt(info.markPNS, 0);

            SnapshotSource memory s = resolver.source(oi);
            assertEq(s.decimals, info.lotDecimals);
            assertEq(s.unit, assets[i]);
            assertEq(resolver.source(mark).decimals, info.priceDecimals);

            console2.log(assets[i], "perp", perpIds[i]);
            console2.log("  open interest (lots)", info.longOpenInterestLNS, "lot decimals", info.lotDecimals);
            console2.log("  mark", info.markPNS, "price decimals", info.priceDecimals);
            console2.log("  mark age (s)", block.timestamp - info.markTimestamp);
        }
        uint64 lock = uint64(block.timestamp + 1 hours);
        uint64 close = uint64(block.timestamp + 1 days);
        console2.log(resolver.describe(_params(0, 10e5, 0, lock, close)));
        console2.log(resolver.describe(_params(1, 900_000, 1, lock, close)));
        Window memory w = resolver.validate(_params(0, 10e5, 0, lock, close));
        assertEq(w.settleDeadline, uint256(close) + WINDOW + 7 days);
    }

    function test_mainnet_sourcesReadPerplsLiveValues() public {
        _forkMainnet();
        _checkLiveSources();
    }

    function test_testnet_sourcesReadPerplsLiveValues() public {
        _forkTestnet();
        _checkLiveSources();
    }

    /// On real values, for every perp: a threshold equal to the value is YES for "at or above" and "at
    /// or below" and NO for "above" and "below"; one unit either side flips exactly the rules it should.
    function test_mainnet_equalEdgesOnRealValues() public {
        _forkMainnet();
        resolver = _deployResolver();
        uint64 lock = uint64(vm.getBlockTimestamp() + 1);
        uint64 close = uint64(vm.getBlockTimestamp() + 2);
        int256[] memory values = new int256[](resolver.sourceCount());
        for (uint16 id = 0; id < values.length; ++id) {
            values[id] = resolver.currentValue(id);
        }
        vm.warp(close);
        for (uint16 id = 0; id < values.length; ++id) {
            int256 v = values[id];
            _expect(id, v, 0, lock, close, Outcome.No);
            _expect(id, v, 1, lock, close, Outcome.Yes);
            _expect(id, v, 2, lock, close, Outcome.No);
            _expect(id, v, 3, lock, close, Outcome.Yes);
            _expect(id, v - 1, 0, lock, close, Outcome.Yes);
            _expect(id, v + 1, 1, lock, close, Outcome.No);
            _expect(id, v + 1, 2, lock, close, Outcome.Yes);
            _expect(id, v - 1, 3, lock, close, Outcome.No);
            Snapshot memory s = resolver.snapshotOf(resolver.snapshotKey(id, close, WINDOW));
            assertEq(s.value, v, "the snapshot is the live value");
            assertEq(s.blockNumber, block.number);
        }
    }

    function _expect(uint16 id, int256 threshold, uint8 comparator, uint64 lock, uint64 close, Outcome want) internal {
        (Outcome o,) = resolver.resolve(_params(id, threshold, comparator, lock, close), "");
        assertEq(uint8(o), uint8(want));
    }

    // ------------------------------------------------------------ replay over real blocks

    /// About thirty minutes of blocks at Monad's measured 0.3 seconds per block.
    uint256 internal constant BLOCKS_BACK = 6000;
    /// The snapshot block, counted from the start of the replay: about eight minutes later.
    uint256 internal constant SNAPSHOT_AFTER = 1500;

    TestUSDC internal usdc;
    HunchBookFactory internal factory;
    address internal creator = makeAddr("creator");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    function _deployHunchBook() internal {
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
        resolver = _deployResolver();
        factory.addTemplate(
            7,
            IResolver(address(resolver)),
            GraduationRule({minPool: 500e6, minStakers: 10, minChanceBps: 300, maxChanceBps: 9700})
        );
        address[] memory keep = new address[](5);
        (keep[0], keep[1], keep[2], keep[3], keep[4]) =
        (address(usdc), address(impl), address(factory), factory.vault(), address(resolver));
        vm.makePersistent(keep);
        address vault = factory.vault();
        address[3] memory people = [creator, alice, bob];
        for (uint256 i = 0; i < people.length; ++i) {
            usdc.mint(people[i], 1000e6);
            vm.prank(people[i]);
            usdc.approve(vault, type(uint256).max);
        }
    }

    function _create(bytes memory params) internal returns (Market m) {
        vm.prank(creator);
        m = Market(payable(factory.createMarket(7, params, Side.Yes, 5e6)));
        (address yes, address no) = m.tokens();
        vm.makePersistent(address(m), yes, no);
    }

    struct Replay {
        uint256 head;
        uint256 start;
        uint256 snapshotBlock;
        uint64 close;
        Market oiAbove; // BTC open interest above 1 lot: YES on any real day
        Market oiBelowHalf; // BTC open interest below half of what it was at the start
        Market markAtOrAbove; // BTC mark at or above its value at the start minus 10%
        Market lateLadder; // BTC open interest at or above 1 lot, settled at the head
        Market missed; // a second window nobody snapshots
    }

    /// A local Hunch Book on a mainnet fork about thirty minutes behind the head. Markets are created
    /// there; the fork rolls to a real block inside the snapshot window, where `settle` takes the
    /// snapshot from Perpl's real state at that block; then to the head, where a market on the same
    /// observation settles from the stored value, and one whose window nobody used cannot settle.
    function test_mainnet_replayOverRealBlocks() public {
        _forkMainnet();
        _replay();
    }

    /// The same replay on testnet (BTC is perp 16 there).
    function test_testnet_replayOverRealBlocks() public {
        _forkTestnet();
        _replay();
    }

    function _replay() internal {
        Replay memory r;
        r.head = vm.getBlockNumber();
        r.start = r.head - BLOCKS_BACK;
        r.snapshotBlock = r.start + SNAPSHOT_AFTER;
        vm.rollFork(r.snapshotBlock);
        r.close = uint64(vm.getBlockTimestamp());
        vm.rollFork(r.start);
        console2.log("replay from block", r.start, "time", vm.getBlockTimestamp());
        console2.log("snapshot block", r.snapshotBlock, "close time", r.close);
        assertLt(vm.getBlockTimestamp() + 60, r.close, "the replay needs a minute before the lock");
        _deployHunchBook();

        IPerplExchange.PerpetualInfoV2 memory atStart = exchange.getPerpetualInfoV2(perpIds[0]);
        uint64 lock = r.close - 60;
        r.oiAbove = _create(_params(0, 1, 0, lock, r.close));
        // forge-lint: disable-next-line(unsafe-typecast)
        r.oiBelowHalf = _create(_params(0, int256(atStart.longOpenInterestLNS / 2), 2, lock, r.close));
        // forge-lint: disable-next-line(unsafe-typecast)
        r.markAtOrAbove = _create(_params(1, int256(atStart.markPNS * 9 / 10), 1, lock, r.close));
        r.lateLadder = _create(_params(0, 1, 1, lock - 1, r.close));
        // Same source and close, another window length: another observation.
        r.missed = _create(
            abi.encode(
                SnapshotParams({
                    sourceId: 0, threshold: 1, comparator: 0, lockTime: lock, closeTime: r.close, snapshotWindow: 60
                })
            )
        );
        console2.log(r.oiBelowHalf.resolver().describe(r.oiBelowHalf.params()));
        vm.prank(alice);
        r.oiAbove.stake(Side.Yes, 100e6);
        vm.prank(bob);
        r.oiAbove.stake(Side.No, 50e6);

        // The snapshot block: Perpl's real state there decides every market on this observation.
        vm.rollFork(r.snapshotBlock);
        assertEq(factory.marketCount(), 5, "local contracts kept across the roll");
        IPerplExchange.PerpetualInfoV2 memory atClose = exchange.getPerpetualInfoV2(perpIds[0]);
        r.oiAbove.settle("");
        r.oiBelowHalf.settle("");
        r.markAtOrAbove.settle("");
        Snapshot memory oi = resolver.snapshotOf(resolver.snapshotKey(0, r.close, WINDOW));
        Snapshot memory mark = resolver.snapshotOf(resolver.snapshotKey(1, r.close, WINDOW));
        assertEq(oi.value, int256(atClose.longOpenInterestLNS));
        assertEq(oi.blockNumber, r.snapshotBlock);
        assertEq(oi.timestamp, r.close);
        assertEq(mark.value, int256(atClose.markPNS));
        console2.log(
            "open interest at start", atStart.longOpenInterestLNS, "at the snapshot", atClose.longOpenInterestLNS
        );
        console2.log("mark at start", atStart.markPNS, "at the snapshot", atClose.markPNS);
        assertEq(uint8(r.oiAbove.outcome()), uint8(Outcome.Yes));
        assertEq(
            uint8(r.oiBelowHalf.outcome()),
            uint8(atClose.longOpenInterestLNS < atStart.longOpenInterestLNS / 2 ? Outcome.Yes : Outcome.No)
        );
        assertEq(
            uint8(r.markAtOrAbove.outcome()),
            uint8(atClose.markPNS >= atStart.markPNS * 9 / 10 ? Outcome.Yes : Outcome.No)
        );
        console2.log("evidence");
        console2.logBytes32(r.oiAbove.evidenceHash());

        // The head, twenty minutes later: Perpl's state has moved on, the snapshot has not.
        vm.rollFork(r.head);
        assertGt(block.timestamp, uint256(r.close) + WINDOW);
        console2.log("open interest at the head", exchange.getPerpetualInfoV2(perpIds[0]).longOpenInterestLNS);
        r.lateLadder.settle("");
        assertEq(uint8(r.lateLadder.outcome()), uint8(Outcome.Yes));
        assertEq(r.lateLadder.evidenceHash(), r.oiAbove.evidenceHash());
        vm.expectRevert(IMarket.NotResolved.selector);
        r.missed.settle("");

        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice);
        r.oiAbove.claimPool();
        assertGt(usdc.balanceOf(alice), before + 100e6);
    }
}

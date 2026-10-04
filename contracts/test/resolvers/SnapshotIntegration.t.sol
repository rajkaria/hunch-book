// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {BaseTest} from "../core/Base.t.sol";
import {Market} from "../../src/core/Market.sol";
import {ICollateralVault} from "../../src/interfaces/ICollateralVault.sol";
import {IHunchBookFactory} from "../../src/interfaces/IHunchBookFactory.sol";
import {IMarket} from "../../src/interfaces/IMarket.sol";
import {IResolver} from "../../src/interfaces/IResolver.sol";
import {Outcome, Phase, Side, Window} from "../../src/interfaces/IHunchBookTypes.sol";
import {ParlayParams} from "../../src/interfaces/ITemplatesV2.sol";
import {Snapshot, SnapshotParams, SnapshotSource} from "../../src/interfaces/ITemplatesV3.sol";
import {IPerplExchange} from "../../src/interfaces/external/IPerplExchange.sol";
import {MarketOutcomeResolver} from "../../src/resolvers/MarketOutcomeResolver.sol";
import {SnapshotResolver} from "../../src/resolvers/SnapshotResolver.sol";
import {PerplSnapshotSources} from "../../script/DeploySnapshotTemplate.s.sol";
import {MockSnapshotSource} from "./SnapshotMocks.sol";

/// Template 7 registered on a real HunchBookFactory with `addTemplate`, driven end to end through real
/// markets: create, stake, graduate, settle (which takes the snapshot), then redeem or claim; and the
/// paths where nobody snapshots, where the source refuses, and where a parlay has snapshot legs. The
/// source is a mock with Perpl's exact return layout; the fork suite covers the real Perpl.
contract SnapshotIntegrationTest is BaseTest {
    uint32 internal constant SNAPSHOT = 7;
    uint32 internal constant PARLAY = 6;
    uint256 internal constant PERP = 1;
    uint16 internal constant OI = 0;
    uint16 internal constant MARK = 1;
    uint32 internal constant WINDOW = 10 minutes;

    MockSnapshotSource internal perpl;
    SnapshotResolver internal snap;
    MarketOutcomeResolver internal parlay;

    uint64 internal lock;
    uint64 internal close;

    function setUp() public override {
        super.setUp();
        perpl = new MockSnapshotSource();
        perpl.listPerp(PERP, "BTC", 1, 5);
        perpl.setOpenInterest(PERP, 954_501); // 9.54501 BTC
        perpl.setMark(PERP, 849_859, block.timestamp); // $84,985.9

        SnapshotSource[] memory sources = new SnapshotSource[](2);
        sources[OI] = PerplSnapshotSources.openInterest(IPerplExchange(address(perpl)), PERP, "BTC");
        sources[MARK] = PerplSnapshotSources.markPrice(IPerplExchange(address(perpl)), PERP, "BTC");
        snap = new SnapshotResolver(sources);
        parlay = new MarketOutcomeResolver(IHunchBookFactory(address(factory)), 200);

        vm.startPrank(guardian);
        factory.addTemplate(SNAPSHOT, IResolver(address(snap)), _rule());
        factory.addTemplate(PARLAY, IResolver(address(parlay)), _rule());
        vm.stopPrank();

        lock = uint64(block.timestamp + 1 days);
        close = uint64(block.timestamp + 2 days);
    }

    // ------------------------------------------------------------ helpers

    function _params(uint16 sourceId, int256 threshold, uint8 comparator) internal view returns (bytes memory) {
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

    function _createWith(uint32 templateId, bytes memory params) internal returns (Market m) {
        vm.prank(creator);
        m = Market(payable(factory.createMarket(templateId, params, Side.Yes, CREATOR_MIN)));
    }

    function _fee(Market m, uint256 tokens, Side winner) internal view returns (uint256) {
        (uint256 y, uint256 n,) = m.poolTotals();
        uint256 losing = winner == Side.Yes ? n : y;
        return (tokens * 200 * losing + 10_000 * (y + n) - 1) / (10_000 * (y + n));
    }

    function _evidenceHash(uint16 sourceId, Snapshot memory s) internal view returns (bytes32) {
        SnapshotSource memory src = snap.source(sourceId);
        return keccak256(abi.encode(src.target, src.callData, src.valueWord, s.value, s.blockNumber, s.timestamp));
    }

    // ------------------------------------------------------------ the golden path

    /// A graduated market settles at the first block after close: `settle` takes the snapshot and
    /// answers in the same transaction. YES redeems for 1 minus the fee; NO is worthless.
    function test_graduatedMarketSettlesInOneTransactionAtClose() public {
        Market m = _createWith(SNAPSHOT, _params(OI, 9e5, snap.ABOVE())); // above 9 BTC
        Window memory w = m.window();
        assertFalse(w.blockClock);
        assertEq(w.lock, lock);
        assertEq(w.close, close);
        assertEq(w.settleDeadline, uint256(close) + WINDOW + 7 days);
        assertFalse(m.resolver().earlyYes());
        _fillToRule(m);
        m.graduate();

        // Before close: nothing to settle, and no early YES.
        vm.warp(close - 1);
        vm.expectRevert(IMarket.NotClosed.selector);
        m.settle("");
        vm.expectRevert(IMarket.NotEarlyYes.selector);
        m.proveYes("");

        vm.warp(close);
        vm.roll(block.number + 100);
        address keeper = makeAddr("keeper");
        vm.prank(keeper);
        m.settle("");
        assertEq(uint8(m.phase()), uint8(Phase.Settled));
        assertEq(uint8(m.outcome()), uint8(Outcome.Yes));
        (bytes32 key, Snapshot memory s) = snap.snapshotFor(m.params());
        assertEq(key, snap.snapshotKey(OI, close, WINDOW));
        assertEq(s.value, 954_501);
        assertEq(s.timestamp, close);
        assertEq(m.evidenceHash(), _evidenceHash(OI, s));

        (uint256 tokens, uint256 paid) = _redeem(m, users[0], Side.Yes);
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

    function _redeem(Market m, address user, Side side) internal returns (uint256 tokens, uint256 paid) {
        vm.startPrank(user);
        m.claimTokens();
        tokens = side == Side.Yes ? _yes(m).balanceOf(user) : _no(m).balanceOf(user);
        paid = vault.redeem(address(m), side, tokens, user);
        vm.stopPrank();
    }

    /// A ladder of strikes on one observation settles from one snapshot: the answers can never
    /// disagree, even if the source moves between the settlements.
    function test_ladderSettlesFromOneSnapshot() public {
        Market low = _createWith(SNAPSHOT, _params(MARK, 840_000, 1)); // at or above $84,000
        Market mid = _createWith(SNAPSHOT, _params(MARK, 849_859, 1)); // at or above exactly the value
        Market high = _createWith(SNAPSHOT, _params(MARK, 850_000, 1)); // at or above $85,000
        Market below = _createWith(SNAPSHOT, _params(MARK, 849_859, 2)); // below exactly the value
        _stake(mid, users[0], Side.Yes, 50e6);
        _stake(mid, users[1], Side.No, 50e6);

        vm.warp(close + 30);
        perpl.setMark(PERP, 849_859, close + 25);
        mid.settle("");
        // The mark jumps; later settlements still read the snapshot.
        vm.warp(close + 5 minutes);
        perpl.setMark(PERP, 900_000, close + 5 minutes);
        low.settle("");
        high.settle("");
        below.settle("");
        assertEq(uint8(low.outcome()), uint8(Outcome.Yes));
        assertEq(uint8(mid.outcome()), uint8(Outcome.Yes)); // equal counts for "at or above"
        assertEq(uint8(high.outcome()), uint8(Outcome.No));
        assertEq(uint8(below.outcome()), uint8(Outcome.No)); // equal is not "below"
        assertEq(low.evidenceHash(), high.evidenceHash());
        assertEq(mid.evidenceHash(), below.evidenceHash());
        assertEq(low.evidenceHash(), mid.evidenceHash());

        vm.prank(users[0]);
        mid.claimPool();
        _assertSolvent();
    }

    // ------------------------------------------------------------ the other paths

    /// Anyone can take the snapshot inside the window; a settlement days later answers from it, even
    /// with the source broken by then.
    function test_snapshotByAnyoneThenLateSettlement() public {
        Market m = _createWith(SNAPSHOT, _params(OI, 1e6, snap.BELOW())); // below 10 BTC
        _stake(m, users[0], Side.Yes, 30e6);
        _stake(m, users[1], Side.No, 70e6);
        vm.warp(close + 2 minutes);
        vm.prank(makeAddr("anyone"));
        snap.snapshot(OI, close, WINDOW);

        vm.warp(close + 5 days);
        perpl.setReverts(true);
        perpl.setVersion(9, 0, 0);
        m.settle("");
        assertEq(uint8(m.outcome()), uint8(Outcome.Yes));
        uint256 before = usdc.balanceOf(users[0]);
        vm.prank(users[0]);
        m.claimPool();
        assertGt(usdc.balanceOf(users[0]), before + 30e6);
        _assertSolvent();
    }

    /// Inside the window a refused read settles nothing; a retry later in the window does.
    function test_refusedReadInsideTheWindowThenRetry() public {
        Market m = _createWith(SNAPSHOT, _params(OI, 9e5, 0));
        vm.warp(close);
        perpl.setStatus(PERP, 0); // paused: a pinned word changed
        vm.expectRevert(IMarket.NotResolved.selector);
        m.settle("");
        (, Snapshot memory none) = snap.snapshotFor(m.params());
        assertEq(none.blockNumber, 0);
        perpl.setStatus(PERP, 4);
        vm.warp(close + 9 minutes);
        m.settle("");
        assertEq(uint8(m.outcome()), uint8(Outcome.Yes));
    }

    /// Nobody snapshots in the window: the market can never settle, and voids at its deadline. A pool
    /// refunds every stake.
    function test_noSnapshotVoidsAtTheDeadline() public {
        Market m = _createWith(SNAPSHOT, _params(OI, 9e5, 0));
        _stake(m, users[0], Side.Yes, 40e6);
        _stake(m, users[1], Side.No, 60e6);
        vm.warp(uint256(close) + WINDOW + 1);
        vm.expectRevert(IMarket.NotResolved.selector);
        m.settle("");
        vm.expectRevert(
            abi.encodeWithSelector(
                SnapshotResolver.OutsideSnapshotWindow.selector, close, uint256(close) + WINDOW, block.timestamp
            )
        );
        snap.snapshot(OI, close, WINDOW);

        Window memory w = m.window();
        vm.warp(w.settleDeadline);
        vm.expectRevert(IMarket.NotExpired.selector);
        m.voidIfExpired();
        vm.warp(uint256(w.settleDeadline) + 1);
        m.voidIfExpired();
        assertEq(uint8(m.phase()), uint8(Phase.Voided));
        uint256 before = usdc.balanceOf(users[1]);
        vm.prank(users[1]);
        m.claimPool();
        assertEq(usdc.balanceOf(users[1]), before + 60e6);
        _assertSolvent();
    }

    /// Creation goes through `validate`, which refuses a source that changed since deployment.
    function test_creationRefusesAChangedSource() public {
        perpl.setVersion(7, 6, 0);
        bytes memory params = _params(OI, 9e5, 0);
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(SnapshotResolver.SourceChanged.selector, OI));
        factory.createMarket(SNAPSHOT, params, Side.Yes, CREATOR_MIN);
        perpl.setVersion(7, 5, 0);
        _createWith(SNAPSHOT, params);
        // The same question cannot be created twice.
        vm.prank(creator);
        vm.expectRevert(IHunchBookFactory.MarketExists.selector);
        factory.createMarket(SNAPSHOT, params, Side.Yes, CREATOR_MIN);
    }

    /// Template 6 composes with template 7: a parlay of two snapshot markets settles from their
    /// outcomes.
    function test_parlayOfSnapshotLegs() public {
        Market a = _createWith(SNAPSHOT, _params(OI, 9e5, 0)); // open interest above 9 BTC
        Market b = _createWith(SNAPSHOT, _params(MARK, 800_000, 1)); // mark at or above $80,000
        address[] memory legs = new address[](2);
        (legs[0], legs[1]) = address(a) < address(b) ? (address(a), address(b)) : (address(b), address(a));
        Market p = _createWith(PARLAY, abi.encode(ParlayParams({legs: legs, lockTime: lock, closeTime: close})));
        _stake(p, users[0], Side.Yes, 40e6);
        _stake(p, users[1], Side.No, 60e6);

        vm.warp(close + 10);
        perpl.setMark(PERP, 849_859, close);
        a.settle("");
        b.settle("");
        p.settle("");
        assertEq(uint8(p.outcome()), uint8(Outcome.Yes));
        vm.prank(users[0]);
        p.claimPool();
        _assertSolvent();
    }
}

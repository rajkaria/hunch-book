// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {BaseTest} from "../core/Base.t.sol";
import {Market} from "../../src/core/Market.sol";
import {IHunchBookFactory} from "../../src/interfaces/IHunchBookFactory.sol";
import {IMarket} from "../../src/interfaces/IMarket.sol";
import {IResolver} from "../../src/interfaces/IResolver.sol";
import {GraduationRule, MarketCaps, Outcome, Side} from "../../src/interfaces/IHunchBookTypes.sol";
import {TemplateTimelock} from "../../src/periphery/TemplateTimelock.sol";
import {ITemplateTimelock} from "../../src/periphery/interfaces/ITemplateTimelock.sol";
import {MockResolver} from "../mocks/MockResolver.sol";

contract TemplateTimelockTest is BaseTest {
    uint256 internal constant DELAY = 2 days;

    TemplateTimelock internal lock;
    address internal proposer = makeAddr("proposer multisig");
    address internal anyone = makeAddr("anyone");
    MockResolver internal newResolver;

    function setUp() public override {
        super.setUp();
        lock = new TemplateTimelock(IHunchBookFactory(address(factory)), proposer, DELAY);
        newResolver = new MockResolver();
        // The current guardian hands the factory to the timelock.
        vm.prank(guardian);
        factory.transferGuardian(address(lock));
        lock.acceptGuardian();
    }

    // ---------------------------------------------------------------- helpers

    function _newRule() internal pure returns (GraduationRule memory) {
        return GraduationRule({minPool: 1000e6, minStakers: 20, minChanceBps: 500, maxChanceBps: 9500});
    }

    function _queueTemplate(uint32 id) internal returns (bytes32 opId, bytes memory data, uint256 opNonce) {
        opNonce = lock.operationCount();
        data = abi.encodeCall(IHunchBookFactory.addTemplate, (id, IResolver(address(newResolver)), _newRule()));
        vm.prank(proposer);
        opId = lock.queueAddTemplate(id, IResolver(address(newResolver)), _newRule());
    }

    // ---------------------------------------------------------------- construction and guardian

    function test_constructor() public {
        assertEq(lock.factory(), address(factory));
        assertEq(lock.proposer(), proposer);
        assertEq(lock.delay(), DELAY);
        assertEq(lock.MIN_DELAY(), 2 days);
        assertEq(lock.MAX_DELAY(), 30 days);
        assertEq(lock.GRACE_PERIOD(), 14 days);

        vm.expectRevert(ITemplateTimelock.ZeroAddress.selector);
        new TemplateTimelock(IHunchBookFactory(address(0)), proposer, DELAY);
        vm.expectRevert(ITemplateTimelock.ZeroAddress.selector);
        new TemplateTimelock(IHunchBookFactory(address(factory)), address(0), DELAY);
        vm.expectRevert(ITemplateTimelock.DelayOutOfRange.selector);
        new TemplateTimelock(IHunchBookFactory(address(factory)), proposer, 2 days - 1);
        vm.expectRevert(ITemplateTimelock.DelayOutOfRange.selector);
        new TemplateTimelock(IHunchBookFactory(address(factory)), proposer, 30 days + 1);
    }

    function test_becameGuardian() public view {
        assertEq(factory.guardian(), address(lock));
        assertEq(factory.pendingGuardian(), address(0));
    }

    function test_acceptGuardian_onlyWhenNamedPending() public {
        TemplateTimelock other = new TemplateTimelock(IHunchBookFactory(address(factory)), proposer, DELAY);
        vm.expectRevert(IHunchBookFactory.OnlyPendingGuardian.selector);
        other.acceptGuardian();
    }

    // ---------------------------------------------------------------- queue and execute

    function test_addTemplate_waitsTheDelayInPublic() public {
        uint32 id = 7;
        uint256 readyAt = block.timestamp + DELAY;
        bytes memory data =
            abi.encodeCall(IHunchBookFactory.addTemplate, (id, IResolver(address(newResolver)), _newRule()));
        bytes32 opId = lock.operationId(data, 0);

        vm.expectEmit(address(lock));
        emit ITemplateTimelock.OperationQueued(opId, 0, IHunchBookFactory.addTemplate.selector, data, readyAt);
        vm.prank(proposer);
        assertEq(lock.queueAddTemplate(id, IResolver(address(newResolver)), _newRule()), opId);
        assertEq(lock.readyAt(opId), readyAt);
        assertEq(lock.operationCount(), 1);

        vm.warp(readyAt - 1);
        vm.prank(anyone);
        vm.expectRevert(abi.encodeWithSelector(ITemplateTimelock.NotReady.selector, opId, readyAt));
        lock.execute(data, 0);

        vm.warp(readyAt);
        vm.expectEmit(address(lock));
        emit ITemplateTimelock.OperationExecuted(opId, 0, anyone);
        vm.prank(anyone);
        lock.execute(data, 0);
        assertEq(address(factory.resolverOf(id)), address(newResolver));
        assertEq(factory.templateOf(id).rule.minStakers, 20);
        assertEq(lock.readyAt(opId), 0);

        vm.expectRevert(abi.encodeWithSelector(ITemplateTimelock.UnknownOperation.selector, opId));
        lock.execute(data, 0);
    }

    function test_queueAddTemplate_checks() public {
        vm.expectRevert(ITemplateTimelock.OnlyProposer.selector);
        lock.queueAddTemplate(7, IResolver(address(newResolver)), _newRule());
        vm.startPrank(proposer);
        vm.expectRevert(ITemplateTimelock.NotAContract.selector);
        lock.queueAddTemplate(7, IResolver(address(0xBEEF)), _newRule());
        vm.expectRevert(ITemplateTimelock.TemplateExists.selector);
        lock.queueAddTemplate(TEMPLATE, IResolver(address(newResolver)), _newRule());
        vm.stopPrank();
    }

    function test_execute_bubblesFactoryReverts() public {
        // Two queued templates with the same id: the second fails on execution, as the factory decides.
        (, bytes memory d1, uint256 n1) = _queueTemplate(9);
        (, bytes memory d2, uint256 n2) = _queueTemplate(9);
        vm.warp(block.timestamp + DELAY);
        lock.execute(d1, n1);
        vm.expectRevert(IHunchBookFactory.TemplateExists.selector);
        lock.execute(d2, n2);
    }

    function test_execute_onlyQueuedCalldata() public {
        (, bytes memory data, uint256 n) = _queueTemplate(7);
        vm.warp(block.timestamp + DELAY);
        // Same call with a different argument, or a call that was never queued: unknown.
        bytes memory forged = abi.encodeCall(IHunchBookFactory.setCreationPaused, (true));
        bytes32 forgedId = lock.operationId(forged, n);
        vm.expectRevert(abi.encodeWithSelector(ITemplateTimelock.UnknownOperation.selector, forgedId));
        lock.execute(forged, n);
        bytes32 wrongNonce = lock.operationId(data, n + 1);
        vm.expectRevert(abi.encodeWithSelector(ITemplateTimelock.UnknownOperation.selector, wrongNonce));
        lock.execute(data, n + 1);
        lock.execute(data, n);
    }

    function test_execute_staleAfterGracePeriod() public {
        (bytes32 opId, bytes memory data, uint256 n) = _queueTemplate(7);
        uint256 readyAt = lock.readyAt(opId);
        vm.warp(readyAt + 14 days + 1);
        vm.expectRevert(abi.encodeWithSelector(ITemplateTimelock.OperationStale.selector, opId));
        lock.execute(data, n);
        vm.warp(readyAt + 14 days);
        lock.execute(data, n);
    }

    function test_cancel() public {
        (bytes32 opId, bytes memory data, uint256 n) = _queueTemplate(7);
        vm.expectRevert(ITemplateTimelock.OnlyProposer.selector);
        lock.cancel(opId);
        vm.expectEmit(address(lock));
        emit ITemplateTimelock.OperationCancelled(opId);
        vm.prank(proposer);
        lock.cancel(opId);
        vm.warp(block.timestamp + DELAY);
        vm.expectRevert(abi.encodeWithSelector(ITemplateTimelock.UnknownOperation.selector, opId));
        lock.execute(data, n);
        vm.prank(proposer);
        vm.expectRevert(abi.encodeWithSelector(ITemplateTimelock.UnknownOperation.selector, opId));
        lock.cancel(opId);
    }

    function test_capsAndCollateralCap() public {
        MarketCaps memory c = MarketCaps({poolCap: 10_000e6, walletCap: 2000e6, minStake: 2e6, creatorMinStake: 10e6});
        uint256 n0 = lock.operationCount();
        vm.startPrank(proposer);
        lock.queueSetCaps(c);
        lock.queueSetCollateralCap(100_000e6);
        vm.stopPrank();
        vm.warp(block.timestamp + DELAY);
        lock.execute(abi.encodeCall(IHunchBookFactory.setCaps, (c)), n0);
        lock.execute(abi.encodeCall(IHunchBookFactory.setCollateralCap, (100_000e6)), n0 + 1);
        assertEq(factory.caps().poolCap, 10_000e6);
        assertEq(vault.collateralCap(), 100_000e6);

        vm.startPrank(anyone);
        vm.expectRevert(ITemplateTimelock.OnlyProposer.selector);
        lock.queueSetCaps(c);
        vm.expectRevert(ITemplateTimelock.OnlyProposer.selector);
        lock.queueSetCollateralCap(1);
        vm.expectRevert(ITemplateTimelock.OnlyProposer.selector);
        lock.queueTransferGuardian(anyone);
        vm.stopPrank();
    }

    function test_transferGuardian_toANewGuardianAfterTheDelay() public {
        address next = makeAddr("next guardian");
        uint256 n = lock.operationCount();
        vm.prank(proposer);
        lock.queueTransferGuardian(next);
        vm.warp(block.timestamp + DELAY);
        lock.execute(abi.encodeCall(IHunchBookFactory.transferGuardian, (next)), n);
        assertEq(factory.pendingGuardian(), next);
        vm.prank(next);
        factory.acceptGuardian();
        assertEq(factory.guardian(), next);
    }

    // ---------------------------------------------------------------- pauses

    function test_pauses_takeEffectAtOnce() public {
        vm.expectRevert(ITemplateTimelock.OnlyProposer.selector);
        lock.setCreationPaused(true);
        vm.expectRevert(ITemplateTimelock.OnlyProposer.selector);
        lock.setGraduationPaused(true);

        vm.startPrank(proposer);
        vm.expectEmit(address(lock));
        emit ITemplateTimelock.CreationPauseSet(true);
        lock.setCreationPaused(true);
        vm.expectEmit(address(lock));
        emit ITemplateTimelock.GraduationPauseSet(true);
        lock.setGraduationPaused(true);
        vm.stopPrank();
        assertTrue(factory.creationPaused());
        assertTrue(factory.graduationPaused());

        vm.prank(proposer);
        lock.setCreationPaused(false);
        assertFalse(factory.creationPaused());
    }

    /// Pauses never reach settlement or redemption: a market created before the pause settles and pays.
    function test_pauses_cannotBlockSettlementOrRedemption() public {
        Market m = _graduated();
        address[] memory stakers = new address[](1);
        stakers[0] = users[0];
        m.claimTokensFor(stakers);
        vm.startPrank(proposer);
        lock.setCreationPaused(true);
        lock.setGraduationPaused(true);
        vm.stopPrank();

        _settle(m, Outcome.Yes);
        assertEq(uint8(IMarket(address(m)).outcome()), uint8(Outcome.Yes));
        uint256 bal = _yes(m).balanceOf(users[0]);
        vm.prank(users[0]);
        uint256 paid = vault.redeem(address(m), Side.Yes, bal, users[0]);
        assertGt(paid, 0);
        _assertSolvent();
    }

    // ---------------------------------------------------------------- fuzz

    function testFuzz_executeOnlyInsideTheWindow(uint256 delay, uint256 wait) public {
        delay = bound(delay, 2 days, 30 days);
        TemplateTimelock l = new TemplateTimelock(IHunchBookFactory(address(factory)), proposer, delay);
        vm.prank(address(lock));
        factory.transferGuardian(address(l));
        l.acceptGuardian();

        vm.prank(proposer);
        bytes32 opId = l.queueSetCollateralCap(77e6);
        bytes memory data = abi.encodeCall(IHunchBookFactory.setCollateralCap, (77e6));
        wait = bound(wait, 0, delay + 20 days);
        vm.warp(block.timestamp + wait);
        if (wait < delay) {
            vm.expectRevert(abi.encodeWithSelector(ITemplateTimelock.NotReady.selector, opId, l.readyAt(opId)));
            l.execute(data, 0);
        } else if (wait > delay + 14 days) {
            vm.expectRevert(abi.encodeWithSelector(ITemplateTimelock.OperationStale.selector, opId));
            l.execute(data, 0);
        } else {
            l.execute(data, 0);
            assertEq(vault.collateralCap(), 77e6);
        }
    }
}

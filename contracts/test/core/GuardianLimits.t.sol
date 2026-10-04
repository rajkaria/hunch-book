// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {BaseTest} from "./Base.t.sol";
import {Market} from "../../src/core/Market.sol";
import {OutcomeToken} from "../../src/core/OutcomeToken.sol";
import {Outcome, Phase, Side} from "../../src/interfaces/IHunchBookTypes.sol";

/// PROTOCOL.md §7.3: the guardian can pause market creation and graduation, and nothing else.
/// With both pauses on, every way out of a market still works: settle, claim tokens, merge,
/// redeem, claim pool payouts, void and void refunds.
contract GuardianLimitsTest is BaseTest {
    function _pauseEverythingTheGuardianCan() internal {
        vm.startPrank(guardian);
        factory.setCreationPaused(true);
        factory.setGraduationPaused(true);
        vm.stopPrank();
        assertTrue(factory.creationPaused());
        assertTrue(factory.graduationPaused());
    }

    function test_pausedGuardian_cannotBlockSettleClaimMergeOrRedeem() public {
        Market m = _graduated();
        _pauseEverythingTheGuardianCan();

        // Claim tokens and merge a set while paused.
        vm.prank(users[0]);
        m.claimTokens();
        vm.prank(users[6]);
        m.claimTokens();
        OutcomeToken no = _no(m);
        vm.prank(users[6]);
        no.transfer(users[0], 10e6);
        uint256 before = usdc.balanceOf(users[0]);
        vm.prank(users[0]);
        vault.mergeSets(address(m), 10e6, users[0]);
        assertEq(usdc.balanceOf(users[0]) - before, 10e6, "merge pays 1 USDC a set");

        // Settle and redeem while paused.
        _settle(m, Outcome.Yes);
        assertEq(uint8(m.phase()), uint8(Phase.Settled));
        uint256 yesBal = _yes(m).balanceOf(users[0]);
        vm.prank(users[0]);
        uint256 paid = vault.redeem(address(m), Side.Yes, yesBal, users[0]);
        assertGt(paid, 0, "winner redeems while paused");
        _assertSolvent();
    }

    function test_pausedGuardian_cannotBlockPoolClaimsOrVoidRefunds() public {
        // A pool that never graduates settles as a pool, and pays out while paused.
        Market settled = _createDefault();
        _stake(settled, users[0], Side.Yes, 50e6);
        _stake(settled, users[6], Side.No, 60e6);
        // A second pool nobody can settle voids after its deadline, and refunds while paused.
        Market voided = _createDefault();
        _stake(voided, users[1], Side.Yes, 40e6);

        _pauseEverythingTheGuardianCan();

        _settle(settled, Outcome.Yes);
        uint256 before = usdc.balanceOf(users[0]);
        vm.prank(users[0]);
        settled.claimPool();
        assertGt(usdc.balanceOf(users[0]) - before, 50e6, "pool winner paid while paused");

        vm.warp(voided.window().settleDeadline + 1);
        voided.voidIfExpired();
        assertEq(uint8(voided.phase()), uint8(Phase.Voided));
        before = usdc.balanceOf(users[1]);
        vm.prank(users[1]);
        voided.claimPool();
        assertEq(usdc.balanceOf(users[1]) - before, 40e6, "void refunds the full stake while paused");
        _assertSolvent();
    }

    function test_pausedGuardian_cannotBlockVoidRedemptionAfterGraduation() public {
        Market m = _graduated();
        _pauseEverythingTheGuardianCan();
        vm.prank(users[0]);
        m.claimTokens();

        vm.warp(m.window().settleDeadline + 1);
        m.voidIfExpired();
        uint256 bal = _yes(m).balanceOf(users[0]);
        vm.prank(users[0]);
        uint256 paid = vault.redeem(address(m), Side.Yes, bal, users[0]);
        assertEq(paid, bal / 2, "0.50 per token after a void, while paused");
        _assertSolvent();
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {BaseTest} from "./Base.t.sol";
import {Market} from "../../src/core/Market.sol";
import {ICollateralVault} from "../../src/interfaces/ICollateralVault.sol";
import {IMarket} from "../../src/interfaces/IMarket.sol";
import {Outcome, Phase, Side} from "../../src/interfaces/IHunchBookTypes.sol";

contract SettlementTest is BaseTest {
    // ---- timing ----

    function test_settle_revertsBeforeClose() public {
        Market m = _graduated();
        vm.warp(m.window().close - 1);
        resolver.setAnswer(Outcome.Yes);
        vm.expectRevert(IMarket.NotClosed.selector);
        m.settle("");
    }

    function test_settle_revertsWhenSourceHasNoAnswer() public {
        Market m = _graduated();
        _toClose(m);
        resolver.setAnswer(Outcome.Unresolved);
        vm.expectRevert(IMarket.NotResolved.selector);
        m.settle("");
    }

    function test_settle_onlyUpToDeadlineThenOnlyVoid() public {
        Market m = _graduated();
        vm.warp(m.window().settleDeadline);
        vm.expectRevert(IMarket.NotExpired.selector);
        m.voidIfExpired();
        resolver.setAnswer(Outcome.No);
        vm.warp(m.window().settleDeadline + 1);
        vm.expectRevert(IMarket.PastSettleDeadline.selector);
        m.settle("");
        m.voidIfExpired();
        assertEq(uint8(m.phase()), uint8(Phase.Voided));
    }

    function test_settle_isFinal() public {
        Market m = _graduated();
        _settle(m, Outcome.Yes);
        resolver.setAnswer(Outcome.No);
        vm.expectRevert(abi.encodeWithSelector(IMarket.WrongPhase.selector, Phase.Settled));
        m.settle("");
        vm.warp(m.window().settleDeadline + 1);
        vm.expectRevert(abi.encodeWithSelector(IMarket.WrongPhase.selector, Phase.Settled));
        m.voidIfExpired();
        assertEq(uint8(m.outcome()), uint8(Outcome.Yes));
    }

    function test_phases_followTheClock() public {
        Market m = _graduated();
        assertEq(uint8(m.phase()), uint8(Phase.Graduated));
        _toClose(m);
        assertEq(uint8(m.phase()), uint8(Phase.Closed));
        Market p = _createDefault();
        vm.warp(p.window().lock);
        assertEq(uint8(p.phase()), uint8(Phase.PoolLocked));
    }

    function test_settle_forwardsValueAndRefundsTheSettler() public {
        Market m = _graduated();
        _toClose(m);
        resolver.setAnswer(Outcome.Yes);
        resolver.setRefund(0.3 ether);
        address settler = makeAddr("settler");
        vm.deal(settler, 1 ether);
        vm.prank(settler);
        m.settle{value: 1 ether}("");
        assertEq(resolver.lastValue(), 1 ether);
        assertEq(settler.balance, 0.3 ether);
        assertEq(address(m).balance, 0);
    }

    function test_settle_recordsEvidenceAndSettler() public {
        Market m = _graduated();
        _toClose(m);
        resolver.setAnswer(Outcome.No);
        bytes32 expected = keccak256(abi.encode(m.params(), bytes("ev"), Outcome.No));
        vm.expectEmit(address(m));
        emit IMarket.Settled(Outcome.No, expected, address(this));
        m.settle("ev");
        assertEq(m.evidenceHash(), expected);
    }

    // ---- graduated payouts ----

    function test_graduated_winnersRedeemOneMinusFee() public {
        Market m = _graduated();
        (uint256 y, uint256 n,) = m.poolTotals();
        uint256 t = y + n;
        _settle(m, Outcome.Yes);

        ICollateralVault.Ledger memory l = vault.ledger(address(m));
        assertEq(uint8(l.status), uint8(ICollateralVault.Status.Settled));
        assertEq(l.feeNumerator, 200 * n);
        assertEq(l.feeDenominator, 10_000 * t);
        assertEq(m.feePerToken(Side.Yes), 200 * n * 1e6 / (10_000 * t));

        vm.startPrank(users[0]);
        m.claimTokens();
        uint256 tokens = _yes(m).balanceOf(users[0]);
        uint256 before = usdc.balanceOf(users[0]);
        uint256 paid = vault.redeem(address(m), Side.Yes, tokens, users[0]);
        vm.stopPrank();

        uint256 fee = (tokens * 200 * n + 10_000 * t - 1) / (10_000 * t);
        assertEq(paid, tokens - fee);
        assertEq(usdc.balanceOf(users[0]), before + paid);
        assertEq(vault.protocolFees() + vault.creatorFees(creator), fee);
        assertEq(vault.creatorFees(creator), fee * 2500 / 10_000);
        _assertSolvent();
    }

    function test_graduated_losingSideCannotRedeem() public {
        Market m = _graduated();
        _settle(m, Outcome.Yes);
        vm.startPrank(users[6]);
        m.claimTokens();
        uint256 tokens = _no(m).balanceOf(users[6]);
        vm.expectRevert(ICollateralVault.LosingSide.selector);
        vault.redeem(address(m), Side.No, tokens, users[6]);
        vm.stopPrank();
    }

    function test_graduated_payoffIdenticalToPool() public {
        Market m = _graduated();
        (uint256 y, uint256 n,) = m.poolTotals();
        _settle(m, Outcome.No);
        for (uint256 i = 6; i < 10; ++i) {
            vm.startPrank(users[i]);
            m.claimTokens();
            uint256 paid = vault.redeem(address(m), Side.No, _no(m).balanceOf(users[i]), users[i]);
            vm.stopPrank();
            uint256 s = 60e6;
            uint256 gross = s * y / n;
            uint256 poolPaid = s + gross - (gross * 200 + 9999) / 10_000;
            assertApproxEqAbs(paid, poolPaid, 2, "graduation changed the payoff");
        }
        _assertSolvent();
    }

    function test_graduated_noMergeAfterSettlement() public {
        Market m = _graduated();
        vm.startPrank(users[0]);
        vault.mintSets(address(m), 10e6, users[0]);
        vm.stopPrank();
        _settle(m, Outcome.No);
        vm.prank(users[0]);
        vm.expectRevert(ICollateralVault.NotMergeable.selector);
        vault.mergeSets(address(m), 10e6, users[0]);
    }

    function test_graduated_mergeAllowedWhenClosed() public {
        Market m = _graduated();
        vm.prank(users[0]);
        vault.mintSets(address(m), 10e6, users[0]);
        _toClose(m);
        vm.prank(users[0]);
        vm.expectRevert(ICollateralVault.NotTradable.selector);
        vault.mintSets(address(m), 1e6, users[0]);
        uint256 before = usdc.balanceOf(users[0]);
        vm.prank(users[0]);
        vault.mergeSets(address(m), 10e6, users[0]);
        assertEq(usdc.balanceOf(users[0]), before + 10e6);
        _assertSetsMatchSupply(m);
    }

    function test_graduated_voidPaysHalfPerTokenAndAllowsMerge() public {
        Market m = _graduated();
        vm.prank(users[11]);
        vault.mintSets(address(m), 10e6, users[11]);
        vm.warp(m.window().settleDeadline + 1);
        m.voidIfExpired();
        assertEq(uint8(vault.ledger(address(m)).status), uint8(ICollateralVault.Status.Voided));

        vm.startPrank(users[0]);
        m.claimTokens();
        uint256 tokens = _yes(m).balanceOf(users[0]);
        uint256 paid = vault.redeem(address(m), Side.Yes, tokens, users[0]);
        vm.stopPrank();
        assertEq(paid, tokens / 2);

        uint256 before = usdc.balanceOf(users[11]);
        vm.prank(users[11]);
        vault.mergeSets(address(m), 10e6, users[11]);
        assertEq(usdc.balanceOf(users[11]), before + 10e6);

        // Everyone redeems everything: the vault can pay all of it.
        address[] memory all = new address[](11);
        all[0] = creator;
        for (uint256 i; i < 10; ++i) {
            all[i + 1] = users[i];
        }
        m.claimTokensFor(all);
        for (uint256 i; i < all.length; ++i) {
            vm.startPrank(all[i]);
            uint256 yb = _yes(m).balanceOf(all[i]);
            uint256 nb = _no(m).balanceOf(all[i]);
            if (yb != 0) vault.redeem(address(m), Side.Yes, yb, all[i]);
            if (nb != 0) vault.redeem(address(m), Side.No, nb, all[i]);
            vm.stopPrank();
        }
        _assertSolvent();
    }

    // ---- pool-only payouts ----

    function test_pool_winnersPaidStakePlusShareMinusFee() public {
        Market m = _createDefault(); // creator 5 YES
        _stake(m, users[0], Side.Yes, 95e6);
        _stake(m, users[1], Side.No, 150e6);
        _stake(m, users[2], Side.No, 50e6);
        vm.warp(m.window().lock);
        _settle(m, Outcome.Yes);
        assertEq(uint8(m.phase()), uint8(Phase.Settled));

        // Y = 100, N = 200. users[0]: gross 190, fee 3.8, paid 281.2.
        (uint256 paid, uint256 fee) = m.claimablePool(users[0]);
        assertEq(paid, 281_200_000);
        assertEq(fee, 3_800_000);
        uint256 before = usdc.balanceOf(users[0]);
        vm.prank(users[0]);
        m.claimPool();
        assertEq(usdc.balanceOf(users[0]), before + paid);

        // Loser has nothing.
        vm.prank(users[1]);
        vm.expectRevert(IMarket.NothingToClaim.selector);
        m.claimPool();

        // Last winner (creator): gross 10, fee 0.2. Pool fully distributed, dust to fees.
        vm.prank(creator);
        m.claimPool();
        assertEq(vault.ledger(address(m)).pool, 0);
        assertEq(vault.protocolFees() + vault.creatorFees(creator), 4e6);
        _assertSolvent();

        vm.prank(users[0]);
        vm.expectRevert(IMarket.NothingToClaim.selector);
        m.claimPool();
    }

    function test_pool_dustGoesToFeesAfterLastWinner() public {
        Market m = _create(_timeWindow(), Side.Yes, 7e6);
        _stake(m, users[0], Side.Yes, 3e6);
        _stake(m, users[1], Side.No, 1e6 + 1);
        _settle(m, Outcome.Yes);
        address[] memory list = new address[](3);
        list[0] = creator;
        list[1] = users[0];
        list[2] = users[1];
        m.claimPoolFor(list);
        assertEq(vault.ledger(address(m)).pool, 0, "pool fully accounted");
        _assertSolvent();
        assertEq(usdc.balanceOf(address(vault)), vault.totalObligations());
    }

    function test_pool_oneSidedRefundsInFull() public {
        Market m = _createDefault();
        _stake(m, users[0], Side.Yes, 40e6);
        _settle(m, Outcome.No);
        uint256 before = usdc.balanceOf(users[0]);
        vm.prank(users[0]);
        m.claimPool();
        assertEq(usdc.balanceOf(users[0]), before + 40e6);
        (uint256 paid, uint256 fee) = m.claimablePool(creator);
        assertEq(paid, CREATOR_MIN);
        assertEq(fee, 0);
    }

    function test_pool_voidRefundsEveryone() public {
        Market m = _createDefault();
        _stake(m, users[0], Side.Yes, 40e6);
        _stake(m, users[1], Side.No, 25e6);
        _stake(m, users[1], Side.Yes, 5e6);
        vm.warp(m.window().settleDeadline + 1);
        m.voidIfExpired();
        uint256 before = usdc.balanceOf(users[1]);
        vm.prank(users[1]);
        m.claimPool();
        assertEq(usdc.balanceOf(users[1]), before + 30e6);
        vm.prank(users[0]);
        m.claimPool();
        vm.prank(creator);
        m.claimPool();
        assertEq(vault.ledger(address(m)).pool, 0);
        assertEq(vault.protocolFees(), 0);
        _assertSolvent();
    }

    function test_pool_claimRevertsBeforeSettlementAndOnGraduatedMarkets() public {
        Market m = _createDefault();
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(IMarket.WrongPhase.selector, Phase.Pool));
        m.claimPool();
        Market g = _graduated();
        _settle(g, Outcome.Yes);
        vm.prank(users[0]);
        vm.expectRevert(IMarket.AlreadyGraduated.selector);
        g.claimPool();
    }

    // ---- touch markets ----

    function test_proveYes_settlesEarlyOnlyForTouchTemplates() public {
        Market m = _graduated();
        resolver.setAnswer(Outcome.Yes);
        vm.expectRevert(IMarket.NotEarlyYes.selector);
        m.proveYes("proof");

        resolver.setEarly(true);
        resolver.setAnswer(Outcome.No);
        vm.expectRevert(IMarket.NotResolved.selector);
        m.proveYes("proof");

        resolver.setAnswer(Outcome.Yes);
        m.proveYes("proof");
        assertEq(uint8(m.outcome()), uint8(Outcome.Yes));
        assertEq(uint8(m.phase()), uint8(Phase.Settled));
    }

    function test_proveYes_notWhileStakingIsOpen() public {
        resolver.setEarly(true);
        resolver.setAnswer(Outcome.Yes);
        Market m = _createDefault();
        vm.expectRevert(abi.encodeWithSelector(IMarket.WrongPhase.selector, Phase.Pool));
        m.proveYes("proof");
        vm.warp(m.window().lock);
        m.proveYes("proof");
    }

    // ---- fees ----

    function test_fees_onlyRecipientAndCreatorsWithdraw() public {
        Market m = _graduated();
        _settle(m, Outcome.Yes);
        vm.startPrank(users[0]);
        m.claimTokens();
        vault.redeem(address(m), Side.Yes, _yes(m).balanceOf(users[0]), users[0]);
        vm.stopPrank();

        uint256 pf = vault.protocolFees();
        uint256 cf = vault.creatorFees(creator);
        assertGt(pf, 0);
        assertGt(cf, 0);

        vm.prank(users[0]);
        vm.expectRevert(ICollateralVault.OnlyFeeRecipient.selector);
        vault.withdrawProtocolFees(users[0]);

        vm.prank(feeRecipient);
        assertEq(vault.withdrawProtocolFees(feeRecipient), pf);
        assertEq(usdc.balanceOf(feeRecipient), pf);
        vm.prank(creator);
        address dest = makeAddr("creator wallet");
        assertEq(vault.withdrawCreatorFees(dest), cf);
        assertEq(usdc.balanceOf(dest), cf);
        assertEq(vault.protocolFees(), 0);
        assertEq(vault.creatorFees(creator), 0);
        _assertSolvent();
    }
}

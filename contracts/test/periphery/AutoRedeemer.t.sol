// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {FixedPointMathLib} from "solady/utils/FixedPointMathLib.sol";
import {Market} from "../../src/core/Market.sol";
import {OutcomeToken} from "../../src/core/OutcomeToken.sol";
import {ICollateralVault} from "../../src/interfaces/ICollateralVault.sol";
import {IHunchBookFactory} from "../../src/interfaces/IHunchBookFactory.sol";
import {Outcome, Side} from "../../src/interfaces/IHunchBookTypes.sol";
import {AutoRedeemer} from "../../src/periphery/AutoRedeemer.sol";
import {IAutoRedeemer} from "../../src/periphery/interfaces/IAutoRedeemer.sol";
import {PeripheryBase} from "./PeripheryBase.sol";

/// A contract that pretends to be an outcome token of a real market.
contract FakeOutcomeToken {
    address public market;

    constructor(address m) {
        market = m;
    }

    function permit(address, address, uint256, uint256, uint8, bytes32, bytes32) external pure {}

    function allowance(address, address) external pure returns (uint256) {
        return type(uint256).max;
    }
}

contract AutoRedeemerTest is PeripheryBase {
    AutoRedeemer internal redeemer;
    Market internal m;
    OutcomeToken internal yes;
    OutcomeToken internal no;

    address internal alice;
    uint256 internal aliceKey;
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

    bytes32 internal constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    function setUp() public override {
        super.setUp();
        (alice, aliceKey) = makeAddrAndKey("alice");
        redeemer = new AutoRedeemer(IHunchBookFactory(address(factory)));
        (m,) = _graduatedWithBook();
        yes = _yes(m);
        no = _no(m);
        _giveTokens(m, alice, Side.Yes, 100e6);
        _giveTokens(m, alice, Side.No, 40e6);
        _giveTokens(m, bob, Side.Yes, 30e6);
        _giveTokens(m, bob, Side.No, 31e6 + 1);
    }

    // ---------------------------------------------------------------- helpers

    function _optIn(address who) internal {
        vm.startPrank(who);
        redeemer.setOptIn(true);
        yes.approve(address(redeemer), type(uint256).max);
        no.approve(address(redeemer), type(uint256).max);
        vm.stopPrank();
    }

    function _permitSig(OutcomeToken token, uint256 key, address owner, uint256 value, uint256 deadline)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        bytes32 structHash =
            keccak256(abi.encode(PERMIT_TYPEHASH, owner, address(redeemer), value, token.nonces(owner), deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash));
        (v, r, s) = vm.sign(key, digest);
    }

    function _winPaid(uint256 amount) internal view returns (uint256) {
        ICollateralVault.Ledger memory l = vault.ledger(address(m));
        return amount - FixedPointMathLib.mulDivUp(amount, l.feeNumerator, l.feeDenominator);
    }

    function _void() internal {
        vm.warp(m.window().settleDeadline + 1);
        m.voidIfExpired();
    }

    function _assertClean() internal view {
        assertEq(usdc.balanceOf(address(redeemer)), 0, "redeemer USDC");
        assertEq(yes.balanceOf(address(redeemer)), 0, "redeemer YES");
        assertEq(no.balanceOf(address(redeemer)), 0, "redeemer NO");
        _assertSolvent();
    }

    // ---------------------------------------------------------------- construction and settings

    function test_constructor() public view {
        assertEq(redeemer.factory(), address(factory));
        assertEq(redeemer.vault(), address(vault));
    }

    function test_constructor_revertsOnZeroFactory() public {
        vm.expectRevert(IAutoRedeemer.ZeroAddress.selector);
        new AutoRedeemer(IHunchBookFactory(address(0)));
    }

    function test_setOptIn_andOptOutPerMarket() public {
        vm.expectEmit(address(redeemer));
        emit IAutoRedeemer.OptInSet(alice, true);
        vm.prank(alice);
        redeemer.setOptIn(true);
        assertTrue(redeemer.optedIn(alice));
        assertTrue(redeemer.isActive(alice, address(m)));

        vm.expectEmit(address(redeemer));
        emit IAutoRedeemer.MarketOptOutSet(alice, address(m), true);
        vm.prank(alice);
        redeemer.setMarketOptOut(address(m), true);
        assertFalse(redeemer.isActive(alice, address(m)));
        assertTrue(redeemer.optedOut(alice, address(m)));

        vm.prank(alice);
        redeemer.setMarketOptOut(address(m), false);
        assertTrue(redeemer.isActive(alice, address(m)));

        vm.prank(alice);
        redeemer.setOptIn(false);
        assertFalse(redeemer.isActive(alice, address(m)));
    }

    function test_setMarketOptOut_revertsForUnknownMarket() public {
        vm.prank(alice);
        vm.expectRevert(IAutoRedeemer.UnknownMarket.selector);
        redeemer.setMarketOptOut(address(0xBEEF), true);
    }

    // ---------------------------------------------------------------- permit

    function test_optInWithPermit_approvesAndOptsIn() public {
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _permitSig(yes, aliceKey, alice, 70e6, deadline);
        vm.prank(alice);
        redeemer.optInWithPermit(address(yes), 70e6, deadline, v, r, s);
        assertTrue(redeemer.optedIn(alice));
        assertEq(yes.allowance(alice, address(redeemer)), 70e6);

        _settle(m, Outcome.Yes);
        uint256 before = usdc.balanceOf(alice);
        vm.prank(keeper);
        uint256 paid = redeemer.redeemFor(address(m), alice);
        assertEq(paid, _winPaid(70e6), "only the permitted amount");
        assertEq(usdc.balanceOf(alice) - before, paid);
        assertEq(yes.balanceOf(alice), 30e6);
        _assertClean();
    }

    function test_optInWithPermit_survivesFrontRunPermit() public {
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _permitSig(no, aliceKey, alice, 10e6, deadline);
        // Someone submits the permit first; the opt-in still goes through on the allowance it set.
        no.permit(alice, address(redeemer), 10e6, deadline, v, r, s);
        vm.prank(alice);
        redeemer.optInWithPermit(address(no), 10e6, deadline, v, r, s);
        assertTrue(redeemer.optedIn(alice));
    }

    function test_optInWithPermit_revertsOnBadSignatureWithoutAllowance() public {
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _permitSig(yes, aliceKey, alice, 10e6, deadline);
        vm.prank(bob); // bob submits alice's signature for himself
        vm.expectRevert(IAutoRedeemer.PermitFailed.selector);
        redeemer.optInWithPermit(address(yes), 10e6, deadline, v, r, s);
        assertFalse(redeemer.optedIn(bob));
    }

    function test_optInWithPermit_rejectsTokensThatAreNotOutcomeTokens() public {
        vm.startPrank(alice);
        vm.expectRevert(IAutoRedeemer.UnknownToken.selector);
        redeemer.optInWithPermit(address(usdc), 1, block.timestamp, 0, 0, 0); // no market()
        vm.expectRevert(IAutoRedeemer.UnknownToken.selector);
        redeemer.optInWithPermit(address(0xBEEF), 1, block.timestamp, 0, 0, 0); // no code
        FakeOutcomeToken fakeOfRealMarket = new FakeOutcomeToken(address(m));
        vm.expectRevert(IAutoRedeemer.UnknownToken.selector);
        redeemer.optInWithPermit(address(fakeOfRealMarket), 1, block.timestamp, 0, 0, 0);
        FakeOutcomeToken fakeOfFakeMarket = new FakeOutcomeToken(address(0xBEEF));
        vm.expectRevert(IAutoRedeemer.UnknownToken.selector);
        redeemer.optInWithPermit(address(fakeOfFakeMarket), 1, block.timestamp, 0, 0, 0);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- redeemFor: settled

    function test_redeemFor_settledYes_paysWinnerDirectly() public {
        _optIn(alice);
        _settle(m, Outcome.Yes);
        uint256 before = usdc.balanceOf(alice);

        vm.expectEmit(address(redeemer));
        emit IAutoRedeemer.AutoRedeemed(address(m), alice, Side.Yes, 100e6, _winPaid(100e6), keeper);
        vm.prank(keeper);
        uint256 paid = redeemer.redeemFor(address(m), alice);

        assertEq(paid, _winPaid(100e6));
        assertEq(usdc.balanceOf(alice) - before, paid);
        assertEq(yes.balanceOf(alice), 0, "winning YES redeemed");
        assertEq(no.balanceOf(alice), 40e6, "losing NO untouched");
        assertEq(usdc.balanceOf(keeper), 0, "the caller gets nothing");
        _assertClean();
    }

    function test_redeemFor_settledNo_redeemsOnlyNo() public {
        _optIn(alice);
        _settle(m, Outcome.No);
        uint256 before = usdc.balanceOf(alice);
        uint256 paid = redeemer.redeemFor(address(m), alice);
        assertEq(paid, _winPaid(40e6));
        assertEq(usdc.balanceOf(alice) - before, paid);
        assertEq(no.balanceOf(alice), 0);
        assertEq(yes.balanceOf(alice), 100e6);
        _assertClean();
    }

    function test_redeemFor_limitedByAllowance() public {
        vm.startPrank(alice);
        redeemer.setOptIn(true);
        yes.approve(address(redeemer), 25e6);
        vm.stopPrank();
        _settle(m, Outcome.Yes);
        assertEq(redeemer.redeemFor(address(m), alice), _winPaid(25e6));
        assertEq(yes.balanceOf(alice), 75e6);
        assertEq(yes.allowance(alice, address(redeemer)), 0);
        vm.expectRevert(IAutoRedeemer.NothingToRedeem.selector);
        redeemer.redeemFor(address(m), alice);
    }

    function test_redeemFor_limitedByBalance() public {
        _optIn(alice);
        vm.prank(alice);
        yes.transfer(carol, 60e6);
        _settle(m, Outcome.Yes);
        assertEq(redeemer.redeemFor(address(m), alice), _winPaid(40e6));
    }

    function test_redeemFor_reverts() public {
        vm.expectRevert(IAutoRedeemer.UnknownMarket.selector);
        redeemer.redeemFor(address(0xBEEF), alice);

        _optIn(alice);
        vm.expectRevert(IAutoRedeemer.NotRedeemable.selector);
        redeemer.redeemFor(address(m), alice); // graduated, not settled

        _settle(m, Outcome.Yes);
        vm.expectRevert(IAutoRedeemer.NotOptedIn.selector);
        redeemer.redeemFor(address(m), carol);

        vm.prank(alice);
        redeemer.setMarketOptOut(address(m), true);
        vm.expectRevert(IAutoRedeemer.NotOptedIn.selector);
        redeemer.redeemFor(address(m), alice);

        // Opted in and approved, but holding only the losing side.
        vm.startPrank(carol);
        redeemer.setOptIn(true);
        no.approve(address(redeemer), type(uint256).max);
        vm.stopPrank();
        vm.prank(alice);
        no.transfer(carol, 1e6);
        vm.expectRevert(IAutoRedeemer.NothingToRedeem.selector);
        redeemer.redeemFor(address(m), carol);
    }

    function test_redeemFor_noApprovalMeansNothingMoves() public {
        vm.prank(alice);
        redeemer.setOptIn(true);
        _settle(m, Outcome.Yes);
        vm.expectRevert(IAutoRedeemer.NothingToRedeem.selector);
        redeemer.redeemFor(address(m), alice);
        assertEq(yes.balanceOf(alice), 100e6);
    }

    // ---------------------------------------------------------------- redeemFor: voided

    function test_redeemFor_voided_paysHalfOnBothSides() public {
        _optIn(alice);
        _void();
        uint256 before = usdc.balanceOf(alice);
        uint256 paid = redeemer.redeemFor(address(m), alice);
        assertEq(paid, 70e6, "(100 + 40) / 2");
        assertEq(usdc.balanceOf(alice) - before, 70e6);
        assertEq(yes.balanceOf(alice), 0);
        assertEq(no.balanceOf(alice), 0);
        _assertClean();
    }

    function test_redeemFor_voided_leavesAnOddUnitInsteadOfLosingIt() public {
        _optIn(bob); // 30 YES, 31.000001 NO
        _void();
        uint256 paid = redeemer.redeemFor(address(m), bob);
        assertEq(paid, 15e6 + 15_500_000);
        assertEq(no.balanceOf(bob), 1, "the odd unit stays with the holder");
        vm.expectRevert(IAutoRedeemer.NothingToRedeem.selector);
        redeemer.redeemFor(address(m), bob);
    }

    // ---------------------------------------------------------------- batch

    function test_redeemManyFor_skipsAndIsolates() public {
        _optIn(alice);
        _optIn(bob);
        vm.prank(carol);
        redeemer.setOptIn(true); // opted in, nothing to redeem
        _settle(m, Outcome.Yes);

        // USDC refuses transfers to bob: his redemption fails alone.
        vm.mockCallRevert(address(usdc), abi.encodeWithSelector(usdc.transfer.selector, bob), "blocked");

        address[] memory holders = new address[](5);
        holders[0] = alice;
        holders[1] = bob;
        holders[2] = carol;
        holders[3] = makeAddr("never opted in");
        holders[4] = alice; // a duplicate finds nothing left
        uint256 aliceBefore = usdc.balanceOf(alice);

        vm.prank(keeper);
        (uint256 paid, uint256 redeemed) = redeemer.redeemManyFor(address(m), holders);
        vm.clearMockedCalls();

        assertEq(redeemed, 1);
        assertEq(paid, _winPaid(100e6));
        assertEq(usdc.balanceOf(alice) - aliceBefore, paid);
        assertEq(yes.balanceOf(bob), 30e6, "bob's tokens did not move");
        _assertClean();
    }

    function test_redeemManyFor_revertsForUnredeemableMarket() public {
        address[] memory holders = new address[](1);
        holders[0] = alice;
        vm.expectRevert(IAutoRedeemer.NotRedeemable.selector);
        redeemer.redeemManyFor(address(m), holders);
        vm.expectRevert(IAutoRedeemer.UnknownMarket.selector);
        redeemer.redeemManyFor(address(0xBEEF), holders);
    }

    function test_selfRedeem_onlyByItself() public {
        vm.expectRevert(IAutoRedeemer.OnlySelf.selector);
        redeemer.selfRedeem(address(m), alice, address(this));
    }

    // ---------------------------------------------------------------- views

    function test_redeemable_matchesRedeemFor() public {
        _optIn(alice);
        (uint256 y0, uint256 n0, uint256 p0) = redeemer.redeemable(address(m), alice);
        assertEq(y0 + n0 + p0, 0, "nothing before settlement");
        (y0, n0, p0) = redeemer.redeemable(address(0xBEEF), alice);
        assertEq(y0 + n0 + p0, 0, "unknown market");
        (y0, n0, p0) = redeemer.redeemable(address(m), carol);
        assertEq(y0 + n0 + p0, 0, "not opted in");

        _settle(m, Outcome.Yes);
        (uint256 y, uint256 n, uint256 p) = redeemer.redeemable(address(m), alice);
        assertEq(y, 100e6);
        assertEq(n, 0);
        assertEq(redeemer.redeemFor(address(m), alice), p);
    }

    function test_redeemable_voidedAndNoWin() public {
        _optIn(bob);
        _void();
        (uint256 y, uint256 n, uint256 p) = redeemer.redeemable(address(m), bob);
        assertEq(y, 30e6);
        assertEq(n, 31e6);
        assertEq(redeemer.redeemFor(address(m), bob), p);

        (Market m2,) = _graduatedWithBook();
        _giveTokens(m2, bob, Side.No, 9e6);
        OutcomeToken no2 = _no(m2);
        vm.prank(bob);
        no2.approve(address(redeemer), type(uint256).max);
        _settle(m2, Outcome.No);
        (y, n, p) = redeemer.redeemable(address(m2), bob);
        assertEq(y, 0);
        assertEq(n, 9e6);
        assertEq(redeemer.redeemFor(address(m2), bob), p);
    }

    // ---------------------------------------------------------------- fuzz

    /// Any balance and allowance: the holder gets exactly what redeeming directly would pay, and the
    /// redeemer keeps nothing.
    function testFuzz_settled_paysExactlyTheVaultAmount(uint256 balance, uint256 allowance, bool yesWins) public {
        balance = bound(balance, 1, 2000e6);
        allowance = bound(allowance, 1, type(uint256).max);
        address h = makeAddr("fuzz holder");
        Side win = yesWins ? Side.Yes : Side.No;
        _giveTokens(m, h, win, balance);
        OutcomeToken t = yesWins ? yes : no;
        vm.startPrank(h);
        redeemer.setOptIn(true);
        t.approve(address(redeemer), allowance);
        vm.stopPrank();
        _settle(m, yesWins ? Outcome.Yes : Outcome.No);

        uint256 amount = balance < allowance ? balance : allowance;
        uint256 paid = redeemer.redeemFor(address(m), h);
        assertEq(paid, _winPaid(amount));
        assertEq(usdc.balanceOf(h), paid);
        assertEq(t.balanceOf(h), balance - amount);
        _assertClean();
    }

    function testFuzz_voided_neverLosesAUnit(uint256 yesBal, uint256 noBal) public {
        yesBal = bound(yesBal, 0, 2000e6);
        noBal = bound(noBal, 0, 2000e6);
        address h = makeAddr("fuzz holder");
        if (yesBal != 0) _giveTokens(m, h, Side.Yes, yesBal);
        if (noBal != 0) _giveTokens(m, h, Side.No, noBal);
        _optIn(h);
        _void();
        if (yesBal < 2 && noBal < 2) {
            vm.expectRevert(IAutoRedeemer.NothingToRedeem.selector);
            redeemer.redeemFor(address(m), h);
            return;
        }
        uint256 paid = redeemer.redeemFor(address(m), h);
        // Every burned unit paid exactly 0.50: 2 * paid == burned.
        uint256 burned = (yesBal - yes.balanceOf(h)) + (noBal - no.balanceOf(h));
        assertEq(2 * paid, burned);
        assertLe(yes.balanceOf(h), 1);
        assertLe(no.balanceOf(h), 1);
        _assertClean();
    }
}

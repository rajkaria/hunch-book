// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {BaseTest} from "./Base.t.sol";
import {Market} from "../../src/core/Market.sol";
import {CollateralVault} from "../../src/core/CollateralVault.sol";
import {ICollateralVault} from "../../src/interfaces/ICollateralVault.sol";
import {IFlashLoanReceiver} from "../../src/interfaces/IFlashLoanReceiver.sol";
import {Outcome, Side} from "../../src/interfaces/IHunchBookTypes.sol";
import {TestUSDC} from "../../src/mocks/TestUSDC.sol";

/// Flash-loan receiver whose behaviour each test picks.
contract Borrower is IFlashLoanReceiver {
    enum Mode {
        Repay,
        NoApprove,
        WrongMagic,
        MintAndKeep,
        MintMergeRepay,
        Reenter,
        StealFees
    }

    CollateralVault internal vault;
    TestUSDC internal usdc;
    Mode public mode;
    address public market;

    constructor(CollateralVault v, TestUSDC u) {
        vault = v;
        usdc = u;
    }

    function set(Mode m, address mkt) external {
        mode = m;
        market = mkt;
    }

    function borrow(uint256 amount) external {
        vault.flashLoan(address(this), amount, "");
    }

    function onFlashLoan(address, uint256 amount, bytes calldata) external returns (bytes32) {
        if (mode == Mode.WrongMagic) return bytes32(0);
        if (mode == Mode.Reenter) vault.flashLoan(address(this), 1, "");
        if (mode == Mode.MintAndKeep || mode == Mode.MintMergeRepay) {
            usdc.approve(address(vault), type(uint256).max);
            vault.mintSets(market, amount, address(this));
            if (mode == Mode.MintMergeRepay) vault.mergeSets(market, amount, address(this));
        }
        if (mode == Mode.StealFees) {
            // Tries to pass off borrowed funds as fee withdrawals: not the fee recipient, so it reverts.
            vault.withdrawProtocolFees(address(this));
        }
        if (mode != Mode.NoApprove) usdc.approve(address(vault), amount);
        return keccak256("HunchBook.onFlashLoan");
    }
}

contract VaultTest is BaseTest {
    Borrower internal borrower;

    function setUp() public override {
        super.setUp();
        borrower = new Borrower(vault, usdc);
    }

    function _withLiquidity() internal returns (Market m) {
        m = _graduated();
    }

    // ---- flash loans ----

    function test_flashLoan_repaidLeavesSurplusUnchanged() public {
        _withLiquidity();
        int256 before = vault.surplus();
        borrower.set(Borrower.Mode.Repay, address(0));
        borrower.borrow(400e6);
        assertEq(vault.surplus(), before);
        assertEq(usdc.balanceOf(address(borrower)), 0);
    }

    function test_flashLoan_revertsWithoutRepayment() public {
        _withLiquidity();
        borrower.set(Borrower.Mode.NoApprove, address(0));
        vm.expectRevert();
        borrower.borrow(400e6);
    }

    function test_flashLoan_revertsOnWrongCallbackValue() public {
        _withLiquidity();
        borrower.set(Borrower.Mode.WrongMagic, address(0));
        vm.expectRevert(ICollateralVault.FlashLoanCallbackFailed.selector);
        borrower.borrow(400e6);
    }

    function test_flashLoan_cannotBeNested() public {
        _withLiquidity();
        borrower.set(Borrower.Mode.Reenter, address(0));
        vm.expectRevert(ICollateralVault.Reentrancy.selector);
        borrower.borrow(400e6);
    }

    function test_flashLoan_cannotKeepBorrowedFundsAsSets() public {
        Market m = _withLiquidity();
        borrower.set(Borrower.Mode.MintAndKeep, address(m));
        // Minted sets with the loan and cannot repay: the pull back fails.
        vm.expectRevert();
        borrower.borrow(100e6);
    }

    function test_flashLoan_mintAndMergeInsideCallback() public {
        Market m = _withLiquidity();
        int256 before = vault.surplus();
        borrower.set(Borrower.Mode.MintMergeRepay, address(m));
        borrower.borrow(100e6);
        assertEq(vault.surplus(), before);
        _assertSetsMatchSupply(m);
    }

    function test_flashLoan_cannotReachFees() public {
        _withLiquidity();
        borrower.set(Borrower.Mode.StealFees, address(0));
        vm.expectRevert(ICollateralVault.OnlyFeeRecipient.selector);
        borrower.borrow(100e6);
    }

    function test_flashLoan_revertsOnZero() public {
        vm.expectRevert(ICollateralVault.ZeroAmount.selector);
        vault.flashLoan(address(borrower), 0, "");
    }

    // ---- access control ----

    function test_marketHooks_onlyRegisteredMarkets() public {
        vm.expectRevert(ICollateralVault.OnlyMarket.selector);
        vault.depositPool(users[0], 1e6);
        vm.expectRevert(ICollateralVault.OnlyMarket.selector);
        vault.creditPool(1e6);
        vm.expectRevert(ICollateralVault.OnlyMarket.selector);
        vault.graduatePool(1e6);
        vm.expectRevert(ICollateralVault.OnlyMarket.selector);
        vault.payPool(users[0], 1e6, 0);
        vm.expectRevert(ICollateralVault.OnlyMarket.selector);
        vault.finalize(Outcome.Yes, 0, 1);
        vm.expectRevert(ICollateralVault.OnlyMarket.selector);
        vault.finalizeVoid();
    }

    function test_factoryHooks_onlyFactory() public {
        vm.expectRevert(ICollateralVault.OnlyFactory.selector);
        vault.registerMarket(users[0], users[0], 1);
        vm.expectRevert(ICollateralVault.OnlyFactory.selector);
        vault.setCollateralCap(1);
    }

    function test_creditPool_requiresTheUsdcToHaveArrived() public {
        Market m = _createDefault();
        vm.prank(address(m));
        vm.expectRevert(ICollateralVault.InsufficientPool.selector);
        vault.creditPool(1e6);
    }

    function test_graduatePool_mustMoveTheWholePool() public {
        Market m = _createDefault();
        vm.prank(address(m));
        vm.expectRevert(ICollateralVault.InsufficientPool.selector);
        vault.graduatePool(1e6);
    }

    function test_payPool_onlyAfterFinalAndWithinPool() public {
        Market m = _createDefault();
        vm.prank(address(m));
        vm.expectRevert(ICollateralVault.MarketNotOpen.selector);
        vault.payPool(users[0], 1e6, 0);
        _settle(m, Outcome.Yes);
        vm.prank(address(m));
        vm.expectRevert(ICollateralVault.InsufficientPool.selector);
        vault.payPool(users[0], CREATOR_MIN, 1);
    }

    // ---- mint, merge, redeem guards ----

    function test_mint_onlyWhileGraduated() public {
        Market m = _createDefault();
        vm.prank(users[0]);
        vm.expectRevert(ICollateralVault.NotTradable.selector);
        vault.mintSets(address(m), 1e6, users[0]);

        vm.prank(users[0]);
        vm.expectRevert(ICollateralVault.UnknownMarket.selector);
        vault.mintSets(users[5], 1e6, users[0]);
    }

    function test_mint_pricesExactlyOneUsdcPerSet() public {
        Market m = _graduated();
        uint256 before = usdc.balanceOf(users[0]);
        vm.prank(users[0]);
        vault.mintSets(address(m), 37e6, users[1]);
        assertEq(usdc.balanceOf(users[0]), before - 37e6);
        assertEq(_yes(m).balanceOf(users[1]), 37e6);
        assertEq(_no(m).balanceOf(users[1]), 37e6);
        _assertSetsMatchSupply(m);

        uint256 b1 = usdc.balanceOf(users[2]);
        vm.prank(users[1]);
        vault.mergeSets(address(m), 37e6, users[2]);
        assertEq(usdc.balanceOf(users[2]), b1 + 37e6);
        _assertSetsMatchSupply(m);
        _assertSolvent();
    }

    function test_merge_needsBothSides() public {
        Market m = _graduated();
        vm.prank(users[0]);
        m.claimTokens(); // YES only
        uint256 y = _yes(m).balanceOf(users[0]);
        vm.prank(users[0]);
        vm.expectRevert();
        vault.mergeSets(address(m), y, users[0]);
    }

    function test_redeem_onlyAfterSettlementOrVoid() public {
        Market m = _graduated();
        vm.prank(users[0]);
        vm.expectRevert(ICollateralVault.NotRedeemable.selector);
        vault.redeem(address(m), Side.Yes, 1e6, users[0]);
    }

    function test_zeroAmountsAndZeroRecipients() public {
        Market m = _graduated();
        vm.startPrank(users[0]);
        vm.expectRevert(ICollateralVault.ZeroAmount.selector);
        vault.mintSets(address(m), 0, users[0]);
        vm.expectRevert(ICollateralVault.ZeroAddress.selector);
        vault.mintSets(address(m), 1e6, address(0));
        vm.expectRevert(ICollateralVault.ZeroAmount.selector);
        vault.mergeSets(address(m), 0, users[0]);
        vm.expectRevert(ICollateralVault.ZeroAmount.selector);
        vault.redeem(address(m), Side.Yes, 0, users[0]);
        vm.stopPrank();
    }

    function test_mint_respectsCollateralCap() public {
        Market m = _graduated();
        uint256 cap = vault.totalCollateral() + 5e6;
        vm.prank(guardian);
        factory.setCollateralCap(cap);
        vm.prank(users[0]);
        vm.expectRevert(ICollateralVault.CollateralCapExceeded.selector);
        vault.mintSets(address(m), 5e6 + 1, users[0]);
        vm.prank(users[0]);
        vault.mintSets(address(m), 5e6, users[0]);
    }

    function test_donationsOnlyIncreaseSurplus() public {
        _graduated();
        usdc.mint(address(vault), 123);
        assertEq(vault.surplus(), 123);
    }

    function test_tokensAreDeterministicPerMarket() public {
        Market m = _createDefault();
        (address y, address n) = vault.tokensOf(address(m));
        (address my, address mn) = m.tokens();
        assertEq(y, my);
        assertEq(n, mn);
        assertTrue(y != n);
    }
}

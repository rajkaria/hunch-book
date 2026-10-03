// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {HunchRouter} from "../../src/core/HunchRouter.sol";
import {IHunchRouter} from "../../src/interfaces/IHunchRouter.sol";
import {MockKuruOrderBook} from "../mocks/MockKuruOrderBook.sol";
import {MockVaultForRouter} from "../mocks/MockVaultForRouter.sol";
import {HunchRouterBase} from "./HunchRouterBase.sol";

/// buyNo, sellNo and the flash-loan callback guards.
contract HunchRouterNoTest is HunchRouterBase {
    address internal minter = makeAddr("minter");
    address internal attacker = makeAddr("attacker");

    /// Gives `to` `amount` NO the way they exist in practice: minted as complete sets through the vault.
    function _giveNo(address to, uint256 amount) internal {
        vm.startPrank(minter);
        usdc.mint(minter, amount);
        usdc.approve(address(vault), amount);
        vault.mintSets(address(market), amount, minter);
        no.transfer(to, amount);
        vm.stopPrank();
        vm.prank(to);
        no.approve(address(router), type(uint256).max);
    }

    function _buyNoData(uint256 noOut, uint256 maxIn) internal view returns (bytes memory) {
        return abi.encode(IHunchRouter.Kind.BuyNo, address(market), address(book), address(yes), alice, noOut, maxIn);
    }

    // ---------------------------------------------------------------- buyNo

    /// Mint 100 sets for 100 USDC, sell 100 YES at 0.60 for 60 USDC: alice pays 40 and gets 100 NO.
    function test_buyNo_basic() public {
        book.addBid(600_000, 1000e6);
        _give(usdc, alice, 40e6);
        int256 surplusBefore = vault.surplus();

        vm.expectEmit(address(router));
        emit IHunchRouter.Trade(address(market), alice, IHunchRouter.Kind.BuyNo, 40e6, 100e6, address(book));
        vm.prank(alice);
        uint256 paid = router.buyNo(address(market), 100e6, 40e6, deadline);

        assertEq(paid, 40e6);
        assertEq(no.balanceOf(alice), 100e6);
        assertEq(usdc.balanceOf(alice), 0);
        assertEq(yes.balanceOf(alice), 0);
        assertEq(vault.sets(address(market)), 100e6);
        assertEq(vault.surplus(), surplusBefore, "vault surplus unchanged");
        assertEq(vault.flashLoans(), 1);
        assertEq(book.lastAllowance(), 100e6, "exact YES approval");
        _assertRouterClean();
    }

    /// Fee 30 bps: proceeds 60e6 - 180000, so alice pays 40180000.
    function test_buyNo_takerFee() public {
        _useBook(30);
        book.addBid(600_000, 1000e6);
        _give(usdc, alice, 50e6);
        vm.prank(alice);
        assertEq(router.buyNo(address(market), 100e6, 50e6, deadline), 40_180_000);
        assertEq(usdc.balanceOf(alice), 50e6 - 40_180_000);
        assertEq(no.balanceOf(alice), 100e6);
        _assertRouterClean();
    }

    /// 50 YES at 0.60 and 50 at 0.50: proceeds 55 USDC, alice pays 45.
    function test_buyNo_walksLevels() public {
        book.addBid(600_000, 50e6);
        book.addBid(500_000, 500e6);
        _give(usdc, alice, 45e6);
        vm.prank(alice);
        assertEq(router.buyNo(address(market), 100e6, 45e6, deadline), 45e6);
        assertEq(no.balanceOf(alice), 100e6);
        _assertRouterClean();
    }

    function test_buyNo_maxInBoundary() public {
        book.addBid(600_000, 1000e6);
        _give(usdc, alice, 100e6);
        uint256 snap = vm.snapshotState();
        vm.prank(alice);
        router.buyNo(address(market), 100e6, 40e6, deadline); // exactly the maximum: passes
        vm.revertToState(snap);
        vm.prank(alice);
        vm.expectRevert(MockKuruOrderBook.SlippageExceeded.selector); // Kuru's own minimum fires first
        router.buyNo(address(market), 100e6, 40e6 - 1, deadline);
    }

    /// Kuru reports 60 USDC but delivers 60 USDC - 1: the cost would be 40 USDC + 1, above the maximum.
    function test_buyNo_checksBalancesNotReturnValues() public {
        book.addBid(600_000, 1000e6);
        book.setShort(0, 1);
        _give(usdc, alice, 100e6);
        vm.prank(alice);
        vm.expectRevert(IHunchRouter.Slippage.selector);
        router.buyNo(address(market), 100e6, 40e6, deadline);
    }

    /// The YES sale is fill-or-kill, so alice gets exactly what she asked for or nothing.
    function test_buyNo_fillOrKill() public {
        book.addBid(600_000, 50e6);
        _give(usdc, alice, 100e6);
        vm.prank(alice);
        vm.expectRevert(HunchRouter.InsufficientLiquidity.selector);
        router.buyNo(address(market), 100e6, 100e6, deadline);
    }

    /// Bids above 1 USDC: the sale pays more than the sets cost, alice pays nothing and keeps the excess.
    function test_buyNo_bidAboveOne() public {
        book.addBid(1_200_000, 1000e6);
        vm.prank(alice);
        assertEq(router.buyNo(address(market), 100e6, 0, deadline), 0);
        assertEq(no.balanceOf(alice), 100e6);
        assertEq(usdc.balanceOf(alice), 20e6);
        _assertRouterClean();
    }

    function test_buyNo_needsApproval() public {
        book.addBid(600_000, 1000e6);
        usdc.mint(alice, 100e6);
        vm.prank(alice);
        vm.expectRevert();
        router.buyNo(address(market), 100e6, 100e6, deadline);
    }

    // ---------------------------------------------------------------- sellNo

    /// Buy 100 YES at 0.40 with 40 borrowed USDC, merge 100 sets for 100 USDC, repay: alice gets 60.
    function test_sellNo_basic() public {
        book.addAsk(400_000, 1000e6);
        _giveNo(alice, 100e6);
        int256 surplusBefore = vault.surplus();
        assertEq(router.quoteSellNo(address(market), 100e6), 40e6);

        vm.expectEmit(address(router));
        emit IHunchRouter.Trade(address(market), alice, IHunchRouter.Kind.SellNo, 100e6, 60e6, address(book));
        vm.prank(alice);
        uint256 out = router.sellNo(address(market), 100e6, 60e6, deadline);

        assertEq(out, 60e6);
        assertEq(usdc.balanceOf(alice), 60e6);
        assertEq(no.balanceOf(alice), 0);
        assertEq(yes.balanceOf(alice), 0);
        assertEq(vault.sets(address(market)), 0);
        assertEq(vault.surplus(), surplusBefore, "vault surplus unchanged");
        assertEq(book.lastAllowance(), 40e6, "exact USDC approval");
        _assertRouterClean();
    }

    /// Fee 30 bps: gross = ceil(100e6 * 1e4 / 9970) = 100300903, Q = ceil(gross * 0.4) = 40120362.
    /// Kuru fills floor(Q / 0.4) = 100300905 and credits 100300905 - 300903 = 100000002 YES: 2 extra.
    function test_sellNo_takerFeeExactQuote() public {
        _useBook(30);
        book.addAsk(400_000, 1000e6);
        _giveNo(alice, 100e6);
        assertEq(router.quoteSellNo(address(market), 100e6), 40_120_362);
        vm.prank(alice);
        assertEq(router.sellNo(address(market), 100e6, 0, deadline), 100e6 - 40_120_362);
        assertEq(yes.balanceOf(alice), 2, "rounding extra goes to the seller");
        _assertRouterClean();
    }

    /// A price that does not divide evenly: need 1000001 at 0.333 gives Q = 333001 and 1000003 YES.
    function test_sellNo_roundingExtraYes() public {
        book.addAsk(333_000, 10e6);
        _giveNo(alice, 1_000_001);
        vm.prank(alice);
        assertEq(router.sellNo(address(market), 1_000_001, 0, deadline), 1_000_001 - 333_001);
        assertEq(yes.balanceOf(alice), 2);
        _assertRouterClean();
    }

    /// Levels: 100 at 0.40, 200 at 0.45. 250 YES: backwards, Q2 = ceil(150e6 * 0.45) = 67.5e6, then level 1
    /// must leave 67.5e6: F = 100e6 + ceil(67.5e6 / 0.4) = 268750000, Q = ceil(F * 0.4) = 107.5e6.
    function test_sellNo_walksLevels() public {
        book.addAsk(400_000, 100e6);
        book.addAsk(450_000, 200e6);
        _giveNo(alice, 250e6);
        assertEq(router.quoteSellNo(address(market), 250e6), 107_500_000);
        vm.prank(alice);
        assertEq(router.sellNo(address(market), 250e6, 0, deadline), 250e6 - 107_500_000);
        assertEq(yes.balanceOf(alice), 0);
        _assertRouterClean();
    }

    /// The quote is the least that works: one unit less buys fewer than the NO being sold.
    function test_sellNo_quoteIsMinimal() public {
        book.addAsk(400_000, 100e6);
        book.addAsk(450_000, 200e6);
        book.addAsk(731_000, 77e6);
        uint256 q = router.quoteSellNo(address(market), 333e6);
        (uint256 got,) = book.previewMarketBuy(q);
        (uint256 less,) = book.previewMarketBuy(q - 1);
        assertGe(got, 333e6);
        assertLt(less, 333e6);
    }

    /// More than 16 ask levels: the router reads 16, then 256.
    function test_sellNo_readsMoreLevels() public {
        book.pushAsks(10_000, 1000, 1e6, 40);
        _giveNo(alice, 30e6);
        uint256 q = router.quoteSellNo(address(market), 30e6);
        vm.prank(alice);
        assertEq(router.sellNo(address(market), 30e6, 0, deadline), 30e6 - q);
        assertEq(book.askCount(), 10);
        _assertRouterClean();
    }

    /// More than 256 ask levels: the router reads 16, then 256, then the whole side.
    function test_sellNo_readsWholeAskSide() public {
        book.pushAsks(10_000, 1000, 1e6, 300);
        _giveNo(alice, 280e6);
        uint256 q = router.quoteSellNo(address(market), 280e6);
        vm.prank(alice);
        assertEq(router.sellNo(address(market), 280e6, 0, deadline), 280e6 - q);
        assertEq(book.askCount(), 20);
        _assertRouterClean();
    }

    function test_sellNo_insufficientLiquidity() public {
        book.addAsk(400_000, 50e6);
        _giveNo(alice, 100e6);
        vm.expectRevert(HunchRouter.InsufficientLiquidity.selector);
        router.quoteSellNo(address(market), 100e6);
        vm.prank(alice);
        vm.expectRevert(HunchRouter.InsufficientLiquidity.selector);
        router.sellNo(address(market), 100e6, 0, deadline);
    }

    /// Exactly 16 levels that are not enough: the second read returns fewer than asked, so stop.
    function test_sellNo_insufficientAfterSecondRead() public {
        book.pushAsks(10_000, 1000, 1e6, 16);
        _giveNo(alice, 20e6);
        vm.prank(alice);
        vm.expectRevert(HunchRouter.InsufficientLiquidity.selector);
        router.sellNo(address(market), 20e6, 0, deadline);
    }

    function test_sellNo_minOutBoundary() public {
        book.addAsk(400_000, 1000e6);
        _giveNo(alice, 100e6);
        uint256 snap = vm.snapshotState();
        vm.prank(alice);
        router.sellNo(address(market), 100e6, 60e6, deadline);
        vm.revertToState(snap);
        vm.prank(alice);
        vm.expectRevert(IHunchRouter.Slippage.selector);
        router.sellNo(address(market), 100e6, 60e6 + 1, deadline);
    }

    /// YES above 1 USDC: buying the YES costs more than the merge returns; the seller never pays.
    function test_sellNo_askAboveOneReverts() public {
        book.addAsk(1_100_000, 1000e6);
        _giveNo(alice, 100e6);
        vm.prank(alice);
        vm.expectRevert(IHunchRouter.Slippage.selector);
        router.sellNo(address(market), 100e6, 0, deadline);
    }

    function test_sellNo_checksBalancesNotReturnValues() public {
        book.addAsk(400_000, 1000e6);
        book.setShort(1, 0);
        _giveNo(alice, 100e6);
        vm.prank(alice);
        vm.expectRevert(IHunchRouter.Slippage.selector);
        router.sellNo(address(market), 100e6, 0, deadline);
    }

    function test_sellNo_ignoresDonations() public {
        usdc.mint(address(router), 5);
        yes.mint(address(router), 7);
        no.mint(address(router), 9);
        book.addAsk(400_000, 1000e6);
        _giveNo(alice, 100e6);
        vm.prank(alice);
        assertEq(router.sellNo(address(market), 100e6, 0, deadline), 60e6);
        assertEq(usdc.balanceOf(address(router)), 5);
        assertEq(yes.balanceOf(address(router)), 7);
        assertEq(no.balanceOf(address(router)), 9);
        assertEq(yes.balanceOf(alice), 0);
    }

    function test_quoteSellNo_checks() public {
        vm.expectRevert(IHunchRouter.ZeroAmount.selector);
        router.quoteSellNo(address(market), 0);
        vm.expectRevert(IHunchRouter.UnknownMarket.selector);
        router.quoteSellNo(makeAddr("notAMarket"), 1e6);
        market.setBook(address(0));
        vm.expectRevert(IHunchRouter.NotTradable.selector);
        router.quoteSellNo(address(market), 1e6);
    }

    // ---------------------------------------------------------------- flash-loan guards

    function test_onFlashLoan_onlyVault() public {
        vm.prank(attacker);
        vm.expectRevert(HunchRouter.OnlyVault.selector);
        router.onFlashLoan(address(router), 1e6, _buyNoData(1e6, 1e6));
    }

    /// The vault calling back with no loan requested (initiator spoofed as the router).
    function test_onFlashLoan_rejectsUnrequestedCallback() public {
        vm.expectRevert(HunchRouter.UnexpectedFlashLoan.selector);
        vault.callOnFlashLoan(address(router), address(router), 1e6, _buyNoData(1e6, 1e6));
    }

    /// An attacker borrows on the router's behalf with data naming alice, who approved the router.
    function test_onFlashLoan_rejectsForeignInitiator() public {
        book.addBid(600_000, 1000e6);
        _give(usdc, alice, 1000e6);
        vm.prank(attacker);
        vm.expectRevert(HunchRouter.UnexpectedFlashLoan.selector);
        vault.flashLoan(address(router), 100e6, _buyNoData(100e6, 1000e6));
        assertEq(usdc.balanceOf(alice), 1000e6);
    }

    function test_onFlashLoan_rejectsTamperedAmount() public {
        book.addBid(600_000, 1000e6);
        _give(usdc, alice, 100e6);
        vault.setTamper(1, false, "");
        vm.prank(alice);
        vm.expectRevert(HunchRouter.UnexpectedFlashLoan.selector);
        router.buyNo(address(market), 100e6, 40e6, deadline);
    }

    function test_onFlashLoan_rejectsTamperedData() public {
        book.addBid(600_000, 1000e6);
        _give(usdc, alice, 100e6);
        vault.setTamper(0, true, _buyNoData(100e6, type(uint256).max));
        vm.prank(alice);
        vm.expectRevert(HunchRouter.UnexpectedFlashLoan.selector);
        router.buyNo(address(market), 100e6, 40e6, deadline);
    }

    /// The book tries to start a second loan to the router from inside the first one.
    function test_onFlashLoan_rejectsNestedLoan() public {
        book.addBid(600_000, 1000e6);
        _give(usdc, alice, 100e6);
        book.setReenter(address(vault), abi.encodeCall(MockVaultForRouter.flashLoan, (address(router), 1e6, "")));
        vm.prank(alice);
        vm.expectRevert(HunchRouter.UnexpectedFlashLoan.selector);
        router.buyNo(address(market), 100e6, 40e6, deadline);
    }
}

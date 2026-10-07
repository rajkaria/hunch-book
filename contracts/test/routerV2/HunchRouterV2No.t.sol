// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {HunchRouterV2} from "../../src/core/HunchRouterV2.sol";
import {IHunchRouter} from "../../src/interfaces/IHunchRouter.sol";
import {MockKuruSpotOrderBookV2} from "../mocks/MockKuruV2.sol";
import {MockVaultForRouter} from "../mocks/MockVaultForRouter.sol";
import {HunchRouterV2Base} from "./HunchRouterV2Base.sol";

/// buyNo, sellNo, the exact-out quote search and the flash-loan callback guards.
contract HunchRouterV2NoTest is HunchRouterV2Base {
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
        _bid(600_000, 1000e6);
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
        _assertRouterClean();
    }

    /// Fee 7000 pps on 60 USDC proceeds: 42000, so alice pays 40042000.
    function test_buyNo_takerFee() public {
        _useBook(7000);
        _bid(600_000, 1000e6);
        _give(usdc, alice, 50e6);
        vm.prank(alice);
        assertEq(router.buyNo(address(market), 100e6, 50e6, deadline), 40e6 + 42_000);
        assertEq(usdc.balanceOf(alice), 50e6 - 40e6 - 42_000);
        _assertRouterClean();
    }

    /// 50 YES at 0.60 + 50 YES at 0.50 = 55 USDC: alice pays 45.
    function test_buyNo_walksLevels() public {
        _bid(600_000, 50e6);
        _bid(500_000, 1000e6);
        _give(usdc, alice, 45e6);
        vm.prank(alice);
        assertEq(router.buyNo(address(market), 100e6, 45e6, deadline), 45e6);
        _assertRouterClean();
    }

    function test_buyNo_maxInBoundary() public {
        _bid(600_000, 1000e6);
        _give(usdc, alice, 100e6);
        uint256 snap = vm.snapshotState();
        vm.prank(alice);
        router.buyNo(address(market), 100e6, 40e6, deadline);
        vm.revertToState(snap);
        vm.prank(alice);
        vm.expectRevert();
        router.buyNo(address(market), 100e6, 40e6 - 1, deadline);
    }

    /// Bids take only 30 of the 100 YES (v2 has no fill-or-kill): alice pays 100 - 18 = 82 within her
    /// limit and gets 100 NO plus the 70 YES the bids did not take.
    function test_buyNo_unfilledYesGoesToCaller() public {
        _bid(600_000, 30e6);
        _give(usdc, alice, 82e6);
        vm.prank(alice);
        assertEq(router.buyNo(address(market), 100e6, 82e6, deadline), 82e6);
        assertEq(no.balanceOf(alice), 100e6);
        assertEq(yes.balanceOf(alice), 70e6);
        _assertRouterClean();
    }

    /// The same thin book with a tighter limit: Kuru's minimum-out check (proceeds >= 100 - 40) stops it.
    function test_buyNo_thinBidsHitTheLimit() public {
        _bid(600_000, 30e6);
        _give(usdc, alice, 100e6);
        vm.prank(alice);
        vm.expectRevert(MockKuruSpotOrderBookV2.SlippageExceeded.selector);
        router.buyNo(address(market), 100e6, 40e6, deadline);
    }

    /// Bids above 1 USDC: proceeds 110 exceed the 100 borrowed; alice pays nothing and receives 10.
    function test_buyNo_bidAboveOne() public {
        _bid(1_100_000, 1000e6);
        _give(usdc, alice, 0);
        vm.prank(alice);
        assertEq(router.buyNo(address(market), 100e6, 0, deadline), 0);
        assertEq(no.balanceOf(alice), 100e6);
        assertEq(usdc.balanceOf(alice), 10e6);
        _assertRouterClean();
    }

    function test_buyNo_needsApproval() public {
        _bid(600_000, 1000e6);
        usdc.mint(alice, 40e6);
        vm.prank(alice);
        vm.expectRevert();
        router.buyNo(address(market), 100e6, 40e6, deadline);
    }

    // ---------------------------------------------------------------- sellNo

    /// Sell 100 NO with asks at 0.40: borrow 40, buy 100 YES, merge 100 sets, repay 40, alice gets 60.
    function test_sellNo_basic() public {
        _ask(400_000, 1000e6);
        _giveNo(alice, 100e6);
        assertEq(router.quoteSellNo(address(market), 100e6), 40e6);

        vm.expectEmit(address(router));
        emit IHunchRouter.Trade(address(market), alice, IHunchRouter.Kind.SellNo, 100e6, 60e6, address(book));
        vm.prank(alice);
        assertEq(router.sellNo(address(market), 100e6, 60e6, deadline), 60e6);
        assertEq(usdc.balanceOf(alice), 60e6);
        assertEq(no.balanceOf(alice), 0);
        assertEq(yes.balanceOf(alice), 0);
        assertEq(vault.sets(address(market)), 0);
        _assertRouterClean();
    }

    /// With a fee the router buys a little more: the least quote that nets 100 YES after 0.07%.
    function test_sellNo_takerFeeQuoteIsMinimal() public {
        _useBook(7000);
        _ask(400_000, 1000e6);
        _giveNo(alice, 100e6);
        uint256 q = router.quoteSellNo(address(market), 100e6);
        assertGe(_estimate(true, q).amountOut, 100e6);
        assertLt(_estimate(true, q - 1).amountOut, 100e6);
        vm.prank(alice);
        uint256 out = router.sellNo(address(market), 100e6, 0, deadline);
        assertEq(out + q, 100e6 + _leftover(q, 100e6));
        _assertRouterClean();
    }

    /// Quote Kuru leaves unused and YES above the target both go to the caller.
    function _leftover(uint256 q, uint256) internal view returns (uint256) {
        return q - _estimate(true, q).amountInUsed;
    }

    /// 50 YES at 0.30 (15 USDC) then 50 at 0.50 (25): quote 40, alice gets 60.
    function test_sellNo_walksLevels() public {
        _ask(300_000, 50e6);
        _ask(500_000, 1000e6);
        _giveNo(alice, 100e6);
        assertEq(router.quoteSellNo(address(market), 100e6), 40e6);
        vm.prank(alice);
        assertEq(router.sellNo(address(market), 100e6, 0, deadline), 60e6);
        _assertRouterClean();
    }

    /// Many small levels: the search still lands on the least quote.
    function test_sellNo_manyLevelsQuoteIsMinimal() public {
        for (uint256 i; i < 40; ++i) {
            // forge-lint: disable-next-line(unsafe-typecast)
            _ask(uint32(100_000 + i * 7000), uint96(1e6 + i * 333_333));
        }
        _giveNo(alice, 50e6);
        uint256 q = router.quoteSellNo(address(market), 50e6);
        assertGe(_estimate(true, q).amountOut, 50e6);
        assertLt(_estimate(true, q - 1).amountOut, 50e6);
        vm.prank(alice);
        router.sellNo(address(market), 50e6, 0, deadline);
        _assertRouterClean();
    }

    function test_sellNo_insufficientLiquidity() public {
        _ask(400_000, 10e6);
        _giveNo(alice, 100e6);
        vm.expectRevert(HunchRouterV2.InsufficientLiquidity.selector);
        router.quoteSellNo(address(market), 100e6);
        vm.prank(alice);
        vm.expectRevert(HunchRouterV2.InsufficientLiquidity.selector);
        router.sellNo(address(market), 100e6, 0, deadline);
    }

    function test_sellNo_minOutBoundary() public {
        _ask(400_000, 1000e6);
        _giveNo(alice, 100e6);
        uint256 snap = vm.snapshotState();
        vm.prank(alice);
        router.sellNo(address(market), 100e6, 60e6, deadline);
        vm.revertToState(snap);
        vm.prank(alice);
        vm.expectRevert(IHunchRouter.Slippage.selector);
        router.sellNo(address(market), 100e6, 60e6 + 1, deadline);
    }

    /// YES at or above 1 USDC: buying it costs more than the merge returns; the seller never pays.
    function test_sellNo_askAboveOneReverts() public {
        _ask(1_100_000, 1000e6);
        _giveNo(alice, 100e6);
        vm.prank(alice);
        vm.expectRevert(IHunchRouter.Slippage.selector);
        router.sellNo(address(market), 100e6, 0, deadline);
    }

    function test_sellNo_ignoresDonationsToTheRouter() public {
        usdc.mint(address(router), 5);
        yes.mint(address(router), 7);
        no.mint(address(router), 9);
        _ask(400_000, 1000e6);
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
        vm.expectRevert(HunchRouterV2.OnlyVault.selector);
        router.onFlashLoan(address(router), 1e6, _buyNoData(1e6, 1e6));
    }

    function test_onFlashLoan_rejectsUnrequestedCallback() public {
        vm.expectRevert(HunchRouterV2.UnexpectedFlashLoan.selector);
        vault.callOnFlashLoan(address(router), address(router), 1e6, _buyNoData(1e6, 1e6));
    }

    function test_onFlashLoan_rejectsForeignInitiator() public {
        _bid(600_000, 1000e6);
        _give(usdc, alice, 1000e6);
        vm.prank(attacker);
        vm.expectRevert(HunchRouterV2.UnexpectedFlashLoan.selector);
        vault.flashLoan(address(router), 100e6, _buyNoData(100e6, 1000e6));
        assertEq(usdc.balanceOf(alice), 1000e6);
    }

    function test_onFlashLoan_rejectsTamperedAmount() public {
        _bid(600_000, 1000e6);
        _give(usdc, alice, 100e6);
        vault.setTamper(1, false, "");
        vm.prank(alice);
        vm.expectRevert(HunchRouterV2.UnexpectedFlashLoan.selector);
        router.buyNo(address(market), 100e6, 40e6, deadline);
    }

    function test_onFlashLoan_rejectsTamperedData() public {
        _bid(600_000, 1000e6);
        _give(usdc, alice, 100e6);
        vault.setTamper(0, true, _buyNoData(100e6, type(uint256).max));
        vm.prank(alice);
        vm.expectRevert(HunchRouterV2.UnexpectedFlashLoan.selector);
        router.buyNo(address(market), 100e6, 40e6, deadline);
    }

    /// The book tries to start a second loan to the router from inside the first one.
    function test_onFlashLoan_rejectsNestedLoan() public {
        _bid(600_000, 1000e6);
        _give(usdc, alice, 100e6);
        book.setReenter(address(vault), abi.encodeCall(MockVaultForRouter.flashLoan, (address(router), 1e6, "")));
        vm.prank(alice);
        vm.expectRevert(HunchRouterV2.UnexpectedFlashLoan.selector);
        router.buyNo(address(market), 100e6, 40e6, deadline);
    }
}

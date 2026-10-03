// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {HunchRouter} from "../../src/core/HunchRouter.sol";
import {IHunchBookFactory} from "../../src/interfaces/IHunchBookFactory.sol";
import {Phase} from "../../src/interfaces/IHunchBookTypes.sol";
import {IHunchRouter} from "../../src/interfaces/IHunchRouter.sol";
import {MockKuruOrderBook} from "../mocks/MockKuruOrderBook.sol";
import {MockFactoryForRouter, MockMarketForRouter} from "../mocks/MockMarketForRouter.sol";
import {MockTokenForRouter, MockVaultForRouter} from "../mocks/MockVaultForRouter.sol";
import {HunchRouterBase} from "./HunchRouterBase.sol";

/// Constructor, checks shared by every path, buyYes and sellYes.
contract HunchRouterYesTest is HunchRouterBase {
    // ---------------------------------------------------------------- constructor

    function test_constructor_readsFactory() public view {
        assertEq(address(router.factory()), address(factory));
        assertEq(address(router.vault()), address(vault));
        assertEq(router.usdc(), address(usdc));
    }

    /// External so `vm.expectRevert` covers exactly this deployment and the test carries on after it.
    function deployRouter(address f) external returns (HunchRouter) {
        return new HunchRouter(IHunchBookFactory(f));
    }

    function test_constructor_reverts() public {
        vm.expectRevert(HunchRouter.ZeroAddress.selector);
        this.deployRouter(address(0));

        MockFactoryForRouter noVault = new MockFactoryForRouter(address(0), address(usdc));
        vm.expectRevert(HunchRouter.ZeroAddress.selector);
        this.deployRouter(address(noVault));

        MockFactoryForRouter noUsdc = new MockFactoryForRouter(address(vault), address(0));
        vm.expectRevert(HunchRouter.ZeroAddress.selector);
        this.deployRouter(address(noUsdc));

        MockVaultForRouter otherVault = new MockVaultForRouter(address(yes));
        MockFactoryForRouter mismatch = new MockFactoryForRouter(address(otherVault), address(usdc));
        vm.expectRevert(HunchRouter.CollateralMismatch.selector);
        this.deployRouter(address(mismatch));

        assertEq(address(this.deployRouter(address(factory)).vault()), address(vault));
    }

    // ---------------------------------------------------------------- shared checks

    function test_allPaths_revertZeroAmount() public {
        vm.startPrank(alice);
        vm.expectRevert(IHunchRouter.ZeroAmount.selector);
        router.buyYes(address(market), 0, 0, deadline);
        vm.expectRevert(IHunchRouter.ZeroAmount.selector);
        router.sellYes(address(market), 0, 0, deadline);
        vm.expectRevert(IHunchRouter.ZeroAmount.selector);
        router.buyNo(address(market), 0, 0, deadline);
        vm.expectRevert(IHunchRouter.ZeroAmount.selector);
        router.sellNo(address(market), 0, 0, deadline);
        vm.stopPrank();
    }

    function test_allPaths_revertExpired() public {
        uint256 past = block.timestamp - 1;
        vm.startPrank(alice);
        vm.expectRevert(IHunchRouter.Expired.selector);
        router.buyYes(address(market), 1e6, 0, past);
        vm.expectRevert(IHunchRouter.Expired.selector);
        router.sellYes(address(market), 1e6, 0, past);
        vm.expectRevert(IHunchRouter.Expired.selector);
        router.buyNo(address(market), 1e6, 1e6, past);
        vm.expectRevert(IHunchRouter.Expired.selector);
        router.sellNo(address(market), 1e6, 0, past);
        vm.stopPrank();
    }

    /// The deadline is inclusive.
    function test_deadlineIsInclusive() public {
        book.addAsk(500_000, 100e6);
        _give(usdc, alice, 10e6);
        vm.prank(alice);
        assertEq(router.buyYes(address(market), 10e6, 0, block.timestamp), 20e6);
    }

    function test_allPaths_revertUnknownMarket() public {
        MockMarketForRouter stranger = new MockMarketForRouter(address(yes), address(no), POOL_CAP);
        stranger.setPhase(Phase.Graduated);
        stranger.setBook(address(book));
        address m = address(stranger);
        vm.startPrank(alice);
        vm.expectRevert(IHunchRouter.UnknownMarket.selector);
        router.buyYes(m, 1e6, 0, deadline);
        vm.expectRevert(IHunchRouter.UnknownMarket.selector);
        router.sellYes(m, 1e6, 0, deadline);
        vm.expectRevert(IHunchRouter.UnknownMarket.selector);
        router.buyNo(m, 1e6, 1e6, deadline);
        vm.expectRevert(IHunchRouter.UnknownMarket.selector);
        router.sellNo(m, 1e6, 0, deadline);
        vm.stopPrank();
    }

    /// Every phase except Graduated refuses router trades (Closed = past close).
    function testFuzz_allPaths_revertUnlessGraduated(uint8 p) public {
        p = uint8(bound(p, 0, 5));
        vm.assume(p != uint8(Phase.Graduated));
        market.setPhase(Phase(p));
        vm.startPrank(alice);
        vm.expectRevert(IHunchRouter.NotTradable.selector);
        router.buyYes(address(market), 1e6, 0, deadline);
        vm.expectRevert(IHunchRouter.NotTradable.selector);
        router.sellYes(address(market), 1e6, 0, deadline);
        vm.expectRevert(IHunchRouter.NotTradable.selector);
        router.buyNo(address(market), 1e6, 1e6, deadline);
        vm.expectRevert(IHunchRouter.NotTradable.selector);
        router.sellNo(address(market), 1e6, 0, deadline);
        vm.stopPrank();
    }

    function test_allPaths_revertWithoutBook() public {
        market.setBook(address(0));
        vm.startPrank(alice);
        vm.expectRevert(IHunchRouter.NotTradable.selector);
        router.buyYes(address(market), 1e6, 0, deadline);
        vm.expectRevert(IHunchRouter.NotTradable.selector);
        router.sellYes(address(market), 1e6, 0, deadline);
        vm.expectRevert(IHunchRouter.NotTradable.selector);
        router.buyNo(address(market), 1e6, 1e6, deadline);
        vm.expectRevert(IHunchRouter.NotTradable.selector);
        router.sellNo(address(market), 1e6, 0, deadline);
        vm.stopPrank();
    }

    function test_reentryIsBlocked() public {
        book.addAsk(500_000, 100e6);
        _give(usdc, alice, 10e6);
        book.setReenter(
            address(router), abi.encodeCall(IHunchRouter.sellYes, (address(market), 1e6, 0, block.timestamp))
        );
        vm.prank(alice);
        vm.expectRevert(HunchRouter.Reentrancy.selector);
        router.buyYes(address(market), 10e6, 0, deadline);
    }

    function test_amountAboveKuruRangeReverts() public {
        uint256 tooMuch = uint256(type(uint96).max) + 1;
        book.addAsk(500_000, 100e6);
        _give(usdc, alice, tooMuch);
        vm.prank(alice);
        vm.expectRevert(HunchRouter.AmountTooLarge.selector);
        router.buyYes(address(market), tooMuch, 0, deadline);
    }

    // ---------------------------------------------------------------- buyYes

    function test_buyYes_singleLevel() public {
        book.addAsk(400_000, 1000e6);
        _give(usdc, alice, 100e6);

        vm.expectEmit(address(router));
        emit IHunchRouter.Trade(address(market), alice, IHunchRouter.Kind.BuyYes, 100e6, 250e6, address(book));
        vm.prank(alice);
        uint256 out = router.buyYes(address(market), 100e6, 250e6, deadline);

        assertEq(out, 250e6);
        assertEq(yes.balanceOf(alice), 250e6);
        assertEq(usdc.balanceOf(alice), 0);
        assertEq(book.lastAllowance(), 100e6, "exact approval");
        _assertRouterClean();
    }

    /// 0.40 x 100 then 0.45: 100 YES for 40 USDC, then floor(60e6 * 1e6 / 450000) = 133333333.
    function test_buyYes_walksLevels() public {
        book.addAsk(400_000, 100e6);
        book.addAsk(450_000, 200e6);
        _give(usdc, alice, 100e6);
        vm.prank(alice);
        uint256 out = router.buyYes(address(market), 100e6, 0, deadline);
        assertEq(out, 233_333_333);
        assertEq(yes.balanceOf(alice), 233_333_333);
        assertEq(usdc.balanceOf(alice), 0);
        _assertRouterClean();
    }

    /// Taker fee 30 bps on the base: 233333333 - ceil(233333333 * 30 / 1e4) = 232633333.
    function test_buyYes_takerFee() public {
        _useBook(30);
        book.addAsk(400_000, 100e6);
        book.addAsk(450_000, 200e6);
        _give(usdc, alice, 100e6);
        vm.prank(alice);
        assertEq(router.buyYes(address(market), 100e6, 0, deadline), 232_633_333);
        _assertRouterClean();
    }

    /// Asks run out: 50 YES for 20 USDC, the other 80 USDC comes back.
    function test_buyYes_refundsUnspentQuote() public {
        book.addAsk(400_000, 50e6);
        _give(usdc, alice, 100e6);
        vm.expectEmit(address(router));
        emit IHunchRouter.Trade(address(market), alice, IHunchRouter.Kind.BuyYes, 20e6, 50e6, address(book));
        vm.prank(alice);
        assertEq(router.buyYes(address(market), 100e6, 0, deadline), 50e6);
        assertEq(usdc.balanceOf(alice), 80e6);
        _assertRouterClean();
    }

    function test_buyYes_minOutBoundary() public {
        book.addAsk(400_000, 1000e6);
        _give(usdc, alice, 200e6);
        uint256 snap = vm.snapshotState();
        vm.prank(alice);
        router.buyYes(address(market), 100e6, 250e6, deadline); // exactly the minimum: passes
        vm.revertToState(snap);
        vm.prank(alice);
        vm.expectRevert(MockKuruOrderBook.SlippageExceeded.selector);
        router.buyYes(address(market), 100e6, 250e6 + 1, deadline);
    }

    /// Kuru's return value says 250 YES but only 250 YES - 1 arrives: the router measures, and reverts.
    function test_buyYes_checksBalancesNotReturnValues() public {
        book.addAsk(400_000, 1000e6);
        book.setShort(1, 0);
        _give(usdc, alice, 100e6);
        vm.prank(alice);
        vm.expectRevert(IHunchRouter.Slippage.selector);
        router.buyYes(address(market), 100e6, 250e6, deadline);
    }

    function test_buyYes_emptyBookReverts() public {
        _give(usdc, alice, 100e6);
        vm.prank(alice);
        vm.expectRevert(HunchRouter.InsufficientLiquidity.selector);
        router.buyYes(address(market), 100e6, 0, deadline);
    }

    /// Tokens someone sent to the router are neither used nor paid out.
    function test_buyYes_ignoresDonations() public {
        usdc.mint(address(router), 5);
        yes.mint(address(router), 7);
        book.addAsk(400_000, 1000e6);
        _give(usdc, alice, 100e6);
        vm.prank(alice);
        assertEq(router.buyYes(address(market), 100e6, 0, deadline), 250e6);
        assertEq(yes.balanceOf(alice), 250e6);
        assertEq(usdc.balanceOf(address(router)), 5);
        assertEq(yes.balanceOf(address(router)), 7);
    }

    // ---------------------------------------------------------------- sellYes

    function test_sellYes_singleLevel() public {
        book.addBid(600_000, 1000e6);
        _give(yes, alice, 100e6);
        vm.expectEmit(address(router));
        emit IHunchRouter.Trade(address(market), alice, IHunchRouter.Kind.SellYes, 100e6, 60e6, address(book));
        vm.prank(alice);
        assertEq(router.sellYes(address(market), 100e6, 60e6, deadline), 60e6);
        assertEq(usdc.balanceOf(alice), 60e6);
        assertEq(yes.balanceOf(alice), 0);
        assertEq(book.lastAllowance(), 100e6, "exact approval");
        _assertRouterClean();
    }

    /// 50 at 0.60 = 30 USDC, then 70 at 0.55 = 38.5 USDC.
    function test_sellYes_walksLevels() public {
        book.addBid(600_000, 50e6);
        book.addBid(550_000, 100e6);
        _give(yes, alice, 120e6);
        vm.prank(alice);
        assertEq(router.sellYes(address(market), 120e6, 0, deadline), 68_500_000);
        _assertRouterClean();
    }

    /// Fee on the quote: 60e6 - ceil(60e6 * 30 / 1e4) = 59820000.
    function test_sellYes_takerFee() public {
        _useBook(30);
        book.addBid(600_000, 1000e6);
        _give(yes, alice, 100e6);
        vm.prank(alice);
        assertEq(router.sellYes(address(market), 100e6, 0, deadline), 59_820_000);
        _assertRouterClean();
    }

    function test_sellYes_returnsUnsoldYes() public {
        book.addBid(600_000, 50e6);
        _give(yes, alice, 100e6);
        vm.expectEmit(address(router));
        emit IHunchRouter.Trade(address(market), alice, IHunchRouter.Kind.SellYes, 50e6, 30e6, address(book));
        vm.prank(alice);
        assertEq(router.sellYes(address(market), 100e6, 0, deadline), 30e6);
        assertEq(yes.balanceOf(alice), 50e6);
        assertEq(usdc.balanceOf(alice), 30e6);
        _assertRouterClean();
    }

    function test_sellYes_minOutBoundary() public {
        book.addBid(600_000, 1000e6);
        _give(yes, alice, 200e6);
        uint256 snap = vm.snapshotState();
        vm.prank(alice);
        router.sellYes(address(market), 100e6, 60e6, deadline);
        vm.revertToState(snap);
        vm.prank(alice);
        vm.expectRevert(MockKuruOrderBook.SlippageExceeded.selector);
        router.sellYes(address(market), 100e6, 60e6 + 1, deadline);
    }

    function test_sellYes_checksBalancesNotReturnValues() public {
        book.addBid(600_000, 1000e6);
        book.setShort(0, 1);
        _give(yes, alice, 100e6);
        vm.prank(alice);
        vm.expectRevert(IHunchRouter.Slippage.selector);
        router.sellYes(address(market), 100e6, 60e6, deadline);
    }

    function test_sellYes_emptyBookReverts() public {
        _give(yes, alice, 100e6);
        vm.prank(alice);
        vm.expectRevert(HunchRouter.InsufficientLiquidity.selector);
        router.sellYes(address(market), 100e6, 0, deadline);
    }

    function test_sellYes_needsApproval() public {
        book.addBid(600_000, 1000e6);
        yes.mint(alice, 100e6);
        vm.prank(alice);
        vm.expectRevert();
        router.sellYes(address(market), 100e6, 0, deadline);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {HunchRouterV2} from "../../src/core/HunchRouterV2.sol";
import {IHunchBookFactory} from "../../src/interfaces/IHunchBookFactory.sol";
import {Phase} from "../../src/interfaces/IHunchBookTypes.sol";
import {IHunchRouter} from "../../src/interfaces/IHunchRouter.sol";
import {IKuruAccountCore} from "../../src/interfaces/external/IKuruV2.sol";
import {MockFactoryForRouter, MockMarketForRouter} from "../mocks/MockMarketForRouter.sol";
import {MockKuruAccountCoreV2, MockKuruSpotOrderBookV2, MockKuruWithdrawalLimiterV2} from "../mocks/MockKuruV2.sol";
import {MockVaultForRouter} from "../mocks/MockVaultForRouter.sol";
import {HunchRouterV2Base} from "./HunchRouterV2Base.sol";

/// Constructor, checks shared by every path, buyYes, sellYes and Kuru-side failures.
contract HunchRouterV2YesTest is HunchRouterV2Base {
    // ---------------------------------------------------------------- constructor

    function test_constructor_readsFactoryAndOpensAccount() public view {
        assertEq(address(router.factory()), address(factory));
        assertEq(address(router.vault()), address(vault));
        assertEq(router.usdc(), address(usdc));
        assertEq(address(router.accountCore()), address(core));
        uint40 id = router.accountId();
        assertTrue(id != 0);
        assertEq(core.ownerOf(id), address(router));
        assertEq(core.rootAccountIdOf(address(router)), id);
    }

    /// External so `vm.expectRevert` covers exactly this deployment and the test carries on after it.
    function deployRouter(address f, address c) external returns (HunchRouterV2) {
        return new HunchRouterV2(IHunchBookFactory(f), IKuruAccountCore(c));
    }

    function test_constructor_reverts() public {
        vm.expectRevert(HunchRouterV2.ZeroAddress.selector);
        this.deployRouter(address(0), address(core));
        vm.expectRevert(HunchRouterV2.ZeroAddress.selector);
        this.deployRouter(address(factory), address(0));

        MockFactoryForRouter noVault = new MockFactoryForRouter(address(0), address(usdc));
        vm.expectRevert(HunchRouterV2.ZeroAddress.selector);
        this.deployRouter(address(noVault), address(core));

        MockFactoryForRouter noUsdc = new MockFactoryForRouter(address(vault), address(0));
        vm.expectRevert(HunchRouterV2.ZeroAddress.selector);
        this.deployRouter(address(noUsdc), address(core));

        MockVaultForRouter otherVault = new MockVaultForRouter(address(yes));
        MockFactoryForRouter mismatch = new MockFactoryForRouter(address(otherVault), address(usdc));
        vm.expectRevert(HunchRouterV2.CollateralMismatch.selector);
        this.deployRouter(address(mismatch), address(core));
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

    function test_deadlineIsInclusive() public {
        _ask(500_000, 100e6);
        _give(usdc, alice, 10e6);
        vm.prank(alice);
        assertEq(router.buyYes(address(market), 10e6, 0, block.timestamp), 20e6);
        _assertRouterClean();
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
        _ask(500_000, 100e6);
        _give(usdc, alice, 10e6);
        book.setReenter(
            address(router), abi.encodeCall(IHunchRouter.sellYes, (address(market), 1e6, 0, block.timestamp))
        );
        vm.prank(alice);
        vm.expectRevert(HunchRouterV2.Reentrancy.selector);
        router.buyYes(address(market), 10e6, 0, deadline);
    }

    function test_amountAboveKuruRangeReverts() public {
        uint256 tooMuch = uint256(type(uint128).max) + 1;
        _ask(500_000, 100e6);
        _give(usdc, alice, tooMuch);
        vm.prank(alice);
        vm.expectRevert(HunchRouterV2.AmountTooLarge.selector);
        router.buyYes(address(market), tooMuch, 0, deadline);
    }

    // ---------------------------------------------------------------- buyYes

    /// 100 USDC at 0.40: 250 YES.
    function test_buyYes_singleLevel() public {
        _ask(400_000, 1000e6);
        _give(usdc, alice, 100e6);
        vm.expectEmit(address(router));
        emit IHunchRouter.Trade(address(market), alice, IHunchRouter.Kind.BuyYes, 100e6, 250e6, address(book));
        vm.prank(alice);
        uint256 out = router.buyYes(address(market), 100e6, 250e6, deadline);
        assertEq(out, 250e6);
        assertEq(yes.balanceOf(alice), 250e6);
        assertEq(usdc.balanceOf(alice), 0);
        assertEq(core.getBalance(makerId, address(usdc)), 100e6, "maker paid");
        _assertRouterClean();
    }

    /// 50 YES at 0.40 (20 USDC), then 30 USDC at 0.50 = 60 YES: 110 YES for 50 USDC.
    function test_buyYes_walksLevels() public {
        _ask(400_000, 50e6);
        _ask(500_000, 1000e6);
        _give(usdc, alice, 50e6);
        vm.prank(alice);
        assertEq(router.buyYes(address(market), 50e6, 0, deadline), 110e6);
        _assertRouterClean();
    }

    /// Fee 7000 pps (0.07%) on 250 YES: ceil(250e6 * 7000 / 1e7) = 175000, so 249825000 YES.
    function test_buyYes_takerFee() public {
        _useBook(7000);
        _ask(400_000, 1000e6);
        _give(usdc, alice, 100e6);
        vm.prank(alice);
        assertEq(router.buyYes(address(market), 100e6, 0, deadline), 249_825_000);
        assertEq(core.getBalance(core.feeAccount(), address(yes)), 175_000);
        _assertRouterClean();
    }

    /// The router's own fee tier applies (AccountCore can override a book's fee per account).
    function test_buyYes_usesTheRoutersFeeTier() public {
        _useBook(7000);
        core.setTakerFeeOverride(router.accountId(), 1);
        _ask(400_000, 1000e6);
        _give(usdc, alice, 100e6);
        vm.prank(alice);
        assertEq(router.buyYes(address(market), 100e6, 0, deadline), 250e6 - 25);
    }

    /// Asks run out: 100 YES at 0.40 cost 40 USDC; the other 60 come back.
    function test_buyYes_refundsUnspentQuote() public {
        _ask(400_000, 100e6);
        _give(usdc, alice, 100e6);
        vm.expectEmit(address(router));
        emit IHunchRouter.Trade(address(market), alice, IHunchRouter.Kind.BuyYes, 40e6, 100e6, address(book));
        vm.prank(alice);
        assertEq(router.buyYes(address(market), 100e6, 0, deadline), 100e6);
        assertEq(usdc.balanceOf(alice), 60e6);
        _assertRouterClean();
    }

    function test_buyYes_minOutBoundary() public {
        _ask(400_000, 1000e6);
        _give(usdc, alice, 200e6);
        uint256 snap = vm.snapshotState();
        vm.prank(alice);
        router.buyYes(address(market), 100e6, 250e6, deadline);
        vm.revertToState(snap);
        vm.prank(alice);
        vm.expectRevert(MockKuruSpotOrderBookV2.SlippageExceeded.selector);
        router.buyYes(address(market), 100e6, 250e6 + 1, deadline);
    }

    function test_buyYes_emptyBookReverts() public {
        _give(usdc, alice, 100e6);
        vm.prank(alice);
        vm.expectRevert(HunchRouterV2.InsufficientLiquidity.selector);
        router.buyYes(address(market), 100e6, 0, deadline);
    }

    /// Tokens sent to the router itself are neither used nor paid out.
    function test_buyYes_ignoresDonationsToTheRouter() public {
        usdc.mint(address(router), 5);
        yes.mint(address(router), 7);
        _ask(400_000, 1000e6);
        _give(usdc, alice, 100e6);
        vm.prank(alice);
        assertEq(router.buyYes(address(market), 100e6, 0, deadline), 250e6);
        assertEq(usdc.balanceOf(address(router)), 5);
        assertEq(yes.balanceOf(address(router)), 7);
    }

    /// Tokens someone deposits into the router's Kuru account go to the next trader: the account ends empty.
    function test_buyYes_paysOutDepositsIntoTheRoutersAccount() public {
        address donor = makeAddr("donor");
        yes.mint(donor, 3e6);
        vm.startPrank(donor);
        yes.approve(address(core), 3e6);
        core.deposit(router.accountId(), address(yes), 3e6);
        vm.stopPrank();

        _ask(400_000, 1000e6);
        _give(usdc, alice, 100e6);
        vm.prank(alice);
        assertEq(router.buyYes(address(market), 100e6, 0, deadline), 253e6);
        _assertRouterClean();
    }

    // ---------------------------------------------------------------- sellYes

    /// 100 YES into a 0.60 bid: 60 USDC.
    function test_sellYes_singleLevel() public {
        _bid(600_000, 1000e6);
        _give(yes, alice, 100e6);
        vm.expectEmit(address(router));
        emit IHunchRouter.Trade(address(market), alice, IHunchRouter.Kind.SellYes, 100e6, 60e6, address(book));
        vm.prank(alice);
        assertEq(router.sellYes(address(market), 100e6, 60e6, deadline), 60e6);
        assertEq(usdc.balanceOf(alice), 60e6);
        assertEq(yes.balanceOf(alice), 0);
        _assertRouterClean();
    }

    function test_sellYes_walksLevels() public {
        _bid(600_000, 50e6);
        _bid(500_000, 1000e6);
        _give(yes, alice, 100e6);
        vm.prank(alice);
        assertEq(router.sellYes(address(market), 100e6, 0, deadline), 55e6);
        _assertRouterClean();
    }

    /// Fee 7000 pps on 60 USDC: 42000.
    function test_sellYes_takerFee() public {
        _useBook(7000);
        _bid(600_000, 1000e6);
        _give(yes, alice, 100e6);
        vm.prank(alice);
        assertEq(router.sellYes(address(market), 100e6, 0, deadline), 60e6 - 42_000);
        _assertRouterClean();
    }

    /// One YES unit left after the first level is worth less than one USDC unit at 0.50: Kuru stops there
    /// and the unit comes back.
    function test_sellYes_dustComesBack() public {
        _bid(600_000, 10e6);
        _bid(500_000, 100e6);
        _give(yes, alice, 10e6 + 1);
        vm.prank(alice);
        assertEq(router.sellYes(address(market), 10e6 + 1, 0, deadline), 6e6);
        assertEq(yes.balanceOf(alice), 1);
        _assertRouterClean();
    }

    /// Bids absorb 40 of 100 YES: the other 60 come back.
    function test_sellYes_returnsUnsoldYes() public {
        _bid(600_000, 40e6);
        _give(yes, alice, 100e6);
        vm.expectEmit(address(router));
        emit IHunchRouter.Trade(address(market), alice, IHunchRouter.Kind.SellYes, 40e6, 24e6, address(book));
        vm.prank(alice);
        assertEq(router.sellYes(address(market), 100e6, 0, deadline), 24e6);
        assertEq(yes.balanceOf(alice), 60e6);
        _assertRouterClean();
    }

    function test_sellYes_minOutBoundary() public {
        _bid(600_000, 1000e6);
        _give(yes, alice, 200e6);
        uint256 snap = vm.snapshotState();
        vm.prank(alice);
        router.sellYes(address(market), 100e6, 60e6, deadline);
        vm.revertToState(snap);
        vm.prank(alice);
        vm.expectRevert(MockKuruSpotOrderBookV2.SlippageExceeded.selector);
        router.sellYes(address(market), 100e6, 60e6 + 1, deadline);
    }

    function test_sellYes_emptyBookReverts() public {
        _give(yes, alice, 100e6);
        vm.prank(alice);
        vm.expectRevert(HunchRouterV2.InsufficientLiquidity.selector);
        router.sellYes(address(market), 100e6, 0, deadline);
    }

    function test_sellYes_needsApproval() public {
        _bid(600_000, 1000e6);
        yes.mint(alice, 100e6);
        vm.prank(alice);
        vm.expectRevert();
        router.sellYes(address(market), 100e6, 0, deadline);
    }

    // ---------------------------------------------------------------- Kuru-side failures

    /// A soft-paused book (state 1, set by Kuru at close) refuses swaps; the whole trade reverts.
    function test_pausedBookRevertsWholeTrade() public {
        _ask(400_000, 1000e6);
        book.setMarketState(1);
        _give(usdc, alice, 100e6);
        vm.prank(alice);
        vm.expectRevert(MockKuruSpotOrderBookV2.MarketPaused.selector);
        router.buyYes(address(market), 100e6, 0, deadline);
        assertEq(usdc.balanceOf(alice), 100e6);
        _assertRouterClean();
    }

    /// Kuru's protocol-wide withdrawal budget used up: the trade reverts and nothing stays in Kuru.
    function test_withdrawalLimitRevertsWholeTrade() public {
        _ask(400_000, 1000e6);
        limiter.setExhausted(true);
        _give(usdc, alice, 100e6);
        vm.prank(alice);
        vm.expectRevert(MockKuruWithdrawalLimiterV2.WithdrawalLimitExceeded.selector);
        router.buyYes(address(market), 100e6, 0, deadline);
        assertEq(usdc.balanceOf(alice), 100e6);
        _assertRouterClean();
    }

    function test_frozenWithdrawalsRevertWholeTrade() public {
        _bid(600_000, 1000e6);
        core.setWithdrawalsFrozen(true);
        _give(yes, alice, 100e6);
        vm.prank(alice);
        vm.expectRevert(MockKuruAccountCoreV2.WithdrawalsFrozen.selector);
        router.sellYes(address(market), 100e6, 0, deadline);
        assertEq(yes.balanceOf(alice), 100e6);
    }

    /// A token AccountCore has not enabled cannot be deposited (the Graduator refuses such books).
    function test_disabledTokenReverts() public {
        _bid(600_000, 1000e6);
        core.configureSpotToken(address(yes), false);
        _give(yes, alice, 100e6);
        vm.prank(alice);
        vm.expectRevert(MockKuruAccountCoreV2.TokenNotEnabled.selector);
        router.sellYes(address(market), 100e6, 0, deadline);
    }
}

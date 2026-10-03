// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {HunchRouter} from "../../src/core/HunchRouter.sol";
import {HunchRouterBase} from "./HunchRouterBase.sol";

/// Every path against random books and fees, checked against the reference model in the mock book
/// (`previewMarketBuy` / `previewMarketSell`, which reproduce Kuru's integer arithmetic).
contract HunchRouterFuzzTest is HunchRouterBase {
    address internal minter = makeAddr("minter");

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

    function testFuzz_buyYes(uint256 usdcIn, uint256 seed, uint256 fee) public {
        _useBook(bound(fee, 0, 100));
        _randomAsks(seed);
        usdcIn = bound(usdcIn, 1, 3000e6);
        (uint256 credit, uint256 refund) = book.previewMarketBuy(usdcIn);
        _give(usdc, alice, usdcIn);

        vm.prank(alice);
        if (credit == 0) {
            vm.expectRevert(HunchRouter.InsufficientLiquidity.selector);
            router.buyYes(address(market), usdcIn, 0, deadline);
            return;
        }
        uint256 out = router.buyYes(address(market), usdcIn, credit, deadline);
        assertEq(out, credit);
        assertEq(yes.balanceOf(alice), credit);
        assertEq(usdc.balanceOf(alice), refund);
        _assertRouterClean();
    }

    function testFuzz_sellYes(uint256 yesIn, uint256 seed, uint256 fee) public {
        _useBook(bound(fee, 0, 100));
        _randomBids(seed);
        yesIn = bound(yesIn, 1, 3000e6);
        (uint256 credit, uint256 unsold) = book.previewMarketSell(yesIn);
        _give(yes, alice, yesIn);

        vm.prank(alice);
        if (credit == 0) {
            vm.expectRevert(HunchRouter.InsufficientLiquidity.selector);
            router.sellYes(address(market), yesIn, 0, deadline);
            return;
        }
        uint256 out = router.sellYes(address(market), yesIn, credit, deadline);
        assertEq(out, credit);
        assertEq(usdc.balanceOf(alice), credit);
        assertEq(yes.balanceOf(alice), unsold);
        _assertRouterClean();
    }

    function testFuzz_buyNo(uint256 noOut, uint256 seed, uint256 fee) public {
        _useBook(bound(fee, 0, 100));
        uint256 depth = _randomBids(seed);
        noOut = bound(noOut, 1, depth);
        (uint256 proceeds, uint256 unsold) = book.previewMarketSell(noOut);
        assertEq(unsold, 0);
        uint256 cost = proceeds >= noOut ? 0 : noOut - proceeds;
        _give(usdc, alice, cost);
        int256 surplusBefore = vault.surplus();

        vm.prank(alice);
        uint256 paid = router.buyNo(address(market), noOut, cost, deadline);

        assertEq(paid, cost);
        assertEq(no.balanceOf(alice), noOut);
        assertEq(usdc.balanceOf(alice), 0);
        assertEq(yes.balanceOf(alice), 0);
        assertEq(vault.surplus(), surplusBefore);
        _assertRouterClean();
    }

    function testFuzz_buyNo_failsWhenBidsTooThin(uint256 seed, uint256 extra) public {
        uint256 depth = _randomBids(seed);
        uint256 noOut = depth + bound(extra, 1, 100e6);
        _give(usdc, alice, noOut);
        vm.prank(alice);
        vm.expectRevert(HunchRouter.InsufficientLiquidity.selector);
        router.buyNo(address(market), noOut, noOut, deadline);
    }

    /// The core sellNo property: the quote is the least that credits noIn YES after the fee, the seller
    /// receives exactly noIn - Q USDC, the extra YES is what Kuru's rounding gives and stays small.
    function testFuzz_sellNo(uint256 noIn, uint256 seed, uint256 fee) public {
        fee = bound(fee, 0, 100);
        _useBook(fee);
        uint256 depth = _randomAsks(seed);
        uint256 maxNo = depth * (10_000 - fee) / 10_000;
        vm.assume(maxNo > 0);
        noIn = bound(noIn, 1, maxNo);

        uint256 q = router.quoteSellNo(address(market), noIn);
        (uint256 credit, uint256 refund, uint256 filled) = book.previewMarketBuyFull(q);
        (uint256 creditLess,) = book.previewMarketBuy(q - 1);
        assertGe(credit, noIn, "quote buys enough");
        assertLt(creditLess, noIn, "quote is minimal");
        assertLe(credit - noIn, _extraYesBound(filled), "extra YES bounded");

        _giveNo(alice, noIn);
        if (q > noIn) {
            // Tiny sizes near 1 USDC with a fee: buying the YES costs more than the merge returns.
            vm.prank(alice);
            vm.expectRevert();
            router.sellNo(address(market), noIn, 0, deadline);
            return;
        }
        _sellNoAndCheck(noIn, q, credit, refund);
    }

    /// Under ceil(1e6 / p) per ask level the fill touches, plus 1 for the fee rounding.
    function _extraYesBound(uint256 filled) internal view returns (uint256 b) {
        b = 1;
        uint256 levels = book.askCount();
        uint256 cumulative;
        for (uint256 i; i < levels; ++i) {
            (uint32 price, uint96 size) = book.askAt(i);
            b += (1e6 + price - 1) / price;
            cumulative += size;
            if (cumulative >= filled) break;
        }
    }

    function _sellNoAndCheck(uint256 noIn, uint256 q, uint256 credit, uint256 refund) internal {
        int256 surplusBefore = vault.surplus();
        vm.prank(alice);
        uint256 out = router.sellNo(address(market), noIn, noIn - q, deadline);
        assertEq(out, noIn - q + refund);
        assertEq(usdc.balanceOf(alice), noIn - q + refund);
        assertEq(yes.balanceOf(alice), credit - noIn);
        assertEq(no.balanceOf(alice), 0);
        assertEq(vault.surplus(), surplusBefore);
        _assertRouterClean();
    }

    function testFuzz_sellNo_failsWhenAsksTooThin(uint256 seed, uint256 extra) public {
        uint256 depth = _randomAsks(seed);
        uint256 noIn = depth + bound(extra, 1, 100e6);
        _giveNo(alice, noIn);
        vm.prank(alice);
        vm.expectRevert(HunchRouter.InsufficientLiquidity.selector);
        router.sellNo(address(market), noIn, 0, deadline);
    }
}

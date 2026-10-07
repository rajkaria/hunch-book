// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {HunchRouterV2} from "../../src/core/HunchRouterV2.sol";
import {IHunchRouter} from "../../src/interfaces/IHunchRouter.sol";
import {KuruSwapResult} from "../../src/interfaces/external/IKuruV2.sol";
import {HunchRouterV2Base} from "./HunchRouterV2Base.sol";

/// Every path against random books and fees, checked against the mock book's own `estimateSwap` (the
/// same matching `swap` runs, as on Kuru).
contract HunchRouterV2FuzzTest is HunchRouterV2Base {
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
        _useBook(bound(fee, 0, 100_000));
        _randomAsks(seed);
        usdcIn = bound(usdcIn, 1, 3000e6);
        KuruSwapResult memory e = _estimate(true, usdcIn);
        _give(usdc, alice, usdcIn);

        vm.prank(alice);
        if (e.amountOut == 0) {
            vm.expectRevert(HunchRouterV2.InsufficientLiquidity.selector);
            router.buyYes(address(market), usdcIn, 0, deadline);
            return;
        }
        uint256 out = router.buyYes(address(market), usdcIn, e.amountOut, deadline);
        assertEq(out, e.amountOut);
        assertEq(yes.balanceOf(alice), e.amountOut);
        assertEq(usdc.balanceOf(alice), usdcIn - e.amountInUsed);
        _assertRouterClean();
    }

    function testFuzz_sellYes(uint256 yesIn, uint256 seed, uint256 fee) public {
        _useBook(bound(fee, 0, 100_000));
        _randomBids(seed);
        yesIn = bound(yesIn, 1, 3000e6);
        KuruSwapResult memory e = _estimate(false, yesIn);
        _give(yes, alice, yesIn);

        vm.prank(alice);
        if (e.amountOut == 0) {
            vm.expectRevert(HunchRouterV2.InsufficientLiquidity.selector);
            router.sellYes(address(market), yesIn, 0, deadline);
            return;
        }
        uint256 out = router.sellYes(address(market), yesIn, e.amountOut, deadline);
        assertEq(out, e.amountOut);
        assertEq(usdc.balanceOf(alice), e.amountOut);
        assertEq(yes.balanceOf(alice), yesIn - e.amountInUsed);
        _assertRouterClean();
    }

    /// The caller pays exactly noOut - proceeds (or nothing), gets noOut NO, and any YES the bids left.
    function testFuzz_buyNo(uint256 noOut, uint256 seed, uint256 fee) public {
        _useBook(bound(fee, 0, 100_000));
        _randomBids(seed);
        noOut = bound(noOut, 1, 3000e6);
        KuruSwapResult memory e = _estimate(false, noOut);
        uint256 cost = e.amountOut >= noOut ? 0 : noOut - e.amountOut;
        _give(usdc, alice, cost);

        vm.prank(alice);
        uint256 paid = router.buyNo(address(market), noOut, cost, deadline);
        assertEq(paid, cost);
        assertEq(no.balanceOf(alice), noOut);
        assertEq(yes.balanceOf(alice), noOut - e.amountInUsed);
        assertEq(usdc.balanceOf(alice), e.amountOut > noOut ? e.amountOut - noOut : 0);
        _assertRouterClean();
    }

    /// The quote is the least that buys noIn YES; the caller gets noIn - Q, the unused quote and the extra YES.
    function testFuzz_sellNo(uint256 noIn, uint256 seed, uint256 fee) public {
        _useBook(bound(fee, 0, 100_000));
        _randomAsks(seed);
        noIn = bound(noIn, 1, 3000e6);
        _giveNo(alice, noIn);

        KuruSwapResult memory atNoIn = _estimate(true, noIn);
        if (atNoIn.amountOut < noIn) {
            bytes4 why = _estimate(true, type(uint96).max).amountOut < noIn
                ? HunchRouterV2.InsufficientLiquidity.selector
                : IHunchRouter.Slippage.selector;
            vm.expectRevert(why);
            router.quoteSellNo(address(market), noIn);
            vm.prank(alice);
            vm.expectRevert(why);
            router.sellNo(address(market), noIn, 0, deadline);
            return;
        }

        uint256 q = router.quoteSellNo(address(market), noIn);
        KuruSwapResult memory e = _estimate(true, q);
        assertGe(e.amountOut, noIn, "quote buys enough");
        if (q > 1) assertLt(_estimate(true, q - 1).amountOut, noIn, "quote is the least");
        assertLe(q, noIn);

        vm.prank(alice);
        uint256 out = router.sellNo(address(market), noIn, 0, deadline);
        assertEq(out, noIn - q + (q - e.amountInUsed));
        assertEq(yes.balanceOf(alice), e.amountOut - noIn);
        assertEq(no.balanceOf(alice), 0);
        _assertRouterClean();
    }
}

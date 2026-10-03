// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {console2} from "forge-std/console2.sol";
import {Graduator} from "../../src/core/Graduator.sol";
import {HunchRouter} from "../../src/core/HunchRouter.sol";
import {IHunchBookFactory} from "../../src/interfaces/IHunchBookFactory.sol";
import {Phase} from "../../src/interfaces/IHunchBookTypes.sol";
import {IHunchRouter} from "../../src/interfaces/IHunchRouter.sol";
import {IKuruOrderBook} from "../../src/interfaces/external/IKuruOrderBook.sol";
import {MockTokenForRouter} from "../mocks/MockVaultForRouter.sol";
import {KuruForkBase} from "./KuruForkBase.sol";

/// All four router paths against a real Kuru book on a fork of Monad testnet, with real maker limit
/// orders resting in Kuru's MarginAccount. Every amount is computed by hand from Kuru's arithmetic.
///
/// Book (fees 0/0): asks 100 YES at 0.40 and 200 YES at 0.45; bids 100 YES at 0.35 and 300 YES at 0.30.
contract KuruRouterForkTest is KuruForkBase {
    Graduator internal grad;
    IKuruOrderBook internal book;
    HunchRouter internal router;

    address internal alice = makeAddr("alice");
    address internal minter = makeAddr("minter");
    address internal buyer = makeAddr("buyer");

    function setUp() public {
        _fork();
        grad = _graduator(true, _params(0, 0));
        book = IKuruOrderBook(grad.createBook(address(market)));
        market.setBook(address(book));
        market.setPhase(Phase.Graduated);
        router = new HunchRouter(IHunchBookFactory(address(factory)));
        usdc.mint(address(vault), 1_000_000e6);

        _rest(book, false, 400_000, 100e6);
        _rest(book, false, 450_000, 200e6);
        _rest(book, true, 350_000, 100e6);
        _rest(book, true, 300_000, 300e6);
    }

    // ---------------------------------------------------------------- helpers

    function _give(MockTokenForRouter token, address to, uint256 amount) internal {
        token.mint(to, amount);
        vm.prank(to);
        token.approve(address(router), type(uint256).max);
    }

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

    function _assertRouterClean() internal view {
        assertEq(usdc.balanceOf(address(router)), 0, "router USDC");
        assertEq(yes.balanceOf(address(router)), 0, "router YES");
        assertEq(no.balanceOf(address(router)), 0, "router NO");
        assertEq(usdc.allowance(address(router), address(book)), 0, "USDC allowance to book");
        assertEq(yes.allowance(address(router), address(book)), 0, "YES allowance to book");
        assertEq(usdc.allowance(address(router), address(vault)), 0, "USDC allowance to vault");
    }

    /// A plain wallet-path market buy straight on Kuru (no router), for checking the quote math.
    function _directBuy(IKuruOrderBook b, uint256 quote) internal returns (uint256 got) {
        usdc.mint(buyer, quote);
        vm.startPrank(buyer);
        usdc.approve(address(b), quote);
        uint256 before = yes.balanceOf(buyer);
        b.placeAndExecuteMarketBuy(uint96(quote), 0, false, false);
        got = yes.balanceOf(buyer) - before;
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- the four paths

    /// 100 YES at 0.40 for 40 USDC, then floor(60e6 * 1e6 / 450000) = 133333333 at 0.45.
    /// The 0.45 maker is paid floor(133333333 * 0.45) = 59999999: Kuru keeps 1 base unit.
    function test_fork_buyYes() public {
        _give(usdc, alice, 100e6);
        vm.prank(alice);
        uint256 g = gasleft();
        uint256 out = router.buyYes(address(market), 100e6, 233_333_333, block.timestamp);
        console2.log("buyYes gas:", g - gasleft());

        assertEq(out, 233_333_333);
        assertEq(yes.balanceOf(alice), 233_333_333);
        assertEq(usdc.balanceOf(alice), 0);
        assertEq(kuruMarginAccount.getBalance(maker, address(usdc)), 40e6 + 59_999_999, "maker paid");
        _assertRouterClean();
    }

    /// 100 YES at 0.35 = 35 USDC, then 50 YES at 0.30 = 15 USDC.
    function test_fork_sellYes() public {
        _give(yes, alice, 150e6);
        vm.prank(alice);
        uint256 g = gasleft();
        uint256 out = router.sellYes(address(market), 150e6, 50e6, block.timestamp);
        console2.log("sellYes gas:", g - gasleft());

        assertEq(out, 50e6);
        assertEq(usdc.balanceOf(alice), 50e6);
        assertEq(yes.balanceOf(alice), 0);
        assertEq(kuruMarginAccount.getBalance(maker, address(yes)), 150e6, "maker's bids filled");
        _assertRouterClean();
    }

    /// Mint 100 sets, sell the 100 YES into the 0.35 bid for 35 USDC: alice pays 65 for 100 NO.
    function test_fork_buyNo() public {
        _give(usdc, alice, 65e6);
        int256 surplusBefore = vault.surplus();
        vm.prank(alice);
        uint256 g = gasleft();
        uint256 paid = router.buyNo(address(market), 100e6, 65e6, block.timestamp);
        console2.log("buyNo gas:", g - gasleft());

        assertEq(paid, 65e6);
        assertEq(no.balanceOf(alice), 100e6);
        assertEq(usdc.balanceOf(alice), 0);
        assertEq(yes.balanceOf(alice), 0);
        assertEq(vault.sets(address(market)), 100e6);
        assertEq(vault.surplus(), surplusBefore);
        _assertRouterClean();
    }

    /// Q = 40 USDC buys exactly 100 YES at 0.40; merge 100 sets for 100 USDC; alice gets 60.
    function test_fork_sellNo() public {
        _giveNo(alice, 100e6);
        assertEq(router.quoteSellNo(address(market), 100e6), 40e6);
        int256 surplusBefore = vault.surplus();
        vm.prank(alice);
        uint256 g = gasleft();
        uint256 out = router.sellNo(address(market), 100e6, 60e6, block.timestamp);
        console2.log("sellNo gas:", g - gasleft());

        assertEq(out, 60e6);
        assertEq(usdc.balanceOf(alice), 60e6);
        assertEq(no.balanceOf(alice), 0);
        assertEq(yes.balanceOf(alice), 0);
        assertEq(vault.sets(address(market)), 0);
        assertEq(vault.surplus(), surplusBefore);
        _assertRouterClean();
    }

    /// Across both ask levels: Q = 107.5 USDC buys 100 at 0.40 and exactly 150 at 0.45.
    function test_fork_sellNo_twoLevels() public {
        _giveNo(alice, 250e6);
        assertEq(router.quoteSellNo(address(market), 250e6), 107_500_000);
        vm.prank(alice);
        uint256 g = gasleft();
        uint256 out = router.sellNo(address(market), 250e6, 0, block.timestamp);
        console2.log("sellNo (two levels) gas:", g - gasleft());
        assertEq(out, 142_500_000);
        assertEq(yes.balanceOf(alice), 0);
        _assertRouterClean();
    }

    /// The four paths back to back on one book, then the book state they leave.
    function test_fork_allPathsInSequence() public {
        _give(usdc, alice, 1000e6);
        _give(yes, alice, 0);
        _giveNo(alice, 50e6);

        vm.startPrank(alice);
        assertEq(router.buyYes(address(market), 20e6, 0, block.timestamp), 50e6); // 50 at 0.40
        assertEq(router.sellYes(address(market), 50e6, 0, block.timestamp), 17_500_000); // 50 at 0.35
        assertEq(router.buyNo(address(market), 40e6, 30e6, block.timestamp), 26e6); // 40 YES at 0.35 = 14
        assertEq(router.sellNo(address(market), 50e6, 0, block.timestamp), 30e6); // 50 YES at 0.40 = 20
        vm.stopPrank();

        assertEq(no.balanceOf(alice), 40e6);
        assertEq(yes.balanceOf(alice), 0);
        assertEq(usdc.balanceOf(alice), 1000e6 - 20e6 + 17_500_000 - 26e6 + 30e6);
        (uint256 bid, uint256 ask) = book.bestBidAsk();
        assertEq(bid, 350_000 * 1e12, "10 YES left at 0.35");
        assertEq(ask, 450_000 * 1e12, "0.40 asks consumed");
        _assertRouterClean();
    }

    // ---------------------------------------------------------------- limits on the real book

    function test_fork_slippageAndLiquidity() public {
        _give(usdc, alice, 1000e6);
        _giveNo(alice, 400e6);
        vm.startPrank(alice);
        vm.expectRevert(); // Kuru's SlippageExceeded()
        router.buyYes(address(market), 100e6, 233_333_334, block.timestamp);
        vm.expectRevert(); // Kuru's SlippageExceeded(): proceeds 35 USDC < 100 - 64
        router.buyNo(address(market), 100e6, 64e6, block.timestamp);
        vm.expectRevert(); // Kuru's InsufficientLiquidity(): 401 YES cannot all sell (fill-or-kill)
        router.buyNo(address(market), 401e6, 1000e6, block.timestamp);
        vm.expectRevert(IHunchRouter.Slippage.selector);
        router.sellNo(address(market), 100e6, 60e6 + 1, block.timestamp);
        vm.expectRevert(HunchRouter.InsufficientLiquidity.selector); // only 300 YES on the asks
        router.sellNo(address(market), 301e6, 0, block.timestamp);
        vm.stopPrank();

        market.setPhase(Phase.Closed);
        vm.prank(alice);
        vm.expectRevert(IHunchRouter.NotTradable.selector);
        router.buyYes(address(market), 1e6, 0, block.timestamp);
    }

    // ---------------------------------------------------------------- fees and the sellNo quote

    /// A second book with taker 30 bps / maker 10 bps (Kuru salts the address with the fees).
    /// sellNo 100 NO at 0.40: gross = ceil(100e6 * 1e4 / 9970) = 100300903, Q = 40120362; Kuru fills
    /// floor(Q / 0.4) = 100300905 and credits 100300905 - 300903 = 100000002 YES (2 extra).
    function test_fork_takerFees() public {
        Graduator feeGrad = _graduator(true, _params(30, 10));
        IKuruOrderBook feeBook = IKuruOrderBook(feeGrad.createBook(address(market)));
        assertTrue(address(feeBook) != address(book));
        market.setBook(address(feeBook));
        _rest(feeBook, false, 400_000, 1000e6);
        _rest(feeBook, true, 350_000, 100e6);

        _giveNo(alice, 100e6);
        _give(usdc, alice, 100e6);
        _give(yes, alice, 10e6);
        vm.startPrank(alice);
        assertEq(router.quoteSellNo(address(market), 100e6), 40_120_362);
        assertEq(router.sellNo(address(market), 100e6, 0, block.timestamp), 59_879_638);
        assertEq(yes.balanceOf(alice), 10e6 + 2);

        // buyYes 10 USDC at 0.40: 25 YES - ceil(25e6 * 30 / 1e4) = 24925000.
        assertEq(router.buyYes(address(market), 10e6, 0, block.timestamp), 24_925_000);
        // sellYes 10 YES at 0.35: 3.5 USDC - 10500 = 3489500.
        assertEq(router.sellYes(address(market), 10e6, 0, block.timestamp), 3_489_500);
        // buyNo 20 NO: proceeds 7 USDC - 21000 = 6979000, cost 13021000.
        assertEq(router.buyNo(address(market), 20e6, 13_021_000, block.timestamp), 13_021_000);
        vm.stopPrank();

        assertEq(usdc.balanceOf(alice), 100e6 + 59_879_638 - 10e6 + 3_489_500 - 13_021_000);
        assertEq(no.balanceOf(alice), 20e6);
        assertEq(usdc.allowance(address(router), address(feeBook)), 0);
        assertEq(yes.allowance(address(router), address(feeBook)), 0);
        assertEq(usdc.balanceOf(address(router)), 0);
        assertEq(yes.balanceOf(address(router)), 0);
        assertEq(no.balanceOf(address(router)), 0);
    }

    /// The sellNo quote against Kuru's real matching, on an uneven three-level book with fees:
    /// Q credits at least noIn YES and Q - 1 credits fewer (checked with plain Kuru market buys).
    /// forge-config: fork.fuzz.runs = 48
    function testFuzz_fork_sellNoQuoteIsExactAndMinimal(uint256 noIn) public {
        Graduator feeGrad = _graduator(true, _params(30, 10));
        IKuruOrderBook feeBook = IKuruOrderBook(feeGrad.createBook(address(market)));
        market.setBook(address(feeBook));
        _rest(feeBook, false, 333_000, 37_123_456);
        _rest(feeBook, false, 417_000, 12_500_000);
        _rest(feeBook, false, 583_000, 80_000_000);
        noIn = bound(noIn, 1, 129_000_000);

        uint256 q = router.quoteSellNo(address(market), noIn);
        uint256 snap = vm.snapshotState();
        uint256 less = _directBuy(feeBook, q - 1);
        vm.revertToState(snap);
        uint256 got = _directBuy(feeBook, q);
        vm.revertToState(snap);
        assertLt(less, noIn, "Q - 1 is not enough");
        assertGe(got, noIn, "Q is enough");

        _giveNo(alice, noIn);
        vm.prank(alice);
        uint256 out = router.sellNo(address(market), noIn, 0, block.timestamp);
        assertGe(out + q, noIn, "seller receives noIn - Q, plus any refund");
        assertEq(yes.balanceOf(alice), got - noIn, "extra YES = Kuru's credit - noIn");
        assertEq(usdc.balanceOf(address(router)), 0);
        assertEq(yes.balanceOf(address(router)), 0);
        assertEq(no.balanceOf(address(router)), 0);
    }
}

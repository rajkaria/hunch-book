// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Market} from "../../src/core/Market.sol";
import {IHunchRouter} from "../../src/interfaces/IHunchRouter.sol";
import {Outcome, Phase, Side} from "../../src/interfaces/IHunchBookTypes.sol";
import {BookPrice} from "../../src/periphery/libraries/BookPrice.sol";
import {HunchOrderBook} from "../../src/venue/HunchOrderBook.sol";
import {VenueBase} from "./VenueBase.sol";

contract BookPriceHarness {
    function quote(address book) external view returns (BookPrice.Quote memory) {
        return BookPrice.yesQuote(book, 1);
    }
}

/// The whole life of a market on Hunch's own book, through the contracts that already run on Kuru v1:
/// pool, graduation (the Graduator creates the book), token claims, maker quotes, every HunchRouter
/// trade, BookPrice reads, close, settlement and redemption. Nothing waits on a third party.
contract VenueLifecycleTest is VenueBase {
    Market internal m;
    HunchOrderBook internal book;
    address internal yesStaker;
    address internal noStaker;

    function setUp() public override {
        super.setUp();
        (m, book) = _graduated();
        yesStaker = users[0];
        noStaker = users[6];
        m.claimTokensFor(users);
        address[] memory c = new address[](1);
        c[0] = creator;
        m.claimTokensFor(c);
        _approveBook(yesStaker, m, book);
        _approveBook(noStaker, m, book);

        // The maker: 1000 sets, 500 USDC in the margin account, a ladder around 0.55.
        _inventory(maker, m, 1000e6, 500e6);
        uint32[] memory bp = new uint32[](3);
        uint96[] memory bs = new uint96[](3);
        uint32[] memory sp = new uint32[](3);
        uint96[] memory ss = new uint96[](3);
        for (uint256 i; i < 3; ++i) {
            bp[i] = uint32(540_000 - 10_000 * i);
            bs[i] = 100e6;
            sp[i] = uint32(560_000 + 10_000 * i);
            ss[i] = 100e6;
        }
        vm.prank(maker);
        book.batchUpdate(bp, bs, sp, ss, new uint40[](0), true);
    }

    function test_StakersHoldTokensAfterGraduation() public view {
        assertEq(uint8(m.phase()), uint8(Phase.Graduated));
        // 305 YES / 240 NO pool: each YES staker of 50 holds floor(545 * 50 / 305) YES.
        assertEq(_yes(m).balanceOf(yesStaker), uint256(545e6) * 50e6 / 305e6);
        assertEq(_no(m).balanceOf(noStaker), uint256(545e6) * 60e6 / 240e6);
    }

    function test_BookPriceReadsHunchBook() public {
        BookPriceHarness h = new BookPriceHarness();
        BookPrice.Quote memory q = h.quote(address(book));
        assertTrue(q.hasBid && q.hasAsk);
        assertEq(q.bid, 540_000);
        assertEq(q.ask, 560_000);
    }

    function test_RouterBuyYes() public {
        uint256 yesBefore = _yes(m).balanceOf(taker);
        vm.prank(taker);
        uint256 out = router.buyYes(address(m), 112e6, 0, deadline);
        // 100 YES at 0.56 (56 USDC), then 56 / 0.57 = 98.245614 YES.
        assertEq(out, 100e6 + uint256(56e6) * 1e6 / 570_000);
        assertEq(_yes(m).balanceOf(taker) - yesBefore, out);
        _assertRouterEmpty();
    }

    function test_RouterSellYes() public {
        uint256 yesIn = 80e6;
        uint256 before = usdc.balanceOf(yesStaker);
        vm.prank(yesStaker);
        uint256 out = router.sellYes(address(m), yesIn, 0, deadline);
        assertEq(out, 43_200_000); // 80 at 0.54
        assertEq(usdc.balanceOf(yesStaker) - before, out);
        _assertRouterEmpty();
    }

    function test_RouterBuyNo() public {
        uint256 noOut = 120e6;
        uint256 before = usdc.balanceOf(taker);
        vm.prank(taker);
        uint256 paid = router.buyNo(address(m), noOut, 60e6, deadline);
        // Sells 120 YES: 100 at 0.54 + 20 at 0.53 = 64.6, so the NO cost 120 - 64.6 = 55.4.
        assertEq(paid, 120e6 - (54e6 + 10_600_000));
        assertEq(before - usdc.balanceOf(taker), paid);
        assertEq(_no(m).balanceOf(taker), noOut);
        _assertRouterEmpty();
        _assertSetsMatchSupply();
    }

    function test_RouterSellNoMeetsItsQuote() public {
        uint256 noIn = 130e6;
        uint256 q = router.quoteSellNo(address(m), noIn);
        // 100 YES at 0.56 + 30 at 0.57 = 73.1, plus one unit from Kuru's rounding recurrence.
        assertEq(q, 73_100_001);
        uint256 before = usdc.balanceOf(noStaker);
        vm.prank(noStaker);
        uint256 out = router.sellNo(address(m), noIn, noIn - q, deadline);
        assertEq(out, noIn - q);
        assertEq(usdc.balanceOf(noStaker) - before, out);
        // Hunch's book fills at least what the router's Kuru-model quote expects: one extra YES unit here.
        assertEq(_yes(m).balanceOf(noStaker), 1);
        _assertRouterEmpty();
        _assertSetsMatchSupply();
    }

    function test_RouterSlippageAndDeadline() public {
        vm.startPrank(taker);
        vm.expectRevert();
        router.buyYes(address(m), 56e6, 100e6 + 1, deadline);
        vm.expectRevert(IHunchRouter.Expired.selector);
        router.buyYes(address(m), 56e6, 0, block.timestamp - 1);
        vm.stopPrank();
    }

    function test_FullLifecycleSettlesAndRedeems() public {
        vm.prank(taker);
        uint256 bought = router.buyYes(address(m), 56e6, 0, deadline);
        assertEq(bought, 100e6);

        // The maker pulls its quotes before close; after close nothing matches and the router refuses.
        _toClose(m);
        vm.expectRevert(IHunchRouter.NotTradable.selector);
        vm.prank(taker);
        router.buyYes(address(m), 1e6, 0, block.timestamp + 1 hours);
        assertEq(book.marketState(), 1);

        uint40 n = book.s_orderIdCounter();
        uint40[] memory all = new uint40[](n);
        for (uint40 i; i < n; ++i) {
            all[i] = i + 1;
        }
        // The filled ask is skipped by batchUpdate; the rest are cancelled.
        vm.prank(maker);
        book.batchUpdate(new uint32[](0), new uint96[](0), new uint32[](0), new uint96[](0), all, true);
        assertEq(margin.escrowOf(address(book), address(usdc)), 0);
        assertEq(margin.escrowOf(address(book), address(_yes(m))), 0);

        resolver.setAnswer(Outcome.Yes);
        m.settle("");
        uint256 fee = m.feePerToken(Side.Yes);
        uint256 before = usdc.balanceOf(taker);
        vm.prank(taker);
        uint256 paid = vault.redeem(address(m), Side.Yes, bought, taker);
        assertApproxEqAbs(paid, bought - bought * fee / 1e6, 1e3);
        assertEq(usdc.balanceOf(taker) - before, paid);

        // The maker withdraws everything it has on the venue.
        address[] memory tokens = new address[](2);
        tokens[0] = address(_yes(m));
        tokens[1] = address(usdc);
        vm.prank(maker);
        margin.batchWithdrawMaxTokens(tokens);
        assertEq(margin.getBalance(maker, address(usdc)), 0);
        assertEq(margin.getBalance(maker, address(_yes(m))), 0);
        assertGe(usdc.balanceOf(address(vault)), vault.totalObligations(), "vault insolvent");
    }

    // ---- helpers ----

    function _assertRouterEmpty() internal view {
        assertEq(usdc.balanceOf(address(router)), 0, "router holds USDC");
        assertEq(_yes(m).balanceOf(address(router)), 0, "router holds YES");
        assertEq(_no(m).balanceOf(address(router)), 0, "router holds NO");
        assertEq(margin.escrowOf(address(book), address(usdc)), _bidLocks(), "quote escrow != bid locks");
    }

    function _assertSetsMatchSupply() internal view {
        uint256 sets = vault.ledger(address(m)).sets;
        assertEq(_yes(m).totalSupply(), sets);
        assertEq(_no(m).totalSupply(), sets);
    }

    /// Sum of ceil(size * price / 1e6) over the resting bids.
    function _bidLocks() internal view returns (uint256 sum) {
        uint40 n = book.s_orderIdCounter();
        for (uint40 id = 1; id <= n; ++id) {
            (, uint96 size,,,, uint32 price,, bool isBuy) = book.s_orders(id);
            if (isBuy && size != 0) sum += _ceilDiv(uint256(size) * price, 1e6);
        }
    }
}

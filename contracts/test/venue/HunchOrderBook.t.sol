// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Market} from "../../src/core/Market.sol";
import {Outcome, Side} from "../../src/interfaces/IHunchBookTypes.sol";
import {HunchOrderBook} from "../../src/venue/HunchOrderBook.sol";
import {HunchMarginAccount} from "../../src/venue/HunchMarginAccount.sol";
import {VenueBase} from "./VenueBase.sol";

/// Unit tests for Hunch's own order book: placing, cancelling, matching arithmetic, Kuru-layout views,
/// and the market-phase gate (PROTOCOL.md §8.1, "Hunch order book").
contract HunchOrderBookTest is VenueBase {
    Market internal m;
    HunchOrderBook internal book;
    address internal yes;

    event OrderCreated(uint40 orderId, address owner, uint96 size, uint32 price, bool isBuy);
    event Trade(
        uint40 orderId,
        address makerAddress,
        bool isBuy,
        uint256 price,
        uint96 updatedSize,
        address takerAddress,
        address txOrigin,
        uint96 filledSize
    );
    event OrdersCanceled(uint40[] orderId, address owner);

    function setUp() public override {
        super.setUp();
        (m, book) = _graduated();
        yes = address(_yes(m));
        _inventory(maker, m, 2000e6, 2000e6);
        _inventory(maker2, m, 2000e6, 2000e6);
    }

    // ---------------------------------------------------------------- creation and views

    function test_GraduationCreatesBookOnHunchVenue() public view {
        assertTrue(address(book) != address(0), "no book");
        assertEq(graduator.bookOf(address(m)), address(book));
        assertTrue(margin.verifiedMarket(address(book)));
        assertEq(book.market(), address(m));
        assertEq(address(book.marginAccount()), address(margin));
        assertEq(book.marketState(), 0);
        assertEq(venue.bookCount(), 1);
        assertEq(venue.books(0), address(book));

        (
            uint32 pP,
            uint96 sP,
            address base,
            uint256 baseDec,
            address quote,
            uint256 quoteDec,
            uint32 tick,
            uint96 minSize,
            uint96 maxSize,
            uint256 takerFee,
            uint256 makerFee
        ) = book.getMarketParams();
        assertEq(pP, 1e6);
        assertEq(sP, 1e6);
        assertEq(base, yes);
        assertEq(baseDec, 6);
        assertEq(quote, address(usdc));
        assertEq(quoteDec, 6);
        assertEq(tick, TICK);
        assertEq(minSize, MIN_SIZE);
        assertEq(maxSize, POOL_CAP);
        assertEq(takerFee, 0);
        assertEq(makerFee, 0);

        (address vaultAddr,,,,,,, uint96 spread) = book.getVaultParams();
        assertEq(vaultAddr, address(0));
        assertEq(spread, 30);

        address predicted = venue.computeAddress(
            yes, address(usdc), 1e6, 1e6, TICK, MIN_SIZE, uint96(POOL_CAP), 0, 0, 30, address(0), false
        );
        assertEq(predicted, address(book));
    }

    function test_EmptyBookUsesKuruSentinels() public view {
        (uint256 bid, uint256 ask) = book.bestBidAsk();
        assertEq(bid, type(uint256).max);
        assertEq(ask, 0);
        bytes memory l2 = book.getL2Book();
        assertEq(l2.length, 64);
        assertEq(_word(l2, 0), block.number);
        assertEq(_word(l2, 1), 0);
    }

    function test_BookPreparedDuringPoolStaysInactiveUntilGraduation() public {
        Market p = _pool();
        HunchOrderBook early = HunchOrderBook(graduator.createBook(address(p)));
        assertEq(early.marketState(), 1);
        vm.expectRevert(HunchOrderBook.MarketStateError.selector);
        vm.prank(maker);
        early.addBuyOrder(400_000, 1e6, true);

        for (uint256 i; i < 6; ++i) {
            vm.prank(users[i]);
            p.stake(Side.Yes, 50e6);
        }
        for (uint256 i = 6; i < 10; ++i) {
            vm.prank(users[i]);
            p.stake(Side.No, 60e6);
        }
        p.graduate();
        assertEq(p.book(), address(early));
        assertEq(early.marketState(), 0);
    }

    // ---------------------------------------------------------------- placing

    function test_PlaceBidLocksCeilQuoteAndLinksLevel() public {
        uint256 freeBefore = margin.getBalance(maker, address(usdc));
        vm.expectEmit(address(book));
        emit OrderCreated(1, maker, 3_333_333, 421_000, true);
        uint40 id = _bid(maker, book, 421_000, 3_333_333);
        assertEq(id, 1);

        uint256 locked = _ceilDiv(uint256(3_333_333) * 421_000, 1e6);
        assertEq(freeBefore - margin.getBalance(maker, address(usdc)), locked);
        assertEq(margin.escrowOf(address(book), address(usdc)), locked);

        (address owner, uint96 size, uint40 prev, uint40 next, uint40 flippedId, uint32 price,, bool isBuy) =
            book.s_orders(id);
        assertEq(owner, maker);
        assertEq(size, 3_333_333);
        assertEq(prev, 0);
        assertEq(next, 0);
        assertEq(flippedId, 0);
        assertEq(price, 421_000);
        assertTrue(isBuy);
        (uint40 head, uint40 tail) = book.s_buyPricePoints(421_000);
        assertEq(head, id);
        assertEq(tail, id);
        assertEq(book.levelSize(421_000, true), 3_333_333);

        (uint256 bid, uint256 ask) = book.bestBidAsk();
        assertEq(bid, 421_000 * 1e12);
        assertEq(ask, 0);
    }

    function test_PlaceAskLocksBaseAndAppendsFifo() public {
        uint40 a = _ask(maker, book, 600_000, 5e6);
        uint40 b = _ask(maker2, book, 600_000, 7e6);
        assertEq(margin.escrowOf(address(book), yes), 12e6);
        (uint40 head, uint40 tail) = book.s_sellPricePoints(600_000);
        assertEq(head, a);
        assertEq(tail, b);
        (,, uint40 prevB,,,,,) = book.s_orders(b);
        (,,, uint40 nextA,,,,) = book.s_orders(a);
        assertEq(prevB, a);
        assertEq(nextA, b);
        assertEq(book.levelSize(600_000, false), 12e6);
    }

    function test_L2BookLayoutBestFirst() public {
        _bid(maker, book, 400_000, 2e6);
        _bid(maker, book, 450_000, 3e6);
        _bid(maker2, book, 450_000, 1e6);
        _ask(maker, book, 520_000, 4e6);
        _ask(maker, book, 700_000, 5e6);

        bytes memory l2 = book.getL2Book();
        // [block] [450000, 4e6] [400000, 2e6] [0] [520000, 4e6] [700000, 5e6]
        assertEq(l2.length, 32 * 10);
        assertEq(_word(l2, 1), 450_000);
        assertEq(_word(l2, 2), 4e6);
        assertEq(_word(l2, 3), 400_000);
        assertEq(_word(l2, 4), 2e6);
        assertEq(_word(l2, 5), 0);
        assertEq(_word(l2, 6), 520_000);
        assertEq(_word(l2, 7), 4e6);
        assertEq(_word(l2, 8), 700_000);
        assertEq(_word(l2, 9), 5e6);

        bytes memory top = book.getL2Book(1, 1);
        assertEq(top.length, 32 * 6);
        assertEq(_word(top, 1), 450_000);
        assertEq(_word(top, 3), 0);
        assertEq(_word(top, 4), 520_000);
    }

    function test_LimitOrdersArePostOnly() public {
        _ask(maker, book, 500_000, 2e6);
        _bid(maker, book, 450_000, 2e6);
        vm.startPrank(maker2);
        vm.expectRevert(HunchOrderBook.PostOnlyError.selector);
        book.addBuyOrder(500_000, 1e6, false);
        vm.expectRevert(HunchOrderBook.PostOnlyError.selector);
        book.addBuyOrder(510_000, 1e6, true);
        vm.expectRevert(HunchOrderBook.PostOnlyError.selector);
        book.addSellOrder(450_000, 1e6, false);
        vm.expectRevert(HunchOrderBook.PostOnlyError.selector);
        book.addSellOrder(440_000, 1e6, true);
        // Inside the spread is fine.
        book.addBuyOrder(490_000, 1e6, true);
        book.addSellOrder(495_000, 1e6, true);
        vm.stopPrank();
    }

    function test_PriceAndSizeChecks() public {
        vm.startPrank(maker);
        vm.expectRevert(HunchOrderBook.PriceError.selector);
        book.addBuyOrder(0, 1e6, true);
        vm.expectRevert(HunchOrderBook.PriceError.selector);
        book.addSellOrder(1_001_000, 1e6, true);
        vm.expectRevert(HunchOrderBook.TickSizeError.selector);
        book.addBuyOrder(400_500, 1e6, true);
        vm.expectRevert(HunchOrderBook.SizeError.selector);
        book.addBuyOrder(400_000, 999_999, true);
        vm.expectRevert(HunchOrderBook.SizeError.selector);
        book.addSellOrder(400_000, uint96(POOL_CAP + 1), true);
        // The extremes are valid: 0.001 and 1.000 USDC.
        book.addBuyOrder(1000, 1e6, true);
        book.addSellOrder(1_000_000, 1e6, true);
        vm.stopPrank();
    }

    function test_PlacingNeedsFreeBalance() public {
        address broke = makeAddr("broke");
        vm.expectRevert(HunchMarginAccount.InsufficientBalance.selector);
        vm.prank(broke);
        book.addBuyOrder(400_000, 1e6, true);
    }

    // ---------------------------------------------------------------- market buy

    function test_MarketBuyWalksAsksFifoAndPaysMakersExactly() public {
        uint40 a1 = _ask(maker, book, 500_000, 2e6);
        uint40 a2 = _ask(maker2, book, 500_000, 3e6);
        uint40 a3 = _ask(maker, book, 600_000, 10e6);
        uint256 m1Usdc = margin.getBalance(maker, address(usdc));
        uint256 m2Usdc = margin.getBalance(maker2, address(usdc));

        // 2.5 + 0.6 = 3.1 USDC: fills 5 YES at 0.50 (both orders) and 1 YES at 0.60.
        uint256 usdcBefore = usdc.balanceOf(taker);
        vm.expectEmit(address(book));
        emit Trade(a1, maker, true, 500_000 * 1e12, 0, taker, taker, 2e6);
        vm.expectEmit(address(book));
        emit Trade(a2, maker2, true, 500_000 * 1e12, 0, taker, taker, 3e6);
        vm.expectEmit(address(book));
        emit Trade(a3, maker, true, 600_000 * 1e12, 9e6, taker, taker, 1e6);
        vm.prank(taker, taker);
        uint256 out = book.placeAndExecuteMarketBuy(3_100_000, 6e6, false, false);

        assertEq(out, 6e6);
        assertEq(_yes(m).balanceOf(taker), 6e6);
        assertEq(usdcBefore - usdc.balanceOf(taker), 3_100_000);
        assertEq(margin.getBalance(maker, address(usdc)) - m1Usdc, 1_000_000 + 600_000);
        assertEq(margin.getBalance(maker2, address(usdc)) - m2Usdc, 1_500_000);

        // a1 and a2 filled: they keep owner and price, size 0, and the head moved past them.
        (address o1, uint96 s1,,,, uint32 p1,,) = book.s_orders(a1);
        assertEq(o1, maker);
        assertEq(s1, 0);
        assertEq(p1, 500_000);
        (uint40 head,) = book.s_sellPricePoints(500_000);
        assertEq(head, 0);
        (uint40 head6,) = book.s_sellPricePoints(600_000);
        assertEq(head6, a3);
        (, uint96 s3,,,,,,) = book.s_orders(a3);
        assertEq(s3, 9e6);
        assertEq(margin.escrowOf(address(book), yes), 9e6);
        assertEq(margin.escrowOf(address(book), address(usdc)), 0);
    }

    function test_MarketBuyRoundingResidualGoesToFirstMaker() public {
        // Two 1.5 YES asks at 0.333: 1 USDC buys floor(1e6 * 1e6 / 333000) = 3_003_003 > 3e6, so both fill.
        _ask(maker, book, 333_000, 1_500_001);
        _ask(maker2, book, 333_000, 1_499_999);
        uint256 m1 = margin.getBalance(maker, address(usdc));
        uint256 m2 = margin.getBalance(maker2, address(usdc));
        vm.prank(taker);
        uint256 out = book.placeAndExecuteMarketBuy(1_000_000, 0, false, false);
        assertEq(out, 3e6);
        uint256 cost = _ceilDiv(3e6 * uint256(333_000), 1e6); // 999000
        uint256 c1 = uint256(1_500_001) * 333_000 / 1e6;
        uint256 c2 = uint256(1_499_999) * 333_000 / 1e6;
        assertEq(margin.getBalance(maker2, address(usdc)) - m2, c2);
        assertEq(margin.getBalance(maker, address(usdc)) - m1, c1 + (cost - c1 - c2));
        assertEq(margin.escrowOf(address(book), address(usdc)), 0);
    }

    function test_MarketBuyRefundsUnspentQuote() public {
        _ask(maker, book, 500_000, 2e6);
        uint256 before = usdc.balanceOf(taker);
        vm.prank(taker);
        uint256 out = book.placeAndExecuteMarketBuy(5e6, 0, false, false);
        assertEq(out, 2e6);
        assertEq(before - usdc.balanceOf(taker), 1e6);
        assertEq(margin.escrowOf(address(book), address(usdc)), 0);
    }

    function test_MarketBuyFillOrKill() public {
        _ask(maker, book, 500_000, 2e6);
        vm.expectRevert(HunchOrderBook.InsufficientLiquidity.selector);
        vm.prank(taker);
        book.placeAndExecuteMarketBuy(5e6, 0, false, true);
        // Exactly enough: no revert even though nothing is left over.
        vm.prank(taker);
        book.placeAndExecuteMarketBuy(1e6, 0, false, true);
    }

    function test_MarketBuySlippage() public {
        _ask(maker, book, 500_000, 2e6);
        vm.expectRevert(HunchOrderBook.SlippageExceeded.selector);
        vm.prank(taker);
        book.placeAndExecuteMarketBuy(1e6, 2e6 + 1, false, false);
    }

    function test_MarketBuyOnEmptyBookRefundsAll() public {
        uint256 before = usdc.balanceOf(taker);
        vm.prank(taker);
        uint256 out = book.placeAndExecuteMarketBuy(5e6, 0, false, false);
        assertEq(out, 0);
        assertEq(usdc.balanceOf(taker), before);
    }

    function test_MarketBuyMarginPath() public {
        _ask(maker, book, 250_000, 8e6);
        vm.prank(taker);
        margin.deposit(taker, address(usdc), 10e6);
        vm.prank(taker);
        uint256 out = book.placeAndExecuteMarketBuy(1e6, 0, true, false);
        assertEq(out, 4e6);
        assertEq(margin.getBalance(taker, yes), 4e6);
        assertEq(margin.getBalance(taker, address(usdc)), 9e6);
    }

    // ---------------------------------------------------------------- market sell

    function test_MarketSellPaysEachBidsLockDrop() public {
        uint40 b1 = _bid(maker, book, 480_000, 3_333_333);
        uint40 b2 = _bid(maker2, book, 470_000, 10e6);
        _inventory(taker, m, 10e6, 0);
        vm.prank(taker);
        margin.withdraw(10e6, yes); // the taker sells from its wallet

        uint256 before = usdc.balanceOf(taker);
        vm.prank(taker);
        uint256 out = book.placeAndExecuteMarketSell(5e6, 0, false, false);

        uint256 lock1 = _ceilDiv(uint256(3_333_333) * 480_000, 1e6);
        uint256 rest2 = 10e6 - (5e6 - 3_333_333);
        uint256 drop2 = _ceilDiv(10e6 * uint256(470_000), 1e6) - _ceilDiv(rest2 * 470_000, 1e6);
        assertEq(out, lock1 + drop2);
        assertEq(usdc.balanceOf(taker) - before, out);
        // At least Kuru's per-level floor.
        uint256 kuru = uint256(3_333_333) * 480_000 / 1e6 + (5e6 - 3_333_333) * uint256(470_000) / 1e6;
        assertGe(out, kuru);

        assertEq(margin.getBalance(maker, yes), 2000e6 + 3_333_333);
        assertEq(margin.getBalance(maker2, yes), 2000e6 + (5e6 - 3_333_333));
        (, uint96 s1,,,,,,) = book.s_orders(b1);
        (, uint96 s2,,,,,,) = book.s_orders(b2);
        assertEq(s1, 0);
        assertEq(s2, rest2);
        assertEq(margin.escrowOf(address(book), address(usdc)), _ceilDiv(rest2 * 470_000, 1e6));
    }

    function test_MarketSellReturnsUnsoldAndFillOrKill() public {
        _bid(maker, book, 400_000, 2e6);
        _inventory(taker, m, 5e6, 0);
        vm.startPrank(taker);
        margin.withdraw(5e6, yes);
        vm.expectRevert(HunchOrderBook.InsufficientLiquidity.selector);
        book.placeAndExecuteMarketSell(5e6, 0, false, true);
        uint256 out = book.placeAndExecuteMarketSell(5e6, 0, false, false);
        vm.stopPrank();
        assertEq(out, 800_000);
        assertEq(_yes(m).balanceOf(taker), 3e6);
    }

    // ---------------------------------------------------------------- cancelling

    function test_CancelReturnsEscrowAndDeletes() public {
        uint40 bid = _bid(maker, book, 421_000, 3_333_333);
        uint40 ask = _ask(maker, book, 600_000, 5e6);
        uint256 freeUsdc = margin.getBalance(maker, address(usdc));
        uint256 freeYes = margin.getBalance(maker, yes);

        uint40[] memory ids = new uint40[](2);
        ids[0] = bid;
        ids[1] = ask;
        vm.expectEmit(address(book));
        emit OrdersCanceled(ids, maker);
        vm.prank(maker);
        book.batchCancelOrders(ids);

        assertEq(margin.getBalance(maker, address(usdc)) - freeUsdc, _ceilDiv(uint256(3_333_333) * 421_000, 1e6));
        assertEq(margin.getBalance(maker, yes) - freeYes, 5e6);
        (address owner,,,,, uint32 price,,) = book.s_orders(bid);
        assertEq(owner, address(0));
        assertEq(price, 0);
        (uint256 b, uint256 a) = book.bestBidAsk();
        assertEq(b, type(uint256).max);
        assertEq(a, 0);
        assertEq(margin.escrowOf(address(book), address(usdc)), 0);
        assertEq(margin.escrowOf(address(book), yes), 0);
    }

    function test_CancelMiddleOfLevelRelinks() public {
        uint40 a = _ask(maker, book, 600_000, 1e6);
        uint40 b = _ask(maker, book, 600_000, 2e6);
        uint40 c = _ask(maker, book, 600_000, 3e6);
        uint40[] memory ids = new uint40[](1);
        ids[0] = b;
        vm.prank(maker);
        book.batchCancelOrders(ids);
        (,,, uint40 nextA,,,,) = book.s_orders(a);
        (,, uint40 prevC,,,,,) = book.s_orders(c);
        assertEq(nextA, c);
        assertEq(prevC, a);
        assertEq(book.levelSize(600_000, false), 4e6);
        // Cancel the tail, then the head: the level empties.
        ids[0] = c;
        vm.prank(maker);
        book.batchCancelOrders(ids);
        (uint40 head, uint40 tail) = book.s_sellPricePoints(600_000);
        assertEq(head, a);
        assertEq(tail, a);
        ids[0] = a;
        vm.prank(maker);
        book.batchCancelOrders(ids);
        (head, tail) = book.s_sellPricePoints(600_000);
        assertEq(head, 0);
        assertEq(tail, 0);
    }

    function test_CancelRules() public {
        uint40 mine = _ask(maker, book, 600_000, 1e6);
        uint40[] memory ids = new uint40[](1);
        ids[0] = mine;
        // Someone else's order.
        vm.expectRevert(HunchOrderBook.OnlyOwnerAllowedError.selector);
        vm.prank(maker2);
        book.batchCancelOrders(ids);
        // Twice.
        vm.prank(maker);
        book.batchCancelOrders(ids);
        vm.expectRevert(HunchOrderBook.OnlyOwnerAllowedError.selector);
        vm.prank(maker);
        book.batchCancelOrders(ids);
        // A filled order: batchCancelOrders reverts, batchUpdate skips it.
        uint40 filled = _ask(maker, book, 600_000, 1e6);
        vm.prank(taker);
        book.placeAndExecuteMarketBuy(600_000, 0, false, false);
        ids[0] = filled;
        vm.expectRevert(HunchOrderBook.OrderAlreadyFilledOrCancelled.selector);
        vm.prank(maker);
        book.batchCancelOrders(ids);
        vm.prank(maker);
        book.batchUpdate(new uint32[](0), new uint96[](0), new uint32[](0), new uint96[](0), ids, true);
    }

    function test_BatchUpdateCancelsThenPlaces() public {
        uint40 old = _bid(maker, book, 400_000, 2e6);
        uint32[] memory bp = new uint32[](2);
        uint96[] memory bs = new uint96[](2);
        uint32[] memory sp = new uint32[](1);
        uint96[] memory ss = new uint96[](1);
        (bp[0], bs[0], bp[1], bs[1]) = (410_000, 2e6, 405_000, 3e6);
        (sp[0], ss[0]) = (430_000, 4e6);
        uint40[] memory cancel = new uint40[](1);
        cancel[0] = old;
        vm.prank(maker);
        book.batchUpdate(bp, bs, sp, ss, cancel, true);
        assertEq(book.s_orderIdCounter(), 4);
        (uint256 bid, uint256 ask) = book.bestBidAsk();
        assertEq(bid, 410_000 * 1e12);
        assertEq(ask, 430_000 * 1e12);
        assertEq(book.levelSize(400_000, true), 0);

        vm.expectRevert(HunchOrderBook.LengthMismatch.selector);
        vm.prank(maker);
        book.batchUpdate(bp, new uint96[](1), sp, ss, new uint40[](0), true);
    }

    // ---------------------------------------------------------------- the market's clock

    function test_ClosedBookAcceptsCancelsOnly() public {
        uint40 ask = _ask(maker, book, 600_000, 5e6);
        _bid(maker, book, 400_000, 5e6);
        _toClose(m);
        assertEq(book.marketState(), 1);

        vm.startPrank(taker);
        vm.expectRevert(HunchOrderBook.MarketStateError.selector);
        book.placeAndExecuteMarketBuy(1e6, 0, false, false);
        vm.expectRevert(HunchOrderBook.MarketStateError.selector);
        book.placeAndExecuteMarketSell(1e6, 0, false, false);
        vm.stopPrank();
        vm.startPrank(maker);
        vm.expectRevert(HunchOrderBook.MarketStateError.selector);
        book.addBuyOrder(300_000, 1e6, true);
        uint32[] memory none = new uint32[](0);
        uint96[] memory noSizes = new uint96[](0);
        uint32[] memory one = new uint32[](1);
        uint96[] memory oneSize = new uint96[](1);
        (one[0], oneSize[0]) = (300_000, 1e6);
        vm.expectRevert(HunchOrderBook.MarketStateError.selector);
        book.batchUpdate(one, oneSize, none, noSizes, new uint40[](0), true);

        // Cancels and withdrawals still work after close, and after settlement.
        uint40[] memory ids = new uint40[](1);
        ids[0] = ask;
        book.batchUpdate(none, noSizes, none, noSizes, ids, true);
        vm.stopPrank();
        resolver.setAnswer(Outcome.Yes);
        m.settle("");
        vm.startPrank(maker);
        address[] memory tokens = new address[](2);
        tokens[0] = yes;
        tokens[1] = address(usdc);
        margin.batchWithdrawMaxTokens(tokens);
        vm.stopPrank();
        assertEq(margin.getBalance(maker, yes), 0);
        assertEq(_yes(m).balanceOf(maker), 2000e6);
    }

    function test_NativeValueRejected() public {
        vm.deal(taker, 1 ether);
        vm.expectRevert(HunchOrderBook.NativeAssetMismatch.selector);
        vm.prank(taker);
        book.placeAndExecuteMarketBuy{value: 1}(1e6, 0, false, false);
    }

    function test_CannotReinitialize() public {
        vm.expectRevert(HunchOrderBook.AlreadyInitialized.selector);
        book.initialize(margin, address(m), yes, address(usdc), 1e6, 1e6, TICK, MIN_SIZE, 1e9, 30, 6, 6);
        HunchOrderBook impl = HunchOrderBook(venue.implementation());
        vm.expectRevert(HunchOrderBook.AlreadyInitialized.selector);
        impl.initialize(margin, address(m), yes, address(usdc), 1e6, 1e6, TICK, MIN_SIZE, 1e9, 30, 6, 6);
    }

    function test_ManyLevelsAcrossBitmapWords() public {
        // Levels 1, 255, 256, 257, 511, 512 and 1000 sit in different bitmap words.
        uint32[7] memory prices = [uint32(1000), 255_000, 256_000, 257_000, 511_000, 512_000, 1_000_000];
        for (uint256 i; i < prices.length; ++i) {
            _ask(maker, book, prices[i], 1e6);
        }
        (, uint256 ask) = book.bestBidAsk();
        assertEq(ask, 1000 * 1e12);
        bytes memory l2 = book.getL2Book();
        for (uint256 i; i < prices.length; ++i) {
            assertEq(_word(l2, 2 + 2 * i), prices[i]);
        }
        // Buy everything: 7 levels.
        uint256 total;
        for (uint256 i; i < prices.length; ++i) {
            total += prices[i];
        }
        vm.prank(taker);
        uint256 out = book.placeAndExecuteMarketBuy(uint96(total), 0, false, false);
        assertEq(out, 7e6);
        (, ask) = book.bestBidAsk();
        assertEq(ask, 0);

        for (uint256 i; i < prices.length; ++i) {
            _bid(maker, book, prices[i], 1e6);
        }
        (uint256 bid,) = book.bestBidAsk();
        assertEq(bid, 1_000_000 * 1e12);
        l2 = book.getL2Book();
        for (uint256 i; i < prices.length; ++i) {
            assertEq(_word(l2, 1 + 2 * i), prices[prices.length - 1 - i]);
        }
    }

    // ---------------------------------------------------------------- helpers

    function _word(bytes memory data, uint256 index) internal pure returns (uint256 w) {
        assembly ("memory-safe") {
            w := mload(add(add(data, 32), mul(index, 32)))
        }
    }
}


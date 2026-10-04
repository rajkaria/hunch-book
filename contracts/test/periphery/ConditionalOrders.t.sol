// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Market} from "../../src/core/Market.sol";
import {OutcomeToken} from "../../src/core/OutcomeToken.sol";
import {IHunchBookFactory} from "../../src/interfaces/IHunchBookFactory.sol";
import {Side} from "../../src/interfaces/IHunchBookTypes.sol";
import {IHunchRouter} from "../../src/interfaces/IHunchRouter.sol";
import {ConditionalOrders} from "../../src/periphery/ConditionalOrders.sol";
import {IConditionalOrders} from "../../src/periphery/interfaces/IConditionalOrders.sol";
import {PeripheryBase} from "./PeripheryBase.sol";
import {PeripheryBook} from "./mocks/PeripheryBook.sol";

/// Shared setup: a graduated market on a PeripheryBook with asks at 0.40 and 0.45 and bids at 0.35
/// and 0.30 (100 YES each), and an owner (alice) who approved the orders contract for USDC, YES, NO.
abstract contract ConditionalOrdersBase is PeripheryBase {
    ConditionalOrders internal orders;
    Market internal m;
    PeripheryBook internal book;
    OutcomeToken internal yes;
    OutcomeToken internal no;
    address internal alice = makeAddr("alice");

    function setUp() public virtual override {
        super.setUp();
        orders = new ConditionalOrders(IHunchBookFactory(address(factory)), address(router));
        (m, book) = _graduatedWithBook();
        yes = _yes(m);
        no = _no(m);
        _ask(m, book, 400_000, 100e6);
        _ask(m, book, 450_000, 100e6);
        _bid(book, 350_000, 100e6);
        _bid(book, 300_000, 100e6);

        _fund(alice, 1000e6);
        _giveTokens(m, alice, Side.Yes, 300e6);
        _giveTokens(m, alice, Side.No, 300e6);
        vm.startPrank(alice);
        usdc.approve(address(orders), type(uint256).max);
        yes.approve(address(orders), type(uint256).max);
        no.approve(address(orders), type(uint256).max);
        vm.stopPrank();
    }

    function _req(
        IHunchRouter.Kind kind,
        IConditionalOrders.Condition c,
        uint32 trigger,
        uint128 amountIn,
        uint128 limit
    ) internal view returns (IConditionalOrders.OrderRequest memory r) {
        r = IConditionalOrders.OrderRequest({
            market: address(m),
            kind: kind,
            condition: c,
            triggerPriceE6: trigger,
            expiry: uint64(block.timestamp + 1 days),
            executorTipBps: 0,
            amountIn: amountIn,
            limit: limit
        });
    }

    function _place(address owner, IConditionalOrders.OrderRequest memory r) internal returns (uint256 id) {
        vm.prank(owner);
        id = orders.place(r);
    }

    function _assertClean() internal view {
        assertEq(usdc.balanceOf(address(orders)), 0, "orders USDC");
        assertEq(yes.balanceOf(address(orders)), 0, "orders YES");
        assertEq(no.balanceOf(address(orders)), 0, "orders NO");
        assertEq(usdc.allowance(address(orders), address(router)), 0, "USDC allowance");
        assertEq(yes.allowance(address(orders), address(router)), 0, "YES allowance");
        assertEq(no.allowance(address(orders), address(router)), 0, "NO allowance");
        assertEq(usdc.balanceOf(address(router)), 0, "router USDC");
        assertEq(yes.balanceOf(address(router)), 0, "router YES");
        assertEq(no.balanceOf(address(router)), 0, "router NO");
        _assertSolvent();
    }
}

contract ConditionalOrdersTest is ConditionalOrdersBase {
    IHunchRouter.Kind internal constant BUY_YES = IHunchRouter.Kind.BuyYes;
    IHunchRouter.Kind internal constant SELL_YES = IHunchRouter.Kind.SellYes;
    IHunchRouter.Kind internal constant BUY_NO = IHunchRouter.Kind.BuyNo;
    IHunchRouter.Kind internal constant SELL_NO = IHunchRouter.Kind.SellNo;
    IConditionalOrders.Condition internal constant ABOVE = IConditionalOrders.Condition.AtOrAbove;
    IConditionalOrders.Condition internal constant BELOW = IConditionalOrders.Condition.AtOrBelow;

    // ---------------------------------------------------------------- construction

    function test_constructor() public view {
        assertEq(orders.factory(), address(factory));
        assertEq(orders.router(), address(router));
        assertEq(orders.usdc(), address(usdc));
        assertEq(orders.MAX_TIP_BPS(), 50);
    }

    function test_constructor_revertsOnZero() public {
        vm.expectRevert(IConditionalOrders.ZeroAddress.selector);
        new ConditionalOrders(IHunchBookFactory(address(0)), address(router));
        vm.expectRevert(IConditionalOrders.ZeroAddress.selector);
        new ConditionalOrders(IHunchBookFactory(address(factory)), address(0));
    }

    // ---------------------------------------------------------------- place and cancel

    function test_place_storesAndEmits() public {
        IConditionalOrders.OrderRequest memory r = _req(SELL_YES, ABOVE, 600_000, 50e6, 29e6);
        r.executorTipBps = 25;
        vm.expectEmit(address(orders));
        emit IConditionalOrders.OrderPlaced(1, alice, address(m), SELL_YES, ABOVE, 600_000, r.expiry, 25, 50e6, 29e6);
        uint256 id = _place(alice, r);
        assertEq(id, 1);
        assertEq(orders.orderCount(), 1);
        IConditionalOrders.Order memory o = orders.getOrder(id);
        assertEq(o.owner, alice);
        assertEq(o.market, address(m));
        assertEq(uint8(o.kind), uint8(SELL_YES));
        assertEq(uint8(o.condition), uint8(ABOVE));
        assertEq(uint8(o.status), uint8(IConditionalOrders.Status.Open));
        assertEq(o.triggerPriceE6, 600_000);
        assertEq(o.expiry, r.expiry);
        assertEq(o.executorTipBps, 25);
        assertEq(o.amountIn, 50e6);
        assertEq(o.limit, 29e6);
        assertEq(_place(alice, r), 2);
        // Placing moves no funds.
        assertEq(yes.balanceOf(alice), 300e6);
    }

    function test_place_reverts() public {
        IConditionalOrders.OrderRequest memory r = _req(BUY_YES, BELOW, 400_000, 10e6, 0);
        vm.startPrank(alice);
        r.market = address(0xBEEF);
        vm.expectRevert(IConditionalOrders.UnknownMarket.selector);
        orders.place(r);
        r.market = address(m);
        r.amountIn = 0;
        vm.expectRevert(IConditionalOrders.ZeroAmount.selector);
        orders.place(r);
        r.amountIn = 10e6;
        r.executorTipBps = 51;
        vm.expectRevert(IConditionalOrders.TipTooHigh.selector);
        orders.place(r);
        r.executorTipBps = 50;
        r.triggerPriceE6 = 1e6 + 1;
        vm.expectRevert(IConditionalOrders.BadTrigger.selector);
        orders.place(r);
        r.triggerPriceE6 = 1e6;
        r.expiry = uint64(block.timestamp - 1);
        vm.expectRevert(IConditionalOrders.BadExpiry.selector);
        orders.place(r);
        r.expiry = uint64(block.timestamp); // expiring this second is fine
        orders.place(r);
        vm.stopPrank();
    }

    function test_cancel() public {
        uint256 id = _place(alice, _req(BUY_YES, BELOW, 400_000, 10e6, 0));
        vm.expectRevert(abi.encodeWithSelector(IConditionalOrders.UnknownOrder.selector, 99));
        orders.cancel(99);
        vm.prank(keeper);
        vm.expectRevert(IConditionalOrders.NotOwner.selector);
        orders.cancel(id);

        vm.expectEmit(address(orders));
        emit IConditionalOrders.OrderCancelled(id, alice);
        vm.prank(alice);
        orders.cancel(id);
        assertEq(uint8(orders.getOrder(id).status), uint8(IConditionalOrders.Status.Cancelled));

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IConditionalOrders.OrderNotOpen.selector, id));
        orders.cancel(id);
        vm.expectRevert(abi.encodeWithSelector(IConditionalOrders.OrderNotOpen.selector, id));
        orders.execute(id);
        assertFalse(orders.isTriggered(id));
    }

    // ---------------------------------------------------------------- prices

    function test_currentPrice_perKind() public view {
        _assertPrice(BUY_YES, true, 400_000);
        _assertPrice(SELL_YES, true, 350_000);
        _assertPrice(BUY_NO, true, 650_000);
        _assertPrice(SELL_NO, true, 600_000);
    }

    function test_currentPrice_emptySides() public {
        book.setBestBidAsk(type(uint256).max, 0);
        _assertPrice(BUY_YES, false, 0);
        _assertPrice(SELL_YES, false, 0);
        _assertPrice(BUY_NO, false, 1e6);
        _assertPrice(SELL_NO, false, 1e6);
        vm.expectRevert(IConditionalOrders.UnknownMarket.selector);
        orders.currentPrice(address(0xBEEF), BUY_YES);
    }

    function test_currentPrice_brokenBookReadsEmpty() public {
        book.setBestReverts(true);
        _assertPrice(BUY_YES, false, 0);
        _assertPrice(SELL_YES, false, 0);
    }

    function test_currentPrice_roundsAgainstTheTrader() public {
        // A sub-tick price, as an AMM vault could quote: bids round down, asks round up.
        book.setBestBidAsk(412_345_678_901_234_567, 412_345_678_901_234_567);
        _assertPrice(SELL_YES, true, 412_345);
        _assertPrice(BUY_YES, true, 412_346);
        _assertPrice(BUY_NO, true, 587_655);
        _assertPrice(SELL_NO, true, 587_654);
    }

    function _assertPrice(IHunchRouter.Kind kind, bool available, uint256 price) internal view {
        (bool a, uint256 p) = orders.currentPrice(address(m), kind);
        assertEq(a, available, "available");
        if (available) assertEq(p, price, "price");
    }

    // ---------------------------------------------------------------- execute: BuyYes

    function test_execute_limitBuyYes() public {
        IConditionalOrders.OrderRequest memory r = _req(BUY_YES, BELOW, 400_000, 20e6, 49e6);
        r.executorTipBps = 10;
        uint256 id = _place(alice, r);
        assertTrue(orders.isTriggered(id));
        uint256 usdcBefore = usdc.balanceOf(alice);

        vm.expectEmit(address(orders));
        emit IConditionalOrders.OrderExecuted(id, alice, keeper, 400_000, 20e6, 49_950_000, 50_000);
        vm.prank(keeper);
        uint256 received = orders.execute(id);

        assertEq(received, 49_950_000, "50 YES at 0.40 minus a 10 bps tip");
        assertEq(yes.balanceOf(alice), 300e6 + 49_950_000);
        assertEq(yes.balanceOf(keeper), 50_000, "tip");
        assertEq(usdcBefore - usdc.balanceOf(alice), 20e6);
        assertEq(uint8(orders.getOrder(id).status), uint8(IConditionalOrders.Status.Executed));
        assertFalse(orders.isTriggered(id));
        _assertClean();

        vm.expectRevert(abi.encodeWithSelector(IConditionalOrders.OrderNotOpen.selector, id));
        orders.execute(id);
    }

    function test_execute_buyYes_refundsUnspentUsdc() public {
        uint256 id = _place(alice, _req(BUY_YES, BELOW, 400_000, 100e6, 0));
        uint256 usdcBefore = usdc.balanceOf(alice);
        uint256 received = orders.execute(id);
        assertEq(received, 200e6, "every ask: 100 at 0.40 and 100 at 0.45");
        // 85 USDC of asks, plus one base unit Kuru's integer matching keeps (HunchRouter notes).
        assertEq(usdcBefore - usdc.balanceOf(alice), 85_000_001, "the rest came back");
        _assertClean();
    }

    function test_execute_buyYes_notTriggered() public {
        uint256 id = _place(alice, _req(BUY_YES, BELOW, 399_000, 20e6, 0));
        assertFalse(orders.isTriggered(id));
        vm.expectRevert(abi.encodeWithSelector(IConditionalOrders.NotTriggered.selector, id, true, 400_000));
        orders.execute(id);
        // The order stays open and runs once the ask comes down.
        _ask(m, book, 399_000, 10e6);
        assertTrue(orders.isTriggered(id));
        orders.execute(id);
    }

    // ---------------------------------------------------------------- execute: SellYes

    function test_execute_takeProfitAndStopLoss() public {
        uint256 tp = _place(alice, _req(SELL_YES, ABOVE, 360_000, 50e6, 0));
        uint256 sl = _place(alice, _req(SELL_YES, BELOW, 350_000, 50e6, 17e6));
        vm.expectRevert(abi.encodeWithSelector(IConditionalOrders.NotTriggered.selector, tp, true, 350_000));
        orders.execute(tp);

        uint256 before = usdc.balanceOf(alice);
        assertEq(orders.execute(sl), 17_500_000, "50 YES at 0.35");
        assertEq(usdc.balanceOf(alice) - before, 17_500_000);
        assertEq(yes.balanceOf(alice), 250e6);
        _assertClean();

        // The best bid is still 0.35 with 50 left; a new bid at 0.36 triggers the take-profit.
        _bid(book, 360_000, 50e6);
        assertEq(orders.execute(tp), 18e6, "50 YES at 0.36");
        _assertClean();
    }

    function test_execute_sellYes_returnsUnsold() public {
        uint256 id = _place(alice, _req(SELL_YES, BELOW, 400_000, 250e6, 0));
        uint256 before = usdc.balanceOf(alice);
        assertEq(orders.execute(id), 35e6 + 30e6, "200 YES sold");
        assertEq(usdc.balanceOf(alice) - before, 65e6);
        assertEq(yes.balanceOf(alice), 300e6 - 200e6, "50 YES came back");
        _assertClean();
    }

    function test_execute_sellYes_limitHoldsAfterTip() public {
        // 50 YES at 0.35 = 17.5 USDC gross. A 50 bps tip leaves 17.4125: a 17.42 limit must fail.
        IConditionalOrders.OrderRequest memory r = _req(SELL_YES, BELOW, 400_000, 50e6, 17_420_000);
        r.executorTipBps = 50;
        uint256 id = _place(alice, r);
        vm.expectRevert(); // the router's limit, tightened by the tip, fires first
        orders.execute(id);

        r.limit = 17_412_500;
        id = _place(alice, r);
        assertEq(orders.execute(id), 17_412_500);
        assertEq(usdc.balanceOf(address(this)), 87_500, "tip");
        _assertClean();
    }

    // ---------------------------------------------------------------- execute: NO

    function test_execute_buyNo() public {
        IConditionalOrders.OrderRequest memory r = _req(BUY_NO, BELOW, 650_000, 40e6, 30e6);
        r.executorTipBps = 50;
        uint256 id = _place(alice, r);
        uint256 before = usdc.balanceOf(alice);
        vm.prank(keeper);
        uint256 received = orders.execute(id);
        // 40 sets minted for 40 USDC, 40 YES sold at 0.35 for 14: the owner pays 26 of the 30 pulled.
        assertEq(received, 40e6 - 200_000, "NO minus a 50 bps tip");
        assertEq(no.balanceOf(keeper), 200_000);
        assertEq(before - usdc.balanceOf(alice), 26e6);
        assertEq(no.balanceOf(alice), 300e6 + received);
        _assertClean();
    }

    function test_execute_buyNo_respectsMaxIn() public {
        uint256 id = _place(alice, _req(BUY_NO, BELOW, 650_000, 40e6, 25e6));
        vm.expectRevert(); // costs 26 > 25
        orders.execute(id);
        assertEq(uint8(orders.getOrder(id).status), uint8(IConditionalOrders.Status.Open));
        assertTrue(orders.isTriggered(id));
    }

    function test_execute_buyNo_bidsAboveOneDollarRefundTheExcess() public {
        _bid(book, 1_100_000, 10e6);
        uint256 id = _place(alice, _req(BUY_NO, BELOW, 0, 10e6, 5e6));
        uint256 before = usdc.balanceOf(alice);
        assertEq(orders.execute(id), 10e6);
        // 10 YES sold at 1.10 = 11 USDC for 10 USDC of sets: the owner is paid 1 and keeps the 5.
        assertEq(usdc.balanceOf(alice) - before, 1e6);
        _assertClean();
    }

    function test_execute_sellNo() public {
        uint256 id = _place(alice, _req(SELL_NO, ABOVE, 600_000, 50e6, 30e6));
        uint256 before = usdc.balanceOf(alice);
        assertEq(orders.execute(id), 30e6, "50 YES bought at 0.40, merged");
        assertEq(usdc.balanceOf(alice) - before, 30e6);
        assertEq(no.balanceOf(alice), 250e6);
        _assertClean();
    }

    function test_execute_sellNo_extraYesGoesToOwner() public {
        // At an ask of 0.333, the least quote for 1.000001 YES (0.333001 USDC) fills 1.000003 YES:
        // Kuru's integer matching credits 2 units more than the merge needs.
        _ask(m, book, 333_000, 100e6);
        uint256 id = _place(alice, _req(SELL_NO, ABOVE, 0, 1_000_001, 0));
        uint256 yesBefore = yes.balanceOf(alice);
        uint256 usdcBefore = usdc.balanceOf(alice);
        assertEq(orders.execute(id), 667_000);
        assertEq(usdc.balanceOf(alice) - usdcBefore, 667_000);
        assertEq(yes.balanceOf(alice) - yesBefore, 2, "extra YES returned to the owner");
        _assertClean();
    }

    // ---------------------------------------------------------------- execute: failures

    function test_execute_expired() public {
        IConditionalOrders.OrderRequest memory r = _req(BUY_YES, BELOW, 400_000, 1e6, 0);
        r.expiry = uint64(block.timestamp + 10);
        uint256 id = _place(alice, r);
        vm.warp(block.timestamp + 11);
        assertFalse(orders.isTriggered(id));
        vm.expectRevert(abi.encodeWithSelector(IConditionalOrders.OrderExpired.selector, id));
        orders.execute(id);
        vm.expectRevert(abi.encodeWithSelector(IConditionalOrders.UnknownOrder.selector, 42));
        orders.execute(42);
    }

    function test_execute_needsTheOwnersApprovalAndBalance() public {
        address bob = makeAddr("bob");
        _fund(bob, 100e6);
        uint256 id = _place(bob, _req(BUY_YES, BELOW, 400_000, 10e6, 0));
        vm.expectRevert(); // no approval to the orders contract
        orders.execute(id);
        vm.prank(bob);
        usdc.approve(address(orders), 5e6);
        vm.expectRevert(); // approval too small
        orders.execute(id);
        vm.prank(bob);
        usdc.approve(address(orders), type(uint256).max);
        orders.execute(id);
        _assertClean();
    }

    function test_execute_afterClose_routerRefuses() public {
        IConditionalOrders.OrderRequest memory r = _req(SELL_YES, BELOW, 400_000, 10e6, 0);
        r.expiry = uint64(m.window().close + 1 days);
        uint256 id = _place(alice, r);
        _toClose(m);
        vm.expectRevert(IHunchRouter.NotTradable.selector);
        orders.execute(id);
        assertEq(uint8(orders.getOrder(id).status), uint8(IConditionalOrders.Status.Open));
    }

    function test_execute_cannotReenter() public {
        uint256 a = _place(alice, _req(BUY_YES, BELOW, 400_000, 1e6, 0));
        uint256 b = _place(alice, _req(BUY_YES, BELOW, 400_000, 1e6, 0));
        book.setReenter(address(orders), abi.encodeCall(orders.execute, (b)));
        vm.expectRevert(IConditionalOrders.Reentrancy.selector);
        orders.execute(a);
    }

    // ---------------------------------------------------------------- fuzz

    /// The trigger check matches the order's condition on its side's price, for any book.
    function testFuzz_trigger(uint256 bid, uint256 ask, uint8 kindSeed, bool above, uint32 trigger) public {
        bid = bound(bid, 1, 1e6) * 1e12;
        ask = bound(ask, 1, 1e6) * 1e12;
        trigger = uint32(bound(trigger, 0, 1e6));
        book.setBestBidAsk(bid, ask);
        IHunchRouter.Kind kind = IHunchRouter.Kind(kindSeed % 4);
        uint256 id = _place(alice, _req(kind, above ? ABOVE : BELOW, trigger, 1e6, 0));

        uint256 price;
        if (kind == BUY_YES) price = ask / 1e12;
        else if (kind == SELL_YES) price = bid / 1e12;
        else if (kind == BUY_NO) price = 1e6 - bid / 1e12;
        else price = 1e6 - ask / 1e12;
        bool expected = above ? price >= trigger : price <= trigger;
        assertEq(orders.isTriggered(id), expected);
        if (!expected) {
            vm.expectRevert(abi.encodeWithSelector(IConditionalOrders.NotTriggered.selector, id, true, price));
            orders.execute(id);
        }
    }

    /// Whenever a sell executes, the owner receives at least the limit after the tip, and the
    /// contract ends with nothing.
    function testFuzz_sell_ownerGetsAtLeastLimit(uint256 amount, uint256 limit, uint16 tip, bool viaNo) public {
        amount = bound(amount, 1e6, 150e6);
        limit = bound(limit, 0, 100e6);
        tip = uint16(bound(tip, 0, 50));
        IConditionalOrders.OrderRequest memory r =
            _req(viaNo ? SELL_NO : SELL_YES, ABOVE, 0, uint128(amount), uint128(limit));
        r.executorTipBps = tip;
        uint256 id = _place(alice, r);
        uint256 before = usdc.balanceOf(alice);
        vm.prank(keeper);
        try orders.execute(id) returns (uint256 received) {
            assertGe(received, limit);
            assertEq(usdc.balanceOf(alice) - before, received);
            uint256 paidTip = usdc.balanceOf(keeper);
            assertEq(paidTip, (paidTip + received) * tip / 10_000, "tip is the order's share of the output");
        } catch {
            assertEq(uint8(orders.getOrder(id).status), uint8(IConditionalOrders.Status.Open));
        }
        _assertClean();
    }

    /// Buys: the owner receives at least the limit (YES) or exactly amountIn minus the tip (NO), and
    /// never pays more than amountIn (YES) or the max in (NO).
    function testFuzz_buy(uint256 amount, uint256 limit, uint16 tip, bool viaNo) public {
        amount = bound(amount, 1e6, 150e6);
        limit = bound(limit, 0, 200e6);
        tip = uint16(bound(tip, 0, 50));
        IConditionalOrders.OrderRequest memory r =
            _req(viaNo ? BUY_NO : BUY_YES, BELOW, 1e6, uint128(amount), uint128(limit));
        r.executorTipBps = tip;
        uint256 id = _place(alice, r);
        uint256 usdcBefore = usdc.balanceOf(alice);
        OutcomeToken out = viaNo ? no : yes;
        uint256 outBefore = out.balanceOf(alice);
        try orders.execute(id) returns (uint256 received) {
            assertEq(out.balanceOf(alice) - outBefore, received);
            uint256 paid = usdcBefore - usdc.balanceOf(alice);
            if (viaNo) {
                assertEq(received, amount - amount * tip / 10_000);
                assertLe(paid, limit);
            } else {
                assertGe(received, limit);
                assertLe(paid, amount);
            }
        } catch {
            assertEq(uint8(orders.getOrder(id).status), uint8(IConditionalOrders.Status.Open));
        }
        _assertClean();
    }
}

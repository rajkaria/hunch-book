// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {CollateralVault} from "../../src/core/CollateralVault.sol";
import {HunchRouter} from "../../src/core/HunchRouter.sol";
import {Market} from "../../src/core/Market.sol";
import {OutcomeToken} from "../../src/core/OutcomeToken.sol";
import {TestUSDC} from "../../src/mocks/TestUSDC.sol";
import {IHunchBookFactory} from "../../src/interfaces/IHunchBookFactory.sol";
import {Phase, Side} from "../../src/interfaces/IHunchBookTypes.sol";
import {IHunchRouter} from "../../src/interfaces/IHunchRouter.sol";
import {ConditionalOrders} from "../../src/periphery/ConditionalOrders.sol";
import {IConditionalOrders} from "../../src/periphery/interfaces/IConditionalOrders.sol";
import {PeripheryBase} from "./PeripheryBase.sol";
import {PeripheryBook} from "./mocks/PeripheryBook.sol";

/// Random orders of every kind, cancels, executions by a keeper, a moving book (a maker adding asks
/// and bids, a trader taking liquidity) and time passing. Executions run in try/catch: an order that
/// cannot fill (limit, liquidity, owner balance) is allowed to revert, and the handler checks every
/// one that does fill against its limits.
contract ConditionalOrdersHandler is Test {
    ConditionalOrders internal orders;
    HunchRouter internal router;
    CollateralVault internal vault;
    TestUSDC internal usdc;
    Market internal m;
    PeripheryBook internal book;
    OutcomeToken internal yes;
    OutcomeToken internal no;
    address internal maker;
    address internal keeper = makeAddr("keeper");
    address[] internal owners;
    uint256[] public ids;

    uint256 public violations;
    uint256 public placed;
    uint256 public executed;
    uint256 public reverted;
    uint256 public cancelled;

    constructor(
        ConditionalOrders o,
        HunchRouter r,
        CollateralVault v,
        TestUSDC u,
        Market m_,
        PeripheryBook b,
        address maker_,
        address[] memory owners_
    ) {
        orders = o;
        router = r;
        vault = v;
        usdc = u;
        m = m_;
        book = b;
        maker = maker_;
        (address y, address n) = m_.tokens();
        yes = OutcomeToken(y);
        no = OutcomeToken(n);
        for (uint256 i; i < owners_.length; ++i) {
            owners.push(owners_[i]);
        }
    }

    function idCount() external view returns (uint256) {
        return ids.length;
    }

    // ---- owners ----

    function place(uint256 o, uint8 kindSeed, bool above, uint256 trigger, uint256 amount, uint256 limit, uint16 tip)
        external
    {
        IHunchRouter.Kind kind = IHunchRouter.Kind(kindSeed % 4);
        amount = bound(amount, 1e6, 120e6);
        limit = bound(limit, 0, amount); // minimum out, or for BuyNo the maximum USDC in
        IConditionalOrders.OrderRequest memory r = IConditionalOrders.OrderRequest({
            market: address(m),
            kind: kind,
            condition: above ? IConditionalOrders.Condition.AtOrAbove : IConditionalOrders.Condition.AtOrBelow,
            triggerPriceE6: uint32(bound(trigger, 0, 1e6)),
            expiry: uint64(block.timestamp + bound(trigger, 0, 3 days)),
            executorTipBps: uint16(bound(tip, 0, 50)),
            amountIn: uint128(amount),
            limit: uint128(limit)
        });
        vm.prank(owners[o % owners.length]);
        ids.push(orders.place(r));
        ++placed;
    }

    function cancel(uint256 seed) external {
        if (ids.length == 0) return;
        uint256 id = ids[seed % ids.length];
        IConditionalOrders.Order memory o = orders.getOrder(id);
        if (o.status != IConditionalOrders.Status.Open) return;
        vm.prank(o.owner);
        orders.cancel(id);
        ++cancelled;
    }

    // ---- keeper ----

    /// Executes the first triggered order at or after a random position.
    function execute(uint256 seed) external {
        uint256 n = ids.length;
        uint256 id;
        for (uint256 i; i < n; ++i) {
            uint256 candidate = ids[(seed % n + i) % n];
            if (orders.isTriggered(candidate)) {
                id = candidate;
                break;
            }
        }
        if (id == 0) return;
        IConditionalOrders.Order memory o = orders.getOrder(id);
        uint256[3] memory before = _balances(o.owner);
        vm.prank(keeper);
        try orders.execute(id) returns (uint256 received) {
            _check(id, o, before, received);
            ++executed;
        } catch {
            if (orders.getOrder(id).status != IConditionalOrders.Status.Open) ++violations;
            ++reverted;
        }
    }

    /// The owner got the output (net of the tip) and paid no more than the order allows.
    function _check(uint256 id, IConditionalOrders.Order memory o, uint256[3] memory before, uint256 received)
        internal
    {
        uint256[3] memory afterBal = _balances(o.owner);
        IHunchRouter.Kind k = o.kind;
        if (k == IHunchRouter.Kind.BuyYes) {
            if (afterBal[1] - before[1] != received || received < o.limit) ++violations;
            if (before[0] - afterBal[0] > o.amountIn) ++violations;
        } else if (k == IHunchRouter.Kind.SellYes) {
            if (afterBal[0] - before[0] != received || received < o.limit) ++violations;
            if (before[1] - afterBal[1] > o.amountIn) ++violations;
        } else if (k == IHunchRouter.Kind.BuyNo) {
            uint256 tip = uint256(o.amountIn) * o.executorTipBps / 10_000;
            if (afterBal[2] - before[2] != received || received != o.amountIn - tip) ++violations;
            if (before[0] > afterBal[0] && before[0] - afterBal[0] > o.limit) ++violations;
        } else {
            if (afterBal[0] - before[0] != received || received < o.limit) ++violations;
            if (before[2] - afterBal[2] != o.amountIn) ++violations;
        }
        if (orders.getOrder(id).status != IConditionalOrders.Status.Executed) ++violations;
    }

    function _balances(address who) internal view returns (uint256[3] memory b) {
        b[0] = usdc.balanceOf(who);
        b[1] = yes.balanceOf(who);
        b[2] = no.balanceOf(who);
    }

    // ---- the book moves ----

    function addAsk(uint256 price, uint256 size) external {
        if (m.phase() != Phase.Graduated) return;
        price = 1000 * bound(price, 50, 950);
        size = bound(size, 1e6, 80e6);
        vm.startPrank(maker);
        vault.mintSets(address(m), size, maker);
        yes.approve(address(book), size);
        book.addAskFrom(maker, uint32(price), uint96(size));
        vm.stopPrank();
    }

    function addBid(uint256 price, uint256 size) external {
        price = 1000 * bound(price, 50, 950);
        size = bound(size, 1e6, 80e6);
        book.addBid(uint32(price), uint96(size));
    }

    function takeLiquidity(bool buy, uint256 amount) external {
        if (m.phase() != Phase.Graduated) return;
        address trader = owners[0];
        vm.startPrank(trader);
        if (buy) {
            amount = bound(amount, 1e6, 30e6);
            if (usdc.balanceOf(trader) < amount || book.askCount() == 0) {
                vm.stopPrank();
                return;
            }
            usdc.approve(address(router), amount);
            router.buyYes(address(m), amount, 0, block.timestamp);
        } else {
            amount = bound(amount, 1e6, 30e6);
            if (yes.balanceOf(trader) < amount || book.bidCount() == 0) {
                vm.stopPrank();
                return;
            }
            yes.approve(address(router), amount);
            router.sellYes(address(m), amount, 0, block.timestamp);
        }
        vm.stopPrank();
    }

    function passTime(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 1, 2 hours));
        vm.roll(block.number + 1);
    }
}

contract ConditionalOrdersInvariantsTest is PeripheryBase {
    ConditionalOrders internal orders;
    ConditionalOrdersHandler internal handler;
    Market internal m;
    PeripheryBook internal book;

    function setUp() public override {
        super.setUp();
        orders = new ConditionalOrders(IHunchBookFactory(address(factory)), address(router));
        (m, book) = _graduatedWithBook();
        _ask(m, book, 450_000, 100e6);
        _ask(m, book, 500_000, 100e6);
        _bid(book, 400_000, 100e6);
        _bid(book, 350_000, 100e6);

        address[] memory owners = new address[](3);
        for (uint256 i; i < 3; ++i) {
            address o = makeAddr(string.concat("owner", vm.toString(i)));
            owners[i] = o;
            _fund(o, 2000e6);
            _giveTokens(m, o, Side.Yes, 400e6);
            _giveTokens(m, o, Side.No, 400e6);
            vm.startPrank(o);
            usdc.approve(address(orders), type(uint256).max);
            _yes(m).approve(address(orders), type(uint256).max);
            _no(m).approve(address(orders), type(uint256).max);
            vm.stopPrank();
        }
        handler = new ConditionalOrdersHandler(orders, router, vault, usdc, m, book, maker, owners);
        vm.prank(maker);
        _yes(m).approve(address(book), type(uint256).max);
        targetContract(address(handler));
        excludeSender(address(vault));
    }

    /// The orders contract and the router hold nothing and leave no approvals between calls.
    function invariant_holdsNothing() public view {
        assertEq(usdc.balanceOf(address(orders)), 0);
        assertEq(_yes(m).balanceOf(address(orders)), 0);
        assertEq(_no(m).balanceOf(address(orders)), 0);
        assertEq(usdc.allowance(address(orders), address(router)), 0);
        assertEq(_yes(m).allowance(address(orders), address(router)), 0);
        assertEq(_no(m).allowance(address(orders), address(router)), 0);
        assertEq(usdc.balanceOf(address(router)), 0);
        assertEq(_yes(m).balanceOf(address(router)), 0);
        assertEq(_no(m).balanceOf(address(router)), 0);
    }

    /// Owners never received less than their limit or paid more than their order allows; a failed
    /// execution left the order open; the vault stayed solvent with YES supply = NO supply = sets.
    function invariant_ownersGetTheirLimits() public view {
        assertEq(handler.violations(), 0);
        _assertSolvent();
        _assertSetsMatchSupply(m);
    }

    /// The handler's paths all execute.
    function test_handlerReachesEveryPath() public {
        handler.place(0, 0, false, 600_000, 10e6, 0, 10); // BuyYes AtOrBelow 0.60
        handler.place(1, 1, false, 450_000, 10e6, 0, 0); // SellYes AtOrBelow 0.45
        handler.place(2, 2, false, 700_000, 10e6, 10e6, 50); // BuyNo AtOrBelow 0.70
        handler.place(0, 3, true, 400_000, 10e6, 0, 0); // SellNo AtOrAbove 0.40
        handler.place(1, 0, true, 999_000, 10e6, 0, 0); // never triggers
        for (uint256 i; i < 4; ++i) {
            handler.execute(i);
        }
        handler.execute(4);
        handler.cancel(4);
        handler.addAsk(400, 5e6);
        handler.addBid(300, 5e6);
        handler.takeLiquidity(true, 2e6);
        handler.takeLiquidity(false, 2e6);
        handler.passTime(60);
        assertEq(handler.placed(), 5);
        assertEq(handler.executed(), 4);
        assertEq(handler.cancelled(), 1);
        invariant_holdsNothing();
        invariant_ownersGetTheirLimits();
    }

    function afterInvariant() public {
        emit log_named_uint("orders placed", handler.placed());
        emit log_named_uint("orders executed", handler.executed());
        emit log_named_uint("executions that reverted", handler.reverted());
        emit log_named_uint("orders cancelled", handler.cancelled());
    }
}

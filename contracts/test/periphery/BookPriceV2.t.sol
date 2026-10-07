// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Market} from "../../src/core/Market.sol";
import {IHunchBookFactory} from "../../src/interfaces/IHunchBookFactory.sol";
import {Side} from "../../src/interfaces/IHunchBookTypes.sol";
import {IHunchRouter} from "../../src/interfaces/IHunchRouter.sol";
import {ConditionalOrders} from "../../src/periphery/ConditionalOrders.sol";
import {ImpliedProbabilityOracle} from "../../src/periphery/ImpliedProbabilityOracle.sol";
import {IConditionalOrders} from "../../src/periphery/interfaces/IConditionalOrders.sol";
import {IImpliedProbabilityOracle} from "../../src/periphery/interfaces/IImpliedProbabilityOracle.sol";
import {BookPrice} from "../../src/periphery/libraries/BookPrice.sol";
import {PeripheryBase} from "./PeripheryBase.sol";

/// A Kuru v2 book's `bestBidAsk()`: two uint32 prices in pricePrecision units, any raw words a test sets,
/// or a revert.
contract V2BestBidAsk {
    uint256 public bid;
    uint256 public ask;
    bool public reverts;
    bool public short;

    function set(uint256 b, uint256 a) external {
        bid = b;
        ask = a;
    }

    function setReverts(bool r) external {
        reverts = r;
    }

    function setShort(bool s) external {
        short = s;
    }

    fallback() external {
        // bestBidAsk() only; raw words so tests can return values a real uint32 could not hold.
        require(!reverts, "book unavailable");
        uint256 b = bid;
        uint256 a = ask;
        bool s = short;
        assembly ("memory-safe") {
            mstore(0, b)
            mstore(32, a)
            if s { return(0, 32) }
            return(0, 64)
        }
    }
}

contract BookPriceHarness {
    function v2(address book) external view returns (BookPrice.Quote memory) {
        return BookPrice.yesQuoteV2(book);
    }

    function byVersion(address book, uint8 version) external view returns (BookPrice.Quote memory) {
        return BookPrice.yesQuote(book, version);
    }
}

contract BookPriceV2Test is PeripheryBase {
    BookPriceHarness internal h;
    V2BestBidAsk internal v2;

    function setUp() public override {
        super.setUp();
        h = new BookPriceHarness();
        v2 = new V2BestBidAsk();
    }

    // ---------------------------------------------------------------- library

    function test_v2_pricesAreAlreadyE6() public {
        v2.set(420_000, 440_000);
        BookPrice.Quote memory q = h.v2(address(v2));
        assertTrue(q.hasBid && q.hasAsk);
        assertEq(q.bid, 420_000);
        assertEq(q.ask, 440_000);
    }

    /// Either sentinel (0 or type(uint32).max) means empty, on either side.
    function test_v2_emptySides() public {
        uint256 max32 = type(uint32).max;
        uint256[2] memory sentinels = [uint256(0), max32];
        for (uint256 i; i < 2; ++i) {
            for (uint256 j; j < 2; ++j) {
                v2.set(sentinels[i], sentinels[j]);
                BookPrice.Quote memory q = h.v2(address(v2));
                assertFalse(q.hasBid);
                assertFalse(q.hasAsk);
            }
        }
        v2.set(500_000, max32);
        BookPrice.Quote memory one = h.v2(address(v2));
        assertTrue(one.hasBid);
        assertFalse(one.hasAsk);
        v2.set(0, 600_000);
        one = h.v2(address(v2));
        assertFalse(one.hasBid);
        assertTrue(one.hasAsk);
    }

    /// Values that do not fit a uint32 cannot come from a v2 book: treated as empty.
    function test_v2_outOfRangeIsEmpty() public {
        v2.set(uint256(type(uint32).max) + 1, type(uint256).max);
        BookPrice.Quote memory q = h.v2(address(v2));
        assertFalse(q.hasBid);
        assertFalse(q.hasAsk);
    }

    function test_v2_brokenBooksReadEmpty() public {
        BookPrice.Quote memory q = h.v2(makeAddr("eoa"));
        assertFalse(q.hasBid || q.hasAsk);

        v2.set(420_000, 440_000);
        v2.setReverts(true);
        q = h.v2(address(v2));
        assertFalse(q.hasBid || q.hasAsk);

        v2.setReverts(false);
        v2.setShort(true);
        q = h.v2(address(v2));
        assertFalse(q.hasBid || q.hasAsk);
    }

    /// The same 0.42 / 0.44 book read the v1 way (1e18 scale) and the v2 way (E6) gives the same quote.
    function test_dispatchByVersion() public {
        v2.set(420_000, 440_000);
        BookPrice.Quote memory q2 = h.byVersion(address(v2), 2);
        assertEq(q2.bid, 420_000);
        assertEq(q2.ask, 440_000);
        v2.set(420_000 * 1e12, 440_000 * 1e12);
        BookPrice.Quote memory q1 = h.byVersion(address(v2), 1);
        assertEq(q1.bid, 420_000);
        assertEq(q1.ask, 440_000);
    }

    function testFuzz_v2_neverInventsAPrice(uint256 bid, uint256 ask) public {
        v2.set(bid, ask);
        BookPrice.Quote memory q = h.v2(address(v2));
        assertEq(q.hasBid, bid != 0 && bid < type(uint32).max);
        assertEq(q.hasAsk, ask != 0 && ask < type(uint32).max);
        if (q.hasBid) assertEq(q.bid, bid);
        if (q.hasAsk) assertEq(q.ask, ask);
    }

    // ---------------------------------------------------------------- periphery on a v2 stack

    /// A graduated market whose book is a v2 book.
    function _graduatedV2() internal returns (Market m) {
        m = _create(_timeWindow(), Side.Yes, CREATOR_MIN);
        graduator.registerBook(address(m), address(v2));
        _fillToRule(m);
        m.graduate();
    }

    function test_oracle_readsV2Books() public {
        Market m = _graduatedV2();
        ImpliedProbabilityOracle oracle = new ImpliedProbabilityOracle(IHunchBookFactory(address(factory)), 2);
        assertEq(oracle.kuruVersion(), 2);
        v2.set(400_000, 420_000);
        (uint256 chance, bool stale) = oracle.chanceE6(address(m));
        assertEq(chance, 410_000);
        assertFalse(stale);
        IImpliedProbabilityOracle.Quote memory q = oracle.quote(address(m));
        assertEq(q.spreadE6, 20_000);
    }

    function test_conditionalOrders_readV2Books() public {
        Market m = _graduatedV2();
        ConditionalOrders orders = new ConditionalOrders(IHunchBookFactory(address(factory)), makeAddr("routerV2"), 2);
        assertEq(orders.kuruVersion(), 2);
        v2.set(400_000, 420_000);
        (bool ok, uint256 p) = orders.currentPrice(address(m), IHunchRouter.Kind.BuyYes);
        assertTrue(ok);
        assertEq(p, 420_000);
        (ok, p) = orders.currentPrice(address(m), IHunchRouter.Kind.SellNo);
        assertEq(p, 580_000);
        (ok, p) = orders.currentPrice(address(m), IHunchRouter.Kind.BuyNo);
        assertEq(p, 600_000);
    }

    function test_constructorsRejectUnknownVersions() public {
        vm.expectRevert(IImpliedProbabilityOracle.BadKuruVersion.selector);
        new ImpliedProbabilityOracle(IHunchBookFactory(address(factory)), 0);
        vm.expectRevert(IImpliedProbabilityOracle.BadKuruVersion.selector);
        new ImpliedProbabilityOracle(IHunchBookFactory(address(factory)), 3);
        vm.expectRevert(IConditionalOrders.BadKuruVersion.selector);
        new ConditionalOrders(IHunchBookFactory(address(factory)), makeAddr("r"), 0);
        vm.expectRevert(IConditionalOrders.BadKuruVersion.selector);
        new ConditionalOrders(IHunchBookFactory(address(factory)), makeAddr("r"), 3);
    }
}

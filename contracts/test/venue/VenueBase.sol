// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {CollateralVault} from "../../src/core/CollateralVault.sol";
import {Graduator} from "../../src/core/Graduator.sol";
import {HunchBookFactory} from "../../src/core/HunchBookFactory.sol";
import {HunchRouter} from "../../src/core/HunchRouter.sol";
import {Market} from "../../src/core/Market.sol";
import {OutcomeToken} from "../../src/core/OutcomeToken.sol";
import {TestUSDC} from "../../src/mocks/TestUSDC.sol";
import {IGraduator} from "../../src/interfaces/IGraduator.sol";
import {IHunchBookFactory} from "../../src/interfaces/IHunchBookFactory.sol";
import {IResolver} from "../../src/interfaces/IResolver.sol";
import {GraduationRule, MarketCaps, Outcome, Side, Window} from "../../src/interfaces/IHunchBookTypes.sol";
import {IKuruMarginAccount} from "../../src/interfaces/external/IKuruMarginAccount.sol";
import {IKuruRouter} from "../../src/interfaces/external/IKuruRouter.sol";
import {HunchMarginAccount} from "../../src/venue/HunchMarginAccount.sol";
import {HunchOrderBook} from "../../src/venue/HunchOrderBook.sol";
import {HunchOrderBookFactory} from "../../src/venue/HunchOrderBookFactory.sol";
import {MockResolver} from "../mocks/MockResolver.sol";

/// Shared fixture: a full Hunch Book core whose v1 Graduator creates books on Hunch's own venue
/// (HunchOrderBookFactory) and whose v1 HunchRouter trades on them, exactly as Deploy.s.sol wires the
/// `hunch` stack (PROTOCOL.md §8.1, "Hunch order book").
abstract contract VenueBase is Test {
    uint32 internal constant TEMPLATE = 1;
    uint256 internal constant POOL_CAP = 5000e6;
    uint256 internal constant WALLET_CAP = 1000e6;
    uint256 internal constant COLLATERAL_CAP = 1_000_000e6;
    uint32 internal constant TICK = 1000;
    uint96 internal constant MIN_SIZE = 1e6;

    TestUSDC internal usdc;
    HunchBookFactory internal factory;
    CollateralVault internal vault;
    MockResolver internal resolver;
    HunchOrderBookFactory internal venue;
    HunchMarginAccount internal margin;
    Graduator internal graduator;
    HunchRouter internal router;

    address internal guardian = makeAddr("guardian");
    address internal feeRecipient = makeAddr("feeRecipient");
    address internal creator = makeAddr("creator");
    address internal maker = makeAddr("maker");
    address internal maker2 = makeAddr("maker2");
    address internal taker = makeAddr("taker");
    address[] internal users;

    uint64 internal nonce;
    uint256 internal deadline;

    function setUp() public virtual {
        vm.warp(1_800_000_000);
        vm.roll(50_000_000);

        usdc = new TestUSDC();
        Market impl = new Market();
        MarketCaps memory caps = MarketCaps({
            poolCap: uint128(POOL_CAP), walletCap: uint128(WALLET_CAP), minStake: 1e6, creatorMinStake: 5e6
        });
        factory = new HunchBookFactory(address(usdc), address(impl), guardian, feeRecipient, caps, COLLATERAL_CAP);
        vault = CollateralVault(factory.vault());
        resolver = new MockResolver();

        venue = new HunchOrderBookFactory(IHunchBookFactory(address(factory)));
        margin = venue.marginAccount();
        graduator = new Graduator(
            IHunchBookFactory(address(factory)),
            IKuruRouter(address(venue)),
            IKuruMarginAccount(address(margin)),
            address(usdc),
            true,
            bookParams()
        );
        factory.setGraduator(address(graduator));
        router = new HunchRouter(IHunchBookFactory(address(factory)));

        vm.prank(guardian);
        factory.addTemplate(
            TEMPLATE,
            IResolver(address(resolver)),
            GraduationRule({minPool: 500e6, minStakers: 10, minChanceBps: 300, maxChanceBps: 9700})
        );

        for (uint256 i; i < 12; ++i) {
            address u = makeAddr(string.concat("user", vm.toString(i)));
            users.push(u);
            _fund(u, WALLET_CAP * 2);
        }
        _fund(creator, 10_000e6);
        _fund(maker, 100_000e6);
        _fund(maker2, 100_000e6);
        _fund(taker, 100_000e6);
        deadline = block.timestamp + 1 days;
    }

    function bookParams() internal pure returns (IGraduator.BookParams memory) {
        return IGraduator.BookParams({
            sizePrecision: 1e6,
            pricePrecision: 1e6,
            tickSize: TICK,
            minSize: MIN_SIZE,
            takerFeeBps: 0,
            makerFeeBps: 0,
            kuruAmmSpread: 30
        });
    }

    // ---- markets ----

    function _fund(address who, uint256 amount) internal {
        while (amount > 0) {
            uint256 m = amount > 10_000e6 ? 10_000e6 : amount;
            usdc.mint(who, m);
            amount -= m;
        }
        vm.startPrank(who);
        usdc.approve(address(vault), type(uint256).max);
        usdc.approve(address(margin), type(uint256).max);
        usdc.approve(address(router), type(uint256).max);
        vm.stopPrank();
    }

    function _window() internal returns (Window memory w) {
        ++nonce;
        w.blockClock = false;
        w.lock = uint64(block.timestamp + 1 days + nonce);
        w.close = uint64(block.timestamp + 2 days + nonce);
        w.settleDeadline = w.close + 7 days;
    }

    /// A market in its pool phase (no book yet).
    function _pool() internal returns (Market m) {
        vm.prank(creator);
        m = Market(payable(factory.createMarket(TEMPLATE, abi.encode(_window()), Side.Yes, 5e6)));
    }

    /// A graduated market: 11 stakers, 305 YES / 240 NO, graduated in one call that creates its book.
    function _graduated() internal returns (Market m, HunchOrderBook book) {
        m = _pool();
        for (uint256 i; i < 6; ++i) {
            vm.prank(users[i]);
            m.stake(Side.Yes, 50e6);
        }
        for (uint256 i = 6; i < 10; ++i) {
            vm.prank(users[i]);
            m.stake(Side.No, 60e6);
        }
        m.graduate();
        book = HunchOrderBook(m.book());
        _approveBook(maker, m, book);
        _approveBook(maker2, m, book);
        _approveBook(taker, m, book);
    }

    function _approveBook(address who, Market m, HunchOrderBook book) internal {
        vm.startPrank(who);
        usdc.approve(address(book), type(uint256).max);
        _yes(m).approve(address(book), type(uint256).max);
        _yes(m).approve(address(margin), type(uint256).max);
        _yes(m).approve(address(router), type(uint256).max);
        _no(m).approve(address(router), type(uint256).max);
        vm.stopPrank();
    }

    function _toClose(Market m) internal {
        vm.warp(m.window().close);
    }

    function _settle(Market m, Outcome o) internal {
        _toClose(m);
        resolver.setAnswer(o);
        m.settle("");
    }

    function _yes(Market m) internal view returns (OutcomeToken) {
        (address y,) = m.tokens();
        return OutcomeToken(y);
    }

    function _no(Market m) internal view returns (OutcomeToken) {
        (, address n) = m.tokens();
        return OutcomeToken(n);
    }

    // ---- venue helpers ----

    /// Mints `amount` complete sets for `who` and deposits the YES (and `usdcIn` USDC) into the margin
    /// account.
    function _inventory(address who, Market m, uint256 yesIn, uint256 usdcIn) internal {
        vm.startPrank(who);
        if (yesIn != 0) {
            vault.mintSets(address(m), yesIn, who);
            margin.deposit(who, address(_yes(m)), yesIn);
        }
        if (usdcIn != 0) margin.deposit(who, address(usdc), usdcIn);
        vm.stopPrank();
    }

    function _bid(address who, HunchOrderBook book, uint32 price, uint96 size) internal returns (uint40 id) {
        vm.prank(who);
        book.addBuyOrder(price, size, true);
        id = book.s_orderIdCounter();
    }

    function _ask(address who, HunchOrderBook book, uint32 price, uint96 size) internal returns (uint40 id) {
        vm.prank(who);
        book.addSellOrder(price, size, true);
        id = book.s_orderIdCounter();
    }

    function _ceilDiv(uint256 a, uint256 b) internal pure returns (uint256) {
        return a == 0 ? 0 : (a - 1) / b + 1;
    }

    /// The margin account's books balance for one token: free balances and escrows equal what it tracks,
    /// and it holds at least that much.
    function _assertMarginSolvent(address token, address[] memory holders, address[] memory books) internal view {
        uint256 sum;
        for (uint256 i; i < holders.length; ++i) {
            sum += margin.getBalance(holders[i], token);
        }
        for (uint256 i; i < books.length; ++i) {
            sum += margin.escrowOf(books[i], token);
        }
        assertEq(sum, margin.tracked(token), "tracked != free + escrow");
        assertGe(_balanceOf(token, address(margin)), margin.tracked(token), "margin account short");
    }

    function _balanceOf(address token, address who) internal view returns (uint256) {
        return OutcomeToken(token).balanceOf(who);
    }
}

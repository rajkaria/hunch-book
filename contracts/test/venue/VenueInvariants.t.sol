// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {CollateralVault} from "../../src/core/CollateralVault.sol";
import {HunchRouter} from "../../src/core/HunchRouter.sol";
import {Market} from "../../src/core/Market.sol";
import {OutcomeToken} from "../../src/core/OutcomeToken.sol";
import {TestUSDC} from "../../src/mocks/TestUSDC.sol";
import {HunchMarginAccount} from "../../src/venue/HunchMarginAccount.sol";
import {HunchOrderBook} from "../../src/venue/HunchOrderBook.sol";
import {VenueBase} from "./VenueBase.sol";

/// Random makers and takers on one Hunch book. Every action is valid (bounded inputs), so a revert is a
/// bug (`fail_on_revert`).
contract VenueHandler is Test {
    HunchOrderBook internal book;
    HunchMarginAccount internal margin;
    HunchRouter internal router;
    CollateralVault internal vault;
    Market internal market;
    TestUSDC internal usdc;
    OutcomeToken internal yes;
    OutcomeToken internal no;
    address[] internal makers;
    address internal walletTaker;
    address internal marginTaker;

    mapping(address => uint40[]) internal ordersOf;
    uint256 public calls;

    constructor(
        HunchOrderBook book_,
        HunchRouter router_,
        CollateralVault vault_,
        Market market_,
        TestUSDC usdc_,
        address[] memory makers_,
        address walletTaker_,
        address marginTaker_
    ) {
        book = book_;
        margin = book_.marginAccount();
        router = router_;
        vault = vault_;
        market = market_;
        usdc = usdc_;
        (address y, address n) = market_.tokens();
        yes = OutcomeToken(y);
        no = OutcomeToken(n);
        makers = makers_;
        walletTaker = walletTaker_;
        marginTaker = marginTaker_;
    }

    // ---- makers ----

    function placeBid(uint256 who, uint256 priceSeed, uint256 sizeSeed) external {
        ++calls;
        address a = makers[who % makers.length];
        (, uint256 askIdx) = _best();
        uint256 maxIdx = askIdx == 0 ? 999 : askIdx - 1;
        if (maxIdx == 0) return;
        uint256 price = bound(priceSeed, 1, maxIdx) * 1000;
        uint256 free = margin.getBalance(a, address(usdc));
        uint256 maxSize = free * 1e6 / price;
        if (maxSize > 500e6) maxSize = 500e6;
        if (maxSize < 1e6) return;
        uint256 size = bound(sizeSeed, 1e6, maxSize);
        vm.prank(a);
        // forge-lint: disable-next-line(unsafe-typecast)
        book.addBuyOrder(uint32(price), uint96(size), true);
        ordersOf[a].push(book.s_orderIdCounter());
    }

    function placeAsk(uint256 who, uint256 priceSeed, uint256 sizeSeed) external {
        ++calls;
        address a = makers[who % makers.length];
        (uint256 bidIdx,) = _best();
        uint256 minIdx = bidIdx + 1;
        // Up to 0.999: router NO sales need asks below 1 USDC.
        if (minIdx > 999) return;
        uint256 price = bound(priceSeed, minIdx, 999) * 1000;
        uint256 free = margin.getBalance(a, address(yes));
        uint256 maxSize = free > 500e6 ? 500e6 : free;
        if (maxSize < 1e6) return;
        uint256 size = bound(sizeSeed, 1e6, maxSize);
        vm.prank(a);
        // forge-lint: disable-next-line(unsafe-typecast)
        book.addSellOrder(uint32(price), uint96(size), true);
        ordersOf[a].push(book.s_orderIdCounter());
    }

    function cancel(uint256 who, uint256 pick) external {
        ++calls;
        address a = makers[who % makers.length];
        uint40[] storage ids = ordersOf[a];
        if (ids.length == 0) return;
        uint256 i = pick % ids.length;
        uint40 id = ids[i];
        ids[i] = ids[ids.length - 1];
        ids.pop();
        uint40[] memory one = new uint40[](1);
        one[0] = id;
        // batchUpdate skips a filled id, so this never reverts for an order we placed.
        vm.prank(a);
        book.batchUpdate(new uint32[](0), new uint96[](0), new uint32[](0), new uint96[](0), one, true);
    }

    // ---- takers ----

    function marketBuy(uint256 amountSeed, bool useMargin) external {
        ++calls;
        address t = useMargin ? marginTaker : walletTaker;
        uint256 have = useMargin ? margin.getBalance(t, address(usdc)) : usdc.balanceOf(t);
        if (have == 0) return;
        uint256 q = bound(amountSeed, 1, have > 2000e6 ? 2000e6 : have);
        vm.prank(t);
        // forge-lint: disable-next-line(unsafe-typecast)
        book.placeAndExecuteMarketBuy(uint96(q), 0, useMargin, false);
    }

    function marketSell(uint256 amountSeed, bool useMargin) external {
        ++calls;
        address t = useMargin ? marginTaker : walletTaker;
        uint256 have = useMargin ? margin.getBalance(t, address(yes)) : yes.balanceOf(t);
        if (have == 0) return;
        uint256 s = bound(amountSeed, 1, have > 2000e6 ? 2000e6 : have);
        vm.prank(t);
        // forge-lint: disable-next-line(unsafe-typecast)
        book.placeAndExecuteMarketSell(uint96(s), 0, useMargin, false);
    }

    function routerBuyYes(uint256 amountSeed) external {
        ++calls;
        (, uint256 askIdx) = _best();
        if (askIdx == 0) return;
        uint256 have = usdc.balanceOf(walletTaker);
        if (have < askIdx * 1000) return;
        uint256 q = bound(amountSeed, askIdx * 1000, have > 1000e6 ? 1000e6 : have);
        vm.prank(walletTaker);
        router.buyYes(address(market), q, 0, block.timestamp);
    }

    function routerSellNo(uint256 amountSeed) external {
        ++calls;
        (uint256 askBase,) = _askDepth();
        uint256 have = no.balanceOf(walletTaker);
        uint256 cap = askBase < have ? askBase : have;
        if (cap == 0) return;
        uint256 k = bound(amountSeed, 1, cap > 500e6 ? 500e6 : cap);
        vm.prank(walletTaker);
        router.sellNo(address(market), k, 0, block.timestamp);
    }

    function routerBuyNo(uint256 amountSeed) external {
        ++calls;
        uint256 bidBase = _bidDepth();
        if (bidBase == 0) return;
        uint256 k = bound(amountSeed, 1, bidBase > 500e6 ? 500e6 : bidBase);
        vm.prank(walletTaker);
        router.buyNo(address(market), k, k, block.timestamp);
    }

    function moveMargin(uint256 amountSeed, bool deposit, bool isUsdc) external {
        ++calls;
        address t = marginTaker;
        address token = isUsdc ? address(usdc) : address(yes);
        if (deposit) {
            uint256 have = OutcomeToken(token).balanceOf(t);
            if (have == 0) return;
            uint256 amt = bound(amountSeed, 1, have);
            vm.prank(t);
            margin.deposit(t, token, amt);
        } else {
            uint256 free = margin.getBalance(t, token);
            if (free == 0) return;
            uint256 amt = bound(amountSeed, 1, free);
            vm.prank(t);
            margin.withdraw(amt, token);
        }
    }

    // ---- views ----

    function _best() internal view returns (uint256 bidIdx, uint256 askIdx) {
        (uint256 bid, uint256 ask) = book.bestBidAsk();
        bidIdx = bid == type(uint256).max ? 0 : bid / 1e12 / 1000;
        askIdx = ask == 0 ? 0 : ask / 1e12 / 1000;
    }

    function _askDepth() internal view returns (uint256 base, uint256 levels) {
        uint256 b = book.s_orderIdCounter();
        for (uint40 id = 1; id <= b; ++id) {
            (, uint96 size,,,, uint32 price,, bool isBuy) = book.s_orders(id);
            if (!isBuy && size != 0 && price != 0) {
                base += size;
                ++levels;
            }
        }
    }

    function _bidDepth() internal view returns (uint256 base) {
        uint256 b = book.s_orderIdCounter();
        for (uint40 id = 1; id <= b; ++id) {
            (, uint96 size,,,, uint32 price,, bool isBuy) = book.s_orders(id);
            if (isBuy && size != 0 && price != 0) base += size;
        }
    }
}

/// Venue invariants: the margin account is solvent per token, each book's escrow equals exactly what its
/// resting orders lock, levels and lists agree, the book is never crossed, no tokens appear or vanish,
/// and the core vault stays solvent with YES supply = NO supply = sets.
contract VenueInvariantsTest is VenueBase {
    VenueHandler internal handler;
    Market internal m;
    HunchOrderBook internal book;
    address[] internal actors;
    address internal marginTaker = makeAddr("marginTaker");
    uint256 internal usdcTotal;

    function setUp() public override {
        super.setUp();
        (m, book) = _graduated();
        _fund(marginTaker, 20_000e6);
        _approveBook(marginTaker, m, book);

        address[] memory makers = new address[](3);
        makers[0] = maker;
        makers[1] = maker2;
        makers[2] = makeAddr("maker3");
        _fund(makers[2], 100_000e6);
        _approveBook(makers[2], m, book);
        for (uint256 i; i < makers.length; ++i) {
            _inventory(makers[i], m, 20_000e6, 20_000e6);
        }
        vm.startPrank(taker);
        vault.mintSets(address(m), 20_000e6, taker);
        vm.stopPrank();
        vm.startPrank(marginTaker);
        vault.mintSets(address(m), 5000e6, marginTaker);
        margin.deposit(marginTaker, address(usdc), 5000e6);
        margin.deposit(marginTaker, address(_yes(m)), 2000e6);
        vm.stopPrank();

        handler = new VenueHandler(book, router, vault, m, usdc, makers, taker, marginTaker);
        targetContract(address(handler));

        actors = makers;
        actors.push(taker);
        actors.push(marginTaker);
        usdcTotal = _systemBalance(address(usdc)) + usdc.balanceOf(address(vault));
    }

    function _systemBalance(address token) internal view returns (uint256 sum) {
        for (uint256 i; i < actors.length; ++i) {
            sum += _balanceOf(token, actors[i]);
        }
        sum += _balanceOf(token, address(margin));
    }

    function _books() internal view returns (address[] memory b) {
        b = new address[](1);
        b[0] = address(book);
    }

    function invariant_MarginAccountSolvent() public view {
        _assertMarginSolvent(address(usdc), actors, _books());
        _assertMarginSolvent(address(_yes(m)), actors, _books());
    }

    function invariant_EscrowEqualsRestingOrders() public view {
        uint256 askBase;
        uint256 bidLock;
        uint40 n = book.s_orderIdCounter();
        for (uint40 id = 1; id <= n; ++id) {
            (, uint96 size,,,, uint32 price,, bool isBuy) = book.s_orders(id);
            if (size == 0 || price == 0) continue;
            if (isBuy) bidLock += _ceilDiv(uint256(size) * price, 1e6);
            else askBase += size;
        }
        assertEq(margin.escrowOf(address(book), address(_yes(m))), askBase, "YES escrow");
        assertEq(margin.escrowOf(address(book), address(usdc)), bidLock, "USDC escrow");
    }

    function invariant_LevelsMatchLinkedLists() public view {
        bytes memory l2 = book.getL2Book();
        uint256 words = l2.length / 32;
        uint256 i = 1;
        uint256 lastBid = type(uint256).max;
        while (i < words && _word(l2, i) != 0) {
            uint256 price = _word(l2, i);
            assertLt(price, lastBid, "bids not descending");
            lastBid = price;
            assertEq(_walk(price, true), _word(l2, i + 1), "bid level != list");
            i += 2;
        }
        ++i;
        uint256 lastAsk;
        uint256 firstAsk;
        while (i < words) {
            uint256 price = _word(l2, i);
            if (firstAsk == 0) firstAsk = price;
            assertGt(price, lastAsk, "asks not ascending");
            lastAsk = price;
            assertEq(_walk(price, false), _word(l2, i + 1), "ask level != list");
            i += 2;
        }
        if (lastBid != type(uint256).max && firstAsk != 0) {
            assertLt(_word(l2, 1), firstAsk, "crossed book");
        }
    }

    function invariant_NoTokensCreatedOrLost() public view {
        uint256 usdcNow =
            _systemBalance(address(usdc)) + usdc.balanceOf(address(vault)) + usdc.balanceOf(address(router));
        assertEq(usdcNow, usdcTotal, "USDC created or lost");
        // YES moves between holders, and to and from the vault only as complete sets.
        uint256 yesHeld =
            _systemBalance(address(_yes(m))) + _yes(m).balanceOf(address(m)) + _yes(m).balanceOf(address(router));
        assertEq(yesHeld, _yes(m).totalSupply(), "YES outside known holders");
    }

    function invariant_CoreVaultSolvent() public view {
        assertGe(usdc.balanceOf(address(vault)), vault.totalObligations(), "vault insolvent");
        uint256 sets = vault.ledger(address(m)).sets;
        assertEq(_yes(m).totalSupply(), sets, "YES supply != sets");
        assertEq(_no(m).totalSupply(), sets, "NO supply != sets");
        assertEq(usdc.balanceOf(address(router)), 0, "router holds USDC");
    }

    // ---- helpers ----

    function _walk(uint256 price, bool isBuy) internal view returns (uint256 sum) {
        (uint40 head, uint40 tail) = isBuy ? book.s_buyPricePoints(price) : book.s_sellPricePoints(price);
        uint40 id = head;
        uint40 last;
        while (id != 0) {
            (, uint96 size, uint40 prev, uint40 next,, uint32 p,, bool b) = book.s_orders(id);
            assertEq(prev, last, "prev link");
            assertEq(p, price, "order at wrong level");
            assertEq(b, isBuy, "order on wrong side");
            assertGt(size, 0, "empty order in a list");
            sum += size;
            last = id;
            id = next;
        }
        assertEq(last, tail, "tail");
    }

    function _word(bytes memory data, uint256 index) internal pure returns (uint256 w) {
        assembly ("memory-safe") {
            w := mload(add(add(data, 32), mul(index, 32)))
        }
    }

    function afterInvariant() public view {
        assertGt(handler.calls(), 0);
    }
}

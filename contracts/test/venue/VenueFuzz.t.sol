// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Market} from "../../src/core/Market.sol";
import {HunchOrderBook} from "../../src/venue/HunchOrderBook.sol";
import {VenueBase} from "./VenueBase.sol";

/// Fuzzed ladders: Hunch's book always fills at least what Kuru's per-level arithmetic would (the model
/// the router, the app and the maker quote with), takers never pay more than they send, makers receive
/// exactly what takers pay, and escrow always equals what the resting orders lock.
contract VenueFuzzTest is VenueBase {
    Market internal m;
    HunchOrderBook internal book;
    address internal yes;

    struct Level {
        uint256 price;
        uint256 size;
    }

    function setUp() public override {
        super.setUp();
        (m, book) = _graduated();
        yes = address(_yes(m));
        _inventory(maker, m, 40_000e6, 40_000e6);
        _inventory(maker2, m, 40_000e6, 40_000e6);
        vm.prank(taker);
        vault.mintSets(address(m), 20_000e6, taker);
    }

    // ---------------------------------------------------------------- ladders

    /// Up to 8 ask levels ascending from `startIdx`, 1 to 3 orders each from alternating makers.
    function _askLadder(uint256 seed) internal returns (Level[] memory levels) {
        uint256 n = 1 + seed % 8;
        levels = new Level[](n);
        uint256 idx = 1 + (seed >> 8) % 600;
        for (uint256 i; i < n; ++i) {
            uint256 price = idx * TICK;
            uint256 orders = 1 + (seed >> (16 + i)) % 3;
            for (uint256 k; k < orders; ++k) {
                uint256 size = 1e6 + uint256(keccak256(abi.encode(seed, i, k))) % 300e6;
                // forge-lint: disable-next-line(unsafe-typecast)
                _ask(k % 2 == 0 ? maker : maker2, book, uint32(price), uint96(size));
                levels[i].size += size;
            }
            levels[i].price = price;
            idx += 1 + uint256(keccak256(abi.encode(seed, i))) % 40;
            if (idx > 1000) {
                assembly ("memory-safe") {
                    mstore(levels, add(i, 1))
                }
                break;
            }
        }
    }

    /// Up to 8 bid levels descending from `startIdx`.
    function _bidLadder(uint256 seed) internal returns (Level[] memory levels) {
        uint256 n = 1 + seed % 8;
        levels = new Level[](n);
        uint256 idx = 400 + (seed >> 8) % 600;
        for (uint256 i; i < n; ++i) {
            uint256 price = idx * TICK;
            uint256 orders = 1 + (seed >> (16 + i)) % 3;
            for (uint256 k; k < orders; ++k) {
                uint256 size = 1e6 + uint256(keccak256(abi.encode(seed, i, k))) % 300e6;
                // forge-lint: disable-next-line(unsafe-typecast)
                _bid(k % 2 == 0 ? maker : maker2, book, uint32(price), uint96(size));
                levels[i].size += size;
            }
            levels[i].price = price;
            uint256 step = 1 + uint256(keccak256(abi.encode(seed, i))) % 40;
            if (idx <= step) {
                assembly ("memory-safe") {
                    mstore(levels, add(i, 1))
                }
                break;
            }
            idx -= step;
        }
    }

    /// Kuru v1's market buy (MockKuruOrderBook, verified against Kuru's book in the fork suites).
    function _kuruBuy(Level[] memory asks, uint256 q) internal pure returns (uint256 filled) {
        for (uint256 i; i < asks.length && q > 0; ++i) {
            uint256 fillable = q * 1e6 / asks[i].price;
            if (fillable <= asks[i].size) return filled + fillable;
            filled += asks[i].size;
            q = asks[i].price * (fillable - asks[i].size) / 1e6;
        }
    }

    /// Kuru v1's market sell: floor(fill * p / sP) per level.
    function _kuruSell(Level[] memory bids, uint256 s) internal pure returns (uint256 quote) {
        for (uint256 i; i < bids.length && s > 0; ++i) {
            uint256 f = s < bids[i].size ? s : bids[i].size;
            quote += f * bids[i].price / 1e6;
            s -= f;
        }
    }

    function _makersUsdc() internal view returns (uint256) {
        return margin.getBalance(maker, address(usdc)) + margin.getBalance(maker2, address(usdc));
    }

    function _restingTotals() internal view returns (uint256 askBase, uint256 bidLock) {
        uint40 n = book.s_orderIdCounter();
        for (uint40 id = 1; id <= n; ++id) {
            (, uint96 size,,,, uint32 price,, bool isBuy) = book.s_orders(id);
            if (size == 0 || price == 0) continue;
            if (isBuy) bidLock += _ceilDiv(uint256(size) * price, 1e6);
            else askBase += size;
        }
    }

    function _assertEscrowMatchesBook() internal view {
        (uint256 askBase, uint256 bidLock) = _restingTotals();
        assertEq(margin.escrowOf(address(book), yes), askBase, "YES escrow != resting asks");
        assertEq(margin.escrowOf(address(book), address(usdc)), bidLock, "USDC escrow != bid locks");
    }

    // ---------------------------------------------------------------- properties

    function testFuzz_MarketBuyMeetsKuruAndPaysMakersExactly(uint256 seed, uint256 quoteIn) public {
        Level[] memory asks = _askLadder(seed);
        quoteIn = bound(quoteIn, 1, 3000e6);
        uint256 kuru = _kuruBuy(asks, quoteIn);

        uint256 makersBefore = _makersUsdc();
        uint256 usdcBefore = usdc.balanceOf(taker);
        uint256 yesBefore = _yes(m).balanceOf(taker);
        vm.prank(taker);
        // forge-lint: disable-next-line(unsafe-typecast)
        uint256 out = book.placeAndExecuteMarketBuy(uint96(quoteIn), 0, false, false);
        uint256 spent = usdcBefore - usdc.balanceOf(taker);

        assertGe(out, kuru, "filled less than Kuru would");
        assertEq(_yes(m).balanceOf(taker) - yesBefore, out);
        assertLe(spent, quoteIn);
        assertEq(_makersUsdc() - makersBefore, spent, "makers != taker payment");
        // Never cheaper than the exact value of what was bought, level by level.
        uint256 left = out;
        uint256 exact;
        for (uint256 i; i < asks.length && left > 0; ++i) {
            uint256 f = left < asks[i].size ? left : asks[i].size;
            exact += f * asks[i].price;
            left -= f;
        }
        assertGe(spent * 1e6, exact, "taker paid below value");
        _assertEscrowMatchesBook();
    }

    function testFuzz_MarketSellMeetsKuruAndEscrowStaysExact(uint256 seed, uint256 sizeIn) public {
        Level[] memory bids = _bidLadder(seed);
        sizeIn = bound(sizeIn, 1, 3000e6);
        uint256 kuru = _kuruSell(bids, sizeIn);

        uint256 usdcBefore = usdc.balanceOf(taker);
        vm.prank(taker);
        // forge-lint: disable-next-line(unsafe-typecast)
        uint256 out = book.placeAndExecuteMarketSell(uint96(sizeIn), 0, false, false);
        assertGe(out, kuru, "paid less than Kuru would");
        assertEq(usdc.balanceOf(taker) - usdcBefore, out);
        // At most one base unit per maker order above the exact value.
        uint256 left = sizeIn;
        uint256 exactCeil;
        for (uint256 i; i < bids.length && left > 0; ++i) {
            uint256 f = left < bids[i].size ? left : bids[i].size;
            exactCeil += _ceilDiv(f * bids[i].price, 1e6);
            left -= f;
        }
        assertLe(out, exactCeil + 3 * bids.length);
        _assertEscrowMatchesBook();
    }

    function testFuzz_RouterSellNoAlwaysCoversItsQuote(uint256 seed, uint256 noIn) public {
        Level[] memory asks = _askLadder(seed);
        uint256 depth;
        for (uint256 i; i < asks.length; ++i) {
            depth += asks[i].size;
        }
        noIn = bound(noIn, 1, depth > 20_000e6 ? 20_000e6 : depth);
        uint256 q = router.quoteSellNo(address(m), noIn);
        uint256 before = usdc.balanceOf(taker);
        vm.prank(taker);
        uint256 out = router.sellNo(address(m), noIn, 0, deadline);
        assertGe(out + q, noIn, "seller got less than the quote promised");
        assertEq(usdc.balanceOf(taker) - before, out);
        assertEq(usdc.balanceOf(address(router)), 0);
        _assertEscrowMatchesBook();
    }

    function testFuzz_RouterBuyNoDeliversExactly(uint256 seed, uint256 noOut) public {
        Level[] memory bids = _bidLadder(seed);
        uint256 depth;
        for (uint256 i; i < bids.length; ++i) {
            depth += bids[i].size;
        }
        noOut = bound(noOut, 1, depth > 10_000e6 ? 10_000e6 : depth);
        uint256 noBefore = _no(m).balanceOf(taker);
        uint256 usdcBefore = usdc.balanceOf(taker);
        vm.prank(taker);
        uint256 paid = router.buyNo(address(m), noOut, noOut, deadline);
        assertEq(_no(m).balanceOf(taker) - noBefore, noOut);
        assertEq(usdcBefore - usdc.balanceOf(taker), paid);
        assertLe(paid, noOut - _kuruSell(bids, noOut));
        assertEq(vault.ledger(address(m)).sets, _yes(m).totalSupply());
        _assertEscrowMatchesBook();
    }

    function testFuzz_CancelRestoresFreeBalance(uint32 priceSeed, uint96 sizeSeed, bool isBuy) public {
        uint32 price = uint32(bound(priceSeed, 1, 1000)) * TICK;
        uint96 size = uint96(bound(sizeSeed, MIN_SIZE, 5000e6));
        address token = isBuy ? address(usdc) : yes;
        uint256 before = margin.getBalance(maker, token);
        uint40 id = isBuy ? _bid(maker, book, price, size) : _ask(maker, book, price, size);
        uint40[] memory ids = new uint40[](1);
        ids[0] = id;
        vm.prank(maker);
        book.batchCancelOrders(ids);
        assertEq(margin.getBalance(maker, token), before);
        _assertEscrowMatchesBook();
    }
}

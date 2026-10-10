// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {LibBit} from "solady/utils/LibBit.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {IMarket} from "../interfaces/IMarket.sol";
import {Phase} from "../interfaces/IHunchBookTypes.sol";
import {HunchMarginAccount} from "./HunchMarginAccount.sol";

/// @title HunchOrderBook
/// @notice Hunch Book's own onchain order book for one graduated market's YES/USDC pair
/// (docs/PROTOCOL.md §8.1, "Hunch order book"). Price-time priority, fully onchain, no admin, no fees.
///
/// It has the function selectors, return layouts, events and error names of the parts of Kuru v1's
/// OrderBook that Hunch Book's Graduator, HunchRouter, maker, keeper, app and indexer use, so all of them
/// work against it unchanged. It is our own code, written from those interfaces.
///
/// What differs from Kuru, on purpose:
/// - It exists only for a Hunch Book market (HunchOrderBookFactory checks), and matches only while that
///   market is in phase Graduated. Before graduation and from close on, it accepts cancels only; the
///   margin account always allows withdrawals. Nobody can pause it or change that: it reads the market's
///   own clock. `marketState()` reads 0 (active) while matching and 1 (cancels only) otherwise.
/// - No trading fees (the factory accepts fee 0 only) and no AMM vault (`getVaultParams` reads zeros).
/// - Every limit order rests (post-only), whatever `_postOnly` says: a limit order that would cross the
///   book reverts `PostOnlyError`. Take liquidity with a market order.
/// - Prices are multiples of tickSize from tickSize up to 1 USDC (pricePrecision).
///
/// Units. The factory requires sizePrecision = 10^(base decimals) and pricePrecision = 10^(quote
/// decimals), so a size is in base token units, a price is quote token units per one whole base token,
/// and a size times a price divided by sizePrecision is quote token units.
///
/// Matching arithmetic (p = level price, sP = sizePrecision; Kuru's own per-level formulas, so the
/// router's and the app's quotes, which reproduce Kuru, are always met or beaten):
/// - Market buy with quote q: at each ask level, take = min(floor(q * sP / p), level size) for
///   ceil(take * p / sP) quote, then q drops by that cost. The makers at the level receive floor(f * p / sP)
///   each, in time order, and the first of them also receives the rounding residual, so they receive
///   exactly what the taker paid. Quote left over is returned to the taker (Kuru keeps that dust).
/// - Market sell of size s: at each bid level, take = min(s, level size). A resting bid of size n locks
///   ceil(n * p / sP) quote; filling f of it pays the taker the drop in that lock,
///   ceil(n * p / sP) - ceil((n - f) * p / sP), which is at least floor(f * p / sP). Over an order's life it
///   pays out exactly what it locked. Base left over is returned to the taker.
/// Taker tokens move through HunchMarginAccount: the wallet path (`_isMargin` = false) pulls from the
/// caller with transferFrom (approve this book) and pays out by transfer; the margin path uses the
/// caller's free balance there.
///
/// Storage readers. `s_orders`, `s_buyPricePoints`, `s_sellPricePoints` and `s_orderIdCounter` have
/// Kuru's layouts. Each price level is a FIFO linked list (head first). A cancelled order is deleted (its
/// price reads 0). A filled order keeps its owner and price with size 0 and leaves the list, so the
/// level's head moves past it: readers tell "filled" from "resting" by comparing ids with the head.
contract HunchOrderBook {
    using SafeTransferLib for address;

    // Kuru v1 error names, so tools that decode Kuru's errors decode ours.
    error MarketStateError();
    error PriceError();
    error SizeError();
    error TickSizeError();
    error PostOnlyError();
    error OnlyOwnerAllowedError();
    error OrderAlreadyFilledOrCancelled();
    error LengthMismatch();
    error InsufficientLiquidity();
    error SlippageExceeded();
    error NativeAssetMismatch();
    error AlreadyInitialized();
    error Reentrancy();

    /// A limit order rested on the book. No field is indexed (Kuru's layout).
    event OrderCreated(uint40 orderId, address owner, uint96 size, uint32 price, bool isBuy);
    /// A taker filled `filledSize` of maker order `orderId`. `isBuy` is the taker's side, `price` is the
    /// level price scaled to 1e18 and `updatedSize` is the maker order's size left.
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

    /// Kuru v1's order layout. `flippedId` and `flippedPrice` are always 0 (no flip orders).
    struct Order {
        address ownerAddress;
        uint96 size;
        uint40 prev;
        uint40 next;
        uint40 flippedId;
        uint32 price;
        uint32 flippedPrice;
        bool isBuy;
    }

    /// One price level's FIFO list (0 = empty).
    struct PricePoint {
        uint40 head;
        uint40 tail;
    }

    /// `bestBidAsk()` and `Trade` prices are scaled to this, like Kuru's.
    uint256 internal constant BEST_PRICE_SCALE = 1e18;

    // ---- set once by `initialize` ----
    HunchMarginAccount public marginAccount;
    /// The Hunch Book market whose YES token this book trades.
    address public market;
    address public baseAsset;
    address public quoteAsset;
    uint32 internal _pricePrecision;
    uint96 internal _sizePrecision;
    uint32 internal _tickSize;
    uint96 internal _minSize;
    uint96 internal _maxSize;
    uint96 internal _kuruAmmSpread;
    uint8 internal _baseDecimals;
    uint8 internal _quoteDecimals;
    /// Price levels: tickSize, 2 * tickSize, ..., pricePrecision (level index = price / tickSize).
    uint32 internal _levels;

    mapping(uint40 id => Order) public s_orders;
    mapping(uint256 price => PricePoint) public s_buyPricePoints;
    mapping(uint256 price => PricePoint) public s_sellPricePoints;
    /// The last order id handed out (ids start at 1).
    uint40 public s_orderIdCounter;

    /// Resting size per level.
    mapping(uint256 price => uint256) internal _bidSize;
    mapping(uint256 price => uint256) internal _askSize;
    /// One bit per non-empty level, by level index.
    mapping(uint256 word => uint256) internal _bidBits;
    mapping(uint256 word => uint256) internal _askBits;

    bool private transient _locked;

    modifier nonReentrant() {
        if (_locked) revert Reentrancy();
        _locked = true;
        _;
        _locked = false;
    }

    /// The implementation behind every clone can never be initialized or used.
    constructor() {
        marginAccount = HunchMarginAccount(address(0xdead));
    }

    /// Called once by HunchOrderBookFactory, in the transaction that creates this clone, after it has
    /// checked every value.
    function initialize(
        HunchMarginAccount marginAccount_,
        address market_,
        address base,
        address quote,
        uint32 pricePrecision,
        uint96 sizePrecision,
        uint32 tickSize,
        uint96 minSize,
        uint96 maxSize,
        uint96 kuruAmmSpread,
        uint8 baseDecimals,
        uint8 quoteDecimals
    ) external {
        if (address(marginAccount) != address(0)) revert AlreadyInitialized();
        marginAccount = marginAccount_;
        market = market_;
        baseAsset = base;
        quoteAsset = quote;
        _pricePrecision = pricePrecision;
        _sizePrecision = sizePrecision;
        _tickSize = tickSize;
        _minSize = minSize;
        _maxSize = maxSize;
        _kuruAmmSpread = kuruAmmSpread;
        _baseDecimals = baseDecimals;
        _quoteDecimals = quoteDecimals;
        _levels = pricePrecision / tickSize;
    }

    // ---------------------------------------------------------------- market orders

    /// Spends up to `_quoteSize` quote (quote token units) on the best asks. Returns the base bought.
    /// Reverts `SlippageExceeded` below `_minAmountOut`; with `_isFillOrKill`, reverts
    /// `InsufficientLiquidity` if the asks run out while the quote left could still buy a unit.
    function placeAndExecuteMarketBuy(uint96 _quoteSize, uint256 _minAmountOut, bool _isMargin, bool _isFillOrKill)
        external
        payable
        nonReentrant
        returns (uint256 baseOut)
    {
        if (msg.value != 0) revert NativeAssetMismatch();
        _requireActive();
        if (_quoteSize == 0) revert SizeError();
        _takeIn(quoteAsset, _quoteSize, _isMargin);

        uint256 q = _quoteSize;
        uint256 sP = _sizePrecision;
        uint256 tick = _tickSize;
        uint256 idx = _lowestAtOrAbove(_askBits, 1);
        uint256 lastPrice;
        while (q != 0 && idx != 0) {
            uint256 price = idx * tick;
            lastPrice = price;
            uint256 fillable = q * sP / price;
            if (fillable == 0) break;
            uint256 depth = _askSize[price];
            uint256 take = fillable < depth ? fillable : depth;
            uint256 cost = _ceilDiv(take * price, sP);
            _fillAsks(price, take, cost);
            q -= cost;
            baseOut += take;
            if (take < depth) break;
            idx = _lowestAtOrAbove(_askBits, idx + 1);
        }
        if (_isFillOrKill && q != 0 && idx == 0 && (lastPrice == 0 || q * sP / lastPrice != 0)) {
            revert InsufficientLiquidity();
        }

        _giveOut(baseAsset, baseOut, _isMargin);
        _giveOut(quoteAsset, q, _isMargin);
        if (baseOut < _minAmountOut) revert SlippageExceeded();
    }

    /// Sells up to `_size` base (base token units) into the best bids. Returns the quote received.
    /// Reverts `SlippageExceeded` below `_minAmountOut`; with `_isFillOrKill`, reverts
    /// `InsufficientLiquidity` unless all of `_size` sells.
    function placeAndExecuteMarketSell(uint96 _size, uint256 _minAmountOut, bool _isMargin, bool _isFillOrKill)
        external
        payable
        nonReentrant
        returns (uint256 quoteOut)
    {
        if (msg.value != 0) revert NativeAssetMismatch();
        _requireActive();
        if (_size == 0) revert SizeError();
        _takeIn(baseAsset, _size, _isMargin);

        uint256 s = _size;
        uint256 tick = _tickSize;
        uint256 idx = _highestAtOrBelow(_bidBits, _levels);
        while (s != 0 && idx != 0) {
            uint256 price = idx * tick;
            uint256 depth = _bidSize[price];
            uint256 take = s < depth ? s : depth;
            quoteOut += _fillBids(price, take);
            s -= take;
            if (s == 0) break;
            idx = _highestAtOrBelow(_bidBits, idx - 1);
        }
        if (_isFillOrKill && s != 0) revert InsufficientLiquidity();

        _giveOut(quoteAsset, quoteOut, _isMargin);
        _giveOut(baseAsset, s, _isMargin);
        if (quoteOut < _minAmountOut) revert SlippageExceeded();
    }

    // ---------------------------------------------------------------- limit orders

    /// Rests a bid for `size` base at `_price`, paid from the caller's free quote balance in the margin
    /// account. Post-only (see the contract notes).
    function addBuyOrder(uint32 _price, uint96 size, bool) external nonReentrant {
        _requireActive();
        _place(_price, size, true);
    }

    /// Rests an ask for `_size` base at `_price`, from the caller's free base balance. Post-only.
    function addSellOrder(uint32 _price, uint96 _size, bool) external nonReentrant {
        _requireActive();
        _place(_price, _size, false);
    }

    /// Cancels `orderIdsToCancel` (a filled id is skipped), then rests the buys, then the sells, all
    /// post-only. Cancels work in any market phase; placing needs the book to be active.
    function batchUpdate(
        uint32[] calldata buyPrices,
        uint96[] calldata buySizes,
        uint32[] calldata sellPrices,
        uint96[] calldata sellSizes,
        uint40[] calldata orderIdsToCancel,
        bool
    ) external nonReentrant {
        if (buyPrices.length != buySizes.length || sellPrices.length != sellSizes.length) revert LengthMismatch();
        _cancelMany(orderIdsToCancel, false);
        if (buyPrices.length == 0 && sellPrices.length == 0) return;
        _requireActive();
        for (uint256 i; i < buyPrices.length; ++i) {
            _place(buyPrices[i], buySizes[i], true);
        }
        for (uint256 i; i < sellPrices.length; ++i) {
            _place(sellPrices[i], sellSizes[i], false);
        }
    }

    /// Cancels the caller's orders. Reverts `OrderAlreadyFilledOrCancelled` for a filled id and
    /// `OnlyOwnerAllowedError` for an id that is not the caller's or is already cancelled.
    function batchCancelOrders(uint40[] calldata _orderIds) external nonReentrant {
        _cancelMany(_orderIds, true);
    }

    // ---------------------------------------------------------------- views (Kuru v1 layouts)

    /// Best bid and ask scaled to 1e18. An empty bid reads type(uint256).max and an empty ask 0 (Kuru's
    /// sentinels).
    function bestBidAsk() external view returns (uint256 bid, uint256 ask) {
        uint256 b = _highestAtOrBelow(_bidBits, _levels);
        uint256 a = _lowestAtOrAbove(_askBits, 1);
        bid = b == 0 ? type(uint256).max : _scaled(b * _tickSize);
        ask = a == 0 ? 0 : _scaled(a * _tickSize);
    }

    /// Every resting level, as 32-byte words: [block number] [bid price, bid size]... [0]
    /// [ask price, ask size]..., best first on each side.
    function getL2Book() external view returns (bytes memory) {
        return getL2Book(type(uint32).max, type(uint32).max);
    }

    /// The best `_bidPricePoints` bid levels and `_askPricePoints` ask levels, laid out as `getL2Book()`.
    function getL2Book(uint32 _bidPricePoints, uint32 _askPricePoints) public view returns (bytes memory) {
        uint256 tick = _tickSize;
        uint256 nb;
        for (uint256 i = _highestAtOrBelow(_bidBits, _levels); i != 0 && nb < _bidPricePoints; ++nb) {
            i = _highestAtOrBelow(_bidBits, i - 1);
        }
        uint256 na;
        for (uint256 i = _lowestAtOrAbove(_askBits, 1); i != 0 && na < _askPricePoints; ++na) {
            i = _lowestAtOrAbove(_askBits, i + 1);
        }

        uint256[] memory words = new uint256[](2 + 2 * (nb + na));
        words[0] = block.number;
        uint256 w = 1;
        uint256 idx = _highestAtOrBelow(_bidBits, _levels);
        for (uint256 k; k < nb; ++k) {
            uint256 price = idx * tick;
            words[w++] = price;
            words[w++] = _bidSize[price];
            idx = _highestAtOrBelow(_bidBits, idx - 1);
        }
        words[w++] = 0;
        idx = _lowestAtOrAbove(_askBits, 1);
        for (uint256 k; k < na; ++k) {
            uint256 price = idx * tick;
            words[w++] = price;
            words[w++] = _askSize[price];
            idx = _lowestAtOrAbove(_askBits, idx + 1);
        }
        return abi.encodePacked(words);
    }

    /// Kuru v1's field order: pricePrecision, sizePrecision, base, base decimals, quote, quote decimals,
    /// tickSize, minSize, maxSize, takerFeeBps (0), makerFeeBps (0).
    function getMarketParams()
        external
        view
        returns (uint32, uint96, address, uint256, address, uint256, uint32, uint96, uint96, uint256, uint256)
    {
        return (
            _pricePrecision,
            _sizePrecision,
            baseAsset,
            _baseDecimals,
            quoteAsset,
            _quoteDecimals,
            _tickSize,
            _minSize,
            _maxSize,
            0,
            0
        );
    }

    /// Kuru v1's field order. There is no AMM vault: every field is zero except the recorded spread.
    function getVaultParams()
        external
        view
        returns (address, uint256, uint96, uint256, uint96, uint96, uint96, uint96)
    {
        return (address(0), 0, 0, 0, 0, 0, 0, _kuruAmmSpread);
    }

    /// 0 while the market is Graduated (matching), 1 otherwise (cancels only). Never 2.
    function marketState() external view returns (uint8) {
        return _active() ? 0 : 1;
    }

    /// Resting size at `price` on one side.
    function levelSize(uint32 price, bool isBuy) external view returns (uint256) {
        return isBuy ? _bidSize[price] : _askSize[price];
    }

    // ---------------------------------------------------------------- matching

    /// Fills `take` of the asks at `price`, oldest first, for `cost` quote the taker has put in escrow.
    function _fillAsks(uint256 price, uint256 take, uint256 cost) internal {
        PricePoint storage pp = s_sellPricePoints[price];
        uint256 scaled = _scaled(price);
        uint256 left = take;
        uint256 paid;
        address first;
        uint40 id = pp.head;
        while (left != 0) {
            Order storage o = s_orders[id];
            uint256 size = o.size;
            uint256 f = left < size ? left : size;
            uint256 credit = f * price / _sizePrecision;
            // forge-lint: disable-next-line(unsafe-typecast)
            o.size = uint96(size - f);
            left -= f;
            paid += credit;
            if (first == address(0)) first = o.ownerAddress;
            marginAccount.release(o.ownerAddress, quoteAsset, credit);
            // forge-lint: disable-next-line(unsafe-typecast)
            emit Trade(id, o.ownerAddress, true, scaled, uint96(size - f), msg.sender, tx.origin, uint96(f));
            if (size == f) id = _popHead(pp, o.next);
        }
        if (cost > paid) marginAccount.release(first, quoteAsset, cost - paid);

        uint256 remaining = _askSize[price] - take;
        _askSize[price] = remaining;
        if (remaining == 0) _clearBit(_askBits, price / _tickSize);
    }

    /// Fills `take` of the bids at `price`, oldest first, against base the taker has put in escrow.
    /// Returns the quote the taker receives.
    function _fillBids(uint256 price, uint256 take) internal returns (uint256 got) {
        PricePoint storage pp = s_buyPricePoints[price];
        uint256 scaled = _scaled(price);
        uint256 left = take;
        uint40 id = pp.head;
        while (left != 0) {
            Order storage o = s_orders[id];
            (uint256 f, uint256 rest, uint256 paid) = _bidFill(o.size, left, price);
            got += paid;
            // forge-lint: disable-next-line(unsafe-typecast)
            o.size = uint96(rest);
            left -= f;
            marginAccount.release(o.ownerAddress, baseAsset, f);
            // forge-lint: disable-next-line(unsafe-typecast)
            emit Trade(id, o.ownerAddress, false, scaled, uint96(rest), msg.sender, tx.origin, uint96(f));
            if (rest == 0) id = _popHead(pp, o.next);
        }

        uint256 remaining = _bidSize[price] - take;
        _bidSize[price] = remaining;
        if (remaining == 0) _clearBit(_bidBits, price / _tickSize);
    }

    /// Filling up to `left` of a resting bid of `size` at `price`: the size filled, the size left, and the
    /// quote it pays (the drop in its lock).
    function _bidFill(uint256 size, uint256 left, uint256 price)
        internal
        view
        returns (uint256 f, uint256 rest, uint256 paid)
    {
        f = left < size ? left : size;
        rest = size - f;
        paid = _lockedQuote(size, price) - _lockedQuote(rest, price);
    }

    /// Removes a level's filled head order (it keeps its owner and price, with size 0). Returns the new head.
    function _popHead(PricePoint storage pp, uint40 next) internal returns (uint40) {
        pp.head = next;
        if (next == 0) pp.tail = 0;
        else s_orders[next].prev = 0;
        return next;
    }

    // ---------------------------------------------------------------- placing and cancelling

    function _place(uint256 price, uint256 size, bool isBuy) internal {
        uint256 idx = _levelOf(price);
        if (size < _minSize || size > _maxSize) revert SizeError();
        if (isBuy) {
            uint256 bestAsk = _lowestAtOrAbove(_askBits, 1);
            if (bestAsk != 0 && idx >= bestAsk) revert PostOnlyError();
            marginAccount.lock(msg.sender, quoteAsset, _lockedQuote(size, price));
        } else {
            uint256 bestBid = _highestAtOrBelow(_bidBits, _levels);
            if (bestBid != 0 && idx <= bestBid) revert PostOnlyError();
            marginAccount.lock(msg.sender, baseAsset, size);
        }

        uint40 id = ++s_orderIdCounter;
        PricePoint storage pp = isBuy ? s_buyPricePoints[price] : s_sellPricePoints[price];
        uint40 tail = pp.tail;
        s_orders[id] = Order({
            ownerAddress: msg.sender,
            // forge-lint: disable-next-line(unsafe-typecast)
            size: uint96(size),
            prev: tail,
            next: 0,
            flippedId: 0,
            // forge-lint: disable-next-line(unsafe-typecast)
            price: uint32(price),
            flippedPrice: 0,
            isBuy: isBuy
        });
        if (tail == 0) pp.head = id;
        else s_orders[tail].next = id;
        pp.tail = id;

        if (isBuy) {
            if (_bidSize[price] == 0) _setBit(_bidBits, idx);
            _bidSize[price] += size;
        } else {
            if (_askSize[price] == 0) _setBit(_askBits, idx);
            _askSize[price] += size;
        }
        // forge-lint: disable-next-line(unsafe-typecast)
        emit OrderCreated(id, msg.sender, uint96(size), uint32(price), isBuy);
    }

    function _cancelMany(uint40[] calldata ids, bool strict) internal {
        if (ids.length == 0) return;
        uint40[] memory done = new uint40[](ids.length);
        uint256 n;
        for (uint256 i; i < ids.length; ++i) {
            if (_cancel(ids[i], strict)) done[n++] = ids[i];
        }
        if (n == 0) return;
        assembly ("memory-safe") {
            mstore(done, n)
        }
        emit OrdersCanceled(done, msg.sender);
    }

    /// Cancels one of the caller's resting orders and returns its escrow to their free balance. Returns
    /// false (or reverts, if `strict`) for a filled order.
    function _cancel(uint40 id, bool strict) internal returns (bool) {
        Order storage o = s_orders[id];
        if (o.price == 0 || o.ownerAddress != msg.sender) revert OnlyOwnerAllowedError();
        uint256 size = o.size;
        if (size == 0) {
            if (strict) revert OrderAlreadyFilledOrCancelled();
            return false;
        }
        uint256 price = o.price;
        bool isBuy = o.isBuy;
        uint40 prev = o.prev;
        uint40 next = o.next;
        PricePoint storage pp = isBuy ? s_buyPricePoints[price] : s_sellPricePoints[price];
        if (prev == 0) pp.head = next;
        else s_orders[prev].next = next;
        if (next == 0) pp.tail = prev;
        else s_orders[next].prev = prev;
        delete s_orders[id];

        if (isBuy) {
            uint256 left = _bidSize[price] - size;
            _bidSize[price] = left;
            if (left == 0) _clearBit(_bidBits, price / _tickSize);
            marginAccount.release(msg.sender, quoteAsset, _lockedQuote(size, price));
        } else {
            uint256 left = _askSize[price] - size;
            _askSize[price] = left;
            if (left == 0) _clearBit(_askBits, price / _tickSize);
            marginAccount.release(msg.sender, baseAsset, size);
        }
        return true;
    }

    // ---------------------------------------------------------------- internals

    function _active() internal view returns (bool) {
        return IMarket(market).phase() == Phase.Graduated;
    }

    function _requireActive() internal view {
        if (!_active()) revert MarketStateError();
    }

    /// Puts the taker's tokens in this book's escrow: from their wallet (transferFrom to the margin
    /// account) or from their free margin balance.
    function _takeIn(address token, uint256 amount, bool isMargin) internal {
        if (isMargin) {
            marginAccount.lock(msg.sender, token, amount);
        } else {
            token.safeTransferFrom(msg.sender, address(marginAccount), amount);
            marginAccount.escrowIn(token, amount);
        }
    }

    /// Pays the taker from this book's escrow: to their wallet or to their free margin balance.
    function _giveOut(address token, uint256 amount, bool isMargin) internal {
        if (amount == 0) return;
        if (isMargin) marginAccount.release(msg.sender, token, amount);
        else marginAccount.payOut(token, msg.sender, amount);
    }

    /// The level index of a valid limit price: a multiple of tickSize, above 0, at most 1 USDC.
    function _levelOf(uint256 price) internal view returns (uint256) {
        if (price == 0 || price > _pricePrecision) revert PriceError();
        if (price % _tickSize != 0) revert TickSizeError();
        return price / _tickSize;
    }

    /// Quote a resting bid of `size` at `price` locks.
    function _lockedQuote(uint256 size, uint256 price) internal view returns (uint256) {
        return _ceilDiv(size * price, _sizePrecision);
    }

    function _scaled(uint256 price) internal view returns (uint256) {
        return price * BEST_PRICE_SCALE / _pricePrecision;
    }

    function _ceilDiv(uint256 a, uint256 b) internal pure returns (uint256) {
        return a == 0 ? 0 : (a - 1) / b + 1;
    }

    function _setBit(mapping(uint256 => uint256) storage bits, uint256 idx) internal {
        bits[idx >> 8] |= 1 << (idx & 255);
    }

    function _clearBit(mapping(uint256 => uint256) storage bits, uint256 idx) internal {
        bits[idx >> 8] &= ~(1 << (idx & 255));
    }

    /// The highest non-empty level index at or below `idx`, or 0 if none (index 0 is never used).
    function _highestAtOrBelow(mapping(uint256 => uint256) storage bits, uint256 idx) internal view returns (uint256) {
        if (idx == 0) return 0;
        uint256 w = idx >> 8;
        uint256 bit = idx & 255;
        uint256 word = bits[w] & (bit == 255 ? type(uint256).max : (uint256(1) << (bit + 1)) - 1);
        while (true) {
            if (word != 0) return (w << 8) | LibBit.fls(word);
            if (w == 0) return 0;
            unchecked {
                --w;
            }
            word = bits[w];
        }
        return 0;
    }

    /// The lowest non-empty level index at or above `idx`, or 0 if none up to the last level.
    function _lowestAtOrAbove(mapping(uint256 => uint256) storage bits, uint256 idx) internal view returns (uint256) {
        uint256 lastWord = uint256(_levels) >> 8;
        uint256 w = idx >> 8;
        if (w > lastWord) return 0;
        uint256 word = bits[w] & (type(uint256).max << (idx & 255));
        while (true) {
            if (word != 0) return (w << 8) | LibBit.ffs(word);
            if (w >= lastWord) return 0;
            unchecked {
                ++w;
            }
            word = bits[w];
        }
        return 0;
    }
}

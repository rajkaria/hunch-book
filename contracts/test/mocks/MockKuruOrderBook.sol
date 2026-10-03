// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {KuruMarketParams} from "../../src/interfaces/external/IKuruOrderBook.sol";
import {MockTokenForRouter} from "./MockVaultForRouter.sol";

/// A Kuru order book stand-in for unit tests: resting liquidity is a list of price levels, and the
/// wallet-path market orders reproduce Kuru's integer arithmetic (written from its documented
/// behaviour, verified against the real book in the fork suites):
/// - market buy with quote q: per ask level (price p, size s), F = floor(q * sP / p); if F <= s fill F
///   and continue with q = floor(p * 0 / sP) = 0; else fill s and continue with q = floor(p * (F - s) / sP).
///   Base credited = filled * 10^baseDecimals / sP, minus ceil(credit * takerFee / 1e4). Quote left after
///   the asks run out is refunded (fill-or-kill: revert). Nothing filled: no credit, quote left refunded.
/// - market sell of size: per bid level, quote += floor(filled * p / sP); credit = quote * 10^quoteDecimals
///   / pP minus ceil(credit * takerFee / 1e4). Size left is refunded (fill-or-kill: revert). Zero quote
///   credited: no credit at all (Kuru returns early), size left refunded.
/// - `SlippageExceeded()` if the credit is below the minimum.
/// Liquidity is minted into the book when a level is added (the tokens are MockTokenForRouter).
/// Test hooks: short-deliver against the returned amount, and re-enter a target during a market order.
contract MockKuruOrderBook {
    using SafeTransferLib for address;

    error SlippageExceeded();
    error InsufficientLiquidity();
    error MarginNotSupported();

    struct Level {
        uint32 price;
        uint96 size;
    }

    KuruMarketParams internal _p;
    uint96 public kuruAmmSpread;

    Level[] internal _asks; // ascending price, live from _askHead
    Level[] internal _bids; // descending price, live from _bidHead
    uint256 internal _askHead;
    uint256 internal _bidHead;

    uint256 public shortBase;
    uint256 public shortQuote;
    address public reenterTarget;
    bytes public reenterData;

    uint256 public marketBuys;
    uint256 public marketSells;
    /// Allowance the caller had given this book when its last market order pulled tokens.
    uint256 public lastAllowance;

    constructor(KuruMarketParams memory p, uint96 spread) {
        _p = p;
        kuruAmmSpread = spread;
    }

    // ---- liquidity ----

    function addAsk(uint32 price, uint96 size) external {
        _insert(_asks, _askHead, price, size, true);
        MockTokenForRouter(_p.baseAsset)
            .mint(address(this), uint256(size) * 10 ** _p.baseAssetDecimals / _p.sizePrecision);
    }

    function addBid(uint32 price, uint96 size) external {
        _insert(_bids, _bidHead, price, size, false);
        uint256 quote = (uint256(price) * size + _p.sizePrecision - 1) / _p.sizePrecision;
        MockTokenForRouter(_p.quoteAsset).mint(address(this), quote * 10 ** _p.quoteAssetDecimals / _p.pricePrecision);
    }

    /// Appends `count` ask levels above the current ones (prices firstPrice, firstPrice + step, ...).
    function pushAsks(uint32 firstPrice, uint32 step, uint96 size, uint256 count) external {
        for (uint256 i; i < count; ++i) {
            _asks.push(Level(uint32(firstPrice + i * step), size));
        }
        MockTokenForRouter(_p.baseAsset)
            .mint(address(this), count * size * 10 ** _p.baseAssetDecimals / _p.sizePrecision);
    }

    function clear() external {
        delete _asks;
        delete _bids;
        _askHead = 0;
        _bidHead = 0;
    }

    function setShort(uint256 base, uint256 quote) external {
        shortBase = base;
        shortQuote = quote;
    }

    function setReenter(address target, bytes calldata data) external {
        reenterTarget = target;
        reenterData = data;
    }

    // ---- market orders (wallet path) ----

    function placeAndExecuteMarketBuy(uint96 quoteSize, uint256 minAmountOut, bool isMargin, bool isFillOrKill)
        external
        payable
        returns (uint256 credit)
    {
        if (isMargin) revert MarginNotSupported();
        _reenter();
        ++marketBuys;
        uint256 sP = _p.sizePrecision;
        lastAllowance = MockTokenForRouter(_p.quoteAsset).allowance(msg.sender, address(this));
        _p.quoteAsset.safeTransferFrom(msg.sender, address(this), _toQuoteUnits(quoteSize));

        uint256 q = quoteSize;
        uint256 filled;
        while (q > 0 && _askHead < _asks.length) {
            Level storage l = _asks[_askHead];
            uint256 fillable = q * sP / l.price;
            if (fillable <= l.size) {
                filled += fillable;
                l.size -= uint96(fillable);
                if (l.size == 0) ++_askHead;
                q = 0;
            } else {
                filled += l.size;
                uint256 left = fillable - l.size;
                uint256 price = l.price;
                l.size = 0;
                ++_askHead;
                q = price * left / sP;
            }
        }

        if (filled != 0) {
            credit = filled * 10 ** _p.baseAssetDecimals / sP;
            credit -= _mulDivUp(credit, _p.takerFeeBps, 10_000);
            _p.baseAsset.safeTransfer(msg.sender, credit - shortBase);
        }
        if (q > 0) {
            if (isFillOrKill) revert InsufficientLiquidity();
            _p.quoteAsset.safeTransfer(msg.sender, _toQuoteUnits(q));
        }
        if (credit < minAmountOut) revert SlippageExceeded();
    }

    function placeAndExecuteMarketSell(uint96 size, uint256 minAmountOut, bool isMargin, bool isFillOrKill)
        external
        payable
        returns (uint256 credit)
    {
        if (isMargin) revert MarginNotSupported();
        _reenter();
        ++marketSells;
        uint256 sP = _p.sizePrecision;
        lastAllowance = MockTokenForRouter(_p.baseAsset).allowance(msg.sender, address(this));
        _p.baseAsset.safeTransferFrom(msg.sender, address(this), _toBaseUnits(size));

        uint256 s = size;
        uint256 quote;
        while (s > 0 && _bidHead < _bids.length) {
            Level storage l = _bids[_bidHead];
            uint256 f = s < l.size ? s : l.size;
            quote += f * l.price / sP;
            s -= f;
            l.size -= uint96(f);
            if (l.size == 0) ++_bidHead;
        }

        if (quote != 0) {
            credit = quote * 10 ** _p.quoteAssetDecimals / _p.pricePrecision;
            credit -= _mulDivUp(credit, _p.takerFeeBps, 10_000);
            _p.quoteAsset.safeTransfer(msg.sender, credit - shortQuote);
        }
        if (s > 0) {
            if (isFillOrKill) revert InsufficientLiquidity();
            _p.baseAsset.safeTransfer(msg.sender, _toBaseUnits(s));
        }
        if (credit < minAmountOut) revert SlippageExceeded();
    }

    // ---- views ----

    function getL2Book() external view returns (bytes memory) {
        return getL2Book(type(uint32).max, type(uint32).max);
    }

    function getL2Book(uint32 bidPoints, uint32 askPoints) public view returns (bytes memory data) {
        data = abi.encodePacked(block.number);
        for (uint256 i = _bidHead; i < _bids.length && i - _bidHead < bidPoints; ++i) {
            data = abi.encodePacked(data, uint256(_bids[i].price), uint256(_bids[i].size));
        }
        data = abi.encodePacked(data, uint256(0));
        for (uint256 i = _askHead; i < _asks.length && i - _askHead < askPoints; ++i) {
            data = abi.encodePacked(data, uint256(_asks[i].price), uint256(_asks[i].size));
        }
    }

    function getMarketParams()
        external
        view
        returns (uint32, uint96, address, uint256, address, uint256, uint32, uint96, uint96, uint256, uint256)
    {
        KuruMarketParams memory p = _p;
        return (
            p.pricePrecision,
            p.sizePrecision,
            p.baseAsset,
            p.baseAssetDecimals,
            p.quoteAsset,
            p.quoteAssetDecimals,
            p.tickSize,
            p.minSize,
            p.maxSize,
            p.takerFeeBps,
            p.makerFeeBps
        );
    }

    function getVaultParams()
        external
        view
        returns (address, uint256, uint96, uint256, uint96, uint96, uint96, uint96)
    {
        return (address(0), 0, 0, type(uint256).max, 0, 0, 0, kuruAmmSpread);
    }

    function askCount() external view returns (uint256) {
        return _asks.length - _askHead;
    }

    function bidCount() external view returns (uint256) {
        return _bids.length - _bidHead;
    }

    function askAt(uint256 i) external view returns (uint32 price, uint96 size) {
        Level memory l = _asks[_askHead + i];
        return (l.price, l.size);
    }

    /// Base a market buy with `quoteSize` would credit right now, without executing (reference model).
    function previewMarketBuy(uint256 quoteSize) external view returns (uint256 credit, uint256 refund) {
        (credit, refund,) = previewMarketBuyFull(quoteSize);
    }

    /// Same, also returning the gross size filled (in sizePrecision units, before the fee).
    function previewMarketBuyFull(uint256 quoteSize)
        public
        view
        returns (uint256 credit, uint256 refund, uint256 filled)
    {
        uint256 sP = _p.sizePrecision;
        uint256 q = quoteSize;
        for (uint256 i = _askHead; q > 0 && i < _asks.length; ++i) {
            Level memory l = _asks[i];
            uint256 fillable = q * sP / l.price;
            if (fillable <= l.size) {
                filled += fillable;
                q = 0;
            } else {
                filled += l.size;
                q = uint256(l.price) * (fillable - l.size) / sP;
            }
        }
        if (filled != 0) {
            credit = filled * 10 ** _p.baseAssetDecimals / sP;
            credit -= _mulDivUp(credit, _p.takerFeeBps, 10_000);
        }
        refund = _toQuoteUnits(q);
    }

    /// Quote a market sell of `size` would credit right now, without executing (reference model).
    function previewMarketSell(uint256 size) external view returns (uint256 credit, uint256 unsold) {
        uint256 sP = _p.sizePrecision;
        uint256 s = size;
        uint256 quote;
        for (uint256 i = _bidHead; s > 0 && i < _bids.length; ++i) {
            uint256 f = s < _bids[i].size ? s : _bids[i].size;
            quote += f * _bids[i].price / sP;
            s -= f;
        }
        if (quote != 0) {
            credit = quote * 10 ** _p.quoteAssetDecimals / _p.pricePrecision;
            credit -= _mulDivUp(credit, _p.takerFeeBps, 10_000);
        }
        unsold = _toBaseUnits(s);
    }

    // ---- internals ----

    function _reenter() internal {
        address target = reenterTarget;
        if (target == address(0)) return;
        reenterTarget = address(0);
        (bool ok, bytes memory ret) = target.call(reenterData);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 32), mload(ret))
            }
        }
    }

    /// Test setup only: O(n) sorted insert into the live part of a side.
    function _insert(Level[] storage side, uint256 head, uint32 price, uint96 size, bool ascending) internal {
        for (uint256 i = head; i < side.length; ++i) {
            if (side[i].price == price) {
                side[i].size += size;
                return;
            }
        }
        side.push(Level(price, size));
        for (uint256 i = side.length - 1; i > head; --i) {
            bool outOfOrder = ascending ? side[i - 1].price > side[i].price : side[i - 1].price < side[i].price;
            if (!outOfOrder) break;
            Level memory t = side[i - 1];
            side[i - 1] = side[i];
            side[i] = t;
        }
    }

    function _toQuoteUnits(uint256 q) internal view returns (uint256) {
        return q * 10 ** _p.quoteAssetDecimals / _p.pricePrecision;
    }

    function _toBaseUnits(uint256 s) internal view returns (uint256) {
        return s * 10 ** _p.baseAssetDecimals / _p.sizePrecision;
    }

    function _mulDivUp(uint256 a, uint256 b, uint256 d) internal pure returns (uint256) {
        uint256 x = a * b;
        return x == 0 ? 0 : (x - 1) / d + 1;
    }
}
